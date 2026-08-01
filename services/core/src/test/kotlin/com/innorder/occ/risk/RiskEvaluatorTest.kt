package com.innorder.occ.risk

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.time.Instant

class RiskEvaluatorTest {
    private val evaluator = RiskEvaluator()

    @Test
    fun `strict package rule parses immutable governance metadata and sealed triggers`() {
        val rule = rule(
            """{"type":"CONSECUTIVE_RETURNS"}""",
            extra = """"severity":"RED","sla":"PT4H","ownerRelationship":"TEACHER","escalationSteps":[{"after":"PT2H","ownerRelationship":"PROGRAM_LEAD"}],"thresholdKind":"ELAPSED"""",
        )

        assertThat(rule.packageId).isEqualTo("embedded-medical-device-pilot")
        assertThat(rule.packageVersion).isEqualTo("1.0.0")
        assertThat(rule.severity).isEqualTo(RiskSeverity.RED)
        assertThat(rule.sla).isEqualTo(java.time.Duration.ofHours(4))
        assertThat(rule.ownerRelationship).isEqualTo("TEACHER")
        assertThat(rule.escalationSteps.single().ownerRelationship).isEqualTo("PROGRAM_LEAD")
        assertThat(rule.thresholdKind).isEqualTo(ThresholdKind.ELAPSED)
        assertThat(rule.zone.id).isEqualTo("Europe/Amsterdam")
        assertThat(rule.calendar.version).isEqualTo("nl-school-2026-v1")
        assertThat(rule.trigger).isEqualTo(RiskTrigger.ConsecutiveReturns(2))

        assertThatThrownBy {
            RiskRule.parse(ruleJson("""{"type":"EVIDENCE_FAILURE","unexpected":true}"""))
        }.isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `overdue critical work triggers exactly at due instant only while open and critical`() {
        val rule = rule("""{"type":"OVERDUE_CRITICAL_WORK"}""")
        val due = Instant.parse("2026-06-01T10:00:00Z")

        assertThat(evaluate(rule, RiskFact.CriticalWork("task-1", "work-v1", due, true), due.minusNanos(1))).isNull()
        assertThat(evaluate(rule, RiskFact.CriticalWork("task-1", "work-v1", due, true), due)).isNotNull()
        assertThat(evaluate(rule, RiskFact.CriticalWork("task-1", "work-v1", due, false), due)).isNull()
        assertThat(evaluate(rule, RiskFact.CriticalWork("task-1", "work-v1", due, true, due), due)).isNull()
    }

    @Test
    fun `consecutive returns defaults to two and triggers at exact threshold`() {
        val rule = rule("""{"type":"CONSECUTIVE_RETURNS"}""")

        assertThat(evaluate(rule, RiskFact.Returns("submission-1", "review-v1", 1), NOW)).isNull()
        assertThat(evaluate(rule, RiskFact.Returns("submission-1", "review-v2", 2), NOW)).isNotNull()
    }

    @Test
    fun `inactivity defaults to seven elapsed days across daylight saving time`() {
        val rule = rule("""{"type":"INACTIVITY"}""")
        val lastActivity = Instant.parse("2026-03-22T09:00:00Z")
        val threshold = lastActivity.plus(java.time.Duration.ofDays(7))

        assertThat(evaluate(rule, RiskFact.Inactivity("process-1", "activity-v1", lastActivity), threshold.minusNanos(1))).isNull()
        assertThat(evaluate(rule, RiskFact.Inactivity("process-1", "activity-v1", lastActivity), threshold)).isNotNull()
        assertThat(threshold.atZone(rule.zone).hour).isEqualTo(11)
    }

    @Test
    fun `blocker triggers only after two business days excluding weekend and package holiday`() {
        val rule = rule(
            """{"type":"BLOCKER_AGE"}""",
            extra = """"severity":"YELLOW","sla":"PT8H","ownerRelationship":"TEACHER","escalationSteps":[],"thresholdKind":"BUSINESS"""",
        )
        val blocked = Instant.parse("2026-04-02T08:00:00Z") // Thursday 10:00 Amsterdam
        val exactTwoBusinessDays = Instant.parse("2026-04-07T08:00:00Z") // Friday + Tuesday; Monday is holiday

        assertThat(evaluate(rule, RiskFact.Blocker("task-1", "blocker-v1", blocked), exactTwoBusinessDays)).isNull()
        assertThat(evaluate(rule, RiskFact.Blocker("task-1", "blocker-v1", blocked), exactTwoBusinessDays.plusNanos(1))).isNotNull()
        assertThat(evaluate(rule, RiskFact.Blocker("task-1", "blocker-v1", blocked, exactTwoBusinessDays), exactTwoBusinessDays.plusNanos(1))).isNull()
    }

    @Test
    fun `evidence failure and missing critical evidence trigger immediately`() {
        val failureRule = rule("""{"type":"EVIDENCE_FAILURE"}""")
        val missingRule = rule("""{"type":"MISSING_CRITICAL_EVIDENCE"}""")

        assertThat(evaluate(failureRule, RiskFact.EvidenceFailure("evidence-1", "scan-v1", true), NOW)).isNotNull()
        assertThat(evaluate(failureRule, RiskFact.EvidenceFailure("evidence-1", "scan-v1", false), NOW)).isNull()
        assertThat(evaluate(missingRule, RiskFact.MissingEvidence("task-1", "requirement-v1", true, true), NOW)).isNotNull()
        assertThat(evaluate(missingRule, RiskFact.MissingEvidence("task-1", "requirement-v1", true, false), NOW)).isNull()
    }

    @Test
    fun `resource conflict triggers from now through exact twenty four hour boundary`() {
        val rule = rule("""{"type":"RESOURCE_CONFLICT"}""")

        assertThat(evaluate(rule, RiskFact.ResourceConflict("reservation-1", "conflict-v1", NOW.minusNanos(1)), NOW)).isNull()
        assertThat(evaluate(rule, RiskFact.ResourceConflict("reservation-1", "conflict-v1", NOW.plus(java.time.Duration.ofHours(24))), NOW)).isNotNull()
        assertThat(evaluate(rule, RiskFact.ResourceConflict("reservation-1", "conflict-v1", NOW.plus(java.time.Duration.ofHours(24)).plusNanos(1)), NOW)).isNull()
    }

    @Test
    fun `occurrence key is canonical stable and package version sensitive`() {
        val fact = RiskFact.Returns("submission-1", "review-v2", 2)
        val first = evaluate(rule("""{"type":"CONSECUTIVE_RETURNS"}"""), fact, NOW)!!
        val repeated = evaluate(rule("""{"type":"CONSECUTIVE_RETURNS"}"""), fact, NOW.plusSeconds(60))!!
        val newFact = evaluate(rule("""{"type":"CONSECUTIVE_RETURNS"}"""), fact.copy(factVersion = "review-v3"), NOW)!!
        val newPackage = evaluate(rule("""{"type":"CONSECUTIVE_RETURNS"}"""), fact, NOW, packageVersion = "1.0.1")!!

        assertThat(first.occurrenceKey).matches("^[0-9a-f]{64}${'$'}")
        assertThat(repeated.occurrenceKey).isEqualTo(first.occurrenceKey)
        assertThat(newFact.occurrenceKey).isNotEqualTo(first.occurrenceKey)
        assertThat(newPackage.occurrenceKey).isNotEqualTo(first.occurrenceKey)
    }

    private fun evaluate(
        rule: RiskRule,
        fact: RiskFact,
        at: Instant,
        packageVersion: String? = null,
    ): RiskDecision? {
        val effectiveRule = if (packageVersion == null) rule else RiskRule.parse(
            ruleJson(rule.trigger.toJson(), packageVersion),
        )
        return evaluator.evaluate(effectiveRule, fact, at)
    }

    private fun rule(trigger: String, extra: String = DEFAULT_METADATA): RiskRule =
        RiskRule.parse(ruleJson(trigger, extra = extra))

    private fun ruleJson(
        trigger: String,
        packageVersion: String = "1.0.0",
        extra: String = DEFAULT_METADATA,
    ): String = """{"packageId":"embedded-medical-device-pilot","packageVersion":"$packageVersion","ruleId":"risk-rule-1",$extra,"zone":"Europe/Amsterdam","calendar":{"version":"nl-school-2026-v1","holidays":["2026-04-06"]},"trigger":$trigger}"""

    private fun RiskTrigger.toJson(): String = when (this) {
        is RiskTrigger.ConsecutiveReturns -> """{"type":"CONSECUTIVE_RETURNS","threshold":$threshold}"""
        else -> error("Only used by the occurrence-key test")
    }

    companion object {
        private val NOW = Instant.parse("2026-06-01T10:00:00Z")
        private const val DEFAULT_METADATA = """"severity":"YELLOW","sla":"PT8H","ownerRelationship":"TEACHER","escalationSteps":[],"thresholdKind":"ELAPSED""""
    }
}
