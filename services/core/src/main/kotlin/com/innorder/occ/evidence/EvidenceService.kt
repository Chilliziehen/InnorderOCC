package com.innorder.occ.evidence

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import com.innorder.occ.api.CursorCodec
import com.innorder.occ.api.CursorContext
import com.innorder.occ.api.CursorDirection
import com.innorder.occ.authz.AuthorizationRequest
import com.innorder.occ.authz.AuthorizationService
import com.innorder.occ.command.*
import org.springframework.context.annotation.Profile
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate
import java.io.Closeable
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.UUID

data class EvidenceDownload(
    val read: ObjectRead,
    val metadata: EvidenceDownloadMetadata,
) : Closeable {
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
    private val workflowIntents: EvidenceWorkflowIntentPort,
    private val workflowBindings: List<EvidenceWorkflowPort>,
    private val notificationIntents: EvidenceDomainNotificationPort,
    private val notificationBindings: List<DomainNotificationPort>,
    private val previews: EvidencePreviewService,
    transactionManager: PlatformTransactionManager,
    private val clock: Clock,
) {
    private val transactions = TransactionTemplate(transactionManager).apply {
        propagationBehavior = TransactionDefinition.PROPAGATION_REQUIRED
    }

    fun requirement(principalId: UUID, correlationId: UUID, id: UUID): EvidenceRequirement {
        authorize(principalId, correlationId, "evidence.requirement.read", id, id)
        return evidence.requirement(id).public()
    }

    fun requirements(
        principalId: UUID, correlationId: UUID, limit: Int, cursor: String? = null,
    ): EvidenceRequirementPage {
        if (limit !in 1..100) throw InvalidEvidenceRequestException()
        val context = cursorContext("evidence.requirements", REQUIREMENTS_CONTEXT_ID)
        val after = cursor?.let { decodeUuid(cursors.decode(it, context)) }
        val rows = evidence.requirements(after, limit + 1).filter { record ->
            allowed(principalId, correlationId, "evidence.requirement.read", record.id, record.id)
        }
        val items = rows.take(limit)
        val next = if (rows.size > limit) cursors.encode(context, MAPPER.createArrayNode().add(items.last().id.toString())) else null
        return EvidenceRequirementPage(items.map { it.public() }, nextCursor = next)
    }

    fun createSession(metadata: CommandMetadata, request: CreateEvidenceSessionRequest): EvidenceCommandResult<EvidenceSession> {
        validate(request)
        val requirement = evidence.requirement(request.requirementId)
        if (request.expectedSizeBytes > requirement.policy.content.maximumBytes) throw EvidenceTooLargeException()
        val sessionId = commandUuid("evidence-upload", metadata)
        val priorSession = try { evidence.session(sessionId) } catch (_: EvidenceSessionNotFoundException) { null }
        val existing = request.evidenceId?.let(evidence::getHead)
            ?: evidence.findHead(request.targetEntityId, request.requirementId, request.slotKey)
        if (priorSession == null && existing != null && (existing.targetId != request.targetEntityId || existing.requirementId != request.requirementId ||
                existing.slotKey != request.slotKey || metadata.expectedVersion == null)
        ) throw EvidenceUploadConflictException()
        if (priorSession == null && existing == null && metadata.expectedVersion != null) throw InvalidExpectedVersionException()
        val evidenceId = priorSession?.evidenceId ?: existing?.id ?: UUID.nameUUIDFromBytes(
            "evidence:${request.targetEntityId}:${request.requirementId}:${request.slotKey}".toByteArray(),
        )
        val result = commands.execute(
            metadata, MAPPER.writeValueAsBytes(request),
            CreateSessionCommand(sessionId, evidenceId, request, priorSession?.let { metadata.expectedVersion != null } ?: (existing != null)),
        )
        return typed(result, EvidenceSession::class.java)
    }

    fun uploadStatus(principalId: UUID, correlationId: UUID, uploadSessionId: UUID): EvidenceSession {
        val session = evidence.session(uploadSessionId)
        authorize(principalId, correlationId, "evidence.upload.read", session.targetId, session.evidenceId)
        if (session.uploaderId != principalId) throw EvidenceNotFoundException()
        return session.public()
    }

    fun upload(metadata: CommandMetadata, uploadSessionId: UUID, source: InputStream): EvidenceCommandResult<EvidenceContentResult> {
        var session = transactions.execute {
            val current = evidence.session(uploadSessionId)
            evidence.bindContentCommand(uploadSessionId, metadata.idempotencyKey, contentRequestHash(metadata, current))
        }!!
        authorize(metadata.principalId, metadata.correlationId, "evidence.upload", session.targetId, session.evidenceId)
        if (session.uploaderId != metadata.principalId || metadata.expectedVersion != session.expectedEvidenceVersion) {
            throw EvidenceUploadConflictException()
        }
        if (session.status == UploadSessionStatus.CONFIRMED) return confirmedReplay(session)
        if (session.status == UploadSessionStatus.FAILED) return failedReplay(session)
        if (session.status == UploadSessionStatus.EXPIRED) throw EvidenceUploadConflictException()

        val owner = UUID.randomUUID()
        val now = maxOf(transactions.execute { evidence.transactionTime() }!!, clock.instant())
        val staleActive = session.status in ACTIVE_UPLOAD_PHASES && session.leaseExpiresAt?.isAfter(now) != true
        val persistedQuarantine = if (staleActive) statOrNull(session.quarantineKey) else null
        val persistedImmutable = if (staleActive) statOrNull(session.immutableKey) else null
        if (staleActive && session.status != UploadSessionStatus.STREAMING &&
            persistedQuarantine == null && persistedImmutable == null
        ) throw EvidenceUploadConflictException()
        session = transactions.execute {
            evidence.acquireLease(uploadSessionId, owner, now, minOf(now.plus(LEASE_DURATION), session.absoluteDeadline))
        }!!
        if (session.status == UploadSessionStatus.EXPIRED) throw EvidenceUploadConflictException()

        val temporary = Files.createTempFile("occ-evidence-", ".upload")
        var quarantineStored = false
        var immutableStored = false
        var previewObject: EvidencePreviewObject? = null
        var processingPhase = "STREAMING"
        try {
            when {
                persistedQuarantine != null -> objects.get(session.quarantineKey).use { read ->
                    Files.newOutputStream(temporary).use { output -> read.stream.copyTo(output) }
                    quarantineStored = true
                }
                persistedImmutable != null -> objects.get(session.immutableKey).use { read ->
                    Files.newOutputStream(temporary).use { output -> read.stream.copyTo(output) }
                    immutableStored = true
                }
                else -> {
                    spool(source, temporary, session, owner)
                    Files.newInputStream(temporary).use { bytes ->
                        objects.putQuarantine(ObjectPut(
                            session.quarantineKey, bytes, session.expectedSize, session.expectedSha256,
                            "application/octet-stream",
                        ))
                    }
                    quarantineStored = true
                }
            }
            processingPhase = "INSPECTING"
            transactions.executeWithoutResult { evidence.inspecting(session.id) }
            heartbeat(session, owner)
            val inspected = inspector.inspect(InspectionRequest(
                temporary, "content.${session.extension}", session.expectedSha256, session.expectedSize,
                evidence.requirement(session.requirementId).policy.content,
                minOf(session.absoluteDeadline, clock.instant().plus(INSPECTION_LIMIT)),
            ))
            previews.generate(temporary, inspected.detectedMediaType)?.let { bytes ->
                val key = "${ObjectStore.PREVIEW_PREFIX}${session.evidenceId}/${UUID.randomUUID()}/preview"
                val stored = objects.putPreview(ObjectPut(
                    key, ByteArrayInputStream(bytes), bytes.size.toLong(), MessageDigest.getInstance("SHA-256").digest(bytes).toHex(),
                    inspected.detectedMediaType,
                ))
                previewObject = EvidencePreviewObject(key, inspected.detectedMediaType, stored.size)
            }
            processingPhase = "SCANNING"
            transactions.executeWithoutResult { evidence.scanned(session.id, inspected) }
            heartbeat(session, owner)
            transactions.executeWithoutResult { evidence.promoting(session.id) }
            heartbeat(session, owner)
            processingPhase = "PROMOTING"
            val promotion = if (immutableStored) {
                PromotionResult(requireNotNull(persistedImmutable), SourceCleanupDisposition.REMOVED)
            } else {
                objects.promote(session.quarantineKey, session.immutableKey, session.expectedSize, session.expectedSha256)
            }
            immutableStored = true
            processingPhase = "CONFIRMING"
            val result = commands.execute(
                metadata, MAPPER.writeValueAsBytes(mapOf("uploadSessionId" to uploadSessionId.toString())),
                ConfirmVersionCommand(session, inspected, previewObject, promotion.sourceCleanupDisposition),
            )
            return typed(result, ConfirmedEvidenceContentResult::class.java).asContent()
        } catch (_: EvidenceStreamDisconnectedException) {
            throw EvidenceUploadConflictException()
        } catch (failure: Exception) {
            LOG.warn(
                "Evidence upload terminal processing failed session={} phase={} type={} rootType={}",
                session.id, processingPhase, failure.javaClass.name,
                generateSequence<Throwable>(failure) { it.cause }.last().javaClass.name,
            )
            val code = failureCode(failure)
            val status = failureStatus(failure)
            val result = commands.execute(
                metadata,
                MAPPER.writeValueAsBytes(mapOf("uploadSessionId" to uploadSessionId.toString(), "failureCode" to code)),
                FailUploadCommand(session, code, status, quarantineStored, immutableStored),
            )
            val failed = typed(result, FailedEvidenceContentResult::class.java).asContent()
            throw when (status) {
                413 -> EvidenceTooLargeException()
                422 -> if (code == "HASH_MISMATCH" || code == "OBJECT_INTEGRITY") EvidenceDigestMismatchException() else EvidenceInvalidContentException()
                else -> InvalidEvidenceRequestException()
            }
        } finally {
            runCatching { Files.deleteIfExists(temporary) }
        }
    }

    fun submit(
        metadata: CommandMetadata, evidenceId: UUID, request: SubmitEvidenceRequest,
    ): EvidenceCommandResult<EvidenceMetadata> {
        if (metadata.expectedVersion == null) throw InvalidExpectedVersionException()
        return typed(commands.execute(metadata, MAPPER.writeValueAsBytes(request), SubmitCommand(evidenceId, request)), EvidenceMetadata::class.java)
    }

    fun review(
        metadata: CommandMetadata, evidenceId: UUID, request: EvidenceReviewRequest,
    ): EvidenceCommandResult<EvidenceReview> {
        validate(request)
        if (metadata.expectedVersion == null) throw InvalidExpectedVersionException()
        return typed(commands.execute(metadata, MAPPER.writeValueAsBytes(request), ReviewCommand(evidenceId, request)), EvidenceReview::class.java)
    }

    fun metadata(principalId: UUID, correlationId: UUID, evidenceId: UUID): EvidenceMetadata {
        val head = evidence.getHead(evidenceId)
        authorize(principalId, correlationId, "evidence.read", head.targetId, head.id)
        return head.public()
    }

    fun versions(principalId: UUID, correlationId: UUID, evidenceId: UUID, limit: Int, cursor: String?): EvidenceVersionPage {
        if (limit !in 1..100) throw InvalidEvidenceRequestException()
        val head = evidence.getHead(evidenceId)
        authorize(principalId, correlationId, "evidence.history.read", head.targetId, head.id)
        val context = cursorContext("evidence.versions", evidenceId)
        val after = cursor?.let { decodeInt(cursors.decode(it, context)) }
        val rows = evidence.versions(evidenceId, after, limit + 1)
        val items = rows.take(limit)
        val next = if (rows.size > limit) cursors.encode(context, MAPPER.createArrayNode().add(items.last().version)) else null
        return EvidenceVersionPage(items, nextCursor = next)
    }

    fun reviews(principalId: UUID, correlationId: UUID, evidenceId: UUID, limit: Int, cursor: String?): EvidenceReviewPage {
        if (limit !in 1..100) throw InvalidEvidenceRequestException()
        val head = evidence.getHead(evidenceId)
        authorize(principalId, correlationId, "evidence.history.read", head.targetId, head.id)
        val context = cursorContext("evidence.reviews", evidenceId)
        val after = cursor?.let { decodeReview(cursors.decode(it, context)) }
        val rows = evidence.reviews(evidenceId, after?.first, after?.second, limit + 1)
        val items = rows.take(limit)
        val next = if (rows.size > limit) cursors.encode(context, MAPPER.createArrayNode().apply {
            add(items.last().reviewedAt.toString()); add(items.last().id.toString())
        }) else null
        return EvidenceReviewPage(items, nextCursor = next)
    }

    fun downloadMetadata(principalId: UUID, correlationId: UUID, evidenceId: UUID): EvidenceDownloadMetadata {
        val head = evidence.getHead(evidenceId)
        authorize(principalId, correlationId, "evidence.download", head.targetId, head.id)
        val version = head.currentVersion ?: throw EvidenceNotFoundException()
        return evidence.download(evidenceId, version).public(evidenceId)
    }

    fun download(
        principalId: UUID, correlationId: UUID, evidenceId: UUID, range: ObjectRange? = null,
    ): EvidenceDownload {
        val metadata = downloadMetadata(principalId, correlationId, evidenceId)
        val record = evidence.download(evidenceId, metadata.evidenceVersion)
        return EvidenceDownload(objects.get(record.key, range), metadata)
    }

    fun previewMetadata(principalId: UUID, correlationId: UUID, evidenceId: UUID): EvidencePreviewMetadata {
        val head = evidence.getHead(evidenceId)
        authorize(principalId, correlationId, "evidence.preview", head.targetId, head.id)
        return evidence.previewMetadata(evidenceId, head.currentVersion ?: throw EvidenceNotFoundException())
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
                    if (count > session.expectedSize || count > EvidenceRequirementPolicy.MAXIMUM_BYTES) throw EvidenceTooLargeException()
                    digest.update(buffer, 0, read)
                    output.write(buffer, 0, read)
                    if (count >= nextHeartbeat) { heartbeat(session, owner); nextHeartbeat += HEARTBEAT_BYTES }
                }
            }
        } catch (failure: IOException) {
            throw EvidenceStreamDisconnectedException(failure)
        }
        val actual = digest.digest().toHex()
        if (count != session.expectedSize || actual != session.expectedSha256) throw EvidenceDigestMismatchException()
    }

    private fun heartbeat(session: EvidenceSessionRecord, owner: UUID) {
        transactions.executeWithoutResult {
            val now = maxOf(evidence.transactionTime(), clock.instant())
            evidence.heartbeat(session.id, owner, now, minOf(now.plus(LEASE_DURATION), session.absoluteDeadline))
        }
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
            context.jdbc.queryForObject("SELECT pg_advisory_xact_lock(hashtextextended(?,1163284054)) IS NULL", Boolean::class.java,
                "${request.targetEntityId}:${request.requirementId}:${request.slotKey}")
            head = evidence.findHead(request.targetEntityId, request.requirementId, request.slotKey)?.let { evidence.lockHead(it.id) }
            if ((head != null) != expectedVersionRequired) throw EvidenceUploadConflictException()
            return head?.rowVersion
        }
        override fun execute(context: CommandContext): CommandMutation {
            val current = head
            val evidenceId = current?.id ?: requestedEvidenceId.also {
                evidence.createHead(it, request.targetEntityId, request.requirementId, request.slotKey, context.metadata.principalId)
            }
            val now = evidence.transactionTime()
            val record = EvidenceSessionRecord(
                sessionId, context.metadata.principalId, request.targetEntityId, request.requirementId, evidenceId,
                request.slotKey, "content.${request.extension}", request.extension, request.expectedSha256, request.expectedSizeBytes,
                current?.rowVersion ?: 0, "quarantine/${UUID.randomUUID()}/content", "evidence/$evidenceId/${UUID.randomUUID()}/content",
                UploadSessionStatus.CREATED, now.plus(SESSION_EXPIRY), now.plus(ABSOLUTE_UPLOAD_LIMIT), null, null,
                null, null, null, null, now, 0, null, null,
            )
            evidence.createSession(record)
            val eventId = UUID.randomUUID()
            notify(context, eventId, evidenceId, "principal:${context.metadata.principalId}", "EVIDENCE_UPLOAD_CREATED", 0)
            return mutation(context, 201, current?.rowVersion, (current?.rowVersion ?: -1) + 1,
                "EVIDENCE_UPLOAD_CREATED", record.public(), eventId, null, sessionId)
        }
    }

    private inner class ConfirmVersionCommand(
        private val session: EvidenceSessionRecord,
        private val inspected: InspectedEvidence,
        private val preview: EvidencePreviewObject?,
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
        override fun lockCurrentVersion(context: CommandContext) = evidence.lockHead(session.evidenceId).also { current = it }.rowVersion
        override fun execute(context: CommandContext): CommandMutation {
            val version = evidence.confirm(session, inspected, preview, sourceCleanup)
            val updated = evidence.getHead(session.evidenceId)
            val body = ConfirmedEvidenceContentResult(
                session.id, session.evidenceId, sha256 = version.sha256, sizeBytes = version.sizeBytes,
                detectedMediaType = version.mediaType, evidenceVersion = version.version, version = updated.rowVersion,
            )
            val eventId = UUID.randomUUID()
            workflow(context, eventId, version.evidenceId, version.version, "VERSION_CONFIRMED", null, false, false, null, null)
            notify(context, eventId, version.evidenceId, "principal:${session.uploaderId}", "EVIDENCE_UPLOAD_CONFIRMED", version.version)
            return mutation(context, 200, current.rowVersion, updated.rowVersion, "EVIDENCE_UPLOAD_CONFIRMED", body, eventId,
                null, session.id, version.version, updated.state)
        }
    }

    private inner class FailUploadCommand(
        private val session: EvidenceSessionRecord,
        private val failureCode: String,
        private val responseStatus: Int,
        private val quarantineStored: Boolean,
        private val immutableStored: Boolean,
    ) : AuthorizedCommand {
        override val action = "evidence.upload.fail"
        override val entityId = session.targetId
        override val resourceId = session.evidenceId
        override val aggregateType = "evidence"
        override val aggregateId = session.evidenceId
        override val expectedVersionRequired = true
        override val changesAuthorizationFacts = false
        private lateinit var current: EvidenceHeadRecord
        override fun lockCurrentVersion(context: CommandContext) = evidence.lockHead(session.evidenceId).also { current = it }.rowVersion
        override fun execute(context: CommandContext): CommandMutation {
            evidence.fail(session.id, failureCode, evidence.transactionTime().plus(ORPHAN_GRACE), quarantineStored)
            if (immutableStored) evidence.recordOrphan(session.id, session.immutableKey, evidence.transactionTime().plus(ORPHAN_GRACE))
            val updated = evidence.recordFailureOnHead(session.evidenceId)
            val body = FailedEvidenceContentResult(session.id, session.evidenceId, failureCode = failureCode, version = updated.rowVersion)
            val eventId = UUID.randomUUID()
            notify(context, eventId, session.evidenceId, "principal:${session.uploaderId}", "EVIDENCE_UPLOAD_FAILED", 0)
            return mutation(context, responseStatus, current.rowVersion, updated.rowVersion,
                "EVIDENCE_UPLOAD_FAILED", body, eventId, failureCode, session.id, null, updated.state)
        }
    }

    private inner class SubmitCommand(private val id: UUID, private val request: SubmitEvidenceRequest) : AuthorizedCommand {
        override val action = "evidence.submit"
        override val entityId = id
        override val resourceId = id
        override val aggregateType = "evidence"
        override val aggregateId = id
        override val expectedVersionRequired = true
        override val changesAuthorizationFacts = false
        private lateinit var current: EvidenceHeadRecord
        override fun lockCurrentVersion(context: CommandContext) = evidence.lockHead(id).also { current = it }.rowVersion
        override fun execute(context: CommandContext): CommandMutation {
            if (current.state != EvidenceState.PENDING || current.currentVersion != request.evidenceVersion) throw EvidenceSubmitConflictException()
            evidence.submit(id, request.evidenceVersion)
            val updated = evidence.getHead(id)
            val eventId = UUID.randomUUID()
            workflow(context, eventId, id, request.evidenceVersion, "SUBMITTED", null, false, false, null, null)
            notify(context, eventId, id, "requirement-reviewers:${updated.requirementId}", "EVIDENCE_SUBMITTED", request.evidenceVersion)
            return mutation(context, 200, current.rowVersion, updated.rowVersion, "EVIDENCE_SUBMITTED", updated.public(), eventId,
                null, null, request.evidenceVersion, updated.state)
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
            if (current.currentVersion != request.evidenceVersion) throw EvidenceReviewConflictException()
            val policy = evidence.requirement(current.requirementId).policy
            val conditionallyAccepted = request.decision == EvidenceReviewOutcome.CONDITIONAL && policy.conditionalAdvancement
            val accepted = request.decision == EvidenceReviewOutcome.ACCEPTED || conditionallyAccepted
            evidence.lockRequirementHeads(current.targetId, current.requirementId)
            val acceptedCount = evidence.acceptedCount(current.targetId, current.requirementId, id, true)
            val gate = accepted && (!policy.hardGate || acceptedCount >= policy.minimumCount)
            val now = evidence.transactionTime()
            val followUp = if (request.decision == EvidenceReviewOutcome.CONDITIONAL) now.plus(Duration.ofHours(policy.conditionalFollowUpHours.toLong())) else null
            val review = evidence.review(current, context.metadata.principalId, request, gate, followUp)
            val updated = evidence.getHead(id)
            val eventId = UUID.randomUUID()
            val priorAssignee = workflowBindings.filterIsInstance<EvidenceWorkflowSnapshotPort>()
                .singleOrNull()?.priorAssignee(id)
            workflow(context, eventId, id, request.evidenceVersion, "REVIEWED", request.decision, gate,
                request.decision == EvidenceReviewOutcome.CONDITIONAL, followUp, priorAssignee)
            notify(context, eventId, id, "evidence-submitter:$id:${request.evidenceVersion}", "EVIDENCE_REVIEWED", request.evidenceVersion)
            return mutation(context, 201, current.rowVersion, updated.rowVersion, "EVIDENCE_REVIEWED", review, eventId,
                request.reason, null, request.evidenceVersion, updated.state, request.decision)
        }
    }

    private fun workflow(
        context: CommandContext, eventId: UUID, evidenceId: UUID, evidenceVersion: Int, type: String,
        outcome: EvidenceReviewOutcome?, gate: Boolean, followUp: Boolean, dueAt: Instant?, priorAssignee: UUID?,
    ) {
        val intent = EvidenceWorkflowIntent(
            UUID.randomUUID(), eventId, evidenceId, evidenceVersion, type, outcome, gate, followUp, dueAt,
            priorAssignee, context.metadata.correlationId,
        )
        workflowIntents.persist(intent)
        workflowBindings.forEach { it.dispatch(intent) }
    }

    private fun notify(
        context: CommandContext, eventId: UUID, evidenceId: UUID, selector: String, type: String, evidenceVersion: Int,
    ) {
        val intent = DomainNotificationIntent(
            UUID.randomUUID(), eventId, evidenceId, selector, type,
            mapOf("evidenceId" to evidenceId.toString(), "evidenceVersion" to evidenceVersion.toString()), context.metadata.correlationId,
        )
        notificationIntents.persist(intent)
        notificationBindings.forEach { it.dispatch(intent) }
    }

    private fun mutation(
        context: CommandContext, status: Int, before: Long?, after: Long, type: String, bodyValue: Any,
        eventId: UUID, reason: String?, uploadSessionId: UUID? = null, evidenceVersion: Int? = null,
        state: EvidenceState = EvidenceState.PENDING, decision: EvidenceReviewOutcome? = null,
    ): CommandMutation {
        val payload = canonical(buildMap<String, Any> {
            put("evidenceId", context.descriptor.resourceId.toString())
            put("state", state.name)
            put("version", after)
            uploadSessionId?.let { put("uploadSessionId", it.toString()) }
            evidenceVersion?.let { put("evidenceVersion", it) }
            decision?.let { put("decision", it.name) }
            if (type == "EVIDENCE_UPLOAD_FAILED" && reason != null) put("reasonCode", reason)
        })
        return CommandMutation(
            status, canonical(bodyValue), context.descriptor.resourceId, context.descriptor.aggregateId,
            context.descriptor.aggregateType, before, after, reason, canonical(mapOf("eventType" to type, "eventId" to eventId.toString())),
            listOf(PendingEventSpec(type, 1, payload, after)),
        )
    }

    private fun validate(request: CreateEvidenceSessionRequest) {
        if (request.slotKey.length !in 1..128 || request.slotKey.any(Char::isISOControl) ||
            !EXTENSION.matches(request.extension) || !SHA256.matches(request.expectedSha256) ||
            request.expectedSizeBytes !in 1..EvidenceRequirementPolicy.MAXIMUM_BYTES
        ) throw InvalidEvidenceRequestException()
    }

    private fun validate(request: EvidenceReviewRequest) {
        val conditions = request.conditions
        if (request.evidenceVersion <= 0 || request.reason.length !in 1..2048 || request.reason.any(Char::isISOControl) ||
            conditions?.size?.let { it > 50 } == true || conditions?.any {
                it.code.length !in 1..128 || it.detail.length !in 1..1024 ||
                    it.code.any(Char::isISOControl) || it.detail.any(Char::isISOControl)
            } == true || (request.decision == EvidenceReviewOutcome.CONDITIONAL && conditions.isNullOrEmpty()) ||
            (request.decision != EvidenceReviewOutcome.CONDITIONAL && conditions != null)
        ) throw InvalidEvidenceRequestException()
    }

    private fun authorize(principalId: UUID, correlationId: UUID, action: String, entityId: UUID, resourceId: UUID) {
        val request = AuthorizationRequest(UUID.randomUUID(), principalId, action, entityId, resourceId, emptyMap(), correlationId)
        if (TransactionSynchronizationManager.isActualTransactionActive()) authorization.authorize(request)
        else transactions.executeWithoutResult { authorization.authorize(request) }
    }

    private fun allowed(principalId: UUID, correlationId: UUID, action: String, entityId: UUID, resourceId: UUID): Boolean = try {
        authorize(principalId, correlationId, action, entityId, resourceId); true
    } catch (_: com.innorder.occ.authz.AuthorizationDeniedException) { false }

    private fun cursorContext(endpoint: String, id: UUID) = CursorContext(
        endpoint, id, canonical(mapOf("resourceId" to id.toString())), endpoint.substringAfterLast('.'), 1, CursorDirection.FORWARD,
    )

    private fun decodeUuid(tuple: com.fasterxml.jackson.databind.node.ArrayNode): UUID {
        if (tuple.size() != 1 || !tuple[0].isTextual) throw InvalidEvidenceRequestException()
        return UUID.fromString(tuple[0].textValue())
    }
    private fun decodeInt(tuple: com.fasterxml.jackson.databind.node.ArrayNode): Int {
        if (tuple.size() != 1 || !tuple[0].isInt) throw InvalidEvidenceRequestException()
        return tuple[0].intValue()
    }
    private fun decodeReview(tuple: com.fasterxml.jackson.databind.node.ArrayNode): Pair<Instant, UUID> {
        if (tuple.size() != 2 || !tuple[0].isTextual || !tuple[1].isTextual) throw InvalidEvidenceRequestException()
        return Instant.parse(tuple[0].textValue()) to UUID.fromString(tuple[1].textValue())
    }

    private fun failureCode(failure: Exception): String = when (failure) {
        is EvidenceRejectedException -> failure.code.name
        is EvidenceDigestMismatchException, is ObjectIntegrityException -> "HASH_MISMATCH"
        is EvidenceTooLargeException -> "FILE_TOO_LARGE"
        is ObjectStoreException -> "OBJECT_STORE_ERROR"
        else -> "CONTENT_PROCESSING_ERROR"
    }
    private fun failureStatus(failure: Exception): Int = when (failure) {
        is EvidenceTooLargeException -> 413
        is EvidenceRejectedException, is EvidenceDigestMismatchException, is ObjectIntegrityException -> 422
        else -> 400
    }

    private fun contentRequestHash(metadata: CommandMetadata, session: EvidenceSessionRecord): String = MessageDigest
        .getInstance("SHA-256")
        .digest(canonical(mapOf(
            "commandKey" to metadata.commandKey,
            "expectedVersion" to metadata.expectedVersion,
            "uploadSessionId" to session.id.toString(),
            "expectedSha256" to session.expectedSha256,
            "expectedSizeBytes" to session.expectedSize,
        )).toJsonNode().toString().toByteArray())
        .toHex()

    private fun statOrNull(key: String): StoredObject? = try {
        objects.stat(key)
    } catch (_: ObjectNotFoundException) {
        null
    }

    private fun confirmedReplay(session: EvidenceSessionRecord): EvidenceCommandResult<EvidenceContentResult> {
        val version = evidence.versionForSession(session.id)
        return EvidenceCommandResult(200, true, ConfirmedEvidenceContentResult(
            session.id, session.evidenceId, sha256 = version.sha256, sizeBytes = version.sizeBytes,
            detectedMediaType = version.mediaType, evidenceVersion = version.version, version = evidence.getHead(session.evidenceId).rowVersion,
        ))
    }
    private fun failedReplay(session: EvidenceSessionRecord) = EvidenceCommandResult<EvidenceContentResult>(
        200, true, FailedEvidenceContentResult(
            session.id, session.evidenceId, failureCode = requireNotNull(session.failureCode),
            version = evidence.getHead(session.evidenceId).rowVersion,
        ),
    )

    private fun RequirementRecord.public() = EvidenceRequirement(
        id, code, policy.content.allowedExtensions.sorted(), policy.content.allowedMediaTypes.sorted(), policy.content.maximumBytes,
        policy.minimumCount, policy.hardGate, policy.conditionalAdvancement, policy.conditionalFollowUpHours,
        EvidenceArchivePolicy(policy.content.archiveLimits.maximumEntries, policy.content.archiveLimits.maximumExpandedBytes,
            policy.content.archiveLimits.maximumCompressionRatio),
    )
    private fun EvidenceSessionRecord.public() = EvidenceSession(
        id, evidenceId, status, expectedSha256, expectedSize, actualSha256, actualSize, detectedMediaType,
        failureCode, createdAt, expiresAt, rowVersion,
    )
    private fun EvidenceHeadRecord.public() = EvidenceMetadata(
        id, requirementId, targetId, slotKey, state, currentVersion, rowVersion, createdAt, updatedAt,
    )
    private fun DownloadRecord.public(evidenceId: UUID) = EvidenceDownloadMetadata(
        evidenceId, evidenceVersion, safeFilename("evidence-$evidenceId-v$evidenceVersion.${fileName.substringAfterLast('.', "bin")}"),
        mediaType, size, sha256,
    )
    private fun safeFilename(value: String) = value.take(255).map {
        if (it.isISOControl() || it in setOf('/', '\\', '"', ':')) '_' else it
    }.joinToString("").ifBlank { "evidence" }

    private fun canonical(value: Any): CanonicalJsonObject = CanonicalJsonObject.from(MAPPER.valueToTree(value))
    private fun <T> typed(result: CommandResult, type: Class<T>) = EvidenceCommandResult(
        result.status, result.replayed, MAPPER.treeToValue(result.body.toJsonNode(), type),
    )
    private fun EvidenceCommandResult<out EvidenceContentResult>.asContent() = EvidenceCommandResult(status, replayed, body)
    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }

    companion object {
        private val MAPPER = ObjectMapper().findAndRegisterModules().disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
        private val SHA256 = Regex("^[0-9a-f]{64}$")
        private val EXTENSION = Regex("^[a-z0-9][a-z0-9._-]{0,31}$")
        private val SESSION_EXPIRY = Duration.ofMinutes(30)
        private val ABSOLUTE_UPLOAD_LIMIT = Duration.ofHours(2)
        private val LEASE_DURATION = Duration.ofMinutes(2)
        private val INSPECTION_LIMIT = Duration.ofMinutes(5)
        private val ORPHAN_GRACE = Duration.ofHours(24)
        private const val HEARTBEAT_BYTES = 1024L * 1024
        private val REQUIREMENTS_CONTEXT_ID = UUID.fromString("00000000-0000-7000-8000-000000000014")
        private val ACTIVE_UPLOAD_PHASES = setOf(
            UploadSessionStatus.STREAMING, UploadSessionStatus.INSPECTING, UploadSessionStatus.SCANNING,
            UploadSessionStatus.PROMOTING,
        )
        private val LOG = LoggerFactory.getLogger(EvidenceService::class.java)
        private fun commandUuid(prefix: String, metadata: CommandMetadata) = UUID.nameUUIDFromBytes(
            "$prefix:${metadata.principalId}:${metadata.commandKey}:${metadata.idempotencyKey}".toByteArray(),
        )
    }
}

private class EvidenceStreamDisconnectedException(cause: IOException) : RuntimeException(cause)
