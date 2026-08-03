package com.innorder.occ.authz

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate

@Repository
class DecisionLogRepository(
    @Qualifier("jdbcTemplate") private val jdbc: JdbcTemplate,
    private val audit: AuditDatabase,
    private val mapper: ObjectMapper,
) : DecisionAuditLog {
    override fun persistInCallerTransaction(entry: DecisionLogEntry) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) throw AuthorizationAvailabilityException()
        insert(jdbc, entry, independent = false)
    }

    override fun persistIndependently(entry: DecisionLogEntry) {
        val requiresNew = TransactionTemplate(audit.transactionManager).apply {
            propagationBehavior = TransactionDefinition.PROPAGATION_REQUIRES_NEW
            timeout = 2
        }
        try {
            requiresNew.executeWithoutResult { insert(audit.jdbc, entry, independent = true) }
        } catch (_: RuntimeException) {
            throw AuthorizationAvailabilityException()
        }
    }

    private fun insert(target: JdbcTemplate, entry: DecisionLogEntry, independent: Boolean) {
        validate(entry)
        target.update(
            """INSERT INTO authz.decision_log
               (id, request_id, correlation_id, policy_release_id, authorization_revision,
                principal_entity_id, action_key, resource_entity_id, resource_ref, decision,
                reason_codes, matched_policies, entity_versions, context_digest, result_digest, latency_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?, ?)""",
            entry.id,
            entry.requestId,
            entry.correlationId,
            entry.policyReleaseId,
            entry.authorizationRevision,
            entry.principalEntityId,
            entry.action,
            if (independent) null else entry.resourceEntityId,
            if (independent) entry.resourceEntityId?.toString() else null,
            entry.decision.name,
            mapper.writeValueAsString(entry.reasonCodes),
            mapper.writeValueAsString(entry.matchedPolicyIds),
            mapper.writeValueAsString(entry.entityVersions.mapKeys { it.key.toString() }.toSortedMap()),
            entry.contextDigest,
            entry.resultDigest,
            entry.latencyMs,
        )
    }

    private fun validate(entry: DecisionLogEntry) {
        if (entry.authorizationRevision < 0 || entry.action.length !in 1..128 ||
            !ACTION.matches(entry.action) || entry.reasonCodes.size > 128 || entry.matchedPolicyIds.size > 256 ||
            entry.reasonCodes.any { it.length !in 1..128 || !REASON_CODE.matches(it) } ||
            entry.reasonCodes.toSet().size != entry.reasonCodes.size ||
            entry.matchedPolicyIds.any { !OPAQUE_REFERENCE.matches(it) } ||
            entry.matchedPolicyIds.toSet().size != entry.matchedPolicyIds.size ||
            entry.entityVersions.size > 3 || entry.entityVersions.values.any { it < 0 } ||
            !DIGEST.matches(entry.contextDigest) || !DIGEST.matches(entry.resultDigest) || entry.latencyMs < 0
        ) throw AuthorizationAvailabilityException()
    }

    companion object {
        private val ACTION = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]*${'$'}")
        private val REASON_CODE = Regex("^[A-Z][A-Z0-9_]*${'$'}")
        private val OPAQUE_REFERENCE = Regex("^(grant|policy):[0-9a-f]{64}${'$'}")
        private val DIGEST = Regex("^[0-9a-f]{64}${'$'}")
    }
}
