package com.innorder.occ.command

import com.innorder.occ.authz.AuthorizationDecisionReference
import org.springframework.jdbc.core.JdbcOperations
import java.util.Collections
import java.util.UUID

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

    /** IAM, relationship, and policy mutation commands must declare this mode. */
    val changesAuthorizationFacts: Boolean

    /** Called after authorization. Update commands must lock their aggregate row with FOR UPDATE before returning. */
    fun lockCurrentVersion(context: CommandContext): Long?
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
)

class CommandContext internal constructor(
    val jdbc: JdbcOperations,
    val metadata: CommandMetadata,
    val descriptor: CommandDescriptor,
    val authorization: AuthorizationDecisionReference,
    val requestDigest: String,
    val transactionId: UUID,
)

data class PendingEventSpec(
    val eventType: String,
    val schemaVersion: Int,
    val payload: CanonicalJsonObject,
    val aggregateVersion: Long,
)

class CommandMutation(
    val status: Int,
    val body: CanonicalJsonObject,
    val resourceId: UUID,
    val aggregateId: UUID,
    val aggregateType: String,
    val beforeVersion: Long?,
    val afterVersion: Long,
    val auditReason: String?,
    val auditDetail: CanonicalJsonObject,
    events: List<PendingEventSpec>,
) {
    val events: List<PendingEventSpec> = Collections.unmodifiableList(events.toList())

    fun copy(
        status: Int = this.status,
        body: CanonicalJsonObject = this.body,
        resourceId: UUID = this.resourceId,
        aggregateId: UUID = this.aggregateId,
        aggregateType: String = this.aggregateType,
        beforeVersion: Long? = this.beforeVersion,
        afterVersion: Long = this.afterVersion,
        auditReason: String? = this.auditReason,
        auditDetail: CanonicalJsonObject = this.auditDetail,
        events: List<PendingEventSpec> = this.events,
    ): CommandMutation = CommandMutation(
        status, body, resourceId, aggregateId, aggregateType, beforeVersion, afterVersion,
        auditReason, auditDetail, events,
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
