package com.innorder.occ.evidence

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.jdbc.core.JdbcOperations
import org.springframework.stereotype.Repository
import java.sql.ResultSet
import java.sql.Timestamp
import java.time.Instant
import java.util.UUID

data class EvidenceHeadRecord(
    val id: UUID, val targetId: UUID, val requirementId: UUID, val slotKey: String,
    val state: EvidenceState, val currentVersion: Int?, val rowVersion: Long, val createdBy: UUID,
    val createdAt: Instant, val updatedAt: Instant,
)

data class EvidenceSessionRecord(
    val id: UUID, val uploaderId: UUID, val targetId: UUID, val requirementId: UUID, val evidenceId: UUID,
    val slotKey: String, val fileName: String, val extension: String, val expectedSha256: String,
    val expectedSize: Long, val expectedEvidenceVersion: Long, val quarantineKey: String,
    val immutableKey: String, val status: UploadSessionStatus, val expiresAt: Instant,
    val absoluteDeadline: Instant, val leaseOwner: UUID?, val leaseExpiresAt: Instant?,
    val actualSha256: String?, val actualSize: Long?, val detectedMediaType: String?, val failureCode: String?,
    val createdAt: Instant, val rowVersion: Long, val contentIdempotencyKey: String? = null,
    val contentRequestHash: String? = null,
)

data class RequirementRecord(val id: UUID, val code: String, val policy: EvidenceRequirementPolicy)
data class DownloadRecord(
    val key: String, val mediaType: String, val size: Long, val fileName: String, val sha256: String,
    val evidenceVersion: Int,
)
data class EvidenceCleanupLease(val id: UUID, val objectKey: String, val owner: UUID)
data class EvidencePreviewObject(val key: String, val mediaType: String, val size: Long)

@Repository
class EvidenceRepository(private val jdbc: JdbcOperations) {
    private val mapper = ObjectMapper().findAndRegisterModules()

    fun transactionTime(): Instant = requireNotNull(
        jdbc.queryForObject("SELECT transaction_timestamp()", Timestamp::class.java),
    ).toInstant()

    fun requirement(id: UUID): RequirementRecord = jdbc.query(
        "SELECT id,requirement_key,validation_schema::text FROM catalog.evidence_requirement WHERE id = ?",
        { row, _ -> RequirementRecord(
            row.getObject(1, UUID::class.java), row.getString(2), EvidenceRequirementPolicy.parse(mapper.readTree(row.getString(3))),
        ) }, id,
    ).singleOrNull() ?: throw InvalidEvidenceRequirementException()

    fun requirements(afterId: UUID?, limit: Int): List<RequirementRecord> = jdbc.query(
        """SELECT id,requirement_key,validation_schema::text FROM catalog.evidence_requirement
           WHERE (?::uuid IS NULL OR id>?) ORDER BY id LIMIT ?""",
        { row, _ -> RequirementRecord(
            row.getObject(1, UUID::class.java), row.getString(2), EvidenceRequirementPolicy.parse(mapper.readTree(row.getString(3))),
        ) }, afterId, afterId, limit,
    )

    fun findHead(targetId: UUID, requirementId: UUID, slotKey: String): EvidenceHeadRecord? = jdbc.query(
        "SELECT * FROM occ.evidence WHERE target_entity_id=? AND requirement_id=? AND slot_key=?",
        ::head, targetId, requirementId, slotKey,
    ).singleOrNull()

    fun getHead(id: UUID): EvidenceHeadRecord = jdbc.query("SELECT * FROM occ.evidence WHERE id=?", ::head, id)
        .singleOrNull() ?: throw EvidenceNotFoundException()

    fun lockHead(id: UUID): EvidenceHeadRecord = jdbc.query("SELECT * FROM occ.evidence WHERE id=? FOR UPDATE", ::head, id)
        .singleOrNull() ?: throw EvidenceNotFoundException()

    fun createHead(id: UUID, targetId: UUID, requirementId: UUID, slotKey: String, actorId: UUID) {
        val inserted = jdbc.update(
            """INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state, created_by)
               SELECT ?, type.id, version.id, ?, 'ACTIVE', ?
               FROM catalog.evidence_requirement requirement
               JOIN catalog.package_version package_version ON package_version.id=requirement.package_version_id
               JOIN catalog.entity_type type ON type.package_id=package_version.package_id AND type.type_key='evidence'
               JOIN catalog.entity_type_version version ON version.entity_type_id=type.id AND version.package_version_id=package_version.id
               WHERE requirement.id=?""",
            id, "evidence-$id", actorId, requirementId,
        )
        if (inserted != 1) throw InvalidEvidenceRequirementException()
        jdbc.update(
            """INSERT INTO occ.evidence
               (id, business_object_id, requirement_id, state, created_by, target_entity_id, slot_key, row_version)
               VALUES (?, ?, ?, 'PENDING', ?, ?, ?, 1)""",
            id, targetId, requirementId, actorId, targetId, slotKey,
        )
    }

    // Opening an upload session changes the evidence aggregate, so its row
    // version advances through the shared touch trigger.
    fun advanceHead(id: UUID): EvidenceHeadRecord {
        check(jdbc.update("UPDATE occ.evidence SET state = state WHERE id = ?", id) == 1)
        return getHead(id)
    }

    fun createSession(record: EvidenceSessionRecord) {
        jdbc.update(
            """INSERT INTO occ.upload_session
               (id,uploader_id,target_entity_id,object_key,expected_sha256,expected_size_bytes,status,expires_at,
                requirement_id,evidence_id,slot_key,expected_evidence_version,original_filename,normalized_extension,
                quarantine_object_key,immutable_object_key,absolute_deadline_at,created_at)
               VALUES (?,?,?,?,?,?,'CREATED',?,?,?,?,?,?,?,?,?,?,?)""",
            record.id, record.uploaderId, record.targetId, record.quarantineKey, record.expectedSha256,
            record.expectedSize, Timestamp.from(record.expiresAt), record.requirementId, record.evidenceId,
            record.slotKey, record.expectedEvidenceVersion, record.fileName, record.extension,
            record.quarantineKey, record.immutableKey, Timestamp.from(record.absoluteDeadline),
            Timestamp.from(record.expiresAt.minus(java.time.Duration.ofMinutes(30))),
        )
    }

    fun session(id: UUID, lock: Boolean = false): EvidenceSessionRecord = jdbc.query(
        "SELECT * FROM occ.upload_session WHERE id=?${if (lock) " FOR UPDATE" else ""}", ::session, id,
    ).singleOrNull() ?: throw EvidenceSessionNotFoundException()

    fun bindContentCommand(id: UUID, idempotencyKey: String, requestHash: String): EvidenceSessionRecord {
        val current = session(id, true)
        if (current.contentIdempotencyKey == null) {
            jdbc.update(
                "UPDATE occ.upload_session SET content_idempotency_key=?,content_request_hash=? WHERE id=?",
                idempotencyKey, requestHash, id,
            )
            return session(id)
        }
        if (current.contentIdempotencyKey != idempotencyKey || current.contentRequestHash != requestHash) {
            throw EvidenceUploadConflictException()
        }
        return current
    }

    fun acquireLease(id: UUID, owner: UUID, now: Instant, leaseUntil: Instant): EvidenceSessionRecord {
        val current = session(id, true)
        if (current.status == UploadSessionStatus.CONFIRMED) return current
        if (current.status == UploadSessionStatus.CREATED && !now.isBefore(current.expiresAt)) {
            jdbc.update("UPDATE occ.upload_session SET status='EXPIRED' WHERE id=?", id)
            return session(id)
        }
        if (current.status in setOf(UploadSessionStatus.FAILED, UploadSessionStatus.EXPIRED) || !now.isBefore(current.absoluteDeadline)) {
            throw EvidenceUploadConflictException()
        }
        if (current.status != UploadSessionStatus.CREATED && current.status !in ACTIVE_UPLOAD_PHASES) {
            throw EvidenceUploadConflictException()
        }
        if (current.status in ACTIVE_UPLOAD_PHASES && current.leaseExpiresAt?.isAfter(now) == true) {
            throw EvidenceUploadConflictException()
        }
        jdbc.update(
            """UPDATE occ.upload_session SET status='STREAMING', lease_owner=?, lease_acquired_at=?,
               lease_heartbeat_at=?, lease_expires_at=? WHERE id=?""",
            owner, Timestamp.from(now), Timestamp.from(now), Timestamp.from(leaseUntil), id,
        )
        return session(id)
    }

    fun heartbeat(id: UUID, owner: UUID, at: Instant, leaseUntil: Instant) {
        if (jdbc.update(
                """UPDATE occ.upload_session SET lease_heartbeat_at=?, lease_expires_at=?
                   WHERE id=? AND lease_owner=? AND status IN ('STREAMING','INSPECTING','SCANNING','PROMOTING')""",
                Timestamp.from(at), Timestamp.from(leaseUntil), id, owner,
            ) != 1
        ) throw EvidenceUploadConflictException()
    }

    fun inspecting(id: UUID) {
        requireUpdated(jdbc.update("UPDATE occ.upload_session SET status='INSPECTING' WHERE id=? AND status='STREAMING'", id))
    }

    fun scanned(id: UUID, inspected: InspectedEvidence) {
        requireUpdated(jdbc.update(
            """UPDATE occ.upload_session SET status='SCANNING', actual_sha256=?, actual_size_bytes=?, detected_media_type=?,
               scanner_engine=?, scanner_version=?, scanner_result_ref=? WHERE id=? AND status='INSPECTING'""",
            inspected.sha256, inspected.sizeBytes, inspected.detectedMediaType, inspected.scannerResult.engine,
            inspected.scannerResult.engineVersion, inspected.scannerResult.reference, id,
        ))
    }

    fun promoting(id: UUID) {
        requireUpdated(jdbc.update("UPDATE occ.upload_session SET status='PROMOTING' WHERE id=? AND status='SCANNING'", id))
    }

    fun fail(id: UUID, code: String, cleanupAfter: Instant, objectExists: Boolean) {
        val record = session(id, true)
        if (record.status in setOf(UploadSessionStatus.CONFIRMED, UploadSessionStatus.FAILED, UploadSessionStatus.EXPIRED)) return
        jdbc.update("UPDATE occ.upload_session SET status='FAILED', failure_code=?, cleanup_after=? WHERE id=?", code.take(128), Timestamp.from(cleanupAfter), id)
        if (objectExists) jdbc.update(
            """INSERT INTO occ.evidence_object_disposition
               (id, upload_session_id, object_key, disposition_state, retained_until)
               VALUES (?, ?, ?, 'CLEANUP_PENDING', ?) ON CONFLICT DO NOTHING""",
            UUID.randomUUID(), id, record.quarantineKey, Timestamp.from(cleanupAfter),
        )
    }

    fun recordFailureOnHead(id: UUID): EvidenceHeadRecord {
        requireUpdated(jdbc.update("UPDATE occ.evidence SET updated_at=updated_at WHERE id=?", id))
        return getHead(id)
    }

    fun recordOrphan(sessionId: UUID, key: String, cleanupAfter: Instant) {
        jdbc.update(
            """INSERT INTO occ.evidence_object_disposition
               (id,upload_session_id,object_key,disposition_state,retained_until)
               VALUES (?,?,?,'CLEANUP_PENDING',?) ON CONFLICT DO NOTHING""",
            UUID.randomUUID(), sessionId, key, Timestamp.from(cleanupAfter),
        )
    }

    fun confirm(
        session: EvidenceSessionRecord, inspected: InspectedEvidence, preview: EvidencePreviewObject?,
        sourceCleanup: SourceCleanupDisposition,
    ): EvidenceVersion {
        lockObjectKey(session.immutableKey)
        preview?.let { lockObjectKey(it.key) }
        val head = lockHead(session.evidenceId)
        if (head.rowVersion != session.expectedEvidenceVersion) throw com.innorder.occ.command.OptimisticConflictException(head.rowVersion)
        val version = (head.currentVersion ?: 0) + 1
        val versionId = UUID.randomUUID()
        jdbc.update(
            """INSERT INTO occ.evidence_version
               (id,evidence_id,version,object_key,sha256,mime_type,size_bytes,submitted_by,upload_session_id,
                  detected_media_type,normalized_extension,scanner_engine,scanner_version,scanner_result,scanner_result_ref,
                  preview_object_key,preview_media_type,preview_size_bytes,preview_generated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'CLEAN',?,?,?,?,
                         CASE WHEN ?::text IS NULL THEN NULL ELSE transaction_timestamp() END)""",
            versionId, session.evidenceId, version, session.immutableKey, inspected.sha256, inspected.detectedMediaType,
            inspected.sizeBytes, session.uploaderId, session.id, inspected.detectedMediaType, inspected.extension,
            inspected.scannerResult.engine, inspected.scannerResult.engineVersion, inspected.scannerResult.reference,
            preview?.key, preview?.mediaType, preview?.size, preview?.key,
        )
        jdbc.update("UPDATE occ.evidence SET current_version=?, state='PENDING' WHERE id=?", version, session.evidenceId)
        jdbc.update(
            """INSERT INTO occ.evidence_object_disposition
               (id,evidence_version_id,upload_session_id,object_key,disposition_state)
               VALUES (?,?,?,?,'RETAINED')""",
            UUID.randomUUID(), versionId, session.id, session.immutableKey,
        )
        if (sourceCleanup == SourceCleanupDisposition.SWEEP_REQUIRED) jdbc.update(
            """INSERT INTO occ.evidence_object_disposition
                (id,upload_session_id,object_key,disposition_state,retained_until)
                VALUES (?,?,?,'CLEANUP_PENDING',statement_timestamp()+interval '24 hours')""",
            UUID.randomUUID(), session.id, session.quarantineKey,
        )
        jdbc.update("UPDATE occ.upload_session SET status='CONFIRMED' WHERE id=?", session.id)
        return versionById(versionId)
    }

    fun versionForSession(sessionId: UUID): EvidenceVersion = jdbc.query(
        "SELECT * FROM occ.evidence_version WHERE upload_session_id=?", ::version, sessionId,
    ).singleOrNull() ?: throw EvidenceSessionNotFoundException()

    fun versionById(id: UUID): EvidenceVersion = jdbc.query("SELECT * FROM occ.evidence_version WHERE id=?", ::version, id)
        .singleOrNull() ?: throw EvidenceNotFoundException()

    fun submit(id: UUID, evidenceVersion: Int) {
        val head = lockHead(id)
        if (head.currentVersion != evidenceVersion) throw EvidenceSubmitConflictException()
        requireUpdated(jdbc.update("UPDATE occ.evidence SET state='SUBMITTED' WHERE id=? AND state IN ('PENDING','REJECTED')", id))
    }

    fun lockRequirementHeads(targetId: UUID, requirementId: UUID): List<EvidenceHeadRecord> = jdbc.query(
        "SELECT * FROM occ.evidence WHERE target_entity_id=? AND requirement_id=? ORDER BY id FOR UPDATE",
        ::head, targetId, requirementId,
    )

    fun review(
        head: EvidenceHeadRecord, reviewerId: UUID, request: EvidenceReviewRequest, gate: Boolean, followUpDueAt: Instant?,
    ): EvidenceReview {
        if (head.state != EvidenceState.SUBMITTED || head.currentVersion == null) throw EvidenceReviewConflictException()
        if (head.currentVersion != request.evidenceVersion) throw EvidenceReviewConflictException()
        val version = jdbc.queryForMap(
            "SELECT id,submitted_by FROM occ.evidence_version WHERE evidence_id=? AND version=?", head.id, head.currentVersion,
        )
        if (reviewerId == head.createdBy || reviewerId == version["submitted_by"]) throw EvidenceReviewSegregationException()
        val id = UUID.randomUUID()
        jdbc.update(
            """INSERT INTO occ.evidence_review
               (id,evidence_version_id,reviewer_id,decision,reason,conditions,follow_up_due_at,gate_satisfied)
               VALUES (?,?,?,?,?,?::jsonb,?,?)""",
            id, version["id"], reviewerId, request.decision.name, boundedReason(request.reason),
            mapper.writeValueAsString(request.conditions ?: emptyList<EvidenceReviewCondition>()), followUpDueAt?.let(Timestamp::from), gate,
        )
        val state = when (request.decision) {
            EvidenceReviewOutcome.ACCEPTED -> "ACCEPTED"
            EvidenceReviewOutcome.REJECTED -> "REJECTED"
            EvidenceReviewOutcome.CONDITIONAL -> if (gate) "ACCEPTED" else "REJECTED"
        }
        jdbc.update("UPDATE occ.evidence SET state=? WHERE id=?", state, head.id)
        return reviewById(id)
    }

    fun acceptedCount(targetId: UUID, requirementId: UUID, currentId: UUID, currentAccepted: Boolean): Int =
        jdbc.queryForObject(
            """SELECT count(*) FROM occ.evidence WHERE target_entity_id=? AND requirement_id=?
               AND ((id=? AND ?) OR (id<>? AND state='ACCEPTED'))""",
            Int::class.java, targetId, requirementId, currentId, currentAccepted, currentId,
        ) ?: 0

    fun versions(id: UUID, afterVersion: Int?, limit: Int): List<EvidenceVersion> = jdbc.query(
        """SELECT * FROM occ.evidence_version WHERE evidence_id=? AND (?::integer IS NULL OR version>?)
           ORDER BY version LIMIT ?""", ::version, id, afterVersion, afterVersion, limit,
    )

    fun reviews(id: UUID, afterReviewedAt: Instant?, afterId: UUID?, limit: Int): List<EvidenceReview> = jdbc.query(
        """SELECT er.*,ev.evidence_id,ev.version AS evidence_version FROM occ.evidence_review er
           JOIN occ.evidence_version ev ON ev.id=er.evidence_version_id WHERE ev.evidence_id=?
             AND (?::timestamptz IS NULL OR (er.reviewed_at,er.id)>(?,?)) ORDER BY er.reviewed_at,er.id LIMIT ?""",
        ::review, id, afterReviewedAt?.let(Timestamp::from), afterReviewedAt?.let(Timestamp::from), afterId, limit,
    )

    fun reviewById(id: UUID): EvidenceReview = jdbc.query(
        """SELECT er.*,ev.evidence_id,ev.version AS evidence_version FROM occ.evidence_review er
           JOIN occ.evidence_version ev ON ev.id=er.evidence_version_id WHERE er.id=?""", ::review, id,
    ).singleOrNull() ?: throw EvidenceNotFoundException()

    fun download(id: UUID, version: Int): DownloadRecord = jdbc.query(
        """SELECT ev.object_key,ev.detected_media_type,ev.size_bytes,us.original_filename,ev.sha256,ev.version
           FROM occ.evidence_version ev JOIN occ.evidence_object_disposition d ON d.evidence_version_id=ev.id
           JOIN occ.upload_session us ON us.id=ev.upload_session_id
           WHERE ev.evidence_id=? AND ev.version=? AND d.disposition_state='RETAINED'""",
        { row, _ -> DownloadRecord(row.getString(1), row.getString(2), row.getLong(3), row.getString(4), row.getString(5), row.getInt(6)) }, id, version,
    ).singleOrNull() ?: throw EvidenceNotFoundException()

    fun previewMetadata(id: UUID, version: Int): EvidencePreviewMetadata = jdbc.query(
        """SELECT evidence_id,version,preview_media_type,preview_size_bytes,preview_generated_at
           FROM occ.evidence_version WHERE evidence_id=? AND version=? AND preview_object_key IS NOT NULL""",
        { row, _ -> EvidencePreviewMetadata(
            row.getObject(1, UUID::class.java), row.getInt(2), row.getString(3), row.getLong(4), row.getTimestamp(5).toInstant(),
        ) }, id, version,
    ).singleOrNull() ?: throw EvidenceNotFoundException()

    fun claimCleanup(owner: UUID, now: Instant, leaseUntil: Instant, limit: Int): List<EvidenceCleanupLease> {
        val candidates = jdbc.query(
            """SELECT disposition.id,disposition.object_key
               FROM occ.evidence_object_disposition disposition
               JOIN occ.upload_session upload ON upload.id=disposition.upload_session_id
               JOIN occ.evidence evidence ON evidence.id=upload.evidence_id
               WHERE disposition.evidence_version_id IS NULL
                 AND disposition.disposition_state IN ('CLEANUP_PENDING','DELETE_FAILED','DELETING')
                 AND (disposition.disposition_state<>'DELETING' OR disposition.cleanup_lease_expires_at<=?)
                 AND disposition.retained_until<=?
                 AND disposition.legal_hold_at IS NULL AND disposition.backup_snapshot_id IS NULL
                 AND evidence.legal_hold_at IS NULL
               ORDER BY disposition.retained_until,disposition.id
               FOR UPDATE OF disposition SKIP LOCKED LIMIT ?""",
            { row, _ -> EvidenceCleanupLease(row.getObject(1, UUID::class.java), row.getString(2), owner) },
            Timestamp.from(now), Timestamp.from(now), limit,
        )
        candidates.forEach { candidate ->
            jdbc.update(
                """UPDATE occ.evidence_object_disposition SET disposition_state='DELETING',cleanup_lease_owner=?,
                   cleanup_lease_expires_at=?,cleanup_attempts=cleanup_attempts+1,cleanup_last_error=NULL WHERE id=?""",
                owner, Timestamp.from(leaseUntil), candidate.id,
            )
        }
        return candidates
    }

    fun lockCleanupEligibility(lease: EvidenceCleanupLease, now: Instant): Boolean {
        lockObjectKey(lease.objectKey)
        return jdbc.query(
            """SELECT disposition.id FROM occ.evidence_object_disposition disposition
               JOIN occ.upload_session upload ON upload.id=disposition.upload_session_id
               JOIN occ.evidence evidence ON evidence.id=upload.evidence_id
               WHERE disposition.id=? AND disposition.object_key=? AND disposition.evidence_version_id IS NULL
                 AND disposition.disposition_state='DELETING' AND disposition.cleanup_lease_owner=?
                 AND disposition.cleanup_lease_expires_at>? AND disposition.retained_until<=?
                 AND disposition.legal_hold_at IS NULL AND disposition.backup_snapshot_id IS NULL
                 AND evidence.legal_hold_at IS NULL
               FOR UPDATE OF disposition,evidence""",
            { row, _ -> row.getObject(1, UUID::class.java) },
            lease.id, lease.objectKey, lease.owner, Timestamp.from(now), Timestamp.from(now),
        ).isNotEmpty()
    }

    fun cleanupDeleted(lease: EvidenceCleanupLease, at: Instant) {
        requireUpdated(jdbc.update(
            """UPDATE occ.evidence_object_disposition SET disposition_state='DELETED',deleted_at=?,
               cleanup_lease_owner=NULL,cleanup_lease_expires_at=NULL WHERE id=? AND cleanup_lease_owner=? AND disposition_state='DELETING'""",
            Timestamp.from(at), lease.id, lease.owner,
        ))
    }

    fun cleanupFailed(lease: EvidenceCleanupLease, error: String) {
        jdbc.update(
            """UPDATE occ.evidence_object_disposition SET disposition_state='DELETE_FAILED',cleanup_last_error=?,
               cleanup_lease_owner=NULL,cleanup_lease_expires_at=NULL WHERE id=? AND cleanup_lease_owner=? AND disposition_state='DELETING'""",
            error.take(1024), lease.id, lease.owner,
        )
    }

    fun lockUnreferencedObject(key: String): Boolean {
        lockObjectKey(key)
        return jdbc.queryForObject(
            """SELECT NOT EXISTS (
                 SELECT 1 FROM occ.evidence_object_disposition d
                 WHERE d.object_key=? AND d.disposition_state<>'DELETED'
                 UNION ALL
                 SELECT 1 FROM occ.evidence_version v
                 WHERE v.object_key=? OR v.preview_object_key=?
                 UNION ALL
                 SELECT 1 FROM occ.upload_session u JOIN occ.evidence e ON e.id=u.evidence_id
                 WHERE (u.quarantine_object_key=? OR u.immutable_object_key=?)
                   AND (u.status NOT IN ('FAILED','EXPIRED') OR e.legal_hold_at IS NOT NULL)
               )""",
            Boolean::class.java, key, key, key, key, key,
        ) == true
    }

    private fun lockObjectKey(key: String) {
        jdbc.queryForObject(
            "SELECT pg_advisory_xact_lock(hashtextextended(?,1163284055)) IS NULL",
            Boolean::class.java, key,
        )
    }

    private fun head(row: ResultSet, ignored: Int) = EvidenceHeadRecord(
        row.getObject("id", UUID::class.java), row.getObject("target_entity_id", UUID::class.java),
        row.getObject("requirement_id", UUID::class.java), row.getString("slot_key"), enumValueOf(row.getString("state")),
        row.getObject("current_version") as Int?, row.getLong("row_version"), row.getObject("created_by", UUID::class.java),
        row.getTimestamp("created_at").toInstant(), row.getTimestamp("updated_at").toInstant(),
    )

    private fun session(row: ResultSet, ignored: Int) = EvidenceSessionRecord(
        row.getObject("id", UUID::class.java), row.getObject("uploader_id", UUID::class.java),
        row.getObject("target_entity_id", UUID::class.java), row.getObject("requirement_id", UUID::class.java),
        row.getObject("evidence_id", UUID::class.java), row.getString("slot_key"), row.getString("original_filename"),
        row.getString("normalized_extension"), row.getString("expected_sha256"), row.getLong("expected_size_bytes"),
        row.getLong("expected_evidence_version"), row.getString("quarantine_object_key"), row.getString("immutable_object_key"),
        enumValueOf(row.getString("status")), row.getTimestamp("expires_at").toInstant(),
        row.getTimestamp("absolute_deadline_at").toInstant(), row.getObject("lease_owner", UUID::class.java),
        row.getTimestamp("lease_expires_at")?.toInstant(), row.getString("actual_sha256"),
        row.getObject("actual_size_bytes") as Long?, row.getString("detected_media_type"), row.getString("failure_code"),
        row.getTimestamp("created_at").toInstant(), row.getLong("row_version"), row.getString("content_idempotency_key"),
        row.getString("content_request_hash"),
    )

    private fun version(row: ResultSet, ignored: Int) = EvidenceVersion(
        row.getObject("id", UUID::class.java), row.getObject("evidence_id", UUID::class.java), row.getInt("version"),
        row.getObject("upload_session_id", UUID::class.java), row.getString("sha256"), row.getString("detected_media_type"),
        row.getString("normalized_extension"), row.getLong("size_bytes"), row.getTimestamp("submitted_at").toInstant(),
    )

    private fun review(row: ResultSet, ignored: Int) = EvidenceReview(
        row.getObject("id", UUID::class.java), row.getObject("evidence_id", UUID::class.java), row.getInt("evidence_version"),
        enumValueOf(row.getString("decision")), row.getString("reason"),
        mapper.readValue(row.getString("conditions"), mapper.typeFactory.constructCollectionType(List::class.java, EvidenceReviewCondition::class.java)),
        row.getTimestamp("follow_up_due_at")?.toInstant(), row.getBoolean("gate_satisfied"), row.getTimestamp("reviewed_at").toInstant(),
    )

    private fun boundedReason(value: String): String {
        if (value.length !in 1..1024 || value.any(Char::isISOControl)) throw InvalidEvidenceRequestException()
        return value
    }

    private fun requireUpdated(count: Int) { if (count != 1) throw EvidenceStateConflictException() }

    private companion object {
        val ACTIVE_UPLOAD_PHASES = setOf(
            UploadSessionStatus.STREAMING, UploadSessionStatus.INSPECTING, UploadSessionStatus.SCANNING,
            UploadSessionStatus.PROMOTING,
        )
    }
}
