package com.innorder.occ.command

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.authz.AuthorizationRequest
import com.innorder.occ.authz.AuthorizationRevisionLockRepository
import com.innorder.occ.authz.AuthorizationService
import com.innorder.occ.events.OutboxRepository
import org.springframework.stereotype.Service
import org.springframework.jdbc.core.JdbcOperations
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionTemplate
import java.text.Normalizer
import java.util.UUID

@Service
class CommandExecutor(
    transactionManager: PlatformTransactionManager,
    private val authorizationService: AuthorizationService,
    private val authorizationLocks: AuthorizationRevisionLockRepository,
    private val idempotency: IdempotencyRepository,
    private val audit: AuditRepository,
    private val outbox: OutboxRepository,
    private val jdbc: JdbcOperations,
) {
    private val mapper = ObjectMapper().findAndRegisterModules()
    private val transactions = TransactionTemplate(transactionManager).apply {
        propagationBehavior = TransactionDefinition.PROPAGATION_REQUIRED
    }
    fun execute(metadata: CommandMetadata, requestBytes: ByteArray, command: AuthorizedCommand): CommandResult {
        val request = CanonicalJsonObject.parse(requestBytes, MAX_REQUEST_BYTES)
        val descriptor = captureDescriptor(metadata, command)
        val fingerprint = fingerprint(descriptor, request)
        val sensitiveValues = sensitiveValues(request)
        return transactions.execute {
            when (val acquisition = idempotency.acquire(descriptor, metadata.idempotencyKey, fingerprint)) {
                is IdempotencyAcquisition.Replay -> acquisition.result
                is IdempotencyAcquisition.Owner -> executeOwned(
                    metadata, descriptor, fingerprint, sensitiveValues, command, acquisition.recordId,
                )
            }
        }!!
    }

    private fun executeOwned(
        metadata: CommandMetadata,
        descriptor: CommandDescriptor,
        requestDigest: String,
        sensitiveValues: Set<String>,
        command: AuthorizedCommand,
        idempotencyRecordId: UUID,
    ): CommandResult {
        if (descriptor.changesAuthorizationFacts) authorizationLocks.acquireForChange()
        val authorization = authorizationService.authorize(
            AuthorizationRequest(
                UUID.randomUUID(), descriptor.principalId, descriptor.action, descriptor.entityId, descriptor.resourceId,
                mapOf(
                    "commandKey" to descriptor.commandKey,
                    "expectedVersion" to descriptor.expectedVersion,
                    "requestDigest" to requestDigest,
                ),
                metadata.correlationId,
            ),
        )
        val transactionId = UUID.randomUUID()
        val context = CommandContext(
            jdbc,
            metadata, descriptor, authorization, requestDigest, transactionId,
        )
        val currentVersion = command.lockCurrentVersion(context)
        if (currentVersion != null && currentVersion !in 0..MAX_SAFE_INTEGER) throw InvalidCommandRequestException()
        if (descriptor.requiresExpectedVersion && currentVersion != descriptor.expectedVersion) {
            throw OptimisticConflictException(currentVersion ?: 0)
        }
        val mutation = command.execute(context)
        validateMutation(descriptor, mutation, currentVersion)
        validateDataMinimization(mutation, sensitiveValues)
        audit.insert(transactionId, metadata.correlationId, descriptor, mutation)
        outbox.insert(descriptor, metadata.correlationId, transactionId, mutation)
        val result = CommandResult(mutation.status, mutation.body, mutation.resourceId, replayed = false)
        idempotency.complete(idempotencyRecordId, result)
        return result
    }

    private fun captureDescriptor(metadata: CommandMetadata, command: AuthorizedCommand): CommandDescriptor {
        val descriptor = CommandDescriptor(
            metadata.commandKey,
            command.action,
            command.entityId,
            command.resourceId,
            command.aggregateType,
            command.aggregateId,
            command.expectedVersionRequired,
            command.changesAuthorizationFacts,
            metadata.expectedVersion,
            metadata.principalId,
        )
        if (!ACTION.matches(descriptor.action) || !ACTION.matches(descriptor.aggregateType) ||
            listOf(descriptor.principalId, descriptor.entityId, descriptor.resourceId, descriptor.aggregateId)
                .any { !validUuid(it) }
        ) throw InvalidCommandMetadataException()
        if (descriptor.requiresExpectedVersion && descriptor.expectedVersion !in 0..MAX_SAFE_INTEGER) {
            throw InvalidExpectedVersionException()
        }
        if (!descriptor.requiresExpectedVersion && descriptor.expectedVersion != null) throw InvalidExpectedVersionException()
        if (!validUuid(metadata.correlationId)) throw InvalidCommandMetadataException()
        if (!descriptor.changesAuthorizationFacts &&
            (authorizationNamespace(descriptor.action) || authorizationNamespace(descriptor.aggregateType))
        ) throw InvalidCommandMetadataException()
        return descriptor
    }

    private fun validateMutation(descriptor: CommandDescriptor, mutation: CommandMutation, currentVersion: Long?) {
        if (mutation.status !in 100..599 || mutation.aggregateType.length !in 1..128 ||
            mutation.aggregateType != descriptor.aggregateType || mutation.resourceId != descriptor.resourceId ||
            mutation.aggregateId != descriptor.aggregateId || mutation.afterVersion !in 0..MAX_SAFE_INTEGER ||
            mutation.beforeVersion != currentVersion || mutation.afterVersion <= (mutation.beforeVersion ?: -1) ||
            (descriptor.requiresExpectedVersion && mutation.afterVersion != requireNotNull(currentVersion) + 1) ||
            mutation.auditReason?.let { it.length !in 1..1024 || it.any(Char::isISOControl) } == true ||
            mutation.body.size() > MAX_RESPONSE_BYTES || mutation.auditDetail.size() > MAX_AUDIT_BYTES ||
            mutation.events.isEmpty() || mutation.events.size > 128 ||
            mutation.events.map { it.aggregateVersion }.distinct().size != mutation.events.size ||
            mutation.events.map { it.aggregateVersion } != mutation.events.map { it.aggregateVersion }.sorted() ||
            mutation.events.any {
                it.payload.size() > MAX_EVENT_BYTES || it.aggregateVersion <= (mutation.beforeVersion ?: -1) ||
                    it.aggregateVersion > mutation.afterVersion || it.schemaVersion < 1 || !ACTION.matches(it.eventType) ||
                    (!descriptor.changesAuthorizationFacts && authorizationNamespace(it.eventType))
            }
        ) throw InvalidCommandRequestException()
    }

    private fun fingerprint(descriptor: CommandDescriptor, request: CanonicalJsonObject): String {
        val envelope = mapper.createObjectNode().apply {
            put("commandKey", descriptor.commandKey)
            put("action", descriptor.action)
            put("entityId", descriptor.entityId.toString())
            put("resourceId", descriptor.resourceId.toString())
            put("aggregateType", descriptor.aggregateType)
            put("aggregateId", descriptor.aggregateId.toString())
            put("requiresExpectedVersion", descriptor.requiresExpectedVersion)
            put("changesAuthorizationFacts", descriptor.changesAuthorizationFacts)
            if (descriptor.expectedVersion == null) putNull("expectedVersion") else put("expectedVersion", descriptor.expectedVersion)
            put("principalId", descriptor.principalId.toString())
            set<JsonNode>("request", request.toJsonNode())
        }
        return CanonicalJsonObject.from(envelope, MAX_REQUEST_BYTES + 4096).digest
    }

    private fun validateDataMinimization(mutation: CommandMutation, requestSensitiveValues: Set<String>) {
        validateSafePersistenceJson(mutation.auditDetail.toJsonNode(), requestSensitiveValues, 0)
        mutation.events.forEach { validateSafePersistenceJson(it.payload.toJsonNode(), requestSensitiveValues, 0) }
    }

    private fun sensitiveValues(request: CanonicalJsonObject): Set<String> {
        val values = linkedSetOf<String>()
        fun visit(node: JsonNode, sensitive: Boolean, depth: Int) {
            if (depth > MAX_JSON_DEPTH) throw InvalidCommandRequestException()
            when {
                node.isObject -> node.fields().forEachRemaining { (name, child) ->
                    visit(child, sensitive || sensitiveName(name), depth + 1)
                }
                node.isArray -> node.forEach { visit(it, sensitive, depth + 1) }
                sensitive && node.isValueNode -> scalar(node)?.takeIf(String::isNotEmpty)?.let(values::add)
            }
        }
        visit(request.toJsonNode(), false, 0)
        return values.toSet()
    }

    private fun validateSafePersistenceJson(node: JsonNode, sensitiveValues: Set<String>, depth: Int) {
        if (depth > MAX_JSON_DEPTH) throw InvalidCommandRequestException()
        when {
            node.isObject -> node.fields().forEachRemaining { (name, child) ->
                if (sensitiveName(name)) throw InvalidCommandRequestException()
                validateSafePersistenceJson(child, sensitiveValues, depth + 1)
            }
            node.isArray -> node.forEach { validateSafePersistenceJson(it, sensitiveValues, depth + 1) }
            node.isValueNode -> {
                val candidate = scalar(node) ?: return
                if (sensitiveValues.any { it.isNotEmpty() && candidate.contains(it) }) throw InvalidCommandRequestException()
            }
        }
    }

    private fun scalar(node: JsonNode): String? = when {
        node.isNull -> null
        node.isTextual -> node.textValue()
        node.isNumber || node.isBoolean -> node.asText()
        else -> null
    }

    private fun sensitiveName(name: String): Boolean {
        val normalized = Normalizer.normalize(name, Normalizer.Form.NFKC).lowercase().filter(Char::isLetterOrDigit)
        return SENSITIVE_NAMES.any { normalized.contains(it) }
    }

    private fun authorizationNamespace(value: String): Boolean {
        val normalized = value.lowercase()
        return AUTHORIZATION_PREFIXES.any { normalized == it || normalized.startsWith("$it.") || normalized.startsWith("$it-") }
    }

    private fun validUuid(value: UUID): Boolean = value != UUID(0, 0) && value.version() in 1..8 && value.variant() == 2

    companion object {
        const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        const val MAX_REQUEST_BYTES = 256 * 1024
        const val MAX_RESPONSE_BYTES = 64 * 1024
        const val MAX_AUDIT_BYTES = 16 * 1024
        const val MAX_EVENT_BYTES = 64 * 1024
        const val MAX_JSON_DEPTH = 64
        val ACTION = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}${'$'}")
        val SENSITIVE_NAMES = setOf(
            "password", "passphrase", "secret", "token", "authorization", "cookie", "apikey", "credential", "privatekey",
        )
        val AUTHORIZATION_PREFIXES = setOf(
            "iam", "authz", "policy", "authorization", "relation", "relationship", "grant", "principal", "role",
        )
    }
}
