import io
import re

p = 'services/core/src/main/kotlin/com/innorder/occ/ai/KnowledgeCommandService.kt'
s = io.open(p, encoding='utf-8').read()

# Declare the aggregate lock once on the shared base command.
old_base = """    override val aggregateType = "knowledge-source"
    override val aggregateId = sourceId
    override val expectedVersionRequired = true
    override val changesAuthorizationFacts = false"""
new_base = """    override val aggregateType = KNOWLEDGE_SOURCE_AGGREGATE_TYPE
    override val aggregateId = sourceId
    override val expectedVersionRequired = true
    override val changesAuthorizationFacts = false
    override val lockPlan = AggregateLockPlan(
        existing = listOf(AggregateReference(KNOWLEDGE_SOURCE_AGGREGATE_TYPE, sourceId)),
    )"""
assert old_base in s
s = s.replace(old_base, new_base, 1)

# Emit aggregate changes and bind the event to its aggregate.
old_mutation = """    protected fun mutation(eventType: String, body: CanonicalJsonObject, detail: CanonicalJsonObject, payload: CanonicalJsonObject) = CommandMutation(
        status = 200, body = body, resourceId = sourceId, aggregateId = sourceId,
        aggregateType = aggregateType, beforeVersion = rowVersion, afterVersion = rowVersion + 1,
        auditReason = eventType, auditDetail = detail,
        events = listOf(PendingEventSpec(eventType, 1, payload, rowVersion + 1)),
    )"""
new_mutation = """    protected fun mutation(eventType: String, body: CanonicalJsonObject, detail: CanonicalJsonObject, payload: CanonicalJsonObject): CommandMutation {
        val aggregate = AggregateReference(KNOWLEDGE_SOURCE_AGGREGATE_TYPE, sourceId)
        return CommandMutation(
            status = 200, body = body, resourceId = sourceId,
            changes = listOf(AggregateChange(aggregate, rowVersion, rowVersion + 1)),
            auditReason = eventType, auditDetail = detail,
            events = listOf(PendingEventSpec(eventType, 1, payload, aggregate, rowVersion + 1)),
        )
    }"""
assert old_mutation in s
s = s.replace(old_mutation, new_mutation, 1)

# The kernel now acquires the aggregate lock before execute, so each command's
# former lockCurrentVersion body becomes a prelude inside execute.
pattern = re.compile(
    r'    override fun lockCurrentVersion\(context: CommandContext\): Long \{\n'
    r'(?P<body>.*?)'
    r'        return rowVersion\n    \}\n\n'
    r'    override fun execute\(context: CommandContext\): CommandMutation \{\n',
    re.S,
)


def fold(match):
    return ('    override fun execute(context: CommandContext): CommandMutation {\n'
            + match.group('body'))


s, count = pattern.subn(fold, s)
print('folded lockCurrentVersion bodies:', count)

s = s.replace(
    'import com.innorder.occ.command.AuthorizedCommand',
    'import com.innorder.occ.command.AggregateChange\n'
    'import com.innorder.occ.command.AggregateLockPlan\n'
    'import com.innorder.occ.command.AggregateReference\n'
    'import com.innorder.occ.command.AuthorizedCommand',
    1,
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('remaining lockCurrentVersion:', s.count('lockCurrentVersion'))
