package com.innorder.occ.notification

import org.springframework.jdbc.core.JdbcOperations
import org.springframework.stereotype.Repository
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.util.UUID

data class PendingNotificationSpec(
    val recipientId: UUID,
    val type: String,
    val severity: String,
    val resourceType: String,
    val resourceId: UUID,
    val eventType: String,
)

fun interface NotificationWriter {
    fun write(spec: PendingNotificationSpec, eventId: UUID)
}

object NoOpNotificationWriter : NotificationWriter {
    override fun write(spec: PendingNotificationSpec, eventId: UUID) = Unit
}

@Repository
class JdbcNotificationWriter(private val jdbc: JdbcOperations) : NotificationWriter {
    override fun write(spec: PendingNotificationSpec, eventId: UUID) {
        check(TransactionSynchronizationManager.isActualTransactionActive())
        jdbc.update(
            """INSERT INTO occ.notification
               (id, recipient_id, type, severity, resource_type, resource_id, event_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (recipient_id, event_id, type) DO NOTHING""",
            UUID.randomUUID(), spec.recipientId, spec.type, spec.severity,
            spec.resourceType, spec.resourceId, eventId,
        )
    }
}
