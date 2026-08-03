package com.innorder.occ.command

import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import com.fasterxml.jackson.databind.node.ObjectNode
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.text.Normalizer
import java.util.TreeMap

class CanonicalJsonObject private constructor(private val bytes: ByteArray) {
    val digest: String = sha256(bytes)

    fun toJsonNode(): ObjectNode = MAPPER.readTree(bytes) as ObjectNode
    fun canonicalText(): String = bytes.toString(StandardCharsets.UTF_8)

    internal fun size(): Int = bytes.size

    override fun equals(other: Any?): Boolean = other is CanonicalJsonObject && bytes.contentEquals(other.bytes)
    override fun hashCode(): Int = bytes.contentHashCode()
    override fun toString(): String = "CanonicalJsonObject(size=${bytes.size},digest=$digest)"

    companion object {
        const val MAX_BYTES = 64 * 1024

        private val MAPPER = ObjectMapper().findAndRegisterModules()
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)

        fun from(node: JsonNode): CanonicalJsonObject = from(node, MAX_BYTES)

        internal fun parse(bytes: ByteArray, maxBytes: Int): CanonicalJsonObject {
            if (bytes.isEmpty() || bytes.size > maxBytes || !isUtf8(bytes)) throw InvalidCommandRequestException()
            val node = try {
                MAPPER.readTree(bytes)
            } catch (_: Exception) {
                throw InvalidCommandRequestException()
            }
            return from(node, maxBytes)
        }

        internal fun from(node: JsonNode, maxBytes: Int): CanonicalJsonObject {
            if (node !is ObjectNode || !valid(node)) throw InvalidCommandRequestException()
            val canonicalBytes = MAPPER.writeValueAsBytes(sortObject(node))
            if (canonicalBytes.size > maxBytes) throw InvalidCommandRequestException()
            return CanonicalJsonObject(canonicalBytes)
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

        private fun valid(node: JsonNode): Boolean {
            fun validText(value: String): Boolean = Normalizer.isNormalized(value, Normalizer.Form.NFC) &&
                value.codePoints().allMatch { it !in 0xD800..0xDFFF && it != 0xFEFF }
            return when {
                node.isObject -> node.fields().asSequence().all { validText(it.key) && valid(it.value) }
                node.isArray -> node.all(::valid)
                node.isTextual -> validText(node.textValue())
                node.isNumber -> node.isIntegralNumber || (node.isFloatingPointNumber && node.doubleValue().isFinite())
                node.isBoolean || node.isNull -> true
                else -> false
            }
        }

        private fun isUtf8(bytes: ByteArray): Boolean = StandardCharsets.UTF_8.newDecoder()
            .runCatching { decode(ByteBuffer.wrap(bytes)) }
            .isSuccess

        private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }
    }
}
