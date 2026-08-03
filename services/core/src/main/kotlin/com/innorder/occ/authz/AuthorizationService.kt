package com.innorder.occ.authz

import com.fasterxml.jackson.databind.MapperFeature
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.security.MessageDigest
import java.util.Collections
import java.util.UUID
import kotlin.math.min

@Service
class AuthorizationService(
    private val snapshots: AuthorizationSnapshotSource,
    private val decisions: PolicyDecisionClient,
    private val auditLog: DecisionAuditLog,
) {
    private val canonicalMapper = ObjectMapper().findAndRegisterModules().apply {
        setConfig(serializationConfig.with(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY))
    }
        .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)

    fun authorize(request: AuthorizationRequest): AuthorizationDecisionReference {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) throw AuthorizationAvailabilityException()
        val started = System.nanoTime()
        val snapshot = try {
            snapshots.load(request)
        } catch (_: RuntimeException) {
            throw AuthorizationAvailabilityException()
        }
        val decision = try {
            decisions.decide(snapshot)
        } catch (_: RuntimeException) {
            val error = errorEntry(request, snapshot, started)
            auditLog.persistIndependently(error)
            throw AuthorizationAvailabilityException()
        }
        if (!matchesSnapshot(decision, snapshot)) {
            auditLog.persistIndependently(errorEntry(request, snapshot, started))
            throw AuthorizationAvailabilityException()
        }

        val entry = entry(request, snapshot, decision, started)
        return when (decision.decision) {
            AuthorizationDecisionValue.ALLOW -> {
                auditLog.persistInCallerTransaction(entry)
                AuthorizationDecisionReference(
                    decision.requestId,
                    decision.authorizationRevision,
                    Collections.unmodifiableMap(decision.releases.toMap()),
                    Collections.unmodifiableList(decision.matchedPolicyIds.toList()),
                )
            }
            AuthorizationDecisionValue.DENY -> {
                auditLog.persistIndependently(entry)
                throw AuthorizationDeniedException()
            }
            AuthorizationDecisionValue.ERROR -> {
                auditLog.persistIndependently(errorEntry(request, snapshot, started))
                throw AuthorizationAvailabilityException()
            }
        }
    }

    private fun matchesSnapshot(decision: AuthorizationDecision, snapshot: AuthorizationSnapshot): Boolean =
        decision.contractVersion == snapshot.contractVersion &&
            decision.opaRevision == snapshot.opaRevision &&
            decision.requestId == snapshot.requestId &&
            decision.authorizationRevision == snapshot.authorizationRevision &&
            decision.releases == snapshot.releases &&
            decision.allow == (decision.decision == AuthorizationDecisionValue.ALLOW)

    private fun entry(
        request: AuthorizationRequest,
        snapshot: AuthorizationSnapshot,
        decision: AuthorizationDecision,
        started: Long,
    ) = DecisionLogEntry(
        UUID.randomUUID(), request.requestId, request.correlationId, snapshot.composedReleaseId,
        snapshot.authorizationRevision, request.principalId, request.action, request.resourceId,
        decision.decision, decision.reasonCodes.toList(), decision.matchedPolicyIds.toList(),
        snapshot.entityVersions.toMap(), snapshot.contextDigest, digest(decision), latency(started),
    )

    private fun errorEntry(
        request: AuthorizationRequest,
        snapshot: AuthorizationSnapshot,
        started: Long,
    ) = DecisionLogEntry(
        UUID.randomUUID(), request.requestId, request.correlationId, snapshot.composedReleaseId,
        snapshot.authorizationRevision, request.principalId, request.action, request.resourceId,
        AuthorizationDecisionValue.ERROR, listOf("AUTHORIZATION_INTEGRITY_ERROR"),
        listOf(ERROR_POLICY_REFERENCE), snapshot.entityVersions.toMap(), snapshot.contextDigest,
        digest(mapOf("outcome" to "ERROR", "policy" to ERROR_POLICY_REFERENCE)), latency(started),
    )

    private fun digest(value: Any): String = MessageDigest.getInstance("SHA-256")
        .digest(canonicalMapper.writeValueAsBytes(value))
        .joinToString("") { "%02x".format(it) }

    private fun latency(started: Long): Int = min(Int.MAX_VALUE.toLong(), (System.nanoTime() - started) / 1_000_000).toInt()

    companion object {
        private const val ERROR_POLICY_REFERENCE =
            "policy:f588c3bf56f52a87833e48bec0932820d831012c74c2d191f652dd76237c24e2"
    }
}
