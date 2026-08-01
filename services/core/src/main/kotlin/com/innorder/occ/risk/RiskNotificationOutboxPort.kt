package com.innorder.occ.risk

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.command.CanonicalJsonObject
import com.innorder.occ.events.EventPayloadPolicy
import com.innorder.occ.events.OutboxRepository
import org.springframework.jdbc.core.JdbcOperations
import org.springframework.stereotype.Component
import org.springframework.transaction.support.TransactionSynchronizationManager

@Component
class RiskNotificationOutboxPort(private val jdbc: JdbcOperations) : RiskNotificationPort {
    override fun emit(intent: RiskNotificationIntent) {
        check(TransactionSynchronizationManager.isActualTransactionActive()) {
            "Risk notification intent requires a transaction"
        }
        val payload = CanonicalJsonObject.from(MAPPER.createObjectNode().apply {
            put("eventId", intent.eventId.toString())
            put("recipientRelationshipId", intent.ownerRelationshipId.toString())
            put("type", intent.type)
            put("severity", intent.severity.name)
            put("resourceId", intent.resourceId.toString())
            put("resourcePath", "/api/v1/risks/${intent.resourceId}")
            set<com.fasterxml.jackson.databind.JsonNode>("templateData", MAPPER.valueToTree(intent.templateData))
        })
        EventPayloadPolicy.validate(payload.toJsonNode())
        jdbc.update(
            """INSERT INTO audit.outbox_event
               (id, customer_instance_id, aggregate_type, aggregate_id, aggregate_version,
                event_type, schema_version, payload, actor_entity_id, correlation_id, causation_id,
                available_at, next_attempt_at, status)
               VALUES (?, ?, 'notification-intent', ?, 0, 'notification.intent', 1, ?::jsonb,
                       ?, ?, ?, statement_timestamp(), statement_timestamp(), 'PENDING')""",
            intent.eventId, OutboxRepository.DEFAULT_CUSTOMER_INSTANCE_ID, intent.eventId, payload.canonicalText(),
            intent.actorId, intent.correlationId, intent.causationId,
        )
    }

    private companion object {
        val MAPPER = ObjectMapper().findAndRegisterModules()
    }
}
