package com.innorder.occ.risk

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Duration
import java.time.Instant

sealed interface RiskFact {
    val targetId: String
    val factVersion: String

    data class CriticalWork(
        override val targetId: String,
        override val factVersion: String,
        val dueAt: Instant,
        val critical: Boolean,
        val completedAt: Instant? = null,
    ) : RiskFact

    data class Returns(override val targetId: String, override val factVersion: String, val consecutive: Int) : RiskFact
    data class Inactivity(override val targetId: String, override val factVersion: String, val lastActivityAt: Instant) : RiskFact
    data class Blocker(
        override val targetId: String,
        override val factVersion: String,
        val blockedAt: Instant,
        val resolvedAt: Instant? = null,
    ) : RiskFact
    data class EvidenceFailure(override val targetId: String, override val factVersion: String, val failed: Boolean) : RiskFact
    data class MissingEvidence(
        override val targetId: String,
        override val factVersion: String,
        val critical: Boolean,
        val missing: Boolean,
    ) : RiskFact
    data class ResourceConflict(override val targetId: String, override val factVersion: String, val startsAt: Instant) : RiskFact
}

data class RiskDecision(
    val occurrenceKey: String,
    val packageId: String,
    val packageVersion: String,
    val ruleId: String,
    val targetId: String,
    val severity: RiskSeverity,
    val sla: Duration,
    val ownerRelationship: String,
    val escalationSteps: List<EscalationStep>,
)

class RiskEvaluator {
    fun evaluate(rule: RiskRule, fact: RiskFact, at: Instant): RiskDecision? {
        require(fact.targetId.isNotBlank() && fact.factVersion.isNotBlank()) { "fact identity is required" }
        val occurrenceWindow = occurrenceWindow(rule, fact, at) ?: return null
        val canonical = canonical(rule, fact, occurrenceWindow)
        return RiskDecision(
            occurrenceKey = sha256(canonical),
            packageId = rule.packageId,
            packageVersion = rule.packageVersion,
            ruleId = rule.ruleId,
            targetId = fact.targetId,
            severity = rule.severity,
            sla = rule.sla,
            ownerRelationship = rule.ownerRelationship,
            escalationSteps = rule.escalationSteps,
        )
    }

    private fun occurrenceWindow(rule: RiskRule, fact: RiskFact, at: Instant): String? = when (val trigger = rule.trigger) {
        RiskTrigger.OverdueCriticalWork -> (fact as? RiskFact.CriticalWork)?.takeIf {
            it.critical && it.completedAt == null && at >= it.dueAt
        }?.let { "due:${it.dueAt}" }
        is RiskTrigger.ConsecutiveReturns -> (fact as? RiskFact.Returns)?.takeIf {
            it.consecutive >= trigger.threshold
        }?.let { "returns:${trigger.threshold}" }
        is RiskTrigger.Inactivity -> (fact as? RiskFact.Inactivity)?.takeIf {
            at >= it.lastActivityAt.plus(Duration.ofDays(trigger.elapsedDays))
        }?.let { "inactive:${it.lastActivityAt.plus(Duration.ofDays(trigger.elapsedDays))}" }
        is RiskTrigger.BlockerAge -> (fact as? RiskFact.Blocker)?.takeIf {
            it.resolvedAt == null && at > rule.calendar.thresholdAfter(it.blockedAt, trigger.businessDays, rule.zone)
        }?.let { "blocked:${rule.calendar.thresholdAfter(it.blockedAt, trigger.businessDays, rule.zone)}" }
        RiskTrigger.EvidenceFailure -> (fact as? RiskFact.EvidenceFailure)?.takeIf { it.failed }?.let { "failed" }
        RiskTrigger.MissingCriticalEvidence -> (fact as? RiskFact.MissingEvidence)?.takeIf {
            it.critical && it.missing
        }?.let { "missing" }
        is RiskTrigger.ResourceConflict -> (fact as? RiskFact.ResourceConflict)?.takeIf {
            it.startsAt >= at && it.startsAt <= at.plus(trigger.within)
        }?.let { "conflict:${it.startsAt}" }
    }

    private fun canonical(rule: RiskRule, fact: RiskFact, window: String): ByteArray {
        val triggerData = when (val trigger = rule.trigger) {
            RiskTrigger.OverdueCriticalWork -> "OVERDUE_CRITICAL_WORK"
            is RiskTrigger.ConsecutiveReturns -> "CONSECUTIVE_RETURNS:${trigger.threshold}"
            is RiskTrigger.Inactivity -> "INACTIVITY:${trigger.elapsedDays}"
            is RiskTrigger.BlockerAge -> "BLOCKER_AGE:${trigger.businessDays}"
            RiskTrigger.EvidenceFailure -> "EVIDENCE_FAILURE"
            RiskTrigger.MissingCriticalEvidence -> "MISSING_CRITICAL_EVIDENCE"
            is RiskTrigger.ResourceConflict -> "RESOURCE_CONFLICT:${trigger.within}"
        }
        val factData = when (fact) {
            is RiskFact.CriticalWork -> "CRITICAL_WORK:${fact.dueAt}:${fact.critical}:${fact.completedAt}"
            is RiskFact.Returns -> "RETURNS:${fact.consecutive}"
            is RiskFact.Inactivity -> "INACTIVITY:${fact.lastActivityAt}"
            is RiskFact.Blocker -> "BLOCKER:${fact.blockedAt}:${fact.resolvedAt}"
            is RiskFact.EvidenceFailure -> "EVIDENCE_FAILURE:${fact.failed}"
            is RiskFact.MissingEvidence -> "MISSING_EVIDENCE:${fact.critical}:${fact.missing}"
            is RiskFact.ResourceConflict -> "RESOURCE_CONFLICT:${fact.startsAt}"
        }
        val escalationData = rule.escalationSteps.joinToString(";") { "${it.after}:${it.ownerRelationship}" }
        val holidayData = rule.calendar.holidays.sorted().joinToString(",")
        val fields = listOf(
            "risk-occurrence-v1", rule.packageId, rule.packageVersion, rule.ruleId,
            rule.severity.name, rule.sla.toString(), rule.ownerRelationship, escalationData,
            rule.thresholdKind.name, rule.zone.id, rule.calendar.version, holidayData, triggerData,
            fact.targetId, fact.factVersion, factData, window,
        )
        return fields.joinToString(separator = "") { value -> "${value.toByteArray(StandardCharsets.UTF_8).size}:$value" }
            .toByteArray(StandardCharsets.UTF_8)
    }

    private fun sha256(value: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(value)
        .joinToString("") { "%02x".format(it) }
}
