package com.innorder.occ.evidence

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.events.EventPayloadPolicy
import org.springframework.jdbc.core.JdbcOperations
import org.springframework.stereotype.Component
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.util.UUID

data class DomainNotificationIntent(
    val id: UUID,
    val eventId: UUID,
    val evidenceId: UUID,
    val recipientSelector: String,
    val type: String,
    val payload: Map<String, String>,
    val correlationId: UUID,
)

fun interface DomainNotificationPort {
    fun dispatch(intent: DomainNotificationIntent)
}

/** Marker contract for a notification sink that rejects or commits in the caller transaction. */
interface TransactionalDomainNotificationPort : DomainNotificationPort

@Component
class EvidenceDomainNotificationPort(private val jdbc: JdbcOperations) {
    fun persist(intent: DomainNotificationIntent) {
        check(TransactionSynchronizationManager.isActualTransactionActive()) { "Notification intent requires a transaction" }
        val payload = MAPPER.valueToTree<com.fasterxml.jackson.databind.JsonNode>(intent.payload)
        EventPayloadPolicy.validate(payload)
        jdbc.update(
            """INSERT INTO occ.evidence_notification_intent
               (id, event_id, evidence_id, recipient_selector, notification_type, payload, correlation_id)
               VALUES (?, ?, ?, ?, ?, ?::jsonb, ?) ON CONFLICT (event_id, recipient_selector) DO NOTHING""",
            intent.id, intent.eventId, intent.evidenceId, intent.recipientSelector, intent.type,
            MAPPER.writeValueAsString(payload), intent.correlationId,
        )
    }

    private companion object { val MAPPER = ObjectMapper().findAndRegisterModules() }
}
