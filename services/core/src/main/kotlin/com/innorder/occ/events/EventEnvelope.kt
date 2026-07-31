package com.innorder.occ.events

import com.fasterxml.jackson.core.JsonGenerator
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import com.fasterxml.jackson.databind.node.ObjectNode
import java.text.Normalizer
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
        if (schemaVersion !in 1..MAX_SAFE_INTEGER || aggregateVersion !in 0..MAX_SAFE_INTEGER) invalid()
        if (payload !is ObjectNode || !validJson(payload, 0)) invalid()
        this.payload = sortObject(payload)
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
        const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        const val MAX_MESSAGE_BYTES = 256 * 1024
        private const val MAX_DEPTH = 32
        private val STABLE_TYPE = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}${'$'}")
        private val SENSITIVE_NAMES = setOf(
            "password", "passwd", "secret", "token", "authorization", "credential", "apikey", "privatekey",
        )
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

        private fun validJson(node: JsonNode, depth: Int): Boolean {
            if (depth > MAX_DEPTH) return false
            return when {
                node.isObject -> node.fields().asSequence().all { (name, value) ->
                    validText(name) && !sensitiveName(name) && validJson(value, depth + 1)
                }
                node.isArray -> node.all { validJson(it, depth + 1) }
                node.isTextual -> validText(node.textValue())
                node.isIntegralNumber -> runCatching { node.longValue() in -MAX_SAFE_INTEGER..MAX_SAFE_INTEGER }.getOrDefault(false)
                node.isFloatingPointNumber -> node.doubleValue().isFinite() && kotlin.math.abs(node.doubleValue()) <= MAX_SAFE_INTEGER
                node.isBoolean || node.isNull -> true
                else -> false
            }
        }

        private fun validText(value: String): Boolean = Normalizer.isNormalized(value, Normalizer.Form.NFC) &&
            value.codePoints().allMatch { it !in 0xD800..0xDFFF && it != 0xFEFF && (it >= 0x20 || it == 0x09) }

        private fun sensitiveName(value: String): Boolean {
            val normalized = Normalizer.normalize(value, Normalizer.Form.NFKC).lowercase().filter(Char::isLetterOrDigit)
            return SENSITIVE_NAMES.any(normalized::contains)
        }

        private fun invalid(): Nothing = throw InvalidEventEnvelopeException()
    }
}

class InvalidEventEnvelopeException : RuntimeException("Stored event is invalid")
