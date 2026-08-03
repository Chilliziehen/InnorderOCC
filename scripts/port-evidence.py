import io

repo = 'services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceRepository.kt'
s = io.open(repo, encoding='utf-8').read()

# Created aggregates land at version 1, matching the platform convention.
old = """            \"\"\"INSERT INTO occ.evidence
               (id, business_object_id, requirement_id, state, created_by, target_entity_id, slot_key)
               VALUES (?, ?, ?, 'PENDING', ?, ?, ?)\"\"\","""
new = """            \"\"\"INSERT INTO occ.evidence
               (id, business_object_id, requirement_id, state, created_by, target_entity_id, slot_key, row_version)
               VALUES (?, ?, ?, 'PENDING', ?, ?, ?, 1)\"\"\","""
if old in s:
        s = s.replace(old, new, 1)

anchor = "    fun createSession(record: EvidenceSessionRecord) {"
helper = '''    // Opening an upload session changes the evidence aggregate, so its row
    // version advances through the shared touch trigger.
    fun advanceHead(id: UUID): EvidenceHeadRecord {
        check(jdbc.update("UPDATE occ.evidence SET state = state WHERE id = ?", id) == 1)
        return getHead(id)
    }

'''
if 'fun advanceHead' not in s:
    assert anchor in s
    s = s.replace(anchor, helper + anchor, 1)
io.open(repo, 'w', encoding='utf-8', newline='').write(s)
print('repository updated')

p = 'services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceService.kt'
s = io.open(p, encoding='utf-8').read()

pairs = []

# --- CreateSessionCommand: the evidence head is the aggregate; the upload
# --- session is a child row written under that aggregate's lock.
pairs.append((
"""        override val aggregateType = "evidence-upload-session"
        override val aggregateId = sessionId
        override val changesAuthorizationFacts = false
        private var head: EvidenceHeadRecord? = null
        override fun lockCurrentVersion(context: CommandContext): Long? {
            context.jdbc.queryForObject("SELECT pg_advisory_xact_lock(hashtextextended(?,1163284054)) IS NULL", Boolean::class.java,
                "${request.targetEntityId}:${request.requirementId}:${request.slotKey}")
            head = evidence.findHead(request.targetEntityId, request.requirementId, request.slotKey)?.let { evidence.lockHead(it.id) }
            if ((head != null) != expectedVersionRequired) throw EvidenceUploadConflictException()
            return head?.rowVersion
        }
        override fun execute(context: CommandContext): CommandMutation {
            val current = head
            val evidenceId = current?.id ?: requestedEvidenceId.also {
                evidence.createHead(it, request.targetEntityId, request.requirementId, request.slotKey, context.metadata.principalId)
            }""",
"""        override val aggregateType = EVIDENCE_AGGREGATE_TYPE
        override val aggregateId = requestedEvidenceId
        override val changesAuthorizationFacts = false
        override val lockPlan = AggregateLockPlan(
            upserted = listOf(AggregateReference(EVIDENCE_AGGREGATE_TYPE, requestedEvidenceId)),
        )

        override fun execute(context: CommandContext): CommandMutation {
            context.jdbc.queryForObject("SELECT pg_advisory_xact_lock(hashtextextended(?,1163284054)) IS NULL", Boolean::class.java,
                "${request.targetEntityId}:${request.requirementId}:${request.slotKey}")
            val current = evidence.findHead(request.targetEntityId, request.requirementId, request.slotKey)
                ?.let { evidence.lockHead(it.id) }
            if ((current != null) != expectedVersionRequired) throw EvidenceUploadConflictException()
            val evidenceId = current?.id ?: requestedEvidenceId.also {
                evidence.createHead(it, request.targetEntityId, request.requirementId, request.slotKey, context.metadata.principalId)
            }
            val advanced = if (current == null) 1L else evidence.advanceHead(evidenceId).rowVersion"""))

pairs.append((
"""            return mutation(context, 201, current?.rowVersion, (current?.rowVersion ?: -1) + 1,
                "EVIDENCE_UPLOAD_CREATED", record.public(), eventId, null, sessionId)""",
"""            return mutation(context, 201, current?.rowVersion ?: 0, advanced,
                "EVIDENCE_UPLOAD_CREATED", record.public(), eventId, null, sessionId)"""))

# --- the four head commands lock through the plan instead of the removed hook
for holder in ('session.evidenceId', 'session.evidenceId', 'id'):
    pass

pairs.append((
"""        private lateinit var current: EvidenceHeadRecord
        override fun lockCurrentVersion(context: CommandContext) = evidence.lockHead(session.evidenceId).also { current = it }.rowVersion
        override fun execute(context: CommandContext): CommandMutation {
            val version = evidence.confirm(session, inspected, preview, sourceCleanup)""",
"""        private lateinit var current: EvidenceHeadRecord
        override val lockPlan = AggregateLockPlan(
            existing = listOf(AggregateReference(EVIDENCE_AGGREGATE_TYPE, session.evidenceId)),
        )

        override fun execute(context: CommandContext): CommandMutation {
            current = evidence.lockHead(session.evidenceId)
            val version = evidence.confirm(session, inspected, preview, sourceCleanup)"""))

pairs.append((
"""        private lateinit var current: EvidenceHeadRecord
        override fun lockCurrentVersion(context: CommandContext) = evidence.lockHead(session.evidenceId).also { current = it }.rowVersion
        override fun execute(context: CommandContext): CommandMutation {
            evidence.fail(session.id, failureCode, evidence.transactionTime().plus(ORPHAN_GRACE), quarantineStored)""",
"""        private lateinit var current: EvidenceHeadRecord
        override val lockPlan = AggregateLockPlan(
            existing = listOf(AggregateReference(EVIDENCE_AGGREGATE_TYPE, session.evidenceId)),
        )

        override fun execute(context: CommandContext): CommandMutation {
            current = evidence.lockHead(session.evidenceId)
            evidence.fail(session.id, failureCode, evidence.transactionTime().plus(ORPHAN_GRACE), quarantineStored)"""))

pairs.append((
"""        private lateinit var current: EvidenceHeadRecord
        override fun lockCurrentVersion(context: CommandContext) = evidence.lockHead(id).also { current = it }.rowVersion
        override fun execute(context: CommandContext): CommandMutation {
            if (current.state != EvidenceState.PENDING""",
"""        private lateinit var current: EvidenceHeadRecord
        override val lockPlan = AggregateLockPlan(
            existing = listOf(AggregateReference(EVIDENCE_AGGREGATE_TYPE, id)),
        )

        override fun execute(context: CommandContext): CommandMutation {
            current = evidence.lockHead(id)
            if (current.state != EvidenceState.PENDING"""))

pairs.append((
"""        private lateinit var current: EvidenceHeadRecord
        override fun lockCurrentVersion(context: CommandContext): Long {
            val initial = evidence.getHead(id)
            evidence.lockRequirementHeads(initial.targetId, initial.requirementId)
            current = evidence.lockHead(id)
            return current.rowVersion
        }
        override fun execute(context: CommandContext): CommandMutation {
            if (current.currentVersion != request.evidenceVersion) throw EvidenceReviewConflictException()""",
"""        private lateinit var current: EvidenceHeadRecord
        override val lockPlan = AggregateLockPlan(
            existing = listOf(AggregateReference(EVIDENCE_AGGREGATE_TYPE, id)),
        )

        override fun execute(context: CommandContext): CommandMutation {
            val initial = evidence.getHead(id)
            evidence.lockRequirementHeads(initial.targetId, initial.requirementId)
            current = evidence.lockHead(id)
            if (current.currentVersion != request.evidenceVersion) throw EvidenceReviewConflictException()"""))

pairs.append((
"""        return CommandMutation(
            status, canonical(bodyValue), context.descriptor.resourceId, context.descriptor.aggregateId,
            context.descriptor.aggregateType, before, after, reason, canonical(mapOf("eventType" to type, "eventId" to eventId.toString())),
            listOf(PendingEventSpec(type, 1, payload, after)),
        )""",
"""        val aggregate = AggregateReference(context.descriptor.aggregateType, context.descriptor.aggregateId)
        return CommandMutation(
            status, canonical(bodyValue), context.descriptor.resourceId,
            listOf(AggregateChange(aggregate, before ?: 0, after)),
            reason, canonical(mapOf("eventType" to type, "eventId" to eventId.toString())),
            listOf(PendingEventSpec(type, 1, payload, aggregate, after)),
        )"""))

for old, new in pairs:
    if old not in s:
        raise SystemExit('pattern not found:\n' + old[:200])
    s = s.replace(old, new, 1)

# Remaining literal aggregate types now reference the shared constant.
s = s.replace('override val aggregateType = "evidence"', 'override val aggregateType = EVIDENCE_AGGREGATE_TYPE')

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('evidence ported; remaining lockCurrentVersion:', s.count('lockCurrentVersion'))
