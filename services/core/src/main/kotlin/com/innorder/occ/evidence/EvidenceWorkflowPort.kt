package com.innorder.occ.evidence

import org.springframework.jdbc.core.JdbcOperations
import org.springframework.stereotype.Component
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.sql.Timestamp
import java.time.Instant
import java.util.UUID

data class EvidenceWorkflowIntent(
    val id: UUID,
    val eventId: UUID,
    val evidenceId: UUID,
    val evidenceVersion: Int,
    val type: String,
    val reviewOutcome: EvidenceReviewOutcome?,
    val gateSatisfied: Boolean,
    val followUpRequired: Boolean,
    val followUpDueAt: Instant?,
    val priorAssigneeId: UUID?,
    val correlationId: UUID,
)

fun interface EvidenceWorkflowPort {
    fun persist(intent: EvidenceWorkflowIntent)
}

/** Transactional adapter boundary. A separate delivery adapter may claim these rows and call Flowable. */
@Component
class EvidenceWorkflowIntentPort(private val jdbc: JdbcOperations) : EvidenceWorkflowPort {
    override fun persist(intent: EvidenceWorkflowIntent) {
        check(TransactionSynchronizationManager.isActualTransactionActive()) { "Workflow intent requires a transaction" }
        jdbc.update(
            """INSERT INTO occ.evidence_workflow_intent
               (id, event_id, evidence_id, evidence_version, intent_type, review_outcome, gate_satisfied,
                follow_up_required, follow_up_due_at, prior_assignee_id, correlation_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            intent.id, intent.eventId, intent.evidenceId, intent.evidenceVersion, intent.type,
            intent.reviewOutcome?.name, intent.gateSatisfied, intent.followUpRequired,
            intent.followUpDueAt?.let(Timestamp::from), intent.priorAssigneeId, intent.correlationId,
        )
    }
}
