package com.innorder.occ.command

import com.innorder.occ.authz.AuthorizationRequest
import com.innorder.occ.authz.AuthorizationService
import com.innorder.occ.events.OutboxRepository
import org.springframework.stereotype.Service
import org.springframework.jdbc.core.JdbcOperations
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionTemplate
import java.util.UUID

@Service
class CommandExecutor(
    transactionManager: PlatformTransactionManager,
    private val authorizationService: AuthorizationService,
    private val idempotency: IdempotencyRepository,
    private val audit: AuditRepository,
    private val outbox: OutboxRepository,
    private val jdbc: JdbcOperations,
) {
    private val transactions = TransactionTemplate(transactionManager).apply {
        propagationBehavior = TransactionDefinition.PROPAGATION_REQUIRED
    }
    fun execute(metadata: CommandMetadata, requestBytes: ByteArray, command: AuthorizedCommand): CommandResult {
        val request = CanonicalJsonObject.parse(requestBytes, MAX_REQUEST_BYTES)
        val requestDigest = request.digest
        return transactions.execute {
            when (val acquisition = idempotency.acquire(metadata, requestDigest)) {
                is IdempotencyAcquisition.Replay -> acquisition.result
                is IdempotencyAcquisition.Owner -> executeOwned(metadata, request, requestDigest, command, acquisition.recordId)
            }
        }!!
    }

    private fun executeOwned(
        metadata: CommandMetadata,
        request: CanonicalJsonObject,
        requestDigest: String,
        command: AuthorizedCommand,
        idempotencyRecordId: UUID,
    ): CommandResult {
        validateCommand(command)
        if (command.expectedVersionRequired && (metadata.expectedVersion == null || metadata.expectedVersion !in 0..MAX_SAFE_INTEGER)) {
            throw InvalidExpectedVersionException()
        }
        if (!command.expectedVersionRequired && metadata.expectedVersion != null) throw InvalidExpectedVersionException()
        val authorization = authorizationService.authorize(
            AuthorizationRequest(
                UUID.randomUUID(), metadata.principalId, command.action, command.entityId, command.resourceId,
                mapOf(
                    "commandKey" to metadata.commandKey,
                    "expectedVersion" to metadata.expectedVersion,
                    "requestDigest" to requestDigest,
                ),
                metadata.correlationId,
            ),
        )
        val transactionId = UUID.randomUUID()
        val context = CommandContext(
            jdbc,
            metadata, request, authorization, transactionId,
        )
        val currentVersion = command.lockCurrentVersion(context)
        if (currentVersion != null && currentVersion !in 0..MAX_SAFE_INTEGER) throw InvalidCommandRequestException()
        if (command.expectedVersionRequired && currentVersion != metadata.expectedVersion) {
            throw OptimisticConflictException(currentVersion ?: 0)
        }
        val mutation = command.execute(context)
        validateMutation(command, mutation, currentVersion)
        audit.insert(transactionId, metadata, command.action, mutation)
        outbox.insert(metadata, transactionId, mutation)
        val result = CommandResult(mutation.status, mutation.body, mutation.resourceId, replayed = false)
        idempotency.complete(idempotencyRecordId, result)
        return result
    }

    private fun validateCommand(command: AuthorizedCommand) {
        if (!ACTION.matches(command.action)) throw InvalidCommandMetadataException()
    }

    private fun validateMutation(command: AuthorizedCommand, mutation: CommandMutation, currentVersion: Long?) {
        if (mutation.status !in 100..599 || mutation.aggregateType.length !in 1..128 ||
            !ACTION.matches(mutation.aggregateType) || mutation.resourceId != command.resourceId ||
            mutation.aggregateId != command.aggregateId || mutation.afterVersion !in 0..MAX_SAFE_INTEGER ||
            mutation.beforeVersion != currentVersion || mutation.afterVersion <= (mutation.beforeVersion ?: -1) ||
            (command.expectedVersionRequired && mutation.afterVersion != requireNotNull(currentVersion) + 1) ||
            mutation.auditReason?.let { it.length !in 1..1024 || it.any(Char::isISOControl) } == true ||
            mutation.body.size() > MAX_RESPONSE_BYTES || mutation.auditDetail.size() > MAX_AUDIT_BYTES ||
            mutation.events.isEmpty() || mutation.events.size > 128 ||
            mutation.events.map { it.aggregateVersion }.distinct().size != mutation.events.size ||
            mutation.events.map { it.aggregateVersion } != mutation.events.map { it.aggregateVersion }.sorted() ||
            mutation.events.any { it.payload.size() > MAX_EVENT_BYTES || it.aggregateVersion <= (mutation.beforeVersion ?: -1) || it.aggregateVersion > mutation.afterVersion || it.schemaVersion < 1 || !ACTION.matches(it.eventType) }
        ) throw InvalidCommandRequestException()
    }

    companion object {
        const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        const val MAX_REQUEST_BYTES = 256 * 1024
        const val MAX_RESPONSE_BYTES = 64 * 1024
        const val MAX_AUDIT_BYTES = 16 * 1024
        const val MAX_EVENT_BYTES = 64 * 1024
        val ACTION = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}${'$'}")
    }
}
