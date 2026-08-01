package com.innorder.occ.risk

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.util.UUID

class RiskEvaluatorTest {
    private val evaluator = RiskEvaluator()

    @Test
    fun `strict package rule parses persistence identity and optional escalation effects`() {
        val parsed = rule(
            """{"type":"CONSECUTIVE_RETURNS"}""",
            extra = """"severity":"RED","sla":"PT4H","ownerRelationship":"TEACHER","escalationSteps":[{"after":"PT2H","severity":"RED"},{"after":"PT3H","ownerRelationship":"PROGRAM_LEAD"},{"after":"PT4H","ownerRelationship":"DIRECTOR","severity":"RED"}],"thresholdKind":"ELAPSED"""",
        )

        assertThat(parsed.ruleDefinitionId).isEqualTo(RULE_DEFINITION_ID)
        assertThat(parsed.packageVersion).isEqualTo("1.0.0")
        assertThat(parsed.severity).isEqualTo(RiskSeverity.RED)
        assertThat(parsed.escalationSteps).containsExactly(
            EscalationStep(Duration.ofHours(2), severity = RiskSeverity.RED),
            EscalationStep(Duration.ofHours(3), ownerRelationship = "PROGRAM_LEAD"),
            EscalationStep(Duration.ofHours(4), "DIRECTOR", RiskSeverity.RED),
        )
        assertThat(parsed.trigger).isEqualTo(RiskTrigger.ConsecutiveReturns(2))

        assertThatThrownBy {
            rule("""{"type":"EVIDENCE_FAILURE"}""", extra = metadata("[{\"after\":\"PT2H\"}]"))
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            rule("""{"type":"EVIDENCE_FAILURE"}""", extra = metadata("[{\"after\":\"PT2H\",\"severity\":\"RED\",\"unknown\":true}]"))
        }.isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `risk evaluation facts own ordered distinct UUID provenance`() {
        val source = mutableListOf(FACT_2, FACT_1)
        val snapshot = RiskEvaluationFacts(TARGET_ID, source, RiskFactValues.ConsecutiveReturns)
        source.clear()

        assertThat(snapshot.triggeringFactIds).containsExactly(FACT_2, FACT_1)
        assertThatThrownBy {
            RiskEvaluationFacts(TARGET_ID, listOf(FACT_1, FACT_1), RiskFactValues.ConsecutiveReturns)
        }.isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `decision contains exact V014 occurrence and risk provenance`() {
        val decision = evaluate(
            rule("""{"type":"INACTIVITY"}"""),
            facts(RiskFactValues.Inactivity(Instant.parse("2026-05-25T10:00:00Z"))),
            NOW,
        )!!

        assertThat(decision.ruleDefinitionId).isEqualTo(RULE_DEFINITION_ID)
        assertThat(decision.targetEntityId).isEqualTo(TARGET_ID)
        assertThat(decision.evaluatedAt).isEqualTo(NOW)
        assertThat(decision.detectedAt).isEqualTo(NOW)
        assertThat(decision.dueAt).isEqualTo(NOW.plus(Duration.ofHours(8)))
        assertThat(decision.calendarVersion).isEqualTo("nl-school-2026-v1")
        assertThat(decision.thresholdKind).isEqualTo(ThresholdKind.ELAPSED)
        assertThat(decision.triggeringFactIds).containsExactly(FACT_1)
        assertThat(decision.thresholdWindowIdentity).isEqualTo("INACTIVITY|threshold=2026-06-01T10:00:00Z")
        assertThat(decision.reason).isEqualTo("INACTIVITY")
    }

    @Test
    fun `all immediate and elapsed triggers retain threshold boundary semantics`() {
        val due = Instant.parse("2026-06-01T10:00:00Z")
        val overdue = rule("""{"type":"OVERDUE_CRITICAL_WORK"}""")
        assertThat(evaluate(overdue, facts(RiskFactValues.CriticalWork(due, true)), due.minusNanos(1))).isNull()
        assertThat(evaluate(overdue, facts(RiskFactValues.CriticalWork(due, true)), due)).isNotNull()
        assertThat(evaluate(overdue, facts(RiskFactValues.CriticalWork(due, true, due)), due)).isNull()

        val inactive = rule("""{"type":"INACTIVITY"}""")
        val lastActivity = Instant.parse("2026-03-22T09:00:00Z")
        val sevenDays = lastActivity.plus(Duration.ofDays(7))
        assertThat(evaluate(inactive, facts(RiskFactValues.Inactivity(lastActivity)), sevenDays.minusNanos(1))).isNull()
        assertThat(evaluate(inactive, facts(RiskFactValues.Inactivity(lastActivity)), sevenDays)).isNotNull()

        assertThat(evaluate(rule("""{"type":"EVIDENCE_FAILURE"}"""), facts(RiskFactValues.EvidenceFailure(true)), NOW)).isNotNull()
        assertThat(evaluate(rule("""{"type":"EVIDENCE_FAILURE"}"""), facts(RiskFactValues.EvidenceFailure(false)), NOW)).isNull()
        assertThat(evaluate(rule("""{"type":"MISSING_CRITICAL_EVIDENCE"}"""), facts(RiskFactValues.MissingEvidence(true, true)), NOW)).isNotNull()
        assertThat(evaluate(rule("""{"type":"MISSING_CRITICAL_EVIDENCE"}"""), facts(RiskFactValues.MissingEvidence(false, true)), NOW)).isNull()
    }

    @Test
    fun `consecutive return occurrence requires the exact threshold crossing facts`() {
        val rule = rule("""{"type":"CONSECUTIVE_RETURNS"}""")
        assertThat(evaluate(rule, facts(RiskFactValues.ConsecutiveReturns, listOf(FACT_1)), NOW)).isNull()

        val atThreshold = evaluate(rule, facts(RiskFactValues.ConsecutiveReturns, listOf(FACT_2, FACT_1)), NOW)!!
        val reordered = evaluate(rule, facts(RiskFactValues.ConsecutiveReturns, listOf(FACT_1, FACT_2)), NOW)!!
        val newWindow = evaluate(rule, facts(RiskFactValues.ConsecutiveReturns, listOf(FACT_2, FACT_3)), NOW)!!
        val newPackageVersion = evaluate(
            RiskRule.parse(ruleJson("""{"type":"CONSECUTIVE_RETURNS"}""").replace("1.0.0", "1.0.1")),
            facts(RiskFactValues.ConsecutiveReturns, listOf(FACT_2, FACT_1)),
            NOW,
        )!!
        val newCalendarVersion = evaluate(
            RiskRule.parse(ruleJson("""{"type":"CONSECUTIVE_RETURNS"}""").replace("nl-school-2026-v1", "nl-school-2026-v2")),
            facts(RiskFactValues.ConsecutiveReturns, listOf(FACT_2, FACT_1)),
            NOW,
        )!!

        assertThat(atThreshold.occurrenceKey).matches("^[0-9a-f]{64}${'$'}")
        assertThat(atThreshold.triggeringFactIds).containsExactly(FACT_1, FACT_2)
        assertThat(reordered.occurrenceKey).isEqualTo(atThreshold.occurrenceKey)
        listOf(
            listOf(FACT_1, FACT_2, FACT_3),
            listOf(FACT_3, FACT_2, FACT_1),
            listOf(FACT_2, FACT_3, FACT_1),
        ).forEach { extraFacts ->
            assertThatThrownBy { evaluate(rule, facts(RiskFactValues.ConsecutiveReturns, extraFacts), NOW) }
                .isInstanceOf(IllegalArgumentException::class.java)
        }
        assertThat(newWindow.occurrenceKey).isNotEqualTo(atThreshold.occurrenceKey)
        assertThat(newWindow.thresholdWindowIdentity).isNotEqualTo(atThreshold.thresholdWindowIdentity)
        assertThat(newPackageVersion.occurrenceKey).isNotEqualTo(atThreshold.occurrenceKey)
        assertThat(newCalendarVersion.occurrenceKey).isNotEqualTo(atThreshold.occurrenceKey)
    }

    @Test
    fun `historical replay ignores completion and resolution after evaluation instant`() {
        val evaluatedAt = Instant.parse("2026-06-01T12:00:00Z")
        val futureStateChange = evaluatedAt.plusSeconds(1)
        val due = evaluatedAt.minusSeconds(1)
        assertThat(
            evaluate(
                rule("""{"type":"OVERDUE_CRITICAL_WORK"}"""),
                facts(RiskFactValues.CriticalWork(due, true, completedAt = futureStateChange)),
                evaluatedAt,
            ),
        ).isNotNull()

        val blockerRule = businessRule()
        val blockedAt = Instant.parse("2026-05-28T10:00:00Z")
        assertThat(
            evaluate(
                blockerRule,
                facts(RiskFactValues.Blocker(blockedAt, resolvedAt = futureStateChange)),
                evaluatedAt,
            ),
        ).isNotNull()
        assertThat(evaluate(blockerRule, facts(RiskFactValues.Blocker(blockedAt, evaluatedAt)), evaluatedAt)).isNull()
    }

    @Test
    fun `every rule rejects a mismatched fact value type`() {
        listOf(
            rule("""{"type":"OVERDUE_CRITICAL_WORK"}""") to RiskFactValues.Inactivity(NOW),
            rule("""{"type":"CONSECUTIVE_RETURNS"}""") to RiskFactValues.EvidenceFailure(true),
            rule("""{"type":"INACTIVITY"}""") to RiskFactValues.ConsecutiveReturns,
            businessRule() to RiskFactValues.ResourceConflict(NOW),
            rule("""{"type":"EVIDENCE_FAILURE"}""") to RiskFactValues.MissingEvidence(true, true),
            rule("""{"type":"MISSING_CRITICAL_EVIDENCE"}""") to RiskFactValues.CriticalWork(NOW, true),
            rule("""{"type":"RESOURCE_CONFLICT"}""") to RiskFactValues.Blocker(NOW),
        ).forEach { (riskRule, mismatchedValues) ->
            assertThatThrownBy { evaluate(riskRule, facts(mismatchedValues), NOW) }
                .describedAs("${riskRule.trigger} with $mismatchedValues")
                .isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `business calendar preserves local threshold time across DST`() {
        val calendar = BusinessCalendar("nl-school-2026-v1", emptySet())
        val fridayTenAmsterdam = Instant.parse("2026-03-27T09:00:00Z")

        val mondayTenAmsterdam = calendar.thresholdAfter(fridayTenAmsterdam, 1, ZoneId.of("Europe/Amsterdam"))

        assertThat(mondayTenAmsterdam).isEqualTo(Instant.parse("2026-03-30T08:00:00Z"))
        assertThat(Duration.between(fridayTenAmsterdam, mondayTenAmsterdam)).isEqualTo(Duration.ofHours(71))
    }

    @Test
    fun `blocker excludes weekend and holiday and triggers strictly after boundary`() {
        val rule = businessRule()
        val blocked = Instant.parse("2026-04-02T08:00:00Z")
        val exactBoundary = Instant.parse("2026-04-07T08:00:00Z")
        val snapshot = facts(RiskFactValues.Blocker(blocked))

        assertThat(evaluate(rule, snapshot, exactBoundary)).isNull()
        assertThat(evaluate(rule, snapshot, exactBoundary.plusNanos(1))).isNotNull()
    }

    @Test
    fun `resource conflict window includes exact lower and upper boundaries`() {
        val rule = rule("""{"type":"RESOURCE_CONFLICT"}""")

        assertThat(evaluate(rule, facts(RiskFactValues.ResourceConflict(NOW.minusNanos(1))), NOW)).isNull()
        assertThat(evaluate(rule, facts(RiskFactValues.ResourceConflict(NOW)), NOW)).isNotNull()
        assertThat(evaluate(rule, facts(RiskFactValues.ResourceConflict(NOW.plus(Duration.ofHours(24)))), NOW)).isNotNull()
        assertThat(evaluate(rule, facts(RiskFactValues.ResourceConflict(NOW.plus(Duration.ofHours(24)).plusNanos(1))), NOW)).isNull()
    }

    @Test
    fun `strict rules reject malformed IANA calendar and version definitions`() {
        assertThatThrownBy { RiskRule.parse(ruleJson("""{"type":"INACTIVITY"}""").replace("Europe/Amsterdam", "+02:00")) }
            .isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { RiskRule.parse(ruleJson("""{"type":"INACTIVITY"}""").replace("nl-school-2026-v1", "")) }
            .isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { RiskRule.parse(ruleJson("""{"type":"INACTIVITY"}""").replace("2026-04-06", "2026-02-30")) }
            .isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { RiskRule.parse(ruleJson("""{"type":"INACTIVITY"}""").replace("1.0.0", "version one")) }
            .isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            RiskRule.parse(ruleJson("""{"type":"INACTIVITY"}""").replace("[\"2026-04-06\"]", "[\"2026-04-06\",\"2026-04-06\"]"))
        }.isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `inactivity rejects elapsed days outside signed long range`() {
        assertThatThrownBy {
            rule("""{"type":"INACTIVITY","elapsedDays":18446744073709551623}""")
        }.isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `numeric trigger fields reject integer overflow and fractional coercion`() {
        listOf(
            """{"type":"CONSECUTIVE_RETURNS","threshold":4294967298}""",
            """{"type":"BLOCKER_AGE","businessDays":4294967298}""",
            """{"type":"CONSECUTIVE_RETURNS","threshold":2.0}""",
            """{"type":"INACTIVITY","elapsedDays":7.0}""",
            """{"type":"BLOCKER_AGE","businessDays":2.0}""",
        ).forEach { trigger ->
            val metadata = if (trigger.contains("BLOCKER_AGE")) BUSINESS_METADATA else DEFAULT_METADATA
            assertThatThrownBy { rule(trigger, metadata) }
                .describedAs(trigger)
                .isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `operational maxima accept boundary and reject larger or primitive limit values`() {
        assertThat(rule("""{"type":"INACTIVITY","elapsedDays":${RiskRule.MAX_ELAPSED_DAYS}}""").trigger)
            .isEqualTo(RiskTrigger.Inactivity(RiskRule.MAX_ELAPSED_DAYS))
        assertThat(rule("""{"type":"BLOCKER_AGE","businessDays":${RiskRule.MAX_BUSINESS_DAYS}}""", BUSINESS_METADATA).trigger)
            .isEqualTo(RiskTrigger.BlockerAge(RiskRule.MAX_BUSINESS_DAYS))
        assertThat(RiskRule.parse(ruleJson("""{"type":"INACTIVITY"}""").replace("PT8H", "P365D")).sla)
            .isEqualTo(RiskRule.MAX_SLA)
        assertThat(rule("""{"type":"EVIDENCE_FAILURE"}""", metadata("[{\"after\":\"P365D\",\"severity\":\"RED\"}]")).escalationSteps.single().after)
            .isEqualTo(RiskRule.MAX_ESCALATION_DELAY)
        assertThat(rule("""{"type":"RESOURCE_CONFLICT","within":"P30D"}""").trigger)
            .isEqualTo(RiskTrigger.ResourceConflict(RiskRule.MAX_CONFLICT_WINDOW))

        listOf(
            ruleJson("""{"type":"INACTIVITY","elapsedDays":${RiskRule.MAX_ELAPSED_DAYS + 1}}"""),
            ruleJson("""{"type":"INACTIVITY","elapsedDays":${Long.MAX_VALUE}}"""),
            ruleJson("""{"type":"BLOCKER_AGE","businessDays":${RiskRule.MAX_BUSINESS_DAYS + 1}}""", BUSINESS_METADATA),
            ruleJson("""{"type":"BLOCKER_AGE","businessDays":${Int.MAX_VALUE}}""", BUSINESS_METADATA),
            ruleJson("""{"type":"INACTIVITY"}""").replace("PT8H", "P366D"),
            ruleJson("""{"type":"INACTIVITY"}""").replace("PT8H", "PT${Long.MAX_VALUE}S"),
            ruleJson("""{"type":"EVIDENCE_FAILURE"}""", metadata("[{\"after\":\"P366D\",\"severity\":\"RED\"}]")),
            ruleJson("""{"type":"EVIDENCE_FAILURE"}""", metadata("[{\"after\":\"PT${Long.MAX_VALUE}S\",\"severity\":\"RED\"}]")),
            ruleJson("""{"type":"RESOURCE_CONFLICT","within":"P31D"}"""),
            ruleJson("""{"type":"RESOURCE_CONFLICT","within":"PT${Long.MAX_VALUE}S"}"""),
        ).forEach { json ->
            assertThatThrownBy { RiskRule.parse(json) }
                .isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `evaluation rejects instant arithmetic overflow explicitly`() {
        assertThatThrownBy {
            evaluate(rule("""{"type":"EVIDENCE_FAILURE"}"""), facts(RiskFactValues.EvidenceFailure(true)), Instant.MAX)
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            evaluate(
                rule("""{"type":"INACTIVITY"}"""),
                facts(RiskFactValues.Inactivity(Instant.MAX.minusSeconds(1))),
                Instant.MAX,
            )
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            evaluate(
                rule("""{"type":"RESOURCE_CONFLICT"}"""),
                facts(RiskFactValues.ResourceConflict(Instant.MAX)),
                Instant.MAX.minusSeconds(1),
            )
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            BusinessCalendar("calendar-v1", emptySet()).thresholdAfter(Instant.MAX, 1, ZoneId.of("Europe/Amsterdam"))
        }.isInstanceOf(IllegalArgumentException::class.java)
    }

    private fun evaluate(rule: RiskRule, facts: RiskEvaluationFacts, at: Instant): RiskDecision? =
        evaluator.evaluate(rule, facts, at)

    private fun facts(values: RiskFactValues, ids: List<UUID> = listOf(FACT_1)): RiskEvaluationFacts =
        RiskEvaluationFacts(TARGET_ID, ids, values)

    private fun rule(trigger: String, extra: String = DEFAULT_METADATA): RiskRule = RiskRule.parse(ruleJson(trigger, extra = extra))

    private fun businessRule(): RiskRule = rule(
        """{"type":"BLOCKER_AGE"}""",
        extra = BUSINESS_METADATA,
    )

    private fun ruleJson(trigger: String, extra: String = DEFAULT_METADATA): String =
        """{"packageId":"embedded-medical-device-pilot","packageVersion":"1.0.0","ruleDefinitionId":"$RULE_DEFINITION_ID","ruleId":"risk-rule-1",$extra,"zone":"Europe/Amsterdam","calendar":{"version":"nl-school-2026-v1","holidays":["2026-04-06"]},"trigger":$trigger}"""

    private fun metadata(steps: String): String =
        """"severity":"YELLOW","sla":"PT8H","ownerRelationship":"TEACHER","escalationSteps":$steps,"thresholdKind":"ELAPSED""""

    companion object {
        private val NOW = Instant.parse("2026-06-01T10:00:00Z")
        private val RULE_DEFINITION_ID = UUID.fromString("10000000-0000-0000-0000-000000000001")
        private val TARGET_ID = UUID.fromString("20000000-0000-0000-0000-000000000001")
        private val FACT_1 = UUID.fromString("30000000-0000-0000-0000-000000000001")
        private val FACT_2 = UUID.fromString("30000000-0000-0000-0000-000000000002")
        private val FACT_3 = UUID.fromString("30000000-0000-0000-0000-000000000003")
        private const val DEFAULT_METADATA = """"severity":"YELLOW","sla":"PT8H","ownerRelationship":"TEACHER","escalationSteps":[],"thresholdKind":"ELAPSED""""
        private const val BUSINESS_METADATA = """"severity":"YELLOW","sla":"PT8H","ownerRelationship":"TEACHER","escalationSteps":[],"thresholdKind":"BUSINESS""""
    }
}
