package com.innorder.occ.risk

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import com.innorder.occ.api.CursorCodec
import com.innorder.occ.api.CursorContext
import com.innorder.occ.api.CursorDirection
import com.innorder.occ.authz.AuthorizationDeniedException
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
import org.springframework.dao.DataIntegrityViolationException
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
) {
    private val transactions = TransactionTemplate(transactionManager).apply {
        propagationBehavior = TransactionDefinition.PROPAGATION_REQUIRED
    }

    fun create(metadata: CommandMetadata, decision: RiskDecision): CommandResult {
        if (metadata.expectedVersion != null) throw InvalidExpectedVersionException()
        val id = RiskRepository.deterministicRiskId(decision)
        return try {
            commands.execute(metadata, requestBytes(mapOf("occurrenceKey" to decision.occurrenceKey)), CreateRiskCommand(id, decision))
                .copy(resourceId = id)
        } catch (failure: DataIntegrityViolationException) {
            risks.findByOccurrence(decision.ruleDefinitionId, decision.targetEntityId, decision.occurrenceKey)
                ?.let(::duplicateResult) ?: throw failure
        }
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
        require(level >= 0 && (ownerRelationshipId != null || severity != null))
        return action(
            metadata, riskId, RiskActionType.ESCALATED, reason, emptyMap(), ownerRelationshipId,
            severity, level, at,
        )
    }

    fun escalateDue(principalId: UUID, at: Instant, limit: Int, correlationId: UUID): List<CommandResult> {
        require(limit in 1..100)
        return transactions.execute {
            risks.dueEscalations(at, limit).map { escalation ->
                val version = risks.get(escalation.riskId).rowVersion
                val metadata = CommandMetadata(
                    principalId, "risk.escalate", "due-${escalation.riskId}-${escalation.level}",
                    version, correlationId,
                )
                action(
                    metadata, escalation.riskId, RiskActionType.ESCALATED,
                    "SLA escalation level ${escalation.level}", emptyMap(), escalation.ownerRelationshipId,
                    escalation.severity, escalation.level, at,
                )
            }
        }!!
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
        require(limit in 1..100)
        val context = queueContext(customerInstanceId, filters)
        val after = cursor?.let { decodeTuple(cursors.decode(it, context)) }
        return transactions.execute {
            val authorized = mutableListOf<RiskQueueItem>()
            for (risk in risks.queue(filters, at, MAX_QUEUE_SCAN)) {
                if (after != null && compare(tuple(risk), after) <= 0) continue
                if (!allowed(principalId, correlationId, "risk.read", risk)) continue
                val reason = if (allowed(principalId, correlationId, "risk.reason.read", risk)) risk.reason else null
                authorized += RiskQueueItem(
                    risk.id, risk.targetEntityId, risk.severity, risk.state, reason, risk.dueAt,
                    risk.ownerRelationshipId, risk.rowVersion,
                )
                if (authorized.size > limit) break
            }
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
                "knownEventKey" to request.knownEventKey,
                "outcome" to request.outcome.name,
                "riskId" to request.riskId?.toString(),
            )),
            AdjudicateRiskCommand(aggregateId, request),
        )
    }

    fun metrics(start: LocalDate, end: LocalDate): RiskMetrics {
        require(end > start)
        return risks.metrics(start, end)
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
                "riskId" to riskId.toString(), "reason" to reason, "data" to data,
                "ownerRelationshipId" to ownerRelationshipId?.toString(), "severity" to severity?.name,
                "escalationLevel" to escalationLevel,
            )),
            RiskActionCommand(riskId, type, reason, data, ownerRelationshipId, severity, escalationLevel, at),
        )
    }

    private fun duplicateResult(risk: RiskRecord): CommandResult = CommandResult(
        200,
        json(mapOf("riskId" to risk.id.toString(), "state" to risk.state.name, "version" to risk.rowVersion)),
        risk.id,
        replayed = true,
    )

    private fun allowed(principalId: UUID, correlationId: UUID, action: String, risk: RiskRecord): Boolean = try {
        authorization.authorize(AuthorizationRequest(
            UUID.randomUUID(), principalId, action, risk.targetEntityId, risk.id,
            mapOf("riskState" to risk.state.name, "severity" to risk.severity.name), correlationId,
        ))
        true
    } catch (_: AuthorizationDeniedException) {
        false
    }

    private fun queueContext(customerInstanceId: UUID, filters: RiskQueueFilters) = CursorContext(
        "risk.intervention-queue",
        customerInstanceId,
        json(mapOf(
            "severities" to filters.severities.map(Enum<*>::name).sorted(),
            "states" to filters.states.map(Enum<*>::name).sorted(),
            "slaStatus" to filters.slaStatus?.name,
            "targetEntityId" to filters.targetEntityId?.toString(),
            "ownerRelationshipId" to filters.ownerRelationshipId?.toString(),
        )),
        "risk-due-severity-id",
        1,
        CursorDirection.FORWARD,
    )

    private data class QueueTuple(val dueAt: Instant?, val severityRank: Int, val id: UUID)

    private fun tuple(risk: RiskRecord) = QueueTuple(risk.dueAt, rank(risk.severity), risk.id)
    private fun tuple(item: RiskQueueItem) = QueueTuple(item.dueAt, rank(item.severity), item.id)

    private fun compare(left: QueueTuple, right: QueueTuple): Int {
        val due = when {
            left.dueAt == null && right.dueAt == null -> 0
            left.dueAt == null -> 1
            right.dueAt == null -> -1
            else -> left.dueAt.compareTo(right.dueAt)
        }
        if (due != 0) return due
        val severity = right.severityRank.compareTo(left.severityRank)
        return if (severity != 0) severity else left.id.toString().compareTo(right.id.toString())
    }

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

    private inner class CreateRiskCommand(private val id: UUID, private val decision: RiskDecision) : AuthorizedCommand {
        override val action = "risk.create"
        override val entityId = decision.targetEntityId
        override val resourceId = decision.targetEntityId
        override val aggregateType = "risk"
        override val aggregateId = id
        override val expectedVersionRequired = false
        override val changesAuthorizationFacts = false

        override fun lockCurrentVersion(context: CommandContext): Long? = null

        override fun execute(context: CommandContext): CommandMutation {
            val owner = risks.resolveOwner(decision.ruleDefinitionId, decision.targetEntityId, decision.ownerRelationship)
            risks.create(id, decision, owner)
            val eventId = UUID.randomUUID()
            notifications.emit(RiskNotificationIntent(
                eventId, context.metadata.principalId, context.metadata.correlationId, context.transactionId,
                owner, "RISK_OPENED", decision.severity, id,
                mapOf("riskId" to id.toString(), "severity" to decision.severity.name, "dueAt" to decision.dueAt.toString()),
            ))
            return mutation(
                context, 201, id, null, 0, "risk.opened",
                mapOf("riskId" to id.toString(), "targetEntityId" to decision.targetEntityId.toString(),
                    "severity" to decision.severity.name, "state" to RiskState.OPEN.name, "dueAt" to decision.dueAt.toString()),
                null,
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
        override val action = "risk.${type.name.lowercase()}"
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
            if (type == RiskActionType.ESCALATED) {
                notifications.emit(RiskNotificationIntent(
                    UUID.randomUUID(), context.metadata.principalId, context.metadata.correlationId, context.transactionId,
                    requireNotNull(updated.ownerRelationshipId), "RISK_ESCALATED", updated.severity, id,
                    mapOf("riskId" to id.toString(), "severity" to updated.severity.name,
                        "level" to requireNotNull(escalationLevel).toString()),
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
    ) : AuthorizedCommand {
        override val action = "risk.adjudicate"
        override val entityId = request.targetEntityId
        override val resourceId = request.targetEntityId
        override val aggregateType = "risk-adjudication"
        override val aggregateId = id
        override val expectedVersionRequired = true
        override val changesAuthorizationFacts = false
        private var prior: RiskAdjudicationRecord? = null

        override fun lockCurrentVersion(context: CommandContext): Long {
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

    companion object {
        private const val MAX_QUEUE_SCAN = 512
        private val DEFAULT_CUSTOMER_ID = UUID.fromString("00000000-0000-7000-8000-000000000001")
        private val TERMINAL_STATES = setOf(RiskState.RESOLVED, RiskState.DISMISSED)
        private val MAPPER = ObjectMapper().findAndRegisterModules()

        private fun adjudicationAggregateId(eventKey: String, targetEntityId: UUID): UUID = UUID.nameUUIDFromBytes(
            "risk-adjudication:$eventKey:$targetEntityId".toByteArray(StandardCharsets.UTF_8),
        )
    }
}
