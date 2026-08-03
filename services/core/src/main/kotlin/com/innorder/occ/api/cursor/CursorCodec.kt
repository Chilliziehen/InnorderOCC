package com.innorder.occ.api.cursor

import com.fasterxml.jackson.core.JsonGenerator
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.Base64
import java.util.Locale
import java.util.UUID

class InvalidCursorException : IllegalArgumentException("Cursor is invalid")

data class CursorPayload(
    val version: Int,
    val subjectId: UUID,
    val endpoint: String,
    val filterDigest: String,
    val sortTimestamp: Instant,
    val lastId: UUID,
    val issuedAt: Instant,
    val keyId: String,
)

data class CursorBinding(
    val subjectId: UUID,
    val endpoint: String,
    val filterDigest: String,
)

interface CursorCodec {
    fun encode(payload: CursorPayload): String
    fun decode(cursor: String, binding: CursorBinding): CursorPayload
}

class HmacCursorCodec(
    private val keys: CursorKeyRing,
    objectMapper: ObjectMapper,
    private val clock: Clock,
) : CursorCodec {
    private val mapper = objectMapper.copy().enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)

    override fun encode(payload: CursorPayload): String = invalidOnFailure {
        validatePayload(payload)
        require(payload.keyId == keys.currentKeyId)
        require(!payload.issuedAt.isAfter(clock.instant()))
        val bytes = canonicalBytes(payload)
        val cursor = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes + keys.sign(bytes))
        require(cursor.length <= MAX_CURSOR_LENGTH)
        cursor
    }

    override fun decode(cursor: String, binding: CursorBinding): CursorPayload = invalidOnFailure {
        require(cursor.isNotEmpty() && cursor.length <= MAX_CURSOR_LENGTH && BASE64_URL.matches(cursor))
        val decoded = Base64.getUrlDecoder().decode(cursor)
        require(decoded.size > SIGNATURE_BYTES)
        val payloadBytes = decoded.copyOfRange(0, decoded.size - SIGNATURE_BYTES)
        val signature = decoded.copyOfRange(decoded.size - SIGNATURE_BYTES, decoded.size)
        val payload = parse(payloadBytes)
        val now = clock.instant()
        require(keys.verify(payload.keyId, payloadBytes, signature, now, payload.issuedAt))
        require(MessageDigest.isEqual(payloadBytes, canonicalBytes(payload)))
        validatePayload(payload)
        require(payload.subjectId == binding.subjectId)
        require(payload.endpoint == normalizeEndpoint(binding.endpoint))
        require(payload.filterDigest == normalizeDigest(binding.filterDigest))
        val age = Duration.between(payload.issuedAt, now)
        require(!age.isNegative && age < MAX_AGE)
        payload
    }

    private fun parse(payload: ByteArray): CursorPayload {
        val node: JsonNode = mapper.readTree(payload)
        require(node.isObject && node.size() == FIELDS.size && node.fieldNames().asSequence().toSet() == FIELDS)
        return CursorPayload(
            integer(node, "version"),
            UUID.fromString(text(node, "subjectId")),
            text(node, "endpoint"),
            text(node, "filterDigest"),
            Instant.parse(text(node, "sortTimestamp")),
            UUID.fromString(text(node, "lastId")),
            Instant.parse(text(node, "issuedAt")),
            text(node, "keyId"),
        )
    }

    private fun canonicalBytes(payload: CursorPayload): ByteArray = ByteArrayOutputStream().use { output ->
        mapper.factory.createGenerator(output).use { generator ->
            generator.writeStartObject()
            generator.writeNumberField("version", payload.version)
            generator.writeStringField("subjectId", payload.subjectId.toString())
            generator.writeStringField("endpoint", payload.endpoint)
            generator.writeStringField("filterDigest", payload.filterDigest)
            generator.writeStringField("sortTimestamp", payload.sortTimestamp.toString())
            generator.writeStringField("lastId", payload.lastId.toString())
            generator.writeStringField("issuedAt", payload.issuedAt.toString())
            generator.writeStringField("keyId", payload.keyId)
            generator.writeEndObject()
        }
        output.toByteArray()
    }

    private fun validatePayload(payload: CursorPayload) {
        require(payload.version == VERSION)
        require(payload.endpoint == normalizeEndpoint(payload.endpoint))
        require(payload.filterDigest == normalizeDigest(payload.filterDigest))
        require(KEY_ID.matches(payload.keyId))
    }

    private fun integer(node: JsonNode, field: String): Int {
        val value = node.get(field)
        require(value != null && value.isIntegralNumber && value.canConvertToInt())
        return value.intValue()
    }

    private fun text(node: JsonNode, field: String): String {
        val value = node.get(field)
        require(value != null && value.isTextual)
        return value.textValue()
    }

    private fun normalizeEndpoint(value: String): String {
        require(value.length in 1..MAX_ENDPOINT_LENGTH && value.startsWith("/api/v1/") &&
            value == value.trim() && !value.contains('?') && !value.contains('#'))
        return value
    }

    private fun normalizeDigest(value: String): String {
        val normalized = value.trim().lowercase(Locale.ROOT)
        require(DIGEST.matches(normalized))
        return normalized
    }

    private inline fun <T> invalidOnFailure(block: () -> T): T = try {
        block()
    } catch (failure: InvalidCursorException) {
        throw failure
    } catch (_: Exception) {
        throw InvalidCursorException()
    }

    companion object {
        private const val VERSION = 1
        private const val SIGNATURE_BYTES = 32
        private const val MAX_CURSOR_LENGTH = 4096
        private const val MAX_ENDPOINT_LENGTH = 256
        private val MAX_AGE = Duration.ofHours(24)
        private val BASE64_URL = Regex("^[A-Za-z0-9_-]+${'$'}")
        private val DIGEST = Regex("^[0-9a-f]{64}${'$'}")
        private val KEY_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}${'$'}")
        private val FIELDS = setOf(
            "version", "subjectId", "endpoint", "filterDigest", "sortTimestamp", "lastId", "issuedAt", "keyId",
        )
    }
}

class CursorFilterDigest(objectMapper: ObjectMapper) {
    private val mapper = objectMapper.copy().enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)

    fun fromJson(json: String): String = try {
        require(json.toByteArray(Charsets.UTF_8).size <= MAX_FILTER_BYTES)
        val node: JsonNode = mapper.readTree(json)
        val output = ByteArrayOutputStream()
        mapper.factory.createGenerator(output).use { writeCanonical(it, node) }
        MessageDigest.getInstance("SHA-256").digest(output.toByteArray())
            .joinToString("") { "%02x".format(it) }
    } catch (_: Exception) {
        throw InvalidCursorException()
    }

    private fun writeCanonical(generator: JsonGenerator, node: JsonNode) {
        when {
            node.isObject -> {
                generator.writeStartObject()
                node.fieldNames().asSequence().sorted().forEach { name ->
                    generator.writeFieldName(name)
                    writeCanonical(generator, node.get(name))
                }
                generator.writeEndObject()
            }
            node.isArray -> {
                generator.writeStartArray()
                node.forEach { writeCanonical(generator, it) }
                generator.writeEndArray()
            }
            else -> generator.writeTree(node)
        }
    }

    companion object {
        private const val MAX_FILTER_BYTES = 16_384
    }
}
