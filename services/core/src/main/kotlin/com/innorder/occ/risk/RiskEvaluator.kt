package com.innorder.occ.risk

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.DateTimeException
import java.time.Duration
import java.time.Instant
import java.util.Collections
import java.util.UUID

sealed interface RiskFactValues {
    data class CriticalWork(val dueAt: Instant, val critical: Boolean, val completedAt: Instant? = null) : RiskFactValues
    data object ConsecutiveReturns : RiskFactValues
    data class Inactivity(val lastActivityAt: Instant) : RiskFactValues
    data class Blocker(val blockedAt: Instant, val resolvedAt: Instant? = null) : RiskFactValues
    data class EvidenceFailure(val failed: Boolean) : RiskFactValues
    data class MissingEvidence(val critical: Boolean, val missing: Boolean) : RiskFactValues
    data class ResourceConflict(val startsAt: Instant) : RiskFactValues
}

class RiskEvaluationFacts(
    val targetEntityId: UUID,
    triggeringFactIds: List<UUID>,
    val values: RiskFactValues,
) {
    val triggeringFactIds: List<UUID> = Collections.unmodifiableList(triggeringFactIds.toList())

    init {
        require(triggeringFactIds.isNotEmpty()) { "at least one triggering fact is required" }
        require(triggeringFactIds.distinct().size == triggeringFactIds.size) { "triggering facts must be distinct" }
    }
}

class RiskDecision internal constructor(
    val occurrenceKey: String,
    val ruleDefinitionId: UUID,
    val packageId: String,
    val packageVersion: String,
    val ruleId: String,
    val targetEntityId: UUID,
    val severity: RiskSeverity,
    val reason: String,
    val dueAt: Instant,
    val ownerRelationship: String,
    val escalationSteps: List<EscalationStep>,
    val evaluatedAt: Instant,
    val detectedAt: Instant,
    val calendarVersion: String,
    val thresholdKind: ThresholdKind,
    triggeringFactIds: List<UUID>,
    val thresholdWindowIdentity: String,
    val factValues: RiskFactValues,
) {
    val triggeringFactIds: List<UUID> = Collections.unmodifiableList(triggeringFactIds.toList())
}

class RiskEvaluator {
    fun evaluate(rule: RiskRule, facts: RiskEvaluationFacts, at: Instant): RiskDecision? {
        val evaluation = evaluateTrigger(rule, facts, at) ?: return null
        val triggeringIds = evaluation.triggeringFactIds.sortedBy(UUID::toString)
        return RiskDecision(
            occurrenceKey = occurrenceKey(rule, facts.targetEntityId, triggeringIds, evaluation.windowIdentity),
            ruleDefinitionId = rule.ruleDefinitionId,
            packageId = rule.packageId,
            packageVersion = rule.packageVersion,
            ruleId = rule.ruleId,
            targetEntityId = facts.targetEntityId,
            severity = rule.severity,
            reason = evaluation.reason,
            dueAt = at.checkedPlus(rule.sla, "risk SLA"),
            ownerRelationship = rule.ownerRelationship,
            escalationSteps = rule.escalationSteps,
            evaluatedAt = at,
            detectedAt = at,
            calendarVersion = rule.calendar.version,
            thresholdKind = rule.thresholdKind,
            triggeringFactIds = triggeringIds,
            thresholdWindowIdentity = evaluation.windowIdentity,
            factValues = facts.values,
        )
    }

    private fun evaluateTrigger(rule: RiskRule, facts: RiskEvaluationFacts, at: Instant): TriggerEvaluation? {
        require(matches(rule.trigger, facts.values)) { "risk rule and fact values do not match" }
        return when (val trigger = rule.trigger) {
            RiskTrigger.OverdueCriticalWork -> (facts.values as RiskFactValues.CriticalWork).takeIf {
                it.critical && (it.completedAt == null || it.completedAt > at) && at >= it.dueAt
            }?.let { evaluation(facts, "OVERDUE_CRITICAL_WORK", "OVERDUE_CRITICAL_WORK|due=${it.dueAt}") }
            is RiskTrigger.ConsecutiveReturns -> (facts.values as RiskFactValues.ConsecutiveReturns).let {
                facts.triggeringFactIds.takeIf { ids -> ids.size >= trigger.threshold }?.let { ids ->
                    require(ids.size == trigger.threshold) { "return facts must identify the exact threshold crossing" }
                    val canonicalIds = ids.sortedBy(UUID::toString).joinToString(",")
                    TriggerEvaluation(
                        "CONSECUTIVE_RETURNS",
                        "CONSECUTIVE_RETURNS|threshold=${trigger.threshold}|facts=$canonicalIds",
                        ids,
                    )
                }
            }
            is RiskTrigger.Inactivity -> (facts.values as RiskFactValues.Inactivity).takeIf {
                at >= it.lastActivityAt.checkedPlus(Duration.ofDays(trigger.elapsedDays), "inactivity threshold")
            }?.let {
                val threshold = it.lastActivityAt.checkedPlus(Duration.ofDays(trigger.elapsedDays), "inactivity threshold")
                evaluation(facts, "INACTIVITY", "INACTIVITY|threshold=$threshold")
            }
            is RiskTrigger.BlockerAge -> (facts.values as RiskFactValues.Blocker).let {
                val threshold = rule.calendar.thresholdAfter(it.blockedAt, trigger.businessDays, rule.zone)
                it.takeIf { value -> (value.resolvedAt == null || value.resolvedAt > at) && at > threshold }
                    ?.let { evaluation(facts, "BLOCKER_AGE", "BLOCKER_AGE|threshold=$threshold") }
            }
            RiskTrigger.EvidenceFailure -> (facts.values as RiskFactValues.EvidenceFailure).takeIf { it.failed }
                ?.let { evaluation(facts, "EVIDENCE_FAILURE", "EVIDENCE_FAILURE|failed") }
            RiskTrigger.MissingCriticalEvidence -> (facts.values as RiskFactValues.MissingEvidence).takeIf {
                it.critical && it.missing
            }?.let { evaluation(facts, "MISSING_CRITICAL_EVIDENCE", "MISSING_CRITICAL_EVIDENCE|missing") }
            is RiskTrigger.ResourceConflict -> (facts.values as RiskFactValues.ResourceConflict).takeIf {
                it.startsAt >= at && it.startsAt <= at.checkedPlus(trigger.within, "conflict window")
            }?.let {
                evaluation(facts, "RESOURCE_CONFLICT", "RESOURCE_CONFLICT|starts=${it.startsAt}|within=${trigger.within}")
            }
        }
    }

    private fun matches(trigger: RiskTrigger, values: RiskFactValues): Boolean = when (trigger) {
        RiskTrigger.OverdueCriticalWork -> values is RiskFactValues.CriticalWork
        is RiskTrigger.ConsecutiveReturns -> values is RiskFactValues.ConsecutiveReturns
        is RiskTrigger.Inactivity -> values is RiskFactValues.Inactivity
        is RiskTrigger.BlockerAge -> values is RiskFactValues.Blocker
        RiskTrigger.EvidenceFailure -> values is RiskFactValues.EvidenceFailure
        RiskTrigger.MissingCriticalEvidence -> values is RiskFactValues.MissingEvidence
        is RiskTrigger.ResourceConflict -> values is RiskFactValues.ResourceConflict
    }

    private fun evaluation(facts: RiskEvaluationFacts, reason: String, window: String): TriggerEvaluation =
        TriggerEvaluation(reason, window, facts.triggeringFactIds)

    private fun occurrenceKey(
        rule: RiskRule,
        targetEntityId: UUID,
        triggeringFactIds: List<UUID>,
        thresholdWindowIdentity: String,
    ): String {
        val fields = listOf(
            "risk-occurrence-v2",
            rule.packageId,
            rule.packageVersion,
            rule.ruleDefinitionId.toString(),
            rule.ruleId,
            rule.calendar.version,
            targetEntityId.toString(),
            triggeringFactIds.joinToString(","),
            thresholdWindowIdentity,
        )
        val canonical = fields.joinToString(separator = "") { value ->
            "${value.toByteArray(StandardCharsets.UTF_8).size}:$value"
        }.toByteArray(StandardCharsets.UTF_8)
        return MessageDigest.getInstance("SHA-256").digest(canonical).joinToString("") { "%02x".format(it) }
    }

    private data class TriggerEvaluation(
        val reason: String,
        val windowIdentity: String,
        val triggeringFactIds: List<UUID>,
    )
}

private fun Instant.checkedPlus(duration: Duration, operation: String): Instant = try {
    plus(duration)
} catch (exception: DateTimeException) {
    throw IllegalArgumentException("$operation arithmetic overflow", exception)
} catch (exception: ArithmeticException) {
    throw IllegalArgumentException("$operation arithmetic overflow", exception)
}
