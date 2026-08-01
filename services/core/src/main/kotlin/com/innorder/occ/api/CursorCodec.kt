package com.innorder.occ.api

import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.core.StreamReadConstraints
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import com.fasterxml.jackson.databind.node.ObjectNode
import com.innorder.occ.command.CanonicalJsonObject
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.text.Normalizer
import java.time.Clock
import java.time.Duration
import java.util.ArrayDeque
import java.util.Base64
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

enum class CursorDirection { FORWARD, BACKWARD }

data class CursorContext(
    val endpoint: String,
    val customerId: UUID,
    val filters: CanonicalJsonObject,
    val sortName: String,
    val sortVersion: Int,
    val direction: CursorDirection,
)

class InvalidCursorException : RuntimeException("Cursor is invalid")

@Component
@ConditionalOnProperty("occ.cursor.secret")
class CursorCodec(
    @Value("\${occ.cursor.secret}") secret: String,
    private val clock: Clock,
    @Value("\${occ.cursor.ttl:PT15M}") private val ttl: Duration = DEFAULT_TTL,
) {
    private val signingKey: SecretKeySpec

    init {
        val secretBytes = secret.toByteArray(StandardCharsets.UTF_8)
        require(secretBytes.size in MIN_SECRET_BYTES..MAX_SECRET_BYTES) { "Cursor secret is invalid" }
        signingKey = try {
            SecretKeySpec(secretBytes, HMAC_ALGORITHM)
        } finally {
            secretBytes.fill(0)
        }
        require(!ttl.isZero && !ttl.isNegative && ttl <= MAX_TTL && ttl.nano == 0) { "Cursor TTL is invalid" }
    }

    fun encode(context: CursorContext, tuple: ArrayNode): String = invalidOnFailure {
        validateContext(context)
        validateTuple(tuple)
        val expiresAt = Math.addExact(clock.instant().epochSecond, ttl.seconds)
        val payload = MAPPER.createObjectNode().apply {
            put("version", VERSION)
            put("endpoint", context.endpoint)
            put("customerId", context.customerId.toString())
            set<JsonNode>("filters", context.filters.toJsonNode())
            put("sortName", context.sortName)
            put("sortVersion", context.sortVersion)
            put("direction", context.direction.name)
            put("expiresAt", expiresAt)
            set<ArrayNode>("tuple", tuple.deepCopy())
        }
        val bytes = canonicalBytes(payload)
        val token = "${ENCODER.encodeToString(bytes)}.${ENCODER.encodeToString(sign(bytes))}"
        require(token.length <= MAX_TOKEN_CHARS)
        token
    }

    fun decode(token: String, expected: CursorContext): ArrayNode = invalidOnFailure {
        validateContext(expected)
        require(token.length in 1..MAX_TOKEN_CHARS && TOKEN_PATTERN.matches(token))
        val separator = token.indexOf('.')
        require(separator > 0 && separator == token.lastIndexOf('.') && separator < token.lastIndex)
        val payloadBytes = DECODER.decode(token.substring(0, separator))
        val suppliedSignature = DECODER.decode(token.substring(separator + 1))
        require(payloadBytes.size in 1..MAX_PAYLOAD_BYTES && suppliedSignature.size == SIGNATURE_BYTES)
        require(MessageDigest.isEqual(sign(payloadBytes), suppliedSignature))

        val payload = MAPPER.readTree(payloadBytes)
        require(payload is ObjectNode && payload.fieldNames().asSequence().toSet() == PAYLOAD_FIELDS)
        require(canonicalBytes(payload).contentEquals(payloadBytes))
        require(payload.requiredInt("version") == VERSION)
        require(payload.requiredText("endpoint") == expected.endpoint)
        require(payload.requiredUuid("customerId") == expected.customerId)
        require(CanonicalJsonObject.from(payload.required("filters")) == expected.filters)
        require(payload.requiredText("sortName") == expected.sortName)
        require(payload.requiredInt("sortVersion") == expected.sortVersion)
        require(payload.requiredText("direction") == expected.direction.name)
        val now = clock.instant().epochSecond
        val expiresAt = payload.requiredLong("expiresAt")
        require(expiresAt > now && expiresAt <= Math.addExact(now, ttl.seconds))
        val tuple = payload.required("tuple")
        require(tuple is ArrayNode)
        validateTuple(tuple)
        tuple.deepCopy()
    }

    private fun canonicalBytes(payload: ObjectNode): ByteArray {
        require(withinJsonDepth(payload))
        val canonical = CanonicalJsonObject.from(payload)
        val bytes = canonical.canonicalText().toByteArray(StandardCharsets.UTF_8)
        require(bytes.size <= MAX_PAYLOAD_BYTES)
        return bytes
    }

    private fun validateContext(context: CursorContext) {
        require(validName(context.endpoint, MAX_ENDPOINT_CHARS))
        require(validName(context.sortName, MAX_SORT_NAME_CHARS))
        require(context.sortVersion in 1..Int.MAX_VALUE)
    }

    private fun validateTuple(tuple: ArrayNode) {
        require(tuple.size() <= MAX_TUPLE_ITEMS && withinJsonDepth(tuple))
        require(tuple.all { value ->
            value.isNull || value.isBoolean || value.isTextual && value.textValue().length <= MAX_TUPLE_TEXT_CHARS ||
                value.isIntegralNumber || value.isFloatingPointNumber && value.doubleValue().isFinite()
        })
    }

    private fun validName(value: String, maxChars: Int): Boolean =
        value.isNotBlank() && value.length <= maxChars && Normalizer.isNormalized(value, Normalizer.Form.NFC) &&
            value.codePoints().allMatch { !Character.isISOControl(it) && it != 0xFEFF }

    private fun sign(payload: ByteArray): ByteArray = Mac.getInstance(HMAC_ALGORITHM).run {
        init(signingKey)
        doFinal(payload)
    }

    private fun withinJsonDepth(root: JsonNode): Boolean {
        val pending = ArrayDeque<Pair<JsonNode, Int>>().apply { add(root to 1) }
        while (pending.isNotEmpty()) {
            val (node, depth) = pending.removeLast()
            if (depth > MAX_JSON_DEPTH) return false
            node.elements().forEachRemaining { pending.add(it to depth + 1) }
        }
        return true
    }

    private inline fun <T> invalidOnFailure(action: () -> T): T = try {
        action()
    } catch (_: Exception) {
        throw InvalidCursorException()
    }

    companion object {
        const val MAX_TOKEN_CHARS = 4096
        const val MAX_PAYLOAD_BYTES = 2048
        const val MAX_JSON_DEPTH = 8
        const val MAX_TUPLE_ITEMS = 8
        const val MAX_SECRET_BYTES = 1024

        private const val VERSION = 1
        private const val MIN_SECRET_BYTES = 32
        private const val SIGNATURE_BYTES = 32
        private const val MAX_ENDPOINT_CHARS = 128
        private const val MAX_SORT_NAME_CHARS = 64
        private const val MAX_TUPLE_TEXT_CHARS = 512
        private const val HMAC_ALGORITHM = "HmacSHA256"
        private val DEFAULT_TTL = Duration.ofMinutes(15)
        private val MAX_TTL = Duration.ofHours(1)
        private val ENCODER = Base64.getUrlEncoder().withoutPadding()
        private val DECODER = Base64.getUrlDecoder()
        private val TOKEN_PATTERN = Regex("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")
        private val PAYLOAD_FIELDS = setOf(
            "version", "endpoint", "customerId", "filters", "sortName", "sortVersion", "direction", "expiresAt", "tuple",
        )
        private val MAPPER = ObjectMapper().findAndRegisterModules().apply {
            enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            factory.setStreamReadConstraints(
                StreamReadConstraints.builder()
                    .maxNestingDepth(MAX_JSON_DEPTH)
                    .maxStringLength(MAX_PAYLOAD_BYTES)
                    .maxNumberLength(64)
                    .build(),
            )
        }
    }
}

private fun ObjectNode.requiredText(name: String): String = required(name).also { require(it.isTextual) }.textValue()

private fun ObjectNode.requiredInt(name: String): Int = required(name).also {
    require(it.isIntegralNumber && it.canConvertToInt())
}.intValue()

private fun ObjectNode.requiredLong(name: String): Long = required(name).also {
    require(it.isIntegralNumber && it.canConvertToLong())
}.longValue()

private fun ObjectNode.requiredUuid(name: String): UUID = requiredText(name).let { value ->
    UUID.fromString(value).also { require(it.toString() == value) }
}
