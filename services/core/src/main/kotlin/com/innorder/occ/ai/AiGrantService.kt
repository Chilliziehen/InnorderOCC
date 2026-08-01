package com.innorder.occ.ai

import org.springframework.jdbc.core.JdbcOperations
import org.springframework.stereotype.Repository
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.dao.DataIntegrityViolationException
import com.innorder.occ.command.IdempotencyConflictException
import com.innorder.occ.command.InvalidIdempotencyKeyException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.sql.ResultSet
import java.sql.Timestamp
import java.time.Clock
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID

data class AiGrantCreationRequest(
    val eventId: UUID,
    val operationId: UUID,
    val principalId: UUID,
    val targetId: UUID,
    val authorizationRevision: Long,
    val policyReleaseId: UUID,
    val policyReleaseDigest: String,
    val classificationCeiling: String,
    val agentVersionId: UUID,
    val modelProfileId: UUID,
    val promptVersionId: UUID,
    val packageVersionId: UUID,
    val embeddingSpaceId: UUID,
    val documentVersionIds: List<UUID>,
    val taskContext: ByteArray,
)

data class AuthorizationSnapshotBinding(val revision: Long, val policyReleaseDigest: String)

data class StoredAiGrant(
    val id: UUID,
    val tokenHash: String,
    val claims: AiGrantClaims,
    val policyReleaseId: UUID,
    val boundedContext: String,
)

data class AiGrantClaimResponse(val operationId: UUID, val grantToken: String)
data class AiGrantCreated(val operationId: UUID)

interface AiGrantStore {
    fun lockAuthorizationSnapshot(policyReleaseId: UUID): AuthorizationSnapshotBinding
    fun insert(record: StoredAiGrant, documentVersionIds: List<UUID>)
    fun findByOperationId(operationId: UUID): StoredAiGrant?
    fun bindClaimIdempotency(grantId: UUID, keyHash: String)
}

@Repository
class JdbcAiGrantStore(private val jdbc: JdbcOperations) : AiGrantStore {
    override fun lockAuthorizationSnapshot(policyReleaseId: UUID): AuthorizationSnapshotBinding =
        jdbc.queryForObject(
            """SELECT state.current_revision, release.content_hash
               FROM authz.authorization_state state
               JOIN authz.policy_release release ON release.id = ?
               WHERE state.singleton AND release.status = 'ACTIVE'
               FOR SHARE OF state, release""",
            { rs, _ -> AuthorizationSnapshotBinding(rs.getLong(1), rs.getString(2)) },
            policyReleaseId,
        ) ?: throw AiGrantInvalidException()

    override fun insert(record: StoredAiGrant, documentVersionIds: List<UUID>) {
        val c = record.claims
        jdbc.update(
            """INSERT INTO authz.ai_authorization_grant
               (id, token_hash, operation, jti, principal_id, target_entity_id, purpose,
                authorization_revision, policy_release_id, policy_release_digest, authorized_set_digest,
                context_digest, bounded_context, classification_ceiling, agent_version_id, model_profile_id,
                prompt_version_id, package_version_id, embedding_space_id, issued_at, expires_at, event_id,
                intended_run_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?,?,?,?,?,?,?,?)""",
            record.id, record.tokenHash, c.operationId.toString(), c.jti.toString(), c.principalId, c.targetId,
            c.purpose, c.authorizationRevision, record.policyReleaseId, c.policyReleaseDigest,
            c.authorizedSetDigest, c.contextDigest, record.boundedContext, c.classificationCeiling,
            c.agentVersionId, c.modelProfileId, c.promptVersionId, c.packageVersionId, c.embeddingSpaceId,
            Timestamp.from(c.issuedAt), Timestamp.from(c.expiresAt), c.eventId, c.operationId,
        )
        documentVersionIds.forEach { documentId ->
            jdbc.update(
                "INSERT INTO authz.ai_authorized_document(grant_id, document_version_id) VALUES (?, ?)",
                record.id, documentId,
            )
        }
    }

    override fun findByOperationId(operationId: UUID): StoredAiGrant? = jdbc.query(
        """SELECT id, token_hash, jti, event_id, operation, principal_id, target_entity_id, purpose,
                  authorization_revision, policy_release_id, policy_release_digest, authorized_set_digest,
                  context_digest, bounded_context::text, classification_ceiling, agent_version_id,
                  model_profile_id, prompt_version_id, package_version_id, embedding_space_id,
                  issued_at, expires_at
           FROM authz.ai_authorization_grant WHERE intended_run_id = ? FOR UPDATE""",
        { rs, _ -> mapGrant(rs, operationId) }, operationId,
    ).singleOrNull()

    override fun bindClaimIdempotency(grantId: UUID, keyHash: String) {
        try {
            val boundId = jdbc.queryForObject(
                "SELECT authz.bind_ai_grant_claim_idempotency(?, ?)", UUID::class.java,
                findOperationId(grantId), keyHash,
            )
            if (boundId != grantId) throw AiGrantIntegrityException()
        } catch (_: DataIntegrityViolationException) {
            throw IdempotencyConflictException()
        }
    }

    private fun findOperationId(grantId: UUID): UUID = jdbc.queryForObject(
        "SELECT intended_run_id FROM authz.ai_authorization_grant WHERE id = ?", UUID::class.java, grantId,
    ) ?: throw AiGrantInvalidException()

    private fun mapGrant(rs: ResultSet, operationId: UUID): StoredAiGrant = StoredAiGrant(
        id = rs.getObject("id", UUID::class.java),
        tokenHash = rs.getString("token_hash"),
        claims = AiGrantClaims(
            jti = UUID.fromString(rs.getString("jti")), eventId = rs.getObject("event_id", UUID::class.java),
            operationId = operationId, principalId = rs.getObject("principal_id", UUID::class.java),
            targetId = rs.getObject("target_entity_id", UUID::class.java), purpose = rs.getString("purpose"),
            authorizationRevision = rs.getLong("authorization_revision"),
            policyReleaseDigest = rs.getString("policy_release_digest"),
            authorizedSetDigest = rs.getString("authorized_set_digest"), contextDigest = rs.getString("context_digest"),
            classificationCeiling = rs.getString("classification_ceiling"),
            agentVersionId = rs.getObject("agent_version_id", UUID::class.java),
            modelProfileId = rs.getObject("model_profile_id", UUID::class.java),
            promptVersionId = rs.getObject("prompt_version_id", UUID::class.java),
            packageVersionId = rs.getObject("package_version_id", UUID::class.java),
            embeddingSpaceId = rs.getObject("embedding_space_id", UUID::class.java),
            issuedAt = rs.getTimestamp("issued_at").toInstant(), expiresAt = rs.getTimestamp("expires_at").toInstant(),
        ),
        policyReleaseId = rs.getObject("policy_release_id", UUID::class.java),
        boundedContext = rs.getString("bounded_context"),
    )
}

@Service
@ConditionalOnProperty(prefix = "occ.ai.grant", name = ["enabled"], havingValue = "true")
class AiGrantService(
    private val store: AiGrantStore,
    private val tokens: AiGrantTokenService,
    private val clock: Clock,
) {
    @Transactional
    fun create(request: AiGrantCreationRequest): AiGrantCreated {
        val documents = AuthorizedAiGrantDocuments(request.documentVersionIds)
        val context = CanonicalTaskContext.parse(request.taskContext)
        val snapshot = store.lockAuthorizationSnapshot(request.policyReleaseId)
        if (snapshot.revision != request.authorizationRevision || snapshot.policyReleaseDigest != request.policyReleaseDigest) {
            throw AiGrantStaleException()
        }
        val issuedAt = clock.instant().truncatedTo(ChronoUnit.SECONDS)
        val claims = AiGrantClaims(
            jti = UUID.randomUUID(), eventId = request.eventId, operationId = request.operationId,
            principalId = request.principalId, targetId = request.targetId, purpose = "PARTICIPANT_GUIDANCE",
            authorizationRevision = request.authorizationRevision, policyReleaseDigest = request.policyReleaseDigest,
            authorizedSetDigest = documents.digest, contextDigest = context.digest,
            classificationCeiling = request.classificationCeiling, agentVersionId = request.agentVersionId,
            modelProfileId = request.modelProfileId, promptVersionId = request.promptVersionId,
            packageVersionId = request.packageVersionId, embeddingSpaceId = request.embeddingSpaceId,
            issuedAt = issuedAt, expiresAt = tokens.expiration(issuedAt),
        )
        val token = tokens.issue(claims)
        store.insert(StoredAiGrant(UUID.randomUUID(), tokens.sha256(token), claims, request.policyReleaseId, context.text), documents.ids)
        return AiGrantCreated(request.operationId)
    }

    @Transactional
    fun claim(operationId: UUID, idempotencyKey: String): AiGrantClaimResponse {
        if (!IDEMPOTENCY_KEY.matches(idempotencyKey)) throw InvalidIdempotencyKeyException()
        val record = store.findByOperationId(operationId) ?: throw AiGrantInvalidException()
        val snapshot = store.lockAuthorizationSnapshot(record.policyReleaseId)
        if (snapshot.revision != record.claims.authorizationRevision ||
            snapshot.policyReleaseDigest != record.claims.policyReleaseDigest) throw AiGrantStaleException()
        if (clock.instant() >= record.claims.expiresAt) throw AiGrantExpiredException()
        store.bindClaimIdempotency(record.id, sha256(idempotencyKey))
        val token = tokens.issue(record.claims)
        if (tokens.sha256(token) != record.tokenHash) throw AiGrantIntegrityException()
        return AiGrantClaimResponse(operationId, token)
    }

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(StandardCharsets.US_ASCII)).joinToString("") { "%02x".format(it) }

    private companion object {
        val IDEMPOTENCY_KEY = Regex("^[!-~]{1,128}${'$'}")
    }
}

class AiGrantInvalidException : RuntimeException("OCC-AI-GRANT-INVALID")
class AiGrantStaleException : RuntimeException("OCC-AI-GRANT-STALE")
class AiGrantExpiredException : RuntimeException("OCC-AI-GRANT-EXPIRED")
class AiGrantIntegrityException : RuntimeException("OCC-AI-GRANT-INTEGRITY")
