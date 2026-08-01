package com.innorder.occ.risk

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.jdbc.core.JdbcOperations
import org.springframework.stereotype.Repository
import java.math.BigDecimal
import java.math.RoundingMode
import java.nio.charset.StandardCharsets
import java.sql.ResultSet
import java.sql.Timestamp
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

@Repository
class RiskRepository(private val jdbc: JdbcOperations) {
    private val mapper = ObjectMapper().findAndRegisterModules()

    fun findByOccurrence(ruleDefinitionId: UUID, targetEntityId: UUID, occurrenceKey: String): RiskRecord? =
        jdbc.query("""SELECT * FROM occ.risk
                       WHERE rule_definition_id = ? AND target_entity_id = ? AND occurrence_key = ?""",
            ::risk, ruleDefinitionId, targetEntityId, occurrenceKey).singleOrNull()

    fun get(id: UUID): RiskRecord = jdbc.query("SELECT * FROM occ.risk WHERE id = ?", ::risk, id)
        .singleOrNull() ?: throw RiskNotFoundException()

    fun lock(id: UUID): RiskRecord = jdbc.query("SELECT * FROM occ.risk WHERE id = ? FOR UPDATE", ::risk, id)
        .singleOrNull() ?: throw RiskNotFoundException()

    fun resolveOwner(ruleDefinitionId: UUID, targetEntityId: UUID, relationKey: String): UUID =
        jdbc.queryForList(
            """SELECT relationship.id
               FROM authz.relationship relationship
               JOIN catalog.relation_definition definition ON definition.id = relationship.relation_definition_id
               JOIN catalog.risk_rule_definition rule ON rule.package_version_id = definition.package_version_id
               WHERE rule.id = ? AND definition.relation_key = ? AND relationship.object_entity_id = ?
                 AND relationship.revoked_at IS NULL AND relationship.valid_from <= statement_timestamp()
                 AND (relationship.valid_until IS NULL OR relationship.valid_until > statement_timestamp())
               ORDER BY relationship.id LIMIT 2""",
            UUID::class.java, ruleDefinitionId, relationKey, targetEntityId,
        ).singleOrNull() ?: throw InvalidRiskActionException()

    fun ownerBelongsToTarget(relationshipId: UUID, targetEntityId: UUID): Boolean = jdbc.queryForObject(
        """SELECT EXISTS (
             SELECT 1 FROM authz.relationship
             WHERE id = ? AND object_entity_id = ? AND revoked_at IS NULL
               AND valid_from <= statement_timestamp()
               AND (valid_until IS NULL OR valid_until > statement_timestamp())
           )""",
        Boolean::class.java, relationshipId, targetEntityId,
    ) == true

    fun create(id: UUID, decision: RiskDecision, ownerRelationshipId: UUID) {
        val entityInserted = jdbc.update(
            """INSERT INTO authz.entity
               (id, entity_type_id, entity_type_version_id, entity_key, state, created_by)
               SELECT ?, type.id, version.id, ?, 'ACTIVE', relationship.subject_entity_id
               FROM catalog.risk_rule_definition rule
               JOIN catalog.package_version package_version ON package_version.id = rule.package_version_id
               JOIN catalog.entity_type type ON type.package_id = package_version.package_id AND type.type_key = 'risk'
               JOIN catalog.entity_type_version version
                 ON version.entity_type_id = type.id AND version.package_version_id = package_version.id
               JOIN authz.relationship relationship ON relationship.id = ?
               WHERE rule.id = ?""",
            id, "risk-${decision.occurrenceKey}", ownerRelationshipId, decision.ruleDefinitionId,
        )
        if (entityInserted != 1) throw InvalidRiskActionException()
        jdbc.update(
            """INSERT INTO occ.risk
               (id, rule_definition_id, target_entity_id, severity, state, confidence, reason, due_at,
                occurrence_key, detected_at, evaluated_at, calendar_version, owner_relationship_id)
               VALUES (?, ?, ?, ?, 'OPEN', NULL, ?, ?, ?, ?, ?, ?, ?)""",
            id, decision.ruleDefinitionId, decision.targetEntityId, decision.severity.name,
            bounded(decision.reason, 1024), Timestamp.from(decision.dueAt), decision.occurrenceKey,
            Timestamp.from(decision.detectedAt), Timestamp.from(decision.evaluatedAt), decision.calendarVersion,
            ownerRelationshipId,
        )
        jdbc.update(
            """INSERT INTO occ.risk_occurrence
               (id, risk_id, rule_definition_id, target_entity_id, occurrence_key, triggering_fact_ids,
                threshold_kind, calendar_version, evaluated_at, detected_at)
               VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)""",
            UUID.randomUUID(), id, decision.ruleDefinitionId, decision.targetEntityId, decision.occurrenceKey,
            mapper.writeValueAsString(decision.triggeringFactIds), decision.thresholdKind.name, decision.calendarVersion,
            Timestamp.from(decision.evaluatedAt), Timestamp.from(decision.detectedAt),
        )
        decision.escalationSteps.forEachIndexed { level, step ->
            val relationship = step.ownerRelationship?.let {
                resolveOwner(decision.ruleDefinitionId, decision.targetEntityId, it)
            }
            val data = mapper.createObjectNode().apply {
                put("level", level)
                step.severity?.let { put("severity", it.name) }
            }
            jdbc.update(
                """INSERT INTO occ.risk_intervention
                   (id, risk_id, intervention_type, owner_relationship_id, due_at, intervention_data)
                   VALUES (?, ?, 'ESCALATION', ?, ?, ?::jsonb)""",
                UUID.randomUUID(), id, relationship, Timestamp.from(decision.detectedAt.plus(step.after)),
                mapper.writeValueAsString(data),
            )
        }
    }

    fun appendAction(
        riskId: UUID,
        actorId: UUID,
        type: RiskActionType,
        reason: String?,
        actionData: Map<String, String> = emptyMap(),
        escalationLevel: Int? = null,
    ): UUID = UUID.randomUUID().also { id ->
        jdbc.update(
            """INSERT INTO occ.risk_action
               (id, risk_id, actor_id, action_type, escalation_level, reason, action_data)
               VALUES (?, ?, ?, ?, ?, ?, ?::jsonb)""",
            id, riskId, actorId, type.name, escalationLevel, reason?.let { bounded(it, 1024) },
            mapper.writeValueAsString(actionData),
        )
    }

    fun updateHead(
        id: UUID,
        state: RiskState? = null,
        ownerRelationshipId: UUID? = null,
        severity: RiskSeverity? = null,
        escalationLevel: Int? = null,
        escalatedAt: Instant? = null,
    ) {
        val changed = jdbc.update(
            """UPDATE occ.risk SET
                 state = coalesce(?, state),
                 owner_relationship_id = coalesce(?, owner_relationship_id),
                 severity = coalesce(?, severity),
                 last_escalation_level = coalesce(?, last_escalation_level),
                 last_escalated_at = coalesce(?, last_escalated_at),
                 resolved_at = CASE WHEN ? = 'RESOLVED' THEN statement_timestamp() ELSE resolved_at END,
                 updated_at = statement_timestamp()
               WHERE id = ?""",
            state?.name, ownerRelationshipId, severity?.name, escalationLevel,
            escalatedAt?.let(Timestamp::from), state?.name, id,
        )
        if (changed != 1) throw RiskNotFoundException()
    }

    fun actions(id: UUID): List<RiskActionRecord> = jdbc.query(
        "SELECT * FROM occ.risk_action WHERE risk_id = ? ORDER BY acted_at, id",
        { row, _ -> RiskActionRecord(
            row.getObject("id", UUID::class.java), row.getObject("risk_id", UUID::class.java),
            row.getObject("actor_id", UUID::class.java), enumValueOf(row.getString("action_type")),
            row.getObject("escalation_level") as Int?, row.getString("reason"), row.getTimestamp("acted_at").toInstant(),
        ) }, id,
    )

    fun dueEscalations(at: Instant, limit: Int): List<DueRiskEscalation> = jdbc.query(
        DUE_ESCALATION_SQL,
        { row, _ -> DueRiskEscalation(
            row.getObject("risk_id", UUID::class.java), row.getObject("target_entity_id", UUID::class.java),
            row.getInt("level"), row.getTimestamp("due_at").toInstant(),
            row.getObject("owner_relationship_id", UUID::class.java),
            row.getString("severity")?.let(RiskSeverity::valueOf),
        ) }, Timestamp.from(at), limit,
    )

    fun queue(filters: RiskQueueFilters, at: Instant, limit: Int): List<RiskRecord> {
        val sql = StringBuilder("SELECT * FROM occ.risk WHERE severity = ANY (?::text[]) AND state = ANY (?::text[])")
        val arguments = mutableListOf<Any>(
            filters.severities.map(Enum<*>::name).toTypedArray(), filters.states.map(Enum<*>::name).toTypedArray(),
        )
        filters.targetEntityId?.let { sql.append(" AND target_entity_id = ?"); arguments += it }
        filters.ownerRelationshipId?.let { sql.append(" AND owner_relationship_id = ?"); arguments += it }
        when (filters.slaStatus) {
            RiskSlaStatus.OVERDUE -> { sql.append(" AND due_at < ?"); arguments += Timestamp.from(at) }
            RiskSlaStatus.DUE -> { sql.append(" AND due_at = ?"); arguments += Timestamp.from(at) }
            RiskSlaStatus.NOT_DUE -> { sql.append(" AND due_at > ?"); arguments += Timestamp.from(at) }
            RiskSlaStatus.NONE -> sql.append(" AND due_at IS NULL")
            null -> Unit
        }
        sql.append(" ORDER BY due_at ASC NULLS LAST, CASE severity WHEN 'RED' THEN 2 WHEN 'YELLOW' THEN 1 ELSE 0 END DESC, id LIMIT ?")
        arguments += limit
        return jdbc.query(sql.toString(), ::risk, *arguments.toTypedArray())
    }

    fun appendAdjudication(actorId: UUID, request: RiskAdjudicationRequest, prior: RiskAdjudicationRecord?): UUID =
        UUID.randomUUID().also { id ->
            jdbc.update(
                """INSERT INTO occ.risk_adjudication
                   (id, reporting_period_start, reporting_period_end, evaluator_id, known_event_key,
                    target_entity_id, severe_event, risk_id, outcome, reason, adjudication_version,
                    supersedes_adjudication_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                id, request.reportingPeriodStart, request.reportingPeriodEnd, actorId, request.knownEventKey,
                request.targetEntityId, request.severeEvent, request.riskId, request.outcome.name,
                bounded(request.reason, 1024), (prior?.version ?: 0) + 1, prior?.id,
            )
        }

    fun latestAdjudication(knownEventKey: String, targetEntityId: UUID, lock: Boolean = false): RiskAdjudicationRecord? =
        jdbc.query(
            """SELECT * FROM occ.risk_adjudication
               WHERE known_event_key = ? AND target_entity_id = ? ORDER BY adjudication_version DESC LIMIT 1${if (lock) " FOR UPDATE" else ""}""",
            ::adjudication, knownEventKey, targetEntityId,
        ).singleOrNull()

    fun adjudications(knownEventKey: String, targetEntityId: UUID): List<RiskAdjudicationRecord> = jdbc.query(
        """SELECT * FROM occ.risk_adjudication WHERE known_event_key = ? AND target_entity_id = ?
           ORDER BY adjudication_version""",
        ::adjudication, knownEventKey, targetEntityId,
    )

    fun metrics(start: LocalDate, end: LocalDate): RiskMetrics {
        val row = jdbc.queryForMap(
            """WITH latest AS (
                 SELECT adjudication.* FROM occ.risk_adjudication adjudication
                 WHERE adjudication.reporting_period_start >= ? AND adjudication.reporting_period_end <= ?
                   AND NOT EXISTS (SELECT 1 FROM occ.risk_adjudication next
                                   WHERE next.supersedes_adjudication_id = adjudication.id)
               ), measured AS (
                 SELECT latest.*, risk.severity, risk.state AS risk_state
                 FROM latest LEFT JOIN occ.risk risk ON risk.id = latest.risk_id
               )
               SELECT count(*) FILTER (WHERE severe_event AND outcome = 'MISSED') AS severe_misses,
                      count(*) FILTER (WHERE severity IN ('YELLOW','RED') AND risk_state = 'DISMISSED'
                                       AND outcome = 'FALSE_POSITIVE') AS false_positives,
                      count(*) FILTER (WHERE severity IN ('YELLOW','RED') AND outcome <> 'NOT_APPLICABLE') AS significant
               FROM measured""",
            start, end,
        )
        val misses = (row["severe_misses"] as Number).toLong()
        val falsePositives = (row["false_positives"] as Number).toLong()
        val significant = (row["significant"] as Number).toLong()
        val rate = if (significant == 0L) BigDecimal.ZERO.setScale(4) else
            BigDecimal.valueOf(falsePositives).divide(BigDecimal.valueOf(significant), 4, RoundingMode.HALF_UP)
        return RiskMetrics(misses, falsePositives, significant, rate)
    }

    private fun risk(row: ResultSet, ignored: Int): RiskRecord = RiskRecord(
        row.getObject("id", UUID::class.java), row.getObject("rule_definition_id", UUID::class.java),
        row.getObject("target_entity_id", UUID::class.java), row.getString("occurrence_key"),
        enumValueOf(row.getString("severity")), enumValueOf(row.getString("state")), row.getString("reason"),
        row.getTimestamp("due_at")?.toInstant(), row.getObject("owner_relationship_id", UUID::class.java),
        row.getObject("last_escalation_level") as Int?, row.getLong("row_version"),
    )

    private fun adjudication(row: ResultSet, ignored: Int) = RiskAdjudicationRecord(
        row.getObject("id", UUID::class.java), row.getString("known_event_key"),
        row.getObject("target_entity_id", UUID::class.java), row.getInt("adjudication_version"),
        enumValueOf(row.getString("outcome")), row.getObject("supersedes_adjudication_id", UUID::class.java),
    )

    private fun bounded(value: String, maximum: Int): String {
        if (value.length !in 1..maximum || value.any(Char::isISOControl)) throw InvalidRiskActionException()
        return value
    }

    companion object {
        const val DUE_ESCALATION_SQL = """SELECT intervention.risk_id, risk.target_entity_id,
                   (intervention.intervention_data->>'level')::integer AS level,
                   intervention.due_at, intervention.owner_relationship_id,
                   intervention.intervention_data->>'severity' AS severity
            FROM occ.risk_intervention intervention
            JOIN occ.risk risk ON risk.id = intervention.risk_id
            WHERE intervention.intervention_type = 'ESCALATION' AND intervention.due_at <= ?
              AND risk.state IN ('OPEN','ACKNOWLEDGED')
              AND NOT EXISTS (SELECT 1 FROM occ.risk_action action
                              WHERE action.risk_id = risk.id
                                AND action.escalation_level = (intervention.intervention_data->>'level')::integer)
            ORDER BY intervention.due_at, intervention.risk_id,
                     (intervention.intervention_data->>'level')::integer
            FOR UPDATE OF risk SKIP LOCKED LIMIT ?"""

        fun deterministicRiskId(decision: RiskDecision): UUID = UUID.nameUUIDFromBytes(
            "risk:${decision.ruleDefinitionId}:${decision.targetEntityId}:${decision.occurrenceKey}"
                .toByteArray(StandardCharsets.UTF_8),
        )
    }
}
