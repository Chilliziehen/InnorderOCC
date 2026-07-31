package com.innorder.occ.command

import com.fasterxml.jackson.databind.JsonNode
import com.innorder.occ.authz.AuthorizationDecisionReference
import org.springframework.jdbc.core.JdbcOperations
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
    val expectedVersionRequired: Boolean
    fun currentVersion(context: CommandContext): Long?
    fun execute(context: CommandContext): CommandMutation
}

class CommandContext internal constructor(
    val jdbc: JdbcOperations,
    val metadata: CommandMetadata,
    request: JsonNode,
    val authorization: AuthorizationDecisionReference,
    val transactionId: UUID,
) {
    private val canonicalRequest = request.deepCopy<JsonNode>()
    val request: JsonNode get() = canonicalRequest.deepCopy<JsonNode>()
}

data class PendingEventSpec(
    val eventType: String,
    val schemaVersion: Int,
    val payload: JsonNode,
    val aggregateVersion: Long,
)

data class CommandMutation(
    val status: Int,
    val body: JsonNode,
    val resourceId: UUID,
    val aggregateId: UUID,
    val aggregateType: String,
    val beforeVersion: Long?,
    val afterVersion: Long,
    val auditReason: String?,
    val auditDetail: JsonNode,
    val events: List<PendingEventSpec>,
)

data class CommandResult(
    val status: Int,
    val body: JsonNode,
    val resourceId: UUID?,
    val replayed: Boolean,
)

class InvalidCommandMetadataException : RuntimeException("Command metadata is invalid")
class InvalidIdempotencyKeyException : RuntimeException("Idempotency key is missing or invalid")
class InvalidExpectedVersionException : RuntimeException("Expected version is missing or invalid")
class InvalidCommandRequestException : RuntimeException("Command request is invalid")
class IdempotencyConflictException : RuntimeException("Idempotency key was used with a different request")
class IdempotencyInProgressException : RuntimeException("Idempotency request is not terminal")
class OptimisticConflictException(val currentVersion: Long) : RuntimeException("Aggregate version does not match")
