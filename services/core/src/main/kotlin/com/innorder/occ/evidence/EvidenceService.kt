package com.innorder.occ.evidence

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import com.innorder.occ.api.CursorCodec
import com.innorder.occ.api.CursorContext
import com.innorder.occ.api.CursorDirection
import com.innorder.occ.authz.AuthorizationRequest
import com.innorder.occ.authz.AuthorizationService
import com.innorder.occ.command.*
import org.springframework.stereotype.Service
import org.springframework.context.annotation.Profile
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.sql.Timestamp
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.UUID

data class EvidenceDownload(val read: ObjectRead, val fileName: String, val mediaType: String, val totalSize: Long) : Closeable {
    override fun close() = read.close()
}

@Service
@Profile("!test & !flowable-init")
class EvidenceService(
    private val evidence: EvidenceRepository,
    private val commands: CommandExecutor,
    private val authorization: AuthorizationService,
    private val cursors: CursorCodec,
    private val objects: ObjectStore,
    private val inspector: EvidenceContentInspector,
    private val workflow: EvidenceWorkflowPort,
    private val notifications: DomainNotificationPort,
    private val previews: EvidencePreviewService,
    transactionManager: PlatformTransactionManager,
    private val clock: Clock,
) {
    private val transactions = TransactionTemplate(transactionManager).apply {
        propagationBehavior = TransactionDefinition.PROPAGATION_REQUIRED
    }

    fun createSession(metadata: CommandMetadata, request: CreateEvidenceSessionRequest): EvidenceCommandResult<EvidenceSession> {
        validate(request)
        val requirement = evidence.requirement(request.requirementId)
        if (request.sizeBytes > requirement.policy.content.maximumBytes) throw InvalidEvidenceRequestException()
        val sessionId = UUID.nameUUIDFromBytes(
            "evidence-upload:${metadata.principalId}:${metadata.commandKey}:${metadata.idempotencyKey}".toByteArray(),
        )
        val priorSession = try {
            evidence.session(sessionId)
        } catch (_: EvidenceSessionNotFoundException) {
            null
        }
        val existing = evidence.findHead(request.targetEntityId, request.requirementId, request.slotKey)
        if (priorSession == null && (existing == null) != (metadata.expectedVersion == null)) throw InvalidExpectedVersionException()
        val evidenceId = priorSession?.evidenceId ?: existing?.id ?: UUID.nameUUIDFromBytes(
            "evidence:${request.targetEntityId}:${request.requirementId}:${request.slotKey}".toByteArray(),
        )
        val resubmit = priorSession?.let { metadata.expectedVersion != null } ?: (existing != null)
        val result = commands.execute(
            metadata,
            MAPPER.writeValueAsBytes(request),
            CreateSessionCommand(sessionId, evidenceId, request, resubmit),
        )
        return typed(result, EvidenceSession::class.java)
    }

    fun upload(metadata: CommandMetadata, sessionId: UUID, source: InputStream): EvidenceCommandResult<EvidenceVersion> {
        var session = evidence.session(sessionId)
        authorize(metadata.principalId, metadata.correlationId, "evidence.upload", session.targetId, session.evidenceId)
        if (session.uploaderId != metadata.principalId || metadata.expectedVersion != session.expectedEvidenceVersion) {
            throw EvidenceUploadConflictException()
        }
        if (session.status == UploadSessionStatus.CONFIRMED) {
            return EvidenceCommandResult(200, true, evidence.versionForSession(sessionId))
        }
        if (session.status == UploadSessionStatus.EXPIRED) throw EvidenceUploadConflictException()
        val owner = UUID.randomUUID()
        val now = clock.instant()
        val leaseUntil = minOf(now.plus(LEASE_DURATION), session.absoluteDeadline)
        session = transactions.execute { evidence.acquireLease(sessionId, owner, now, leaseUntil) }!!
        if (session.status == UploadSessionStatus.CONFIRMED) {
            return EvidenceCommandResult(200, true, evidence.versionForSession(sessionId))
        }
        if (session.status == UploadSessionStatus.EXPIRED) throw EvidenceUploadConflictException()

        val temporary = Files.createTempFile("occ-evidence-", ".upload")
        var quarantineStored = false
        var immutableStored = false
        try {
            spool(source, temporary, session, owner)
            Files.newInputStream(temporary).use { bytes ->
                objects.putQuarantine(ObjectPut(
                    session.quarantineKey, bytes, session.expectedSize, session.expectedSha256, "application/octet-stream",
                ))
            }
            quarantineStored = true
            transactions.executeWithoutResult { evidence.inspecting(session.id) }
            val inspected = inspector.inspect(InspectionRequest(
                temporary, session.fileName, session.expectedSha256, session.expectedSize,
                evidence.requirement(session.requirementId).policy.content,
                minOf(session.absoluteDeadline, clock.instant().plus(INSPECTION_LIMIT)),
            ))
            val preview = previews.generate(temporary, inspected.detectedMediaType)
            transactions.executeWithoutResult {
                evidence.scanned(session.id, inspected)
                evidence.promoting(session.id)
            }
            val promotion = objects.promote(
                session.quarantineKey, session.immutableKey, session.expectedSize, session.expectedSha256,
            )
            immutableStored = true
            val result = commands.execute(
                metadata,
                MAPPER.writeValueAsBytes(mapOf("sessionId" to sessionId.toString())),
                ConfirmVersionCommand(session, inspected, preview, promotion.sourceCleanupDisposition),
            )
            return typed(result, EvidenceVersion::class.java)
        } catch (_: EvidenceStreamDisconnectedException) {
            throw EvidenceUploadConflictException()
        } catch (failure: Exception) {
            transactions.executeWithoutResult {
                evidence.fail(sessionId, failureCode(failure), clock.instant().plus(ORPHAN_GRACE), quarantineStored)
                if (immutableStored) evidence.recordOrphan(sessionId, session.immutableKey, clock.instant().plus(ORPHAN_GRACE))
            }
            throw failure
        } finally {
            runCatching { Files.deleteIfExists(temporary) }
        }
    }

    fun submit(metadata: CommandMetadata, evidenceId: UUID): EvidenceCommandResult<EvidenceMetadata> {
        if (metadata.expectedVersion == null) throw InvalidExpectedVersionException()
        return typed(
            commands.execute(metadata, MAPPER.writeValueAsBytes(mapOf("evidenceId" to evidenceId)), SubmitCommand(evidenceId)),
            EvidenceMetadata::class.java,
        )
    }

    fun review(
        metadata: CommandMetadata,
        evidenceId: UUID,
        request: EvidenceReviewRequest,
    ): EvidenceCommandResult<EvidenceReviewResult> {
        validate(request)
        if (metadata.expectedVersion == null) throw InvalidExpectedVersionException()
        return typed(
            commands.execute(metadata, MAPPER.writeValueAsBytes(request), ReviewCommand(evidenceId, request)),
            EvidenceReviewResult::class.java,
        )
    }

    fun metadata(principalId: UUID, correlationId: UUID, evidenceId: UUID): EvidenceMetadata {
        val head = evidence.getHead(evidenceId)
        authorize(principalId, correlationId, "evidence.read", head.targetId, head.id)
        return head.metadata()
    }

    fun history(
        principalId: UUID,
        correlationId: UUID,
        evidenceId: UUID,
        limit: Int,
        cursor: String? = null,
    ): EvidenceHistoryPage {
        if (limit !in 1..100) throw InvalidEvidenceRequestException()
        val head = evidence.getHead(evidenceId)
        authorize(principalId, correlationId, "evidence.history.read", head.targetId, head.id)
        val context = cursorContext(evidenceId)
        val after = cursor?.let { token ->
            cursors.decode(token, context).also { if (it.size() != 1 || !it[0].isInt) throw InvalidEvidenceRequestException() }[0].intValue()
        }
        val rows = evidence.history(evidenceId, after, limit + 1)
        val items = rows.take(limit)
        val next = if (rows.size > limit) cursors.encode(context, MAPPER.createArrayNode().add(items.last().version)) else null
        return EvidenceHistoryPage(items, next)
    }

    fun download(
        principalId: UUID,
        correlationId: UUID,
        evidenceId: UUID,
        version: Int,
        range: ObjectRange? = null,
    ): EvidenceDownload {
        val head = evidence.getHead(evidenceId)
        authorize(principalId, correlationId, "evidence.download", head.targetId, head.id)
        val record = evidence.download(evidenceId, version)
        return EvidenceDownload(objects.get(record.key, range), safeFilename(record.fileName), record.mediaType, record.size)
    }

    fun preview(principalId: UUID, correlationId: UUID, evidenceId: UUID, version: Int): String? {
        val head = evidence.getHead(evidenceId)
        authorize(principalId, correlationId, "evidence.preview", head.targetId, head.id)
        return evidence.preview(evidenceId, version)
    }

    private fun spool(source: InputStream, path: java.nio.file.Path, session: EvidenceSessionRecord, owner: UUID) {
        val digest = MessageDigest.getInstance("SHA-256")
        var count = 0L
        var nextHeartbeat = HEARTBEAT_BYTES
        try {
            Files.newOutputStream(path).buffered().use { output ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    val read = source.read(buffer)
                    if (read < 0) break
                    if (read == 0) continue
                    count += read
                    if (count > session.expectedSize || count > ObjectStore.MAX_OBJECT_SIZE) throw ObjectIntegrityException()
                    digest.update(buffer, 0, read)
                    output.write(buffer, 0, read)
                    if (count >= nextHeartbeat) {
                        val now = clock.instant()
                        transactions.executeWithoutResult {
                            evidence.heartbeat(session.id, owner, now, minOf(now.plus(LEASE_DURATION), session.absoluteDeadline))
                        }
                        nextHeartbeat += HEARTBEAT_BYTES
                    }
                }
            }
        } catch (failure: IOException) {
            throw EvidenceStreamDisconnectedException(failure)
        }
        val actual = digest.digest().joinToString("") { "%02x".format(it) }
        if (count != session.expectedSize || actual != session.expectedSha256) throw ObjectIntegrityException()
    }

    private inner class CreateSessionCommand(
        private val sessionId: UUID,
        private val requestedEvidenceId: UUID,
        private val request: CreateEvidenceSessionRequest,
        override val expectedVersionRequired: Boolean,
    ) : AuthorizedCommand {
        override val action = "evidence.upload.create"
        override val entityId = request.targetEntityId
        override val resourceId = request.targetEntityId
        override val aggregateType = "evidence-upload-session"
        override val aggregateId = sessionId
        override val changesAuthorizationFacts = false
        private var head: EvidenceHeadRecord? = null

        override fun lockCurrentVersion(context: CommandContext): Long? {
            context.jdbc.queryForObject(
                "SELECT pg_advisory_xact_lock(hashtextextended(?, 1163284054)) IS NULL", Boolean::class.java,
                "${request.targetEntityId}:${request.requirementId}:${request.slotKey}",
            )
            head = evidence.findHead(request.targetEntityId, request.requirementId, request.slotKey)?.let { evidence.lockHead(it.id) }
            if ((head != null) != expectedVersionRequired) throw EvidenceUploadConflictException()
            return head?.rowVersion
        }

        override fun execute(context: CommandContext): CommandMutation {
            val current = head
            val evidenceId = current?.id ?: requestedEvidenceId.also {
                evidence.createHead(it, request.targetEntityId, request.requirementId, request.slotKey, context.metadata.principalId)
            }
            val expectedEvidenceVersion = current?.rowVersion ?: 0
            val now = clock.instant()
            val extension = request.fileName.substringAfterLast('.', "").lowercase()
            val record = EvidenceSessionRecord(
                sessionId, context.metadata.principalId, request.targetEntityId, request.requirementId, evidenceId,
                request.slotKey, request.fileName, extension, request.sha256, request.sizeBytes, expectedEvidenceVersion,
                "quarantine/${UUID.randomUUID()}/content", "evidence/$evidenceId/${UUID.randomUUID()}/content",
                UploadSessionStatus.CREATED, now.plus(SESSION_EXPIRY), now.plus(ABSOLUTE_UPLOAD_LIMIT), null, null,
            )
            evidence.createSession(record)
            val body = EvidenceSession(record.id, evidenceId, record.status, record.expiresAt, expectedEvidenceVersion)
            val eventId = UUID.randomUUID()
            notify(context, eventId, evidenceId, request.recipientSelector, "EVIDENCE_UPLOAD_CREATED", 0)
            return mutation(context, 201, current?.rowVersion, (current?.rowVersion ?: -1) + 1,
                "evidence.upload.created", body, eventId)
        }
    }

    private inner class ConfirmVersionCommand(
        private val session: EvidenceSessionRecord,
        private val inspected: InspectedEvidence,
        private val preview: String?,
        private val sourceCleanup: SourceCleanupDisposition,
    ) : AuthorizedCommand {
        override val action = "evidence.upload.confirm"
        override val entityId = session.targetId
        override val resourceId = session.evidenceId
        override val aggregateType = "evidence"
        override val aggregateId = session.evidenceId
        override val expectedVersionRequired = true
        override val changesAuthorizationFacts = false
        private lateinit var current: EvidenceHeadRecord
        override fun lockCurrentVersion(context: CommandContext): Long = evidence.lockHead(session.evidenceId).also { current = it }.rowVersion
        override fun execute(context: CommandContext): CommandMutation {
            val version = evidence.confirm(session, inspected, preview, sourceCleanup)
            val eventId = UUID.randomUUID()
            workflow(context, eventId, version, "VERSION_CONFIRMED", null, false, false, null, null)
            notify(context, eventId, version.evidenceId, "uploader:${session.uploaderId}", "EVIDENCE_VERSION_CONFIRMED", version.version)
            return mutation(context, 201, current.rowVersion, version.evidenceRowVersion, "evidence.version.confirmed", version, eventId)
        }
    }

    private inner class SubmitCommand(private val id: UUID) : AuthorizedCommand {
        override val action = "evidence.submit"
        override val entityId = id
        override val resourceId = id
        override val aggregateType = "evidence"
        override val aggregateId = id
        override val expectedVersionRequired = true
        override val changesAuthorizationFacts = false
        private lateinit var current: EvidenceHeadRecord
        override fun lockCurrentVersion(context: CommandContext): Long = evidence.lockHead(id).also { current = it }.rowVersion
        override fun execute(context: CommandContext): CommandMutation {
            if (current.currentVersion == null || current.state != EvidenceState.PENDING) throw EvidenceStateConflictException()
            evidence.submit(id)
            val updated = evidence.getHead(id)
            val eventId = UUID.randomUUID()
            workflow(context, eventId, EvidenceVersion(UUID.randomUUID(), id, requireNotNull(updated.currentVersion), "", 0, updated.rowVersion),
                "SUBMITTED", null, false, false, null, null)
            notify(context, eventId, id, "reviewers:${updated.requirementId}", "EVIDENCE_SUBMITTED", requireNotNull(updated.currentVersion))
            return mutation(context, 200, current.rowVersion, updated.rowVersion, "evidence.submitted", updated.metadata(), eventId)
        }
    }

    private inner class ReviewCommand(private val id: UUID, private val request: EvidenceReviewRequest) : AuthorizedCommand {
        override val action = "evidence.review"
        override val entityId = id
        override val resourceId = id
        override val aggregateType = "evidence"
        override val aggregateId = id
        override val expectedVersionRequired = true
        override val changesAuthorizationFacts = false
        private lateinit var current: EvidenceHeadRecord
        override fun lockCurrentVersion(context: CommandContext): Long {
            val initial = evidence.getHead(id)
            evidence.lockRequirementHeads(initial.targetId, initial.requirementId)
            current = evidence.lockHead(id)
            return current.rowVersion
        }
        override fun execute(context: CommandContext): CommandMutation {
            val requirement = evidence.requirement(current.requirementId)
            val accepted = request.outcome == EvidenceReviewOutcome.ACCEPTED ||
                request.outcome == EvidenceReviewOutcome.CONDITIONAL && !requirement.policy.conditionalHardGate
            val gate = accepted && evidence.acceptedCount(current.targetId, current.requirementId, id, true) >= requirement.minimumCount
            val reviewId = evidence.review(current, context.metadata.principalId, request, gate)
            val updated = evidence.getHead(id)
            val followUp = request.outcome == EvidenceReviewOutcome.CONDITIONAL
            val result = EvidenceReviewResult(
                reviewId, id, requireNotNull(updated.currentVersion), request.outcome, gate, followUp, updated.rowVersion,
            )
            val eventId = UUID.randomUUID()
            workflow(context, eventId, EvidenceVersion(UUID.randomUUID(), id, result.evidenceVersion, "", 0, updated.rowVersion),
                "REVIEWED", request.outcome, gate, followUp, request.followUpDueAt, request.priorAssigneeId)
            notify(context, eventId, id, "submitter:$id:${result.evidenceVersion}", "EVIDENCE_REVIEWED", result.evidenceVersion)
            return mutation(context, 200, current.rowVersion, updated.rowVersion, "evidence.reviewed", result, eventId, request.reason)
        }
    }

    private fun workflow(
        context: CommandContext, eventId: UUID, version: EvidenceVersion, type: String,
        outcome: EvidenceReviewOutcome?, gate: Boolean, followUp: Boolean, dueAt: Instant?, priorAssignee: UUID?,
    ) = workflow.persist(EvidenceWorkflowIntent(
        UUID.randomUUID(), eventId, version.evidenceId, version.version, type, outcome, gate, followUp, dueAt,
        priorAssignee, context.metadata.correlationId,
    ))

    private fun notify(
        context: CommandContext, eventId: UUID, evidenceId: UUID, selector: String, type: String, version: Int,
    ) = notifications.persist(DomainNotificationIntent(
        UUID.randomUUID(), eventId, evidenceId, selector, type,
        mapOf("evidenceId" to evidenceId.toString(), "version" to version.toString()), context.metadata.correlationId,
    ))

    private fun mutation(
        context: CommandContext, status: Int, before: Long?, after: Long, type: String, bodyValue: Any,
        eventId: UUID, reason: String? = null,
    ): CommandMutation {
        val body = canonical(bodyValue)
        val payload = canonical(mapOf(
            "evidenceId" to context.descriptor.resourceId.toString(), "integrationEventId" to eventId.toString(),
            "version" to after,
        ))
        return CommandMutation(
            status, body, context.descriptor.resourceId, context.descriptor.aggregateId, context.descriptor.aggregateType,
            before, after, reason, canonical(mapOf("eventType" to type)), listOf(PendingEventSpec(type, 1, payload, after)),
        )
    }

    private fun validate(request: CreateEvidenceSessionRequest) {
        if (request.slotKey.length !in 1..128 || request.slotKey.any(Char::isISOControl) ||
            request.fileName.length !in 1..255 || request.fileName.any(Char::isISOControl) ||
            '/' in request.fileName || '\\' in request.fileName || !SHA256.matches(request.sha256) ||
            request.sizeBytes !in 1..ObjectStore.MAX_OBJECT_SIZE ||
            request.recipientSelector.length !in 1..256 || request.recipientSelector.any(Char::isISOControl)
        ) throw InvalidEvidenceRequestException()
    }

    private fun validate(request: EvidenceReviewRequest) {
        if (request.reason.length !in 1..1024 || request.reason.any(Char::isISOControl) || request.conditions.size > 32 ||
            request.conditions.any { (key, value) -> key.length !in 1..128 || value.length > 512 || key.any(Char::isISOControl) || value.any(Char::isISOControl) } ||
            (request.outcome == EvidenceReviewOutcome.CONDITIONAL) != (request.followUpDueAt != null)
        ) throw InvalidEvidenceRequestException()
    }

    private fun authorize(principalId: UUID, correlationId: UUID, action: String, entityId: UUID, resourceId: UUID) {
        val request = AuthorizationRequest(
            UUID.randomUUID(), principalId, action, entityId, resourceId, emptyMap(), correlationId,
        )
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            authorization.authorize(request)
        } else {
            transactions.executeWithoutResult { authorization.authorize(request) }
        }
    }

    private fun cursorContext(id: UUID) = CursorContext(
        "evidence.history", id, canonical(mapOf("evidenceId" to id.toString())),
        "evidence-version", 1, CursorDirection.FORWARD,
    )

    private fun safeFilename(value: String): String = value.take(255).map {
        if (it.isISOControl() || it == '/' || it == '\\' || it == '"') '_' else it
    }.joinToString("").ifBlank { "evidence" }

    private fun failureCode(failure: Exception): String = when (failure) {
        is EvidenceRejectedException -> failure.code.name
        is ObjectIntegrityException -> "OBJECT_INTEGRITY"
        is ObjectStoreException -> "OBJECT_STORE_ERROR"
        else -> "CONFIRMATION_ERROR"
    }

    private fun canonical(value: Any): CanonicalJsonObject = CanonicalJsonObject.from(MAPPER.valueToTree(value))
    private fun <T> typed(result: CommandResult, type: Class<T>) = EvidenceCommandResult(
        result.status, result.replayed, MAPPER.treeToValue(result.body.toJsonNode(), type),
    )

    private fun EvidenceHeadRecord.metadata() = EvidenceMetadata(
        id, targetId, requirementId, slotKey, state, currentVersion, rowVersion,
    )

    companion object {
        private val MAPPER = ObjectMapper().findAndRegisterModules()
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
        private val SHA256 = Regex("^[0-9a-f]{64}$")
        private val SESSION_EXPIRY = Duration.ofMinutes(30)
        private val ABSOLUTE_UPLOAD_LIMIT = Duration.ofHours(2)
        private val LEASE_DURATION = Duration.ofMinutes(2)
        private val INSPECTION_LIMIT = Duration.ofMinutes(5)
        private val ORPHAN_GRACE = Duration.ofMinutes(5)
        private const val HEARTBEAT_BYTES = 1024L * 1024
    }
}

private class EvidenceStreamDisconnectedException(cause: IOException) : RuntimeException(cause)
