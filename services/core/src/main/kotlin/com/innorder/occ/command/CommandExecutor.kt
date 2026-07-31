package com.innorder.occ.command

import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import com.fasterxml.jackson.databind.node.ObjectNode
import com.innorder.occ.authz.AuthorizationRequest
import com.innorder.occ.authz.AuthorizationService
import com.innorder.occ.events.OutboxRepository
import org.springframework.stereotype.Service
import org.springframework.jdbc.core.JdbcOperations
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionTemplate
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.text.Normalizer
import java.util.TreeMap
import java.util.UUID

@Service
class CommandExecutor(
    transactionManager: PlatformTransactionManager,
    private val authorizationService: AuthorizationService,
    private val idempotency: IdempotencyRepository,
    private val audit: AuditRepository,
    private val outbox: OutboxRepository,
    mapper: ObjectMapper,
    private val jdbc: JdbcOperations,
) {
    private val transactions = TransactionTemplate(transactionManager).apply {
        propagationBehavior = TransactionDefinition.PROPAGATION_REQUIRED
    }
    private val strictMapper = mapper.copy()
        .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)

    fun execute(metadata: CommandMetadata, requestBytes: ByteArray, command: AuthorizedCommand): CommandResult {
        val request = canonicalRequest(requestBytes)
        val requestDigest = digest(canonicalBytes(request))
        return transactions.execute {
            when (val acquisition = idempotency.acquire(metadata, requestDigest)) {
                is IdempotencyAcquisition.Replay -> acquisition.result
                is IdempotencyAcquisition.Owner -> executeOwned(metadata, request, requestDigest, command, acquisition.recordId)
            }
        }!!
    }

    private fun executeOwned(
        metadata: CommandMetadata,
        request: ObjectNode,
        requestDigest: String,
        command: AuthorizedCommand,
        idempotencyRecordId: UUID,
    ): CommandResult {
        validateCommand(command)
        if (command.expectedVersionRequired && (metadata.expectedVersion == null || metadata.expectedVersion < 0)) {
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
        val currentVersion = command.currentVersion(context)
        if (currentVersion != null && currentVersion < 0) throw InvalidCommandRequestException()
        if (command.expectedVersionRequired && currentVersion != metadata.expectedVersion) {
            throw OptimisticConflictException(currentVersion ?: 0)
        }
        val mutation = command.execute(context)
        validateMutation(mutation, currentVersion)
        val response = canonicalObject(mutation.body, MAX_RESPONSE_BYTES, InvalidCommandRequestException::class.java)
        val detail = canonicalObject(mutation.auditDetail, MAX_AUDIT_BYTES, InvalidCommandRequestException::class.java)
        val events = mutation.events.map { event ->
            event.copy(payload = canonicalObject(event.payload, MAX_EVENT_BYTES, InvalidCommandRequestException::class.java))
        }
        val canonicalMutation = mutation.copy(body = response, auditDetail = detail, events = events)
        audit.insert(transactionId, metadata, command.action, canonicalMutation)
        outbox.insert(metadata, transactionId, canonicalMutation)
        val result = CommandResult(mutation.status, response, mutation.resourceId, replayed = false)
        idempotency.complete(idempotencyRecordId, result, digest(canonicalBytes(response)))
        return result
    }

    private fun canonicalRequest(bytes: ByteArray): ObjectNode {
        if (bytes.isEmpty() || bytes.size > MAX_REQUEST_BYTES || !StandardCharsets.UTF_8.newDecoder().runCatching { decode(java.nio.ByteBuffer.wrap(bytes)) }.isSuccess) {
            throw InvalidCommandRequestException()
        }
        val parsed = try {
            strictMapper.readTree(bytes)
        } catch (_: Exception) {
            throw InvalidCommandRequestException()
        }
        if (parsed !is ObjectNode || !validUnicode(parsed)) throw InvalidCommandRequestException()
        return sortObject(parsed)
    }

    private fun canonicalObject(node: JsonNode, maxBytes: Int, failure: Class<out RuntimeException>): ObjectNode {
        if (node !is ObjectNode || !validUnicode(node)) throw failure.getDeclaredConstructor().newInstance()
        val canonical = sortObject(node)
        if (canonicalBytes(canonical).size > maxBytes) throw failure.getDeclaredConstructor().newInstance()
        return canonical
    }

    private fun sortObject(source: ObjectNode): ObjectNode = strictMapper.createObjectNode().also { target ->
        TreeMap<String, JsonNode>().apply { source.fields().forEachRemaining { put(it.key, it.value) } }
            .forEach { (key, value) -> target.set<JsonNode>(key, sort(value)) }
    }

    private fun sort(node: JsonNode): JsonNode = when (node) {
        is ObjectNode -> sortObject(node)
        is ArrayNode -> strictMapper.createArrayNode().also { array -> node.forEach { array.add(sort(it)) } }
        else -> node.deepCopy<JsonNode>()
    }

    private fun validUnicode(node: JsonNode): Boolean {
        fun valid(value: String): Boolean = Normalizer.isNormalized(value, Normalizer.Form.NFC) && value.codePoints().allMatch {
            it !in 0xD800..0xDFFF && it != 0xFEFF
        }
        return when {
            node.isObject -> node.fields().asSequence().all { valid(it.key) && validUnicode(it.value) }
            node.isArray -> node.all(::validUnicode)
            node.isTextual -> valid(node.textValue())
            node.isNumber -> node.isIntegralNumber || (node.isFloatingPointNumber && node.doubleValue().isFinite())
            node.isBoolean || node.isNull -> true
            else -> false
        }
    }

    private fun validateCommand(command: AuthorizedCommand) {
        if (!ACTION.matches(command.action)) throw InvalidCommandMetadataException()
    }

    private fun validateMutation(mutation: CommandMutation, currentVersion: Long?) {
        if (mutation.status !in 100..599 || mutation.aggregateType.length !in 1..128 ||
            !ACTION.matches(mutation.aggregateType) || mutation.afterVersion < 0 ||
            mutation.beforeVersion != currentVersion || mutation.afterVersion <= (mutation.beforeVersion ?: -1) ||
            mutation.auditReason?.let { it.length !in 1..1024 || it.any(Char::isISOControl) } == true ||
            mutation.events.isEmpty() || mutation.events.size > 128 ||
            mutation.events.map { it.aggregateVersion }.distinct().size != mutation.events.size ||
            mutation.events.map { it.aggregateVersion } != mutation.events.map { it.aggregateVersion }.sorted() ||
            mutation.events.any { it.aggregateVersion <= (mutation.beforeVersion ?: -1) || it.aggregateVersion > mutation.afterVersion || it.schemaVersion < 1 || !ACTION.matches(it.eventType) }
        ) throw InvalidCommandRequestException()
    }

    private fun canonicalBytes(node: JsonNode): ByteArray = strictMapper.writeValueAsBytes(node)
    private fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }

    private companion object {
        const val MAX_REQUEST_BYTES = 256 * 1024
        const val MAX_RESPONSE_BYTES = 64 * 1024
        const val MAX_AUDIT_BYTES = 16 * 1024
        const val MAX_EVENT_BYTES = 64 * 1024
        val ACTION = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}${'$'}")
    }
}
