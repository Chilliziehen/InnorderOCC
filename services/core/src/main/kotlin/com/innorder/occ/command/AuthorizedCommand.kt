package com.innorder.occ.command

import com.innorder.occ.authz.AuthorizationDecisionReference
import org.springframework.jdbc.core.JdbcOperations
import java.util.Collections
import java.util.UUID
import com.innorder.occ.notification.PendingNotificationSpec

data class CommandMetadata(
    val principalId: UUID,
    val commandKey: String,
    val idempotencyKey: String,
    val expectedVersion: Long?,
    val correlationId: UUID,
) {
    init {
        if (!COMMAND_KEY.matches(commandKey)) throw InvalidCommandMetadataException()
        if (!IDEMPOTENCY_KEY.matches(idempotencyKey)) throw InvalidIdempotencyKeyException()
    }

    private companion object {
        val COMMAND_KEY = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}${'$'}")
        val IDEMPOTENCY_KEY = Regex("^[!-~]{1,128}${'$'}")
    }
}

interface AuthorizedCommand {
    val action: String
    val entityId: UUID
    val resourceId: UUID
    val aggregateType: String
    val aggregateId: UUID
    val expectedVersionRequired: Boolean
    val lockPlan: AggregateLockPlan?

    /** IAM, relationship, and policy mutation commands must declare this mode. */
    val changesAuthorizationFacts: Boolean

    fun execute(context: CommandContext): CommandMutation
}

data class CommandDescriptor(
    val commandKey: String,
    val action: String,
    val entityId: UUID,
    val resourceId: UUID,
    val aggregateType: String,
    val aggregateId: UUID,
    val requiresExpectedVersion: Boolean,
    val changesAuthorizationFacts: Boolean,
    val expectedVersion: Long?,
    val principalId: UUID,
    val lockPlan: AggregateLockPlan?,
)

class CommandContext internal constructor(
    val jdbc: JdbcOperations,
    val metadata: CommandMetadata,
    val descriptor: CommandDescriptor,
    val authorization: AuthorizationDecisionReference,
    val requestDigest: String,
    val transactionId: UUID,
    val lockedVersions: Map<AggregateReference, Long>,
    val createdAggregates: Set<AggregateReference>,
)

data class PendingEventSpec(
    val eventType: String,
    val schemaVersion: Int,
    val payload: CanonicalJsonObject,
    val aggregate: AggregateReference,
    val aggregateVersion: Long,
)

data class AggregateChange(
    val ref: AggregateReference,
    val beforeVersion: Long,
    val afterVersion: Long,
)

class CommandMutation(
    val status: Int,
    val body: CanonicalJsonObject,
    val resourceId: UUID,
    changes: List<AggregateChange>,
    val auditReason: String?,
    val auditDetail: CanonicalJsonObject,
    events: List<PendingEventSpec>,
    notifications: List<PendingNotificationSpec> = emptyList(),
) {
    val changes: List<AggregateChange> = Collections.unmodifiableList(changes.toList())
    val events: List<PendingEventSpec> = Collections.unmodifiableList(events.toList())
    val notifications: List<PendingNotificationSpec> = Collections.unmodifiableList(notifications.toList())

    fun copy(
        status: Int = this.status,
        body: CanonicalJsonObject = this.body,
        resourceId: UUID = this.resourceId,
        changes: List<AggregateChange> = this.changes,
        auditReason: String? = this.auditReason,
        auditDetail: CanonicalJsonObject = this.auditDetail,
        events: List<PendingEventSpec> = this.events,
        notifications: List<PendingNotificationSpec> = this.notifications,
    ): CommandMutation = CommandMutation(
        status, body, resourceId, changes, auditReason, auditDetail, events, notifications,
    )
}

data class CommandResult(
    val status: Int,
    val body: CanonicalJsonObject,
    val resourceId: UUID?,
    val replayed: Boolean,
)

class InvalidCommandMetadataException : RuntimeException("Command metadata is invalid")
class InvalidIdempotencyKeyException : RuntimeException("Idempotency key is missing or invalid")
class InvalidExpectedVersionException : RuntimeException("Expected version is missing or invalid")
class InvalidCommandRequestException : RuntimeException("Command request is invalid")
class IdempotencyConflictException : RuntimeException("Idempotency key was used with a different request")
class IdempotencyInProgressException : RuntimeException("Idempotency request is not terminal")
class IdempotencyExpiredException : RuntimeException("Idempotency key is expired; use a new key")
class CommandIntegrityException : RuntimeException("Stored command result failed integrity validation")
class OptimisticConflictException(val currentVersion: Long) : RuntimeException("Aggregate version does not match") {
    init {
        require(currentVersion in 0..CommandExecutor.MAX_SAFE_INTEGER)
    }
}
