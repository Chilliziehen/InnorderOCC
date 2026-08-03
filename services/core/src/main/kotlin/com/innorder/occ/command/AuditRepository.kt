package com.innorder.occ.command

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.util.UUID

@Repository
class AuditRepository(
    private val jdbc: JdbcTemplate,
) {
    private val mapper = ObjectMapper().findAndRegisterModules()

    internal fun detail(mutation: CommandMutation): CanonicalJsonObject {
        val detail = mutation.auditDetail.toJsonNode()
        if (detail.has(AFFECTED_AGGREGATES)) throw InvalidCommandRequestException()
        detail.putArray(AFFECTED_AGGREGATES).also { affected ->
            mutation.changes.sortedWith(compareBy({ it.ref.type }, { it.ref.id.toString() })).forEach { change ->
                affected.add(mapper.createObjectNode().apply {
                    put("type", change.ref.type)
                    put("id", change.ref.id.toString())
                    put("beforeVersion", change.beforeVersion)
                    put("afterVersion", change.afterVersion)
                })
            }
        }
        return CanonicalJsonObject.from(detail, CommandExecutor.MAX_AUDIT_BYTES)
    }

    fun insert(
        transactionId: UUID,
        correlationId: UUID,
        descriptor: CommandDescriptor,
        mutation: CommandMutation,
        detail: CanonicalJsonObject,
    ) {
        check(TransactionSynchronizationManager.isActualTransactionActive()) { "Audit repository requires a transaction" }
        val primary = mutation.changes.single { it.ref == AggregateReference(descriptor.aggregateType, descriptor.aggregateId) }
        jdbc.update(
            """INSERT INTO audit.audit_record
               (id, transaction_id, actor_entity_id, action_key, target_entity_id, before_version,
                after_version, reason, detail, correlation_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)""",
            UUID.randomUUID(), transactionId, descriptor.principalId, descriptor.action, mutation.resourceId,
            primary.beforeVersion, primary.afterVersion, mutation.auditReason,
            detail.canonicalText(), correlationId,
        )
    }

    private companion object {
        const val AFFECTED_AGGREGATES = "affectedAggregates"
    }
}
