package com.innorder.occ.risk

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import java.math.BigDecimal
import java.time.Instant
import java.time.LocalDate
import java.util.Collections
import java.util.UUID

enum class RiskState { OPEN, ACKNOWLEDGED, RESOLVED, DISMISSED }
enum class RiskActionType { ACKNOWLEDGED, ASSIGNED, ESCALATED, MITIGATED, SLA_BREACHED, RESOLVED, DISMISSED }
enum class RiskSlaStatus { OVERDUE, DUE, NOT_DUE, NONE }
enum class RiskAdjudicationOutcome { TRUE_POSITIVE, FALSE_POSITIVE, MISSED, NOT_APPLICABLE }

data class RiskRecord(
    val id: UUID,
    val ruleDefinitionId: UUID,
    val targetEntityId: UUID,
    val occurrenceKey: String,
    val severity: RiskSeverity,
    val state: RiskState,
    val reason: String,
    val dueAt: Instant?,
    val ownerRelationshipId: UUID?,
    val lastEscalationLevel: Int?,
    val rowVersion: Long,
)

data class RiskActionRecord(
    val id: UUID,
    val riskId: UUID,
    val actorId: UUID,
    val type: RiskActionType,
    val escalationLevel: Int?,
    val reason: String?,
    val actedAt: Instant,
)

data class DueRiskEscalation(
    val riskId: UUID,
    val targetEntityId: UUID,
    val level: Int?,
    val dueAt: Instant,
    val ownerRelationshipId: UUID?,
    val severityKey: String?,
)

data class RiskQueueFilters(
    val severities: Set<RiskSeverity> = setOf(RiskSeverity.YELLOW, RiskSeverity.RED),
    val states: Set<RiskState> = setOf(RiskState.OPEN, RiskState.ACKNOWLEDGED),
    val slaStatus: RiskSlaStatus? = null,
    val targetEntityId: UUID? = null,
    val ownerRelationshipId: UUID? = null,
) {
    init {
        if (severities.isEmpty() || states.isEmpty()) throw InvalidRiskRequestException()
    }
}

data class RiskQueueItem(
    val id: UUID,
    val targetEntityId: UUID,
    val severity: RiskSeverity,
    val state: RiskState,
    val reason: String?,
    val dueAt: Instant?,
    val ownerRelationshipId: UUID?,
    val rowVersion: Long,
)

data class RiskQueuePage(val items: List<RiskQueueItem>, val nextCursor: String?)

@JsonIgnoreProperties(ignoreUnknown = false)
data class RiskAdjudicationRequest(
    val reportingPeriodStart: LocalDate,
    val reportingPeriodEnd: LocalDate,
    val knownEventKey: String,
    val targetEntityId: UUID,
    val severeEvent: Boolean,
    val riskId: UUID?,
    val outcome: RiskAdjudicationOutcome,
    val reason: String,
) {
    init {
        if (reportingPeriodEnd <= reportingPeriodStart || knownEventKey.length !in 1..256 ||
            reason.length !in 1..1024
        ) throw InvalidRiskRequestException()
        if (outcome in setOf(RiskAdjudicationOutcome.MISSED, RiskAdjudicationOutcome.NOT_APPLICABLE) && riskId != null) {
            throw InvalidRiskRequestException()
        }
        if (outcome in setOf(RiskAdjudicationOutcome.TRUE_POSITIVE, RiskAdjudicationOutcome.FALSE_POSITIVE) && riskId == null) {
            throw InvalidRiskRequestException()
        }
    }
}

data class RiskAdjudicationRecord(
    val id: UUID,
    val knownEventKey: String,
    val targetEntityId: UUID,
    val version: Int,
    val outcome: RiskAdjudicationOutcome,
    val supersedesId: UUID?,
)

data class RiskMetrics(
    val severeMisses: Long,
    val falsePositiveCount: Long,
    val adjudicatedSignificantRiskCount: Long,
    val falsePositiveRate: BigDecimal,
)

class RiskNotificationIntent(
    val eventId: UUID,
    val actorId: UUID,
    val correlationId: UUID,
    val causationId: UUID,
    val ownerRelationshipId: UUID,
    val type: String,
    val severity: RiskSeverity,
    val resourceId: UUID,
    templateData: Map<String, String>,
) {
    val templateData: Map<String, String> = Collections.unmodifiableMap(templateData.toMap())
}

fun interface RiskNotificationPort {
    fun emit(intent: RiskNotificationIntent)
}

class RiskNotFoundException : RuntimeException("Risk was not found")
class TerminalRiskException : RuntimeException("Terminal risk rejects actions")
class InvalidRiskActionException : RuntimeException("Risk action is invalid")
class InvalidRiskRequestException : RuntimeException("Risk request is invalid")
class EscalationLevelConflictException(val riskId: UUID, val level: Int) :
    RuntimeException("Risk escalation level already exists")
