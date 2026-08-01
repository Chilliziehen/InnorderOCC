package com.innorder.occ.resource

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import com.innorder.occ.api.CursorCodec
import com.innorder.occ.api.CursorContext
import com.innorder.occ.api.CursorDirection
import com.innorder.occ.authz.AuthorizationAvailabilityException
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
import com.innorder.occ.command.InvalidCommandRequestException
import com.innorder.occ.command.PendingEventSpec
import com.innorder.occ.events.OutboxRepository
import org.postgresql.util.PSQLException
import org.springframework.dao.DataAccessException
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.math.BigDecimal
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID

enum class ResourceState { AVAILABLE, UNAVAILABLE, MAINTENANCE, ARCHIVED }
enum class AvailabilityMode { AVAILABLE, UNAVAILABLE }
enum class ReservationState { PENDING, CONFIRMED, CANCELLED, COMPLETED }

data class ManagedResource(
    val id: UUID,
    val resourceType: String,
    val capacity: BigDecimal,
    val state: ResourceState,
    val data: Map<String, Any?>,
    val version: Long,
)

data class AvailabilityWindow(
    val id: UUID,
    val resourceId: UUID,
    val start: OffsetDateTime,
    val end: OffsetDateTime,
    val mode: AvailabilityMode,
    val reason: String?,
    val createdBy: UUID,
)

data class Reservation(
    val id: UUID,
    val resourceId: UUID,
    val requesterEntityId: UUID?,
    val processInstanceId: UUID?,
    val taskId: UUID?,
    val start: OffsetDateTime,
    val end: OffsetDateTime,
    val capacity: BigDecimal,
    val exclusive: Boolean,
    val state: ReservationState,
    val version: Long,
)

data class CreateResourceRequest(
    val id: UUID,
    val resourceType: String,
    val capacity: BigDecimal,
    val state: ResourceState = ResourceState.AVAILABLE,
    val data: Map<String, Any?> = emptyMap(),
) {
    init {
        require(resourceType.length in 1..128 && capacity > BigDecimal.ZERO && data.size <= 128)
    }
}

data class UpdateResourceRequest(val capacity: BigDecimal, val state: ResourceState, val data: Map<String, Any?>) {
    init { require(capacity > BigDecimal.ZERO && data.size <= 128) }
}

data class AddAvailabilityRequest(
    val id: UUID,
    val start: OffsetDateTime,
    val end: OffsetDateTime,
    val mode: AvailabilityMode,
    val reason: String?,
) {
    init { validateRange(start, end); require(reason == null || reason.length <= 512) }
}

data class ReserveResourceRequest(
    val id: UUID,
    val requesterEntityId: UUID,
    val processInstanceId: UUID?,
    val taskId: UUID?,
    val start: OffsetDateTime,
    val end: OffsetDateTime,
    val capacity: BigDecimal,
    val exclusive: Boolean,
) {
    init { validateRange(start, end); require(capacity > BigDecimal.ZERO) }
}

data class ChangeReservationRequest(
    val start: OffsetDateTime,
    val end: OffsetDateTime,
    val capacity: BigDecimal,
    val exclusive: Boolean,
) {
    init { validateRange(start, end); require(capacity > BigDecimal.ZERO) }
}

data class CursorPage<T>(val items: List<T>, val nextCursor: String?)
data class ResourceCommandResult<T>(val status: Int, val replayed: Boolean, val body: T)

class ReservationConflictException(
    val resourceId: UUID,
    val start: OffsetDateTime,
    val end: OffsetDateTime,
    val reservationId: UUID? = null,
    val requesterEntityId: UUID? = null,
) : RuntimeException("Reservation conflicts with resource availability or capacity")

class ReservationStateConflictException : RuntimeException("Reservation state does not permit this command")

@Service
class ResourceService(
    private val repository: ResourceRepository,
    private val commands: CommandExecutor,
    private val authorization: AuthorizationService,
    transactionManager: PlatformTransactionManager,
    private val cursorCodec: CursorCodec,
    private val mapper: ObjectMapper,
) {
    private val transactions = TransactionTemplate(transactionManager)

    fun create(metadata: CommandMetadata, bytes: ByteArray, request: CreateResourceRequest): ResourceCommandResult<ManagedResource> =
        decodeResource(commands.execute(metadata, bytes, createCommand(request)))

    fun update(id: UUID, metadata: CommandMetadata, bytes: ByteArray, request: UpdateResourceRequest): ResourceCommandResult<ManagedResource> =
        domainFailure(id, repository.commitmentInterval(id)) {
            decodeResource(commands.execute(metadata, bytes, updateCommand(id, request)))
        }

    fun addAvailability(
        resourceId: UUID,
        metadata: CommandMetadata,
        bytes: ByteArray,
        request: AddAvailabilityRequest,
    ): ResourceCommandResult<ManagedResource> = domainFailure(resourceId, utc(request.start) to utc(request.end)) {
        decodeResource(commands.execute(metadata, bytes, availabilityCommand(resourceId, request.normalized())))
    }

    fun reserve(
        resourceId: UUID,
        metadata: CommandMetadata,
        bytes: ByteArray,
        request: ReserveResourceRequest,
    ): ResourceCommandResult<Reservation> = domainFailure(resourceId, utc(request.start) to utc(request.end), metadata) {
        decodeReservation(commands.execute(metadata, bytes, reserveCommand(resourceId, request.normalized())))
    }

    fun change(
        reservationId: UUID,
        metadata: CommandMetadata,
        bytes: ByteArray,
        request: ChangeReservationRequest,
    ): ResourceCommandResult<Reservation> {
        val parent = repository.reservationParent(reservationId) ?: throw InvalidCommandRequestException()
        return domainFailure(parent.resourceId, utc(request.start) to utc(request.end), metadata) {
            decodeReservation(commands.execute(metadata, bytes, changeCommand(reservationId, parent, request.normalized())))
        }
    }

    fun cancel(reservationId: UUID, metadata: CommandMetadata, bytes: ByteArray): ResourceCommandResult<Reservation> {
        val parent = repository.reservationParent(reservationId) ?: throw InvalidCommandRequestException()
        val current = repository.reservation(reservationId) ?: throw InvalidCommandRequestException()
        return domainFailure(parent.resourceId, current.start to current.end, metadata) {
            decodeReservation(commands.execute(metadata, bytes, cancelCommand(reservationId, parent)))
        }
    }

    fun inventory(principalId: UUID, correlationId: UUID, limit: Int, cursor: String?): CursorPage<ManagedResource> {
        require(limit in 1..100)
        val context = cursorContext("resource.inventory", CanonicalJsonObject.from(mapper.createObjectNode()), "resource-id")
        val tuple = cursor?.let { cursorCodec.decode(it, context) }
        var examined = tuple?.get(0)?.textValue()?.let(UUID::fromString)
        var inclusive = tuple?.get(1)?.booleanValue() ?: false
        var exhausted = false
        val authorized = transactions.execute {
            buildList {
                while (size < limit + 1 && !exhausted) {
                    val rows = repository.inventory(examined, inclusive, maxOf(limit + 1, DATABASE_PAGE_SIZE))
                    if (rows.isEmpty()) {
                        exhausted = true
                        break
                    }
                    inclusive = false
                    for (row in rows) {
                        examined = row.id
                        if (authorizeRow(principalId, correlationId, row.id, row.id)) add(row)
                        if (size == limit + 1) break
                    }
                    if (rows.size < maxOf(limit + 1, DATABASE_PAGE_SIZE)) exhausted = true
                }
            }
        }!!
        val page = authorized.take(limit)
        val next = if (authorized.size > limit) authorized[limit].let { resource ->
            cursorCodec.encode(context, mapper.createArrayNode().add(resource.id.toString()).add(true))
        } else null
        return CursorPage(page, next)
    }

    fun availability(
        principalId: UUID,
        correlationId: UUID,
        resourceId: UUID,
        start: OffsetDateTime,
        end: OffsetDateTime,
    ): List<AvailabilityWindow> = transactions.execute {
        authorizeRequired(principalId, correlationId, resourceId, resourceId, READ_ACTION)
        repository.availability(resourceId, utc(start), utc(end))
    }!!

    fun schedule(
        principalId: UUID,
        correlationId: UUID,
        resourceId: UUID,
        start: OffsetDateTime,
        end: OffsetDateTime,
        limit: Int,
        cursor: String?,
    ): CursorPage<Reservation> {
        require(limit in 1..100)
        val normalizedStart = utc(start)
        val normalizedEnd = utc(end)
        validateRange(normalizedStart, normalizedEnd)
        val filters = CanonicalJsonObject.from(mapper.createObjectNode().apply {
            put("resourceId", resourceId.toString())
            put("start", normalizedStart.toString())
            put("end", normalizedEnd.toString())
        })
        val context = cursorContext("resource.schedule", filters, "reservation-start-id")
        val tuple = cursor?.let { cursorCodec.decode(it, context) }
        val afterStart = tuple?.get(0)?.textValue()?.let(OffsetDateTime::parse)
        val afterId = tuple?.get(1)?.textValue()?.let(UUID::fromString)
        val inclusive = tuple?.get(2)?.booleanValue() ?: false
        val authorized = transactions.execute {
            authorizeRequired(principalId, correlationId, resourceId, resourceId, READ_ACTION)
            repository.schedule(resourceId, normalizedStart, normalizedEnd, afterStart, afterId, inclusive, limit + 1)
                .map { revealOrRedactIdentity(principalId, correlationId, it) }
        }!!
        val page = authorized.take(limit)
        val next = if (authorized.size > limit) authorized[limit].let { reservation ->
            cursorCodec.encode(
                context,
                mapper.createArrayNode().add(reservation.start.toString()).add(reservation.id.toString()).add(true),
            )
        } else null
        return CursorPage(page, next)
    }

    private fun createCommand(request: CreateResourceRequest) = object : ResourceCommand(request.id, request.id, request.id, false) {
        override fun lockCurrentVersion(context: CommandContext): Long? {
            repository.lockResourceEntity(request.id)
            return null
        }

        override fun execute(context: CommandContext): CommandMutation = mutation(
            repository.insertResource(request), null, 0, 201, "resource.created",
        )
    }

    private fun updateCommand(id: UUID, request: UpdateResourceRequest) = object : ResourceCommand(id, id, id, true) {
        override fun lockCurrentVersion(context: CommandContext): Long? = repository.lockResource(id)
        override fun execute(context: CommandContext): CommandMutation {
            val before = requireNotNull(context.descriptor.expectedVersion)
            return mutation(repository.updateResource(id, request, before + 1), before, before + 1, 200, "resource.updated")
        }
    }

    private fun availabilityCommand(resourceId: UUID, request: AddAvailabilityRequest) =
        object : ResourceCommand(resourceId, resourceId, resourceId, true) {
            override fun lockCurrentVersion(context: CommandContext): Long? = repository.lockResource(resourceId)
            override fun execute(context: CommandContext): CommandMutation {
                val before = requireNotNull(context.descriptor.expectedVersion)
                repository.insertAvailability(resourceId, context.metadata.principalId, request)
                val resource = repository.advanceResourceVersion(resourceId, before + 1)
                return availabilityMutation(resource, request, before, before + 1)
            }
        }

    private fun reserveCommand(resourceId: UUID, request: ReserveResourceRequest) =
        object : ResourceCommand(request.requesterEntityId, resourceId, request.id, false, "resource-reservation") {
            override fun lockCurrentVersion(context: CommandContext): Long? {
                if (repository.lockResource(resourceId) == null) throw InvalidCommandRequestException()
                return null
            }

            override fun execute(context: CommandContext): CommandMutation = reservationMutation(
                repository.insertReservation(resourceId, request), null, 0, 201, "resource-reservation.created",
            )
        }

    private fun changeCommand(id: UUID, parent: ReservationIdentity, request: ChangeReservationRequest) =
        object : ResourceCommand(parent.requesterEntityId, parent.resourceId, id, true, "resource-reservation") {
            override fun lockCurrentVersion(context: CommandContext): Long? {
                if (repository.lockResource(parent.resourceId) == null) throw InvalidCommandRequestException()
                return repository.lockReservation(id)
            }

            override fun execute(context: CommandContext): CommandMutation {
                val before = requireNotNull(context.descriptor.expectedVersion)
                return reservationMutation(
                    repository.changeReservation(id, request, before + 1), before, before + 1, 200,
                    "resource-reservation.changed",
                )
            }
        }

    private fun cancelCommand(id: UUID, parent: ReservationIdentity) =
        object : ResourceCommand(parent.requesterEntityId, parent.resourceId, id, true, "resource-reservation") {
            override fun lockCurrentVersion(context: CommandContext): Long? {
                if (repository.lockResource(parent.resourceId) == null) throw InvalidCommandRequestException()
                return repository.lockReservation(id)
            }

            override fun execute(context: CommandContext): CommandMutation {
                val before = requireNotNull(context.descriptor.expectedVersion)
                return reservationMutation(
                    repository.cancelReservation(id, before + 1), before, before + 1, 200,
                    "resource-reservation.cancelled",
                )
            }
        }

    private abstract inner class ResourceCommand(
        final override val entityId: UUID,
        final override val resourceId: UUID,
        final override val aggregateId: UUID,
        final override val expectedVersionRequired: Boolean,
        final override val aggregateType: String = "managed-resource",
    ) : AuthorizedCommand {
        final override val action = WRITE_ACTION
        final override val changesAuthorizationFacts = false
    }

    private fun mutation(
        resource: ManagedResource,
        before: Long?,
        after: Long,
        status: Int,
        eventType: String,
    ): CommandMutation {
        val event = mapper.createObjectNode().apply {
            put("id", resource.id.toString())
            put("resourceId", resource.id.toString())
            put("version", after)
            put("state", resource.state.name)
            put("capacity", resource.capacity)
        }
        return commandMutation(
            status, resource.id, resource.id, "managed-resource", before, after, eventType,
            mapper.valueToTree(resource), event,
        )
    }

    private fun availabilityMutation(
        resource: ManagedResource,
        request: AddAvailabilityRequest,
        before: Long,
        after: Long,
    ): CommandMutation {
        val event = mapper.createObjectNode().apply {
            put("id", request.id.toString())
            put("resourceId", resource.id.toString())
            put("version", after)
            put("state", resource.state.name)
            put("capacity", resource.capacity)
            put("start", request.start.toString())
            put("end", request.end.toString())
            put("mode", request.mode.name)
            request.reason?.let { put("reason", it) }
        }
        return commandMutation(
            201, resource.id, resource.id, "managed-resource", before, after,
            "resource.availability-changed", mapper.valueToTree(resource), event,
        )
    }

    private fun reservationMutation(
        reservation: Reservation,
        before: Long?,
        after: Long,
        status: Int,
        eventType: String,
    ): CommandMutation {
        val event = mapper.createObjectNode().apply {
            put("id", reservation.id.toString())
            put("resourceId", reservation.resourceId.toString())
            put("version", after)
            put("state", reservation.state.name)
            put("start", reservation.start.toString())
            put("end", reservation.end.toString())
            put("capacity", reservation.capacity)
            put("exclusive", reservation.exclusive)
        }
        return commandMutation(
            status, reservation.resourceId, reservation.id, "resource-reservation", before, after, eventType,
            mapper.valueToTree(reservation), event,
        )
    }

    private fun commandMutation(
        status: Int,
        resourceId: UUID,
        aggregateId: UUID,
        aggregateType: String,
        before: Long?,
        after: Long,
        eventType: String,
        body: JsonNode,
        eventBody: JsonNode,
    ): CommandMutation {
        val response = CanonicalJsonObject.from(body)
        val event = CanonicalJsonObject.from(eventBody)
        return CommandMutation(
            status, response, resourceId, aggregateId, aggregateType, before, after, null,
            CanonicalJsonObject.from(mapper.createObjectNode().apply { put("version", after) }),
            listOf(PendingEventSpec(eventType, 1, event, after)),
        )
    }

    private fun decodeResource(result: CommandResult): ResourceCommandResult<ManagedResource> = ResourceCommandResult(
        result.status, result.replayed, mapper.treeToValue(result.body.toJsonNode(), ManagedResource::class.java),
    )

    private fun decodeReservation(result: CommandResult): ResourceCommandResult<Reservation> = ResourceCommandResult(
        result.status, result.replayed, mapper.treeToValue(result.body.toJsonNode(), Reservation::class.java),
    )

    private fun authorizeRow(principalId: UUID, correlationId: UUID, entityId: UUID, resourceId: UUID): Boolean = try {
        authorizeRequired(principalId, correlationId, entityId, resourceId, READ_ACTION)
        true
    } catch (_: AuthorizationDeniedException) {
        false
    }

    private fun authorizeRequired(
        principalId: UUID,
        correlationId: UUID,
        entityId: UUID,
        resourceId: UUID,
        action: String,
    ) {
        authorization.authorize(AuthorizationRequest(UUID.randomUUID(), principalId, action, entityId, resourceId, correlationId = correlationId))
    }

    private fun revealOrRedactIdentity(
        principalId: UUID,
        correlationId: UUID,
        reservation: Reservation,
    ): Reservation = try {
        authorizeRequired(
            principalId, correlationId, requireNotNull(reservation.requesterEntityId), reservation.resourceId,
            IDENTITY_READ_ACTION,
        )
        reservation
    } catch (_: AuthorizationDeniedException) {
        redactIdentity(reservation)
    } catch (_: AuthorizationAvailabilityException) {
        redactIdentity(reservation)
    }

    private fun redactIdentity(reservation: Reservation): Reservation = reservation.copy(
        requesterEntityId = null,
        processInstanceId = null,
        taskId = null,
    )

    private fun cursorContext(endpoint: String, filters: CanonicalJsonObject, sortName: String) = CursorContext(
        endpoint, OutboxRepository.DEFAULT_CUSTOMER_INSTANCE_ID, filters, sortName, 1, CursorDirection.FORWARD,
    )

    private inline fun <T> domainFailure(
        resourceId: UUID,
        interval: Pair<OffsetDateTime, OffsetDateTime>?,
        metadata: CommandMetadata? = null,
        action: () -> T,
    ): T = try {
        action()
    } catch (exception: DataAccessException) {
        when (sqlState(exception)) {
            STATE_SQLSTATE -> throw ReservationStateConflictException()
            CONSTRAINT_SQLSTATE -> throw InvalidCommandRequestException()
            EXCLUSION_SQLSTATE -> Unit
            else -> throw exception
        }
        val bounded = interval ?: repository.commitmentInterval(resourceId)
            ?: (OffsetDateTime.now(ZoneOffset.UTC) to OffsetDateTime.now(ZoneOffset.UTC).plusNanos(1))
        val identity = metadata?.let { authorizedConflictIdentity(it, resourceId, bounded) }
        throw ReservationConflictException(resourceId, bounded.first, bounded.second, identity?.reservationId, identity?.requesterEntityId)
    }

    private fun authorizedConflictIdentity(
        metadata: CommandMetadata,
        resourceId: UUID,
        interval: Pair<OffsetDateTime, OffsetDateTime>,
    ): ReservationIdentityDetail? {
        val candidate = repository.conflicts(resourceId, interval.first, interval.second).firstOrNull() ?: return null
        return try {
            transactions.execute {
                authorizeRequired(
                    metadata.principalId, metadata.correlationId, candidate.requesterEntityId, resourceId,
                    IDENTITY_READ_ACTION,
                )
                candidate
            }
        } catch (_: AuthorizationDeniedException) {
            null
        } catch (_: AuthorizationAvailabilityException) {
            null
        }
    }

    private fun sqlState(exception: Throwable): String? {
        var current: Throwable? = exception
        while (current != null) {
            if (current is PSQLException) return current.sqlState
            current = current.cause
        }
        return null
    }

    companion object {
        private const val WRITE_ACTION = "occ.execute"
        private const val READ_ACTION = "occ.read"
        private const val IDENTITY_READ_ACTION = "occ.reservation.identity.read"
        private const val EXCLUSION_SQLSTATE = "23P01"
        private const val STATE_SQLSTATE = "55000"
        private const val CONSTRAINT_SQLSTATE = "23514"
        private const val DATABASE_PAGE_SIZE = 32
    }
}

private fun AddAvailabilityRequest.normalized() = copy(start = utc(start), end = utc(end))
private fun ReserveResourceRequest.normalized() = copy(start = utc(start), end = utc(end))
private fun ChangeReservationRequest.normalized() = copy(start = utc(start), end = utc(end))
private fun utc(value: OffsetDateTime): OffsetDateTime = value.withOffsetSameInstant(ZoneOffset.UTC)
private fun validateRange(start: OffsetDateTime, end: OffsetDateTime) {
    require(start.toInstant().isBefore(end.toInstant()))
}
