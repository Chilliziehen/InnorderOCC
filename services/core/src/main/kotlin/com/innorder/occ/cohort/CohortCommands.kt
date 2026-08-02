package com.innorder.occ.cohort

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import com.innorder.occ.catalog.UuidV5
import com.innorder.occ.command.AggregateChange
import com.innorder.occ.command.AggregateLockPlan
import com.innorder.occ.command.AggregateReference
import com.innorder.occ.command.AuthorizedCommand
import com.innorder.occ.command.CanonicalJsonObject
import com.innorder.occ.command.CommandContext
import com.innorder.occ.command.CommandExecutor
import com.innorder.occ.command.CommandMetadata
import com.innorder.occ.command.CommandMutation
import com.innorder.occ.command.PendingEventSpec
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.stereotype.Service
import java.util.UUID

class CohortNotFoundException : RuntimeException("Cohort was not found")
class CohortConflictException : RuntimeException("Cohort command conflicts with current state")

data class CohortCommandResult(
    val value: CohortDetail,
    val replayed: Boolean,
    val status: Int,
)

@Service
class CohortCommandService(
    private val executor: CommandExecutor,
    private val cohorts: CohortRepository,
    mapper: ObjectMapper,
) {
    private val mapper = mapper.copy().disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)

    fun create(
        principalId: UUID,
        idempotencyKey: String,
        correlationId: UUID,
        request: CreateCohortRequest,
    ): CohortCommandResult {
        val customerId = cohorts.customerRootId()
        val cohortId = UuidV5.from(CREATE_NAMESPACE, "$principalId\u0000$idempotencyKey")
        return execute(
            metadata(principalId, "cohort.create", idempotencyKey, null, correlationId),
            request,
            CreateCohortCommand(cohorts, mapper, cohortId, customerId, principalId, request),
        )
    }

    fun update(
        principalId: UUID,
        idempotencyKey: String,
        correlationId: UUID,
        cohortId: UUID,
        request: UpdateCohortRequest,
    ): CohortCommandResult = execute(
        metadata(principalId, "cohort.update", idempotencyKey, request.expectedVersion, correlationId),
        request,
        UpdateCohortCommand(cohorts, mapper, cohortId, principalId, request),
    )

    fun addMember(
        principalId: UUID,
        idempotencyKey: String,
        correlationId: UUID,
        cohortId: UUID,
        request: AddCohortMemberRequest,
    ): CohortCommandResult = execute(
        metadata(principalId, "cohort.members.add", idempotencyKey, request.expectedVersion, correlationId),
        request,
        AddCohortMemberCommand(cohorts, mapper, cohortId, principalId, request),
    )

    fun removeMember(
        principalId: UUID,
        idempotencyKey: String,
        correlationId: UUID,
        cohortId: UUID,
        request: RemoveCohortMemberRequest,
    ): CohortCommandResult = execute(
        metadata(principalId, "cohort.members.remove", idempotencyKey, request.expectedVersion, correlationId),
        request,
        RemoveCohortMemberCommand(cohorts, mapper, cohortId, principalId, request),
    )

    fun transferOwner(
        principalId: UUID,
        idempotencyKey: String,
        correlationId: UUID,
        cohortId: UUID,
        request: TransferCohortOwnerRequest,
    ): CohortCommandResult = execute(
        metadata(principalId, "cohort.owner.transfer", idempotencyKey, request.expectedVersion, correlationId),
        request,
        TransferCohortOwnerCommand(cohorts, mapper, cohortId, principalId, request),
    )

    fun archive(
        principalId: UUID,
        idempotencyKey: String,
        correlationId: UUID,
        cohortId: UUID,
        request: ArchiveCohortRequest,
    ): CohortCommandResult = execute(
        metadata(principalId, "cohort.archive", idempotencyKey, request.expectedVersion, correlationId),
        request,
        ArchiveCohortCommand(cohorts, mapper, cohortId, principalId, request),
    )

    private fun execute(metadata: CommandMetadata, request: Any, command: AuthorizedCommand): CohortCommandResult {
        val result = executor.execute(metadata, mapper.writeValueAsBytes(request), command)
        return CohortCommandResult(
            mapper.treeToValue(result.body.toJsonNode(), CohortDetail::class.java),
            result.replayed,
            result.status,
        )
    }

    private fun metadata(
        principalId: UUID,
        commandKey: String,
        idempotencyKey: String,
        expectedVersion: Long?,
        correlationId: UUID,
    ) = CommandMetadata(principalId, commandKey, idempotencyKey, expectedVersion, correlationId)

    private companion object {
        val CREATE_NAMESPACE: UUID = UUID.fromString("d9374553-0d83-5cc4-979f-fbde8b439229")
    }
}

private class CreateCohortCommand(
    private val cohorts: CohortRepository,
    private val mapper: ObjectMapper,
    override val aggregateId: UUID,
    private val customerId: UUID,
    private val actorId: UUID,
    private val request: CreateCohortRequest,
) : AuthorizedCommand {
    override val action = "cohort.create"
    override val entityId = customerId
    override val resourceId = customerId
    override val aggregateType = COHORT_AGGREGATE_TYPE
    override val expectedVersionRequired = false
    override val changesAuthorizationFacts = true
    override val lockPlan = AggregateLockPlan(created = listOf(AggregateReference(aggregateType, aggregateId)))

    override fun execute(context: CommandContext): CommandMutation {
        if (!cohorts.publishedPackage(request.packageVersionId) || !cohorts.activeProcessOwner(request.ownerPrincipalId)) {
            throw CohortConflictException()
        }
        val created = try {
            cohorts.beginAuthorizationChange()
            val value = cohorts.create(aggregateId, customerId, request, actorId)
            cohorts.finishAuthorizationChange()
            value
        } catch (_: DataIntegrityViolationException) {
            throw CohortConflictException()
        }
        val aggregate = AggregateReference(aggregateType, aggregateId)
        return CommandMutation(
            201,
            json(mapper, created),
            resourceId,
            listOf(AggregateChange(aggregate, 0, 1)),
            null,
            json(mapper, mapOf("cohortId" to aggregateId, "status" to created.status.name)),
            listOf(
                PendingEventSpec(
                    "cohort.created",
                    1,
                    json(
                        mapper,
                        mapOf(
                            "cohortId" to aggregateId,
                            "packageVersionId" to request.packageVersionId,
                            "ownerPrincipalId" to request.ownerPrincipalId,
                            "status" to created.status.name,
                        ),
                    ),
                    aggregate,
                    1,
                ),
            ),
        )
    }
}

private class UpdateCohortCommand(
    private val cohorts: CohortRepository,
    private val mapper: ObjectMapper,
    override val aggregateId: UUID,
    private val actorId: UUID,
    private val request: UpdateCohortRequest,
) : AuthorizedCommand {
    override val action = "cohort.update"
    override val entityId = aggregateId
    override val resourceId = aggregateId
    override val aggregateType = COHORT_AGGREGATE_TYPE
    override val expectedVersionRequired = true
    override val changesAuthorizationFacts = false
    override val lockPlan = AggregateLockPlan(existing = listOf(AggregateReference(aggregateType, aggregateId)))

    override fun execute(context: CommandContext): CommandMutation {
        val before = context.lockedVersions.getValue(AggregateReference(aggregateType, aggregateId))
        val updated = cohorts.update(aggregateId, request, actorId)
        val aggregate = AggregateReference(aggregateType, aggregateId)
        return CommandMutation(
            200,
            json(mapper, updated),
            resourceId,
            listOf(AggregateChange(aggregate, before, before + 1)),
            null,
            json(mapper, mapOf("cohortId" to aggregateId, "status" to updated.status.name)),
            listOf(
                PendingEventSpec(
                    "cohort.updated",
                    1,
                    json(mapper, mapOf("cohortId" to aggregateId, "status" to updated.status.name)),
                    aggregate,
                    before + 1,
                ),
            ),
        )
    }
}

private abstract class MembershipCommand(
    protected val cohorts: CohortRepository,
    protected val mapper: ObjectMapper,
    final override val aggregateId: UUID,
    protected val actorId: UUID,
) : AuthorizedCommand {
    final override val action = "cohort.members.manage"
    final override val entityId = aggregateId
    final override val resourceId = aggregateId
    final override val aggregateType = COHORT_AGGREGATE_TYPE
    final override val expectedVersionRequired = true
    final override val changesAuthorizationFacts = true
    final override val lockPlan = AggregateLockPlan(existing = listOf(AggregateReference(aggregateType, aggregateId)))

    protected fun mutation(
        context: CommandContext,
        updated: CohortDetail,
        eventType: String,
        principalId: UUID,
        role: CohortMemberRole,
    ): CommandMutation {
        val aggregate = AggregateReference(aggregateType, aggregateId)
        val before = context.lockedVersions.getValue(aggregate)
        return CommandMutation(
            200,
            json(mapper, updated),
            resourceId,
            listOf(AggregateChange(aggregate, before, before + 1)),
            null,
            json(mapper, mapOf("cohortId" to aggregateId, "role" to role.name)),
            listOf(
                PendingEventSpec(
                    eventType,
                    1,
                    json(
                        mapper,
                        mapOf("cohortId" to aggregateId, "principalId" to principalId, "role" to role.name),
                    ),
                    aggregate,
                    before + 1,
                ),
            ),
        )
    }
}

private class AddCohortMemberCommand(
    cohorts: CohortRepository,
    mapper: ObjectMapper,
    aggregateId: UUID,
    actorId: UUID,
    private val request: AddCohortMemberRequest,
) : MembershipCommand(cohorts, mapper, aggregateId, actorId) {
    override fun execute(context: CommandContext): CommandMutation {
        cohorts.beginAuthorizationChange()
        val updated = cohorts.addMember(
            aggregateId, request.principalId, request.role, request.validUntil, actorId,
        )
        cohorts.finishAuthorizationChange()
        return mutation(context, updated, "cohort.member-added", request.principalId, request.role)
    }
}

private class RemoveCohortMemberCommand(
    cohorts: CohortRepository,
    mapper: ObjectMapper,
    aggregateId: UUID,
    actorId: UUID,
    private val request: RemoveCohortMemberRequest,
) : MembershipCommand(cohorts, mapper, aggregateId, actorId) {
    override fun execute(context: CommandContext): CommandMutation {
        cohorts.beginAuthorizationChange()
        val updated = cohorts.removeMember(aggregateId, request.principalId, request.role, actorId)
        cohorts.finishAuthorizationChange()
        return mutation(context, updated, "cohort.member-removed", request.principalId, request.role)
    }
}

private class TransferCohortOwnerCommand(
    private val cohorts: CohortRepository,
    private val mapper: ObjectMapper,
    override val aggregateId: UUID,
    private val actorId: UUID,
    private val request: TransferCohortOwnerRequest,
) : AuthorizedCommand {
    override val action = "cohort.owner.transfer"
    override val entityId = aggregateId
    override val resourceId = aggregateId
    override val aggregateType = COHORT_AGGREGATE_TYPE
    override val expectedVersionRequired = true
    override val changesAuthorizationFacts = true
    override val lockPlan = AggregateLockPlan(existing = listOf(AggregateReference(aggregateType, aggregateId)))

    override fun execute(context: CommandContext): CommandMutation {
        val aggregate = AggregateReference(aggregateType, aggregateId)
        val before = context.lockedVersions.getValue(aggregate)
        val previousOwner = cohorts.find(aggregateId)?.ownerPrincipalId ?: throw CohortNotFoundException()
        cohorts.beginAuthorizationChange()
        val updated = cohorts.transferOwner(aggregateId, request.ownerPrincipalId, actorId)
        cohorts.finishAuthorizationChange()
        return CommandMutation(
            200,
            json(mapper, updated),
            resourceId,
            listOf(AggregateChange(aggregate, before, before + 1)),
            request.reason,
            json(mapper, mapOf("cohortId" to aggregateId, "ownerPrincipalId" to request.ownerPrincipalId)),
            listOf(
                PendingEventSpec(
                    "cohort.owner-transferred",
                    1,
                    json(
                        mapper,
                        mapOf(
                            "cohortId" to aggregateId,
                            "previousOwnerPrincipalId" to previousOwner,
                            "ownerPrincipalId" to request.ownerPrincipalId,
                        ),
                    ),
                    aggregate,
                    before + 1,
                ),
            ),
        )
    }
}

private class ArchiveCohortCommand(
    private val cohorts: CohortRepository,
    private val mapper: ObjectMapper,
    override val aggregateId: UUID,
    private val actorId: UUID,
    private val request: ArchiveCohortRequest,
) : AuthorizedCommand {
    override val action = "cohort.archive"
    override val entityId = aggregateId
    override val resourceId = aggregateId
    override val aggregateType = COHORT_AGGREGATE_TYPE
    override val expectedVersionRequired = true
    override val changesAuthorizationFacts = false
    override val lockPlan = AggregateLockPlan(existing = listOf(AggregateReference(aggregateType, aggregateId)))

    override fun execute(context: CommandContext): CommandMutation {
        val aggregate = AggregateReference(aggregateType, aggregateId)
        val before = context.lockedVersions.getValue(aggregate)
        val updated = cohorts.archive(aggregateId, actorId)
        return CommandMutation(
            200,
            json(mapper, updated),
            resourceId,
            listOf(AggregateChange(aggregate, before, before + 1)),
            request.reason,
            json(mapper, mapOf("cohortId" to aggregateId, "status" to updated.status.name)),
            listOf(
                PendingEventSpec(
                    "cohort.archived",
                    1,
                    json(mapper, mapOf("cohortId" to aggregateId, "status" to updated.status.name)),
                    aggregate,
                    before + 1,
                ),
            ),
        )
    }
}

private fun json(mapper: ObjectMapper, value: Any): CanonicalJsonObject =
    CanonicalJsonObject.from(mapper.valueToTree(value), CommandExecutor.MAX_RESPONSE_BYTES)
