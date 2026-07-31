package com.innorder.occ.command

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.util.UUID

@Repository
class AuditRepository(
    private val jdbc: JdbcTemplate,
    private val mapper: ObjectMapper,
) {
    fun insert(
        transactionId: UUID,
        metadata: CommandMetadata,
        action: String,
        mutation: CommandMutation,
    ) {
        check(TransactionSynchronizationManager.isActualTransactionActive()) { "Audit repository requires a transaction" }
        jdbc.update(
            """INSERT INTO audit.audit_record
               (id, transaction_id, actor_entity_id, action_key, target_entity_id, before_version,
                after_version, reason, detail, correlation_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)""",
            UUID.randomUUID(), transactionId, metadata.principalId, action, mutation.resourceId,
            mutation.beforeVersion, mutation.afterVersion, mutation.auditReason,
            mapper.writeValueAsString(mutation.auditDetail), metadata.correlationId,
        )
    }
}
