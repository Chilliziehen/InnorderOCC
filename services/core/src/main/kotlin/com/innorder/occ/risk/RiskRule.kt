package com.innorder.occ.risk

import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import java.time.Duration
import java.time.LocalDate
import java.time.ZoneId
import java.util.Collections

enum class RiskSeverity { INFO, YELLOW, RED }
enum class ThresholdKind { ELAPSED, BUSINESS }

data class EscalationStep(val after: Duration, val ownerRelationship: String)

sealed interface RiskTrigger {
    data object OverdueCriticalWork : RiskTrigger
    data class ConsecutiveReturns(val threshold: Int = 2) : RiskTrigger
    data class Inactivity(val elapsedDays: Long = 7) : RiskTrigger
    data class BlockerAge(val businessDays: Int = 2) : RiskTrigger
    data object EvidenceFailure : RiskTrigger
    data object MissingCriticalEvidence : RiskTrigger
    data class ResourceConflict(val within: Duration = Duration.ofHours(24)) : RiskTrigger
}

class RiskRule private constructor(
    val packageId: String,
    val packageVersion: String,
    val ruleId: String,
    val severity: RiskSeverity,
    val sla: Duration,
    val ownerRelationship: String,
    escalationSteps: List<EscalationStep>,
    val thresholdKind: ThresholdKind,
    val zone: ZoneId,
    val calendar: BusinessCalendar,
    val trigger: RiskTrigger,
) {
    val escalationSteps: List<EscalationStep> = Collections.unmodifiableList(escalationSteps.toList())

    companion object {
        private val MAPPER = ObjectMapper().findAndRegisterModules()
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
        private val TOP_LEVEL_FIELDS = setOf(
            "packageId", "packageVersion", "ruleId", "severity", "sla", "ownerRelationship",
            "escalationSteps", "thresholdKind", "zone", "calendar", "trigger",
        )

        fun parse(json: String): RiskRule = invalidOnFailure {
            val root = MAPPER.readTree(json).objectWithExactly(TOP_LEVEL_FIELDS)
            val zoneText = root.requiredText("zone")
            require(zoneText in ZoneId.getAvailableZoneIds()) { "zone must be an IANA identifier" }
            val trigger = parseTrigger(root.requiredObject("trigger"))
            val thresholdKind = enumValueOf<ThresholdKind>(root.requiredText("thresholdKind"))
            require((trigger is RiskTrigger.BlockerAge) == (thresholdKind == ThresholdKind.BUSINESS)) {
                "BUSINESS threshold kind is reserved for blocker age"
            }
            val sla = Duration.parse(root.requiredText("sla")).also { require(!it.isNegative && !it.isZero) }
            val steps = root.requiredArray("escalationSteps").map { node ->
                val step = node.objectWithExactly(setOf("after", "ownerRelationship"))
                EscalationStep(
                    Duration.parse(step.requiredText("after")).also { require(!it.isNegative && !it.isZero) },
                    step.requiredText("ownerRelationship").requireValue("escalation owner relationship"),
                )
            }
            require(steps.zipWithNext().all { (left, right) -> left.after < right.after }) {
                "escalation steps must be ordered"
            }
            val calendarNode = root.requiredObject("calendar").objectWithExactly(setOf("version", "holidays"))
            val holidays = calendarNode.requiredArray("holidays").map {
                require(it.isTextual)
                LocalDate.parse(it.textValue())
            }.toSet()

            RiskRule(
                packageId = root.requiredText("packageId").requireValue("package id"),
                packageVersion = root.requiredText("packageVersion").requireValue("package version"),
                ruleId = root.requiredText("ruleId").requireValue("rule id"),
                severity = enumValueOf(root.requiredText("severity")),
                sla = sla,
                ownerRelationship = root.requiredText("ownerRelationship").requireValue("owner relationship"),
                escalationSteps = steps,
                thresholdKind = thresholdKind,
                zone = ZoneId.of(zoneText),
                calendar = BusinessCalendar(calendarNode.requiredText("version"), holidays),
                trigger = trigger,
            )
        }

        private fun parseTrigger(node: ObjectNode): RiskTrigger = when (node.requiredText("type")) {
            "OVERDUE_CRITICAL_WORK" -> node.noArguments { RiskTrigger.OverdueCriticalWork }
            "CONSECUTIVE_RETURNS" -> node.optionalPositiveInt("threshold", 2, RiskTrigger::ConsecutiveReturns)
            "INACTIVITY" -> node.optionalPositiveLong("elapsedDays", 7, RiskTrigger::Inactivity)
            "BLOCKER_AGE" -> node.optionalPositiveInt("businessDays", 2, RiskTrigger::BlockerAge)
            "EVIDENCE_FAILURE" -> node.noArguments { RiskTrigger.EvidenceFailure }
            "MISSING_CRITICAL_EVIDENCE" -> node.noArguments { RiskTrigger.MissingCriticalEvidence }
            "RESOURCE_CONFLICT" -> {
                node.objectWithOnly(setOf("type", "within"))
                val duration = node.get("within")?.let {
                    require(it.isTextual)
                    Duration.parse(it.textValue())
                } ?: Duration.ofHours(24)
                require(!duration.isNegative && !duration.isZero)
                RiskTrigger.ResourceConflict(duration)
            }
            else -> throw IllegalArgumentException("unknown risk trigger")
        }

        private inline fun <T> ObjectNode.noArguments(factory: () -> T): T {
            objectWithExactly(setOf("type"))
            return factory()
        }

        private inline fun <T> ObjectNode.optionalPositiveInt(name: String, default: Int, factory: (Int) -> T): T {
            objectWithOnly(setOf("type", name))
            val value = get(name)?.let { require(it.isIntegralNumber && it.canConvertToInt()); it.intValue() } ?: default
            require(value > 0)
            return factory(value)
        }

        private inline fun <T> ObjectNode.optionalPositiveLong(name: String, default: Long, factory: (Long) -> T): T {
            objectWithOnly(setOf("type", name))
            val value = get(name)?.let { require(it.isIntegralNumber); it.longValue() } ?: default
            require(value > 0)
            return factory(value)
        }

        private inline fun <T> invalidOnFailure(block: () -> T): T = try {
            block()
        } catch (exception: IllegalArgumentException) {
            throw exception
        } catch (exception: Exception) {
            throw IllegalArgumentException("invalid risk rule", exception)
        }
    }
}

private fun JsonNode.objectWithExactly(fields: Set<String>): ObjectNode = (this as? ObjectNode)
    ?.also { require(it.fieldNames().asSequence().toSet() == fields) { "invalid fields" } }
    ?: throw IllegalArgumentException("object required")

private fun ObjectNode.objectWithOnly(fields: Set<String>): ObjectNode = also {
    require(fieldNames().asSequence().all { field -> field in fields }) { "unknown field" }
}

private fun ObjectNode.requiredText(name: String): String = get(name)?.takeIf(JsonNode::isTextual)?.textValue()
    ?: throw IllegalArgumentException("$name must be text")

private fun ObjectNode.requiredObject(name: String): ObjectNode = get(name) as? ObjectNode
    ?: throw IllegalArgumentException("$name must be an object")

private fun ObjectNode.requiredArray(name: String): List<JsonNode> = get(name)?.takeIf(JsonNode::isArray)?.toList()
    ?: throw IllegalArgumentException("$name must be an array")
