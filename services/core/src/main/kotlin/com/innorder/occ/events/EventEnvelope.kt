package com.innorder.occ.events

import com.fasterxml.jackson.core.JsonGenerator
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import com.fasterxml.jackson.databind.node.ObjectNode
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.TreeMap
import java.util.UUID

class EventEnvelope(
    val id: UUID,
    val customerInstanceId: UUID,
    val type: String,
    val schemaVersion: Long,
    val aggregateType: String,
    val aggregateId: UUID,
    val aggregateVersion: Long,
    val occurredAt: Instant,
    val actorId: UUID?,
    val correlationId: UUID,
    val causationId: UUID?,
    payload: JsonNode,
) {
    private val payload: ObjectNode
    private val bytes: ByteArray

    init {
        if (!STABLE_TYPE.matches(type) || !STABLE_TYPE.matches(aggregateType)) invalid()
        if (schemaVersion !in 1..EventPayloadPolicy.MAX_SAFE_INTEGER ||
            aggregateVersion !in 0..EventPayloadPolicy.MAX_SAFE_INTEGER
        ) invalid()
        val validatedPayload = try {
            EventPayloadPolicy.validate(payload)
        } catch (_: InvalidEventPayloadException) {
            invalid()
        }
        this.payload = sortObject(validatedPayload)
        bytes = serialize()
        if (bytes.size > MAX_MESSAGE_BYTES) invalid()
    }

    fun canonicalBytes(): ByteArray = bytes.copyOf()
    fun payload(): ObjectNode = payload.deepCopy()

    private fun serialize(): ByteArray = MAPPER.writeValueAsBytes(MAPPER.createObjectNode().apply {
        put("id", id.toString())
        put("customerInstanceId", customerInstanceId.toString())
        put("type", type)
        put("schemaVersion", schemaVersion)
        put("aggregateType", aggregateType)
        put("aggregateId", aggregateId.toString())
        put("aggregateVersion", aggregateVersion)
        put("occurredAt", DateTimeFormatter.ISO_INSTANT.format(occurredAt))
        actorId?.let { put("actorId", it.toString()) }
        put("correlationId", correlationId.toString())
        causationId?.let { put("causationId", it.toString()) }
        set<ObjectNode>("payload", payload)
    })

    companion object {
        const val MAX_MESSAGE_BYTES = 256 * 1024
        private val STABLE_TYPE = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}${'$'}")
        private val MAPPER = ObjectMapper().findAndRegisterModules().apply {
            factory.configure(JsonGenerator.Feature.AUTO_CLOSE_TARGET, false)
        }

        internal fun parsePayload(value: String): JsonNode = try {
            MAPPER.readTree(value)
        } catch (_: Exception) {
            throw InvalidEventEnvelopeException()
        }

        private fun sortObject(source: ObjectNode): ObjectNode = MAPPER.createObjectNode().also { target ->
            TreeMap<String, JsonNode>().apply { source.fields().forEachRemaining { put(it.key, it.value) } }
                .forEach { (key, value) -> target.set<JsonNode>(key, sort(value)) }
        }

        private fun sort(node: JsonNode): JsonNode = when (node) {
            is ObjectNode -> sortObject(node)
            is ArrayNode -> MAPPER.createArrayNode().also { array -> node.forEach { array.add(sort(it)) } }
            else -> node.deepCopy<JsonNode>()
        }

        private fun invalid(): Nothing = throw InvalidEventEnvelopeException()
    }
}

class InvalidEventEnvelopeException : RuntimeException("Stored event is invalid")
