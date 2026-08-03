package com.innorder.occ.command

import org.springframework.jdbc.core.JdbcOperations
import org.springframework.stereotype.Component
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Collections
import java.util.UUID

data class AggregateReference(
    val type: String,
    val id: UUID,
)

class AggregateLockPlan(
    existing: List<AggregateReference> = emptyList(),
    created: List<AggregateReference> = emptyList(),
    // Aggregates whose first command creates the row and whose later commands
    // advance it. The row's presence decides which case applies, under the same
    // advisory lock that serializes concurrent first writers.
    upserted: List<AggregateReference> = emptyList(),
) {
    val existing: List<AggregateReference> = Collections.unmodifiableList(existing.toList())
    val created: List<AggregateReference> = Collections.unmodifiableList(created.toList())
    val upserted: List<AggregateReference> = Collections.unmodifiableList(upserted.toList())

    internal val all: List<AggregateReference> = Collections.unmodifiableList(
        this.existing + this.created + this.upserted,
    )
}

class AggregateLockResolver(
    val type: String,
    val order: Int,
    val lock: (JdbcOperations, UUID) -> Long?,
)

internal data class AcquiredAggregateLocks(
    val versions: Map<AggregateReference, Long>,
    val created: Set<AggregateReference>,
)

@Component
class AggregateLockRegistry(resolvers: List<AggregateLockResolver>) {
    private val resolversByType = resolvers.associateBy { it.type }.also {
        check(it.size == resolvers.size) { "Aggregate lock resolver types must be unique" }
        check(resolvers.all { resolver -> CommandExecutor.ACTION.matches(resolver.type) }) {
            "Aggregate lock resolver type is invalid"
        }
    }

    internal fun validate(plan: AggregateLockPlan?, primary: AggregateReference) {
        if (plan == null) throw InvalidCommandRequestException()
        val all = plan.all
        if (all.isEmpty() || all.toSet().size != all.size ||
            all.count { it == primary } != 1 || all.any { !valid(it) || it.type !in resolversByType }
        ) throw InvalidCommandRequestException()
    }

    internal fun acquire(jdbc: JdbcOperations, plan: AggregateLockPlan): AcquiredAggregateLocks {
        val existing = plan.existing.toSet()
        val upserted = plan.upserted.toSet()
        val ordered = plan.all.sortedWith(
            compareBy<AggregateReference>({ resolversByType.getValue(it.type).order }, { it.id.toString() }, { it.type }),
        )
        val versions = linkedMapOf<AggregateReference, Long>()
        val created = plan.created.toMutableSet()
        ordered.forEach { reference ->
            if (reference in existing) {
                val version = resolversByType.getValue(reference.type).lock(jdbc, reference.id)
                    ?: throw InvalidCommandRequestException()
                if (version !in 0..CommandExecutor.MAX_SAFE_INTEGER) throw InvalidCommandRequestException()
                versions[reference] = version
            } else {
                jdbc.queryForObject(
                    "SELECT pg_advisory_xact_lock(?)",
                    { _, _ -> Unit },
                    advisoryLockKey(reference),
                )
                val version = resolversByType.getValue(reference.type).lock(jdbc, reference.id)
                if (reference in upserted && version != null) {
                    if (version !in 0..CommandExecutor.MAX_SAFE_INTEGER) throw InvalidCommandRequestException()
                    versions[reference] = version
                } else if (version != null) {
                    throw InvalidCommandRequestException()
                } else {
                    created.add(reference)
                }
            }
        }
        return AcquiredAggregateLocks(
            Collections.unmodifiableMap(versions),
            Collections.unmodifiableSet(created),
        )
    }

    internal fun verifyVersions(
        jdbc: JdbcOperations,
        changes: List<AggregateChange>,
    ) {
        changes.sortedWith(
            compareBy<AggregateChange>({ resolversByType.getValue(it.ref.type).order }, { it.ref.id.toString() }, { it.ref.type }),
        ).forEach { change ->
            if (resolversByType.getValue(change.ref.type).lock(jdbc, change.ref.id) != change.afterVersion) {
                throw InvalidCommandRequestException()
            }
        }
    }

    private fun valid(reference: AggregateReference): Boolean =
        CommandExecutor.ACTION.matches(reference.type) && reference.id != UUID(0, 0) &&
            reference.id.version() in 1..8 && reference.id.variant() == 2

    companion object {
        internal fun advisoryLockKey(reference: AggregateReference): Long {
            val identity = "${reference.type}\u0000${reference.id}".toByteArray(StandardCharsets.UTF_8)
            return ByteBuffer.wrap(MessageDigest.getInstance("SHA-256").digest(identity)).long
        }
    }
}
