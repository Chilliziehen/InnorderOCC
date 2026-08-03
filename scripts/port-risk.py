import io

p = 'services/core/src/main/kotlin/com/innorder/occ/risk/RiskService.kt'
s = io.open(p, encoding='utf-8').read()

pairs = []

# --- CreateRiskCommand -------------------------------------------------
# The occurrence-command row is derived from the idempotency identity, so the
# kernel always sees a fresh aggregate on both the new-risk and already-observed
# paths. The risk itself is created only on the first observation.
pairs.append((
"""        override val aggregateType = "risk-occurrence-command"
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
            existing?.let { risk ->""",
"""        override val aggregateType = RISK_OCCURRENCE_COMMAND_AGGREGATE_TYPE
        override val aggregateId = commandId
        override val expectedVersionRequired = false
        override val changesAuthorizationFacts = false
        override val lockPlan = AggregateLockPlan(
            created = listOf(AggregateReference(RISK_OCCURRENCE_COMMAND_AGGREGATE_TYPE, commandId)),
        )

        override fun execute(context: CommandContext): CommandMutation {
            risks.lockOccurrenceIdentity(decision.ruleDefinitionId, decision.targetEntityId, decision.occurrenceKey)
            val existing = risks.lockByOccurrence(decision.ruleDefinitionId, decision.targetEntityId, decision.occurrenceKey)
            existing?.let { risk ->
                risks.recordOccurrenceCommand(commandId, decision, risk.id, observedExisting = true)"""))

pairs.append((
"""                return mutation(
                    context, 200, commandId, null, 0, "risk.occurrence_observed",""",
"""                return mutation(
                    context, 200, commandId, 0, 1, "risk.occurrence_observed","""))

pairs.append((
"""            val owner = risks.resolveOwner(decision.ruleDefinitionId, decision.targetEntityId, decision.ownerRelationship)
            risks.create(riskId, decision, owner)""",
"""            val owner = risks.resolveOwner(decision.ruleDefinitionId, decision.targetEntityId, decision.ownerRelationship)
            risks.create(riskId, decision, owner)
            risks.recordOccurrenceCommand(commandId, decision, riskId, observedExisting = false)"""))

pairs.append((
"""            return mutation(
                context, 201, commandId, null, 0, "risk.opened",""",
"""            return mutation(
                context, 201, commandId, 0, 1, "risk.opened","""))

# --- RiskActionCommand -------------------------------------------------
pairs.append((
"""        override val aggregateType = "risk"
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
            validateTransition(current, type)""",
"""        override val aggregateType = RISK_AGGREGATE_TYPE
        override val aggregateId = id
        override val expectedVersionRequired = true
        override val changesAuthorizationFacts = false
        override val lockPlan = AggregateLockPlan(
            existing = listOf(AggregateReference(RISK_AGGREGATE_TYPE, id)),
        )
        private lateinit var current: RiskRecord

        override fun execute(context: CommandContext): CommandMutation {
            current = risks.lock(id)
            if (current.state in TERMINAL_STATES) throw TerminalRiskException()
            validateTransition(current, type)"""))

# --- AdjudicateRiskCommand ---------------------------------------------
# The series row is created by the first adjudication and advanced afterwards.
pairs.append((
"""        override val aggregateType = "risk-adjudication"
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
            val after = (prior?.version ?: 0).toLong() + 1""",
"""        override val aggregateType = RISK_ADJUDICATION_AGGREGATE_TYPE
        override val aggregateId = id
        override val expectedVersionRequired = true
        override val changesAuthorizationFacts = false
        override val lockPlan = AggregateLockPlan(
            upserted = listOf(AggregateReference(RISK_ADJUDICATION_AGGREGATE_TYPE, id)),
        )

        override fun execute(context: CommandContext): CommandMutation {
            risks.lockAdjudicationIdentity(request.knownEventKey, request.targetEntityId)
            val linkedRisk = request.riskId?.let(risks::lock)
            if (linkedRisk != null && linkedRisk.targetEntityId != request.targetEntityId) {
                throw InvalidRiskActionException()
            }
            val prior = risks.latestAdjudication(request.knownEventKey, request.targetEntityId, lock = true)
            val adjudicationId = risks.appendAdjudication(context.metadata.principalId, request, prior)
            val after = (prior?.version ?: 0).toLong() + 1
            risks.upsertAdjudicationSeries(id, request.knownEventKey, request.targetEntityId, after)"""))

pairs.append((
"""                request.reason,
                aggregateType = "risk-adjudication",
            )""",
"""                request.reason,
                aggregateType = RISK_ADJUDICATION_AGGREGATE_TYPE,
            )"""))

pairs.append((
"""                    null,
                    aggregateType = "risk-occurrence-command",
                )""",
"""                    null,
                    aggregateType = RISK_OCCURRENCE_COMMAND_AGGREGATE_TYPE,
                )"""))

pairs.append((
"""                null,
                aggregateType = "risk-occurrence-command",
            )""",
"""                null,
                aggregateType = RISK_OCCURRENCE_COMMAND_AGGREGATE_TYPE,
            )"""))

# --- mutation helper ---------------------------------------------------
pairs.append((
"""        val payload = json(fields)
        return CommandMutation(
            status, payload, context.descriptor.resourceId, aggregateId, aggregateType, before, after,
            reason, json(mapOf("eventType" to eventType)),
            listOf(PendingEventSpec(eventType, 1, payload, after)),
        )""",
"""        val payload = json(fields)
        val aggregate = AggregateReference(aggregateType, aggregateId)
        return CommandMutation(
            status, payload, context.descriptor.resourceId,
            listOf(AggregateChange(aggregate, before ?: 0, after)),
            reason, json(mapOf("eventType" to eventType)),
            listOf(PendingEventSpec(eventType, 1, payload, aggregate, after)),
        )"""))

pairs.append((
"import com.innorder.occ.command.AuthorizedCommand",
"import com.innorder.occ.command.AggregateChange\n"
"import com.innorder.occ.command.AggregateLockPlan\n"
"import com.innorder.occ.command.AggregateReference\n"
"import com.innorder.occ.command.AuthorizedCommand"))

for old, new in pairs:
    if old not in s:
        raise SystemExit('pattern not found:\n' + old[:200])
    s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('risk ported; remaining lockCurrentVersion:', s.count('lockCurrentVersion'))
