package com.innorder.occ.events

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.command.CommandMetadata
import com.innorder.occ.command.CommandMutation
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.util.UUID

@Repository
class OutboxRepository(
    private val jdbc: JdbcTemplate,
    private val mapper: ObjectMapper,
) {
    fun insert(metadata: CommandMetadata, transactionId: UUID, mutation: CommandMutation) {
        check(TransactionSynchronizationManager.isActualTransactionActive()) { "Outbox repository requires a transaction" }
        mutation.events.forEach { event ->
            jdbc.update(
                """INSERT INTO audit.outbox_event
                   (id, customer_instance_id, aggregate_type, aggregate_id, aggregate_version,
                    event_type, schema_version, payload, actor_entity_id, correlation_id, causation_id,
                    available_at, next_attempt_at, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, statement_timestamp(), statement_timestamp(), 'PENDING')""",
                UUID.randomUUID(), DEFAULT_CUSTOMER_INSTANCE_ID, mutation.aggregateType, mutation.aggregateId,
                event.aggregateVersion, event.eventType, event.schemaVersion, mapper.writeValueAsString(event.payload),
                metadata.principalId, metadata.correlationId, transactionId,
            )
        }
    }

    companion object {
        val DEFAULT_CUSTOMER_INSTANCE_ID: UUID = UUID.fromString("00000000-0000-7000-8000-000000000001")
    }
}
