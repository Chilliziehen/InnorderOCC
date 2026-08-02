package com.innorder.occ.risk

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import com.innorder.occ.api.CursorCodec
import com.innorder.occ.api.CursorContext
import com.innorder.occ.api.CursorDirection
import com.innorder.occ.authz.AuthorizationDeniedException
import com.innorder.occ.authz.AuthorizationAvailabilityException
import com.innorder.occ.authz.AuthorizationRequest
import com.innorder.occ.authz.AuthorizationService
import com.innorder.occ.command.AuthorizedCommand
import com.innorder.occ.command.CanonicalJsonObject
import com.innorder.occ.command.CommandContext
import com.innorder.occ.command.CommandExecutor
import com.innorder.occ.command.CommandMetadata
import com.innorder.occ.command.CommandMutation
import com.innorder.occ.command.CommandResult
import com.innorder.occ.command.InvalidExpectedVersionException
import com.innorder.occ.command.PendingEventSpec
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionTemplate
import java.math.BigDecimal
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

@Service
class RiskService(
    private val risks: RiskRepository,
    private val commands: CommandExecutor,
    private val authorization: AuthorizationService,
    private val cursors: CursorCodec,
    transactionManager: PlatformTransactionManager,
    private val notifications: RiskNotificationPort,
    private val metricsProperties: RiskMetricsProperties,
) {
    private val transactions = TransactionTemplate(transactionManager).apply {
        propagationBehavior = TransactionDefinition.PROPAGATION_REQUIRED
    }

    fun create(metadata: CommandMetadata, decision: RiskDecision): CommandResult {
        if (metadata.expectedVersion != null) throw InvalidExpectedVersionException()
        val riskId = RiskRepository.deterministicRiskId(decision)
        val commandId = commandInvocationId(metadata)
        val result = commands.execute(
            metadata, requestBytes(decisionRequest(decision)), CreateRiskCommand(commandId, riskId, decision),
        )
        val resultRiskId = UUID.fromString(result.body.toJsonNode().path("riskId").textValue())
        return result.copy(resourceId = resultRiskId)
    }

    fun acknowledge(metadata: CommandMetadata, riskId: UUID, reason: String): CommandResult =
        action(metadata, riskId, RiskActionType.ACKNOWLEDGED, reason)

    fun assign(metadata: CommandMetadata, riskId: UUID, ownerRelationshipId: UUID, reason: String): CommandResult =
        action(metadata, riskId, RiskActionType.ASSIGNED, reason, ownerRelationshipId = ownerRelationshipId)

    fun mitigate(
        metadata: CommandMetadata,
        riskId: UUID,
        reason: String,
        data: Map<String, String>,
    ): CommandResult = action(metadata, riskId, RiskActionType.MITIGATED, reason, data)

    fun resolve(metadata: CommandMetadata, riskId: UUID, reason: String): CommandResult =
        action(metadata, riskId, RiskActionType.RESOLVED, reason)

    fun dismiss(metadata: CommandMetadata, riskId: UUID, reason: String): CommandResult =
        action(metadata, riskId, RiskActionType.DISMISSED, reason)

    fun escalate(
        metadata: CommandMetadata,
        riskId: UUID,
        level: Int,
        reason: String,
        ownerRelationshipId: UUID?,
        severity: RiskSeverity?,
        at: Instant,
    ): CommandResult {
        if (level < 0 || (ownerRelationshipId == null && severity == null)) throw InvalidRiskActionException()
        return action(
            metadata, riskId, RiskActionType.ESCALATED, reason, emptyMap(), ownerRelationshipId,
            severity, level, at,
        )
    }

    fun escalateDue(principalId: UUID, at: Instant, limit: Int, correlationId: UUID): List<CommandResult> {
        if (limit !in 1..100) throw InvalidRiskRequestException()
        val candidates = transactions.execute { risks.dueEscalations(at, DUE_SCAN_LIMIT) }!!
        return processDue("escalation", candidates, limit, DueRiskEscalation::riskId) { escalation ->
            val level = escalation.level ?: throw InvalidRiskActionException()
            val severity = try {
                escalation.severityKey?.let(RiskSeverity::valueOf)
            } catch (_: IllegalArgumentException) {
                throw InvalidRiskActionException()
            }
            if (escalation.ownerRelationshipId == null && severity == null) throw InvalidRiskActionException()
            val version = risks.get(escalation.riskId).rowVersion
            val metadata = CommandMetadata(
                principalId, "risk.escalate", "due-${escalation.riskId}-$level",
                version, correlationId,
            )
            action(
                metadata, escalation.riskId, RiskActionType.ESCALATED,
                "SLA escalation level $level", emptyMap(), escalation.ownerRelationshipId,
                severity, level, at,
            )
        }
    }

    fun recordDueSlaBreaches(principalId: UUID, at: Instant, limit: Int, correlationId: UUID): List<CommandResult> {
        if (limit !in 1..100) throw InvalidRiskRequestException()
        val candidates = transactions.execute { risks.dueSlaBreaches(at, DUE_SCAN_LIMIT) }!!
        return processDue("sla-breach", candidates, limit, RiskRecord::id) { risk ->
            action(
                CommandMetadata(
                    principalId, "risk.sla_breach", "sla-${risk.id}-${risk.dueAt}",
                    risk.rowVersion, correlationId,
                ),
                risk.id,
                RiskActionType.SLA_BREACHED,
                "Risk SLA breached",
                at = at,
            )
        }
    }

    fun interventionQueue(
        principalId: UUID,
        correlationId: UUID,
        filters: RiskQueueFilters,
        at: Instant,
        limit: Int,
        cursor: String? = null,
    ): RiskQueuePage = interventionQueue(
        principalId, DEFAULT_CUSTOMER_ID, correlationId, filters, at, limit, cursor,
    )

    fun interventionQueue(
        principalId: UUID,
        customerInstanceId: UUID,
        correlationId: UUID,
        filters: RiskQueueFilters,
        at: Instant,
        limit: Int,
        cursor: String? = null,
    ): RiskQueuePage {
        if (limit !in 1..100) throw InvalidRiskRequestException()
        val context = queueContext(customerInstanceId, filters, at)
        val after = cursor?.let { decodeTuple(cursors.decode(it, context)) }
        return transactions.execute {
            val authorized = mutableListOf<RiskQueueItem>()
            var position = after?.let { RiskRepository.QueuePosition(it.dueAt, it.severityRank, it.id) }
            do {
                val candidates = risks.queue(filters, at, QUEUE_BATCH_SIZE, position)
                for (risk in candidates) {
                    position = RiskRepository.QueuePosition(risk.dueAt, rank(risk.severity), risk.id)
                    if (!allowed(principalId, correlationId, "risk.read", risk)) continue
                    val reason = if (allowed(principalId, correlationId, "risk.reason.read", risk)) risk.reason else null
                    authorized += RiskQueueItem(
                        risk.id, risk.targetEntityId, risk.severity, risk.state, reason, risk.dueAt,
                        risk.ownerRelationshipId, risk.rowVersion,
                    )
                    if (authorized.size > limit) break
                }
            } while (authorized.size <= limit && candidates.size == QUEUE_BATCH_SIZE)
            val items = authorized.take(limit)
            val next = if (authorized.size > limit && items.isNotEmpty()) {
                cursors.encode(context, encodeTuple(items.last()))
            } else null
            RiskQueuePage(items, next)
        }!!
    }

    fun adjudicate(metadata: CommandMetadata, request: RiskAdjudicationRequest): CommandResult {
        val aggregateId = adjudicationAggregateId(request.knownEventKey, request.targetEntityId)
        return commands.execute(
            metadata,
            requestBytes(mapOf(
                "reportingPeriodStart" to request.reportingPeriodStart.toString(),
                "reportingPeriodEnd" to request.reportingPeriodEnd.toString(),
                "knownEventKey" to request.knownEventKey,
                "targetEntityId" to request.targetEntityId.toString(),
                "severeEvent" to request.severeEvent,
                "riskId" to request.riskId?.toString(),
                "outcome" to request.outcome.name,
                "reason" to request.reason,
            )),
            AdjudicateRiskCommand(
                aggregateId, request, request.targetEntityId, request.riskId ?: request.targetEntityId,
            ),
        )
    }

    fun metrics(
        principalId: UUID,
        customerInstanceId: UUID,
        correlationId: UUID,
        start: LocalDate,
        end: LocalDate,
    ): RiskMetrics {
        if (end <= start) throw InvalidRiskRequestException()
        if (!metricsProperties.enabled) throw AuthorizationAvailabilityException()
        val reportResourceId = metricsProperties.reportResourceUuid ?: throw AuthorizationAvailabilityException()
        return transactions.execute {
            authorization.authorize(AuthorizationRequest(
                UUID.randomUUID(), principalId, "risk.metrics.read", reportResourceId, reportResourceId,
                mapOf(
                    "customerInstanceId" to customerInstanceId.toString(),
                    "reportingPeriodStart" to start.toString(),
                    "reportingPeriodEnd" to end.toString(),
                ),
                correlationId,
            ))
            risks.metrics(start, end)
        }!!
    }

    private fun action(
        metadata: CommandMetadata,
        riskId: UUID,
        type: RiskActionType,
        reason: String,
        data: Map<String, String> = emptyMap(),
        ownerRelationshipId: UUID? = null,
        severity: RiskSeverity? = null,
        escalationLevel: Int? = null,
        at: Instant? = null,
    ): CommandResult {
        if (metadata.expectedVersion == null) throw InvalidExpectedVersionException()
        return commands.execute(
            metadata,
            requestBytes(mapOf(
                "riskId" to riskId.toString(), "actionType" to type.name, "reason" to reason, "data" to data,
                "ownerRelationshipId" to ownerRelationshipId?.toString(), "severity" to severity?.name,
                "escalationLevel" to escalationLevel, "evaluatedAt" to at?.toString(),
            )),
            RiskActionCommand(riskId, type, reason, data, ownerRelationshipId, severity, escalationLevel, at),
        )
    }

    private fun <T> processDue(
        type: String,
        candidates: List<T>,
        limit: Int,
        riskId: (T) -> UUID,
        execute: (T) -> CommandResult,
    ): List<CommandResult> {
        val results = mutableListOf<CommandResult>()
        for (candidate in candidates) {
            if (results.size == limit) break
            try {
                results += execute(candidate)
            } catch (failure: Exception) {
                LOG.warn(
                    "Risk due item failed type={} riskId={} failure={}",
                    type, riskId(candidate), failure.javaClass.name,
                )
            }
        }
        return results
    }

    private fun allowed(principalId: UUID, correlationId: UUID, action: String, risk: RiskRecord): Boolean = try {
        authorization.authorize(AuthorizationRequest(
            UUID.randomUUID(), principalId, action, risk.targetEntityId, risk.id,
            mapOf("riskState" to risk.state.name, "severity" to risk.severity.name), correlationId,
        ))
        true
    } catch (_: AuthorizationDeniedException) {
        false
    }

    private fun queueContext(customerInstanceId: UUID, filters: RiskQueueFilters, evaluatedAt: Instant) = CursorContext(
        "risk.intervention-queue",
        customerInstanceId,
        json(mapOf(
            "severities" to filters.severities.map(Enum<*>::name).sorted(),
            "states" to filters.states.map(Enum<*>::name).sorted(),
            "slaStatus" to filters.slaStatus?.name,
            "targetEntityId" to filters.targetEntityId?.toString(),
            "ownerRelationshipId" to filters.ownerRelationshipId?.toString(),
            "evaluatedAt" to evaluatedAt.toString(),
        )),
        "risk-due-severity-id",
        1,
        CursorDirection.FORWARD,
    )

    private data class QueueTuple(val dueAt: Instant?, val severityRank: Int, val id: UUID)

    private fun encodeTuple(item: RiskQueueItem): ArrayNode = MAPPER.createArrayNode().apply {
        item.dueAt?.let { add(it.toString()) } ?: addNull()
        add(rank(item.severity))
        add(item.id.toString())
    }

    private fun decodeTuple(tuple: ArrayNode): QueueTuple {
        if (tuple.size() != 3 || !(tuple[0].isNull || tuple[0].isTextual) || !tuple[1].isInt || !tuple[2].isTextual) {
            throw IllegalArgumentException("Invalid risk queue cursor")
        }
        return QueueTuple(tuple[0].takeUnless(JsonNode::isNull)?.textValue()?.let(Instant::parse), tuple[1].intValue(),
            UUID.fromString(tuple[2].textValue()))
    }

    private fun rank(severity: RiskSeverity): Int = when (severity) {
        RiskSeverity.RED -> 2
        RiskSeverity.YELLOW -> 1
        RiskSeverity.INFO -> 0
    }

    private inner class CreateRiskCommand(
        private val commandId: UUID,
        private val riskId: UUID,
        private val decision: RiskDecision,
    ) : AuthorizedCommand {
        override val action = "risk.create"
        override val entityId = decision.targetEntityId
        override val resourceId = decision.targetEntityId
        override val aggregateType = "risk-occurrence-command"
        override val aggregateId = commandId
        override val expectedVersionRequired = false
        override val changesAuthorizationFacts = false
        private var existing: RiskRecord? = null

        override fun lockCurrentVersion(context: CommandContext): Long? {
            risks.lockOccurrenceIdentity(decision.ruleDefinitionId, decision.targetEntityId, decision.occurrenceKey)
            existing = risks.lockByOccurrence(decision.ruleDefinitionId, decision.targetEntityId, decision.occurrenceKey)
            return null
        }

        override fun execute(context: CommandContext): CommandMutation {
            existing?.let { risk ->
                return mutation(
                    context, 200, commandId, null, 0, "risk.occurrence_observed",
                    mapOf(
                        "riskId" to risk.id.toString(), "targetEntityId" to risk.targetEntityId.toString(),
                        "severity" to risk.severity.name, "state" to risk.state.name, "version" to risk.rowVersion,
                    ),
                    null,
                    aggregateType = "risk-occurrence-command",
                )
            }
            val owner = risks.resolveOwner(decision.ruleDefinitionId, decision.targetEntityId, decision.ownerRelationship)
            risks.create(riskId, decision, owner)
            val eventId = UUID.randomUUID()
            notifications.emit(RiskNotificationIntent(
                eventId, context.metadata.principalId, context.metadata.correlationId, context.transactionId,
                owner, "RISK_OPENED", decision.severity, riskId,
                mapOf("riskId" to riskId.toString(), "severity" to decision.severity.name, "dueAt" to decision.dueAt.toString()),
            ))
            return mutation(
                context, 201, commandId, null, 0, "risk.opened",
                mapOf("riskId" to riskId.toString(), "targetEntityId" to decision.targetEntityId.toString(),
                    "severity" to decision.severity.name, "state" to RiskState.OPEN.name, "dueAt" to decision.dueAt.toString()),
                null,
                aggregateType = "risk-occurrence-command",
            )
        }
    }

    private inner class RiskActionCommand(
        private val id: UUID,
        private val type: RiskActionType,
        private val reason: String,
        private val data: Map<String, String>,
        private val ownerRelationshipId: UUID?,
        private val severity: RiskSeverity?,
        private val escalationLevel: Int?,
        private val at: Instant?,
    ) : AuthorizedCommand {
        override val action = if (type == RiskActionType.SLA_BREACHED) "risk.sla_breach" else "risk.${type.name.lowercase()}"
        override val entityId = id
        override val resourceId = id
        override val aggregateType = "risk"
        override val aggregateId = id
        override val expectedVersionRequired = true
        override val changesAuthorizationFacts = false
        private lateinit var current: RiskRecord

        override fun lockCurrentVersion(context: CommandContext): Long {
            current = risks.lock(id)
            if (current.state in TERMINAL_STATES) throw TerminalRiskException()
            return current.rowVersion
        }

        override fun execute(context: CommandContext): CommandMutation {
            validateTransition(current, type)
            if (type == RiskActionType.ASSIGNED && ownerRelationshipId == null) throw InvalidRiskActionException()
            if (ownerRelationshipId != null && !risks.ownerBelongsToTarget(ownerRelationshipId, current.targetEntityId)) {
                throw InvalidRiskActionException()
            }
            if (type == RiskActionType.ESCALATED && escalationLevel != null &&
                risks.escalationLevelExists(id, escalationLevel)
            ) {
                throw EscalationLevelConflictException(id, escalationLevel)
            }
            val actionData = LinkedHashMap(data).apply {
                ownerRelationshipId?.let { put("ownerRelationshipId", it.toString()) }
                severity?.let { put("severity", it.name) }
                escalationLevel?.let { put("escalationLevel", it.toString()) }
            }
            risks.appendAction(id, context.metadata.principalId, type, reason, actionData, escalationLevel)
            val nextState = when (type) {
                RiskActionType.ACKNOWLEDGED -> RiskState.ACKNOWLEDGED
                RiskActionType.RESOLVED -> RiskState.RESOLVED
                RiskActionType.DISMISSED -> RiskState.DISMISSED
                else -> null
            }
            risks.updateHead(
                id, nextState, ownerRelationshipId, severity, escalationLevel,
                escalatedAt = if (type == RiskActionType.ESCALATED) requireNotNull(at) else null,
            )
            val updated = risks.get(id)
            val eventType = "risk.${type.name.lowercase()}"
            if (type == RiskActionType.ESCALATED || type == RiskActionType.SLA_BREACHED) {
                val notificationType = if (type == RiskActionType.ESCALATED) "RISK_ESCALATED" else "RISK_SLA_BREACHED"
                notifications.emit(RiskNotificationIntent(
                    UUID.randomUUID(), context.metadata.principalId, context.metadata.correlationId, context.transactionId,
                    requireNotNull(updated.ownerRelationshipId), notificationType, updated.severity, id,
                    buildMap {
                        put("riskId", id.toString())
                        put("severity", updated.severity.name)
                        escalationLevel?.let { put("level", it.toString()) }
                    },
                ))
            }
            return mutation(
                context, 200, id, current.rowVersion, updated.rowVersion, eventType,
                mapOf("riskId" to id.toString(), "state" to updated.state.name,
                    "severity" to updated.severity.name, "version" to updated.rowVersion,
                    "escalationLevel" to escalationLevel),
                reason,
            )
        }
    }

    private inner class AdjudicateRiskCommand(
        private val id: UUID,
        private val request: RiskAdjudicationRequest,
        override val entityId: UUID,
        override val resourceId: UUID,
    ) : AuthorizedCommand {
        override val action = "risk.adjudicate"
        override val aggregateType = "risk-adjudication"
        override val aggregateId = id
        override val expectedVersionRequired = true
        override val changesAuthorizationFacts = false
        private var prior: RiskAdjudicationRecord? = null

        override fun lockCurrentVersion(context: CommandContext): Long {
            risks.lockAdjudicationIdentity(request.knownEventKey, request.targetEntityId)
            val linkedRisk = request.riskId?.let(risks::lock)
            if (linkedRisk != null && linkedRisk.targetEntityId != request.targetEntityId) {
                throw InvalidRiskActionException()
            }
            prior = risks.latestAdjudication(request.knownEventKey, request.targetEntityId, lock = true)
            return prior?.version?.toLong() ?: 0
        }

        override fun execute(context: CommandContext): CommandMutation {
            val adjudicationId = risks.appendAdjudication(context.metadata.principalId, request, prior)
            val after = (prior?.version ?: 0).toLong() + 1
            return mutation(
                context, 201, id, after - 1, after, "risk.adjudicated",
                mapOf("adjudicationId" to adjudicationId.toString(), "knownEventKey" to request.knownEventKey,
                    "targetEntityId" to request.targetEntityId.toString(), "outcome" to request.outcome.name,
                    "version" to after),
                request.reason,
                aggregateType = "risk-adjudication",
            )
        }
    }

    private fun validateTransition(risk: RiskRecord, type: RiskActionType) {
        if (risk.state in TERMINAL_STATES) throw TerminalRiskException()
        if (type == RiskActionType.ACKNOWLEDGED && risk.state != RiskState.OPEN) throw InvalidRiskActionException()
    }

    private fun mutation(
        context: CommandContext,
        status: Int,
        aggregateId: UUID,
        before: Long?,
        after: Long,
        eventType: String,
        fields: Map<String, Any?>,
        reason: String?,
        aggregateType: String = "risk",
    ): CommandMutation {
        val payload = json(fields)
        return CommandMutation(
            status, payload, context.descriptor.resourceId, aggregateId, aggregateType, before, after,
            reason, json(mapOf("eventType" to eventType)),
            listOf(PendingEventSpec(eventType, 1, payload, after)),
        )
    }

    private fun requestBytes(fields: Map<String, Any?>): ByteArray = MAPPER.writeValueAsBytes(fields)
    private fun json(fields: Map<String, Any?>): CanonicalJsonObject = CanonicalJsonObject.from(MAPPER.valueToTree(fields))

    private fun decisionRequest(decision: RiskDecision): Map<String, Any?> = mapOf(
        "occurrenceKey" to decision.occurrenceKey,
        "ruleDefinitionId" to decision.ruleDefinitionId.toString(),
        "packageId" to decision.packageId,
        "packageVersion" to decision.packageVersion,
        "ruleId" to decision.ruleId,
        "targetEntityId" to decision.targetEntityId.toString(),
        "severity" to decision.severity.name,
        "reason" to decision.reason,
        "dueAt" to decision.dueAt.toString(),
        "ownerRelationship" to decision.ownerRelationship,
        "escalationSteps" to decision.escalationSteps.map { step ->
            mapOf(
                "after" to step.after.toString(),
                "ownerRelationship" to step.ownerRelationship,
                "severity" to step.severity?.name,
            )
        },
        "evaluatedAt" to decision.evaluatedAt.toString(),
        "detectedAt" to decision.detectedAt.toString(),
        "calendarVersion" to decision.calendarVersion,
        "thresholdKind" to decision.thresholdKind.name,
        "triggeringFactIds" to decision.triggeringFactIds.map(UUID::toString),
        "thresholdWindowIdentity" to decision.thresholdWindowIdentity,
        "factValues" to factValuesRequest(decision.factValues),
    )

    private fun factValuesRequest(values: RiskFactValues): Map<String, Any?> = when (values) {
        is RiskFactValues.CriticalWork -> mapOf(
            "type" to "CRITICAL_WORK", "dueAt" to values.dueAt.toString(), "critical" to values.critical,
            "completedAt" to values.completedAt?.toString(),
        )
        RiskFactValues.ConsecutiveReturns -> mapOf("type" to "CONSECUTIVE_RETURNS")
        is RiskFactValues.Inactivity -> mapOf("type" to "INACTIVITY", "lastActivityAt" to values.lastActivityAt.toString())
        is RiskFactValues.Blocker -> mapOf(
            "type" to "BLOCKER", "blockedAt" to values.blockedAt.toString(),
            "resolvedAt" to values.resolvedAt?.toString(),
        )
        is RiskFactValues.EvidenceFailure -> mapOf("type" to "EVIDENCE_FAILURE", "failed" to values.failed)
        is RiskFactValues.MissingEvidence -> mapOf(
            "type" to "MISSING_EVIDENCE", "critical" to values.critical, "missing" to values.missing,
        )
        is RiskFactValues.ResourceConflict -> mapOf(
            "type" to "RESOURCE_CONFLICT", "startsAt" to values.startsAt.toString(),
        )
    }

    companion object {
        private const val QUEUE_BATCH_SIZE = 128
        private const val DUE_SCAN_LIMIT = 100
        private val DEFAULT_CUSTOMER_ID = UUID.fromString("00000000-0000-7000-8000-000000000001")
        private val TERMINAL_STATES = setOf(RiskState.RESOLVED, RiskState.DISMISSED)
        private val MAPPER = ObjectMapper().findAndRegisterModules()
        private val LOG = LoggerFactory.getLogger(RiskService::class.java)

        private fun adjudicationAggregateId(eventKey: String, targetEntityId: UUID): UUID = UUID.nameUUIDFromBytes(
            "risk-adjudication:$eventKey:$targetEntityId".toByteArray(StandardCharsets.UTF_8),
        )

        private fun commandInvocationId(metadata: CommandMetadata): UUID = UUID.nameUUIDFromBytes(
            (
                "risk-occurrence-command:${metadata.principalId}:${metadata.commandKey.length}:${metadata.commandKey}:" +
                    "${metadata.idempotencyKey.length}:${metadata.idempotencyKey}"
            ).toByteArray(StandardCharsets.UTF_8),
        )
    }
}
