package com.innorder.occ.api

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import com.innorder.occ.command.CanonicalJsonObject
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.boot.convert.ApplicationConversionService
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.util.Base64
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class CursorCodecTest {
    @TempDir
    lateinit var configTree: Path

    private val mapper = ObjectMapper().findAndRegisterModules()
    private val now = Instant.parse("2026-08-01T12:00:00Z")
    private val clock = Clock.fixed(now, ZoneOffset.UTC)
    private val codec = CursorCodec(SECRET, clock, Duration.ofMinutes(10))
    private val context = CursorContext(
        endpoint = "risk-interventions",
        customerId = UUID.fromString("10000000-0000-0000-0000-000000000001"),
        filters = canonical("""{"severity":["RED","YELLOW"],"state":"ACTIVE"}"""),
        sortName = "due-severity-id",
        sortVersion = 2,
        direction = CursorDirection.FORWARD,
    )
    private val tuple = array("2026-08-01T13:00:00Z", 3, "20000000-0000-0000-0000-000000000001")

    @Test
    fun `round trips stable tuple as opaque URL safe token`() {
        val token = codec.encode(context, tuple)

        assertThat(codec.decode(token, context)).isEqualTo(tuple)
        assertThat(token).matches("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$")
        assertThat(token).doesNotContain("=").doesNotContain(context.customerId.toString()).doesNotContain("ACTIVE")
    }

    @Test
    fun `rejects alternate trailing-bit encoding of payload segment`() {
        val token = generateSequence(0) { it + 1 }
            .map { codec.encode(context, array("tuple-$it")) }
            .first { it.substringBefore('.').length % 4 != 0 }
        val payload = token.substringBefore('.')
        val alternate = "${alternateEncoding(payload)}.${token.substringAfter('.')}"

        assertInvalid { codec.decode(alternate, context) }
    }

    @Test
    fun `rejects alternate trailing-bit encoding of signature segment`() {
        val token = codec.encode(context, tuple)
        val alternate = "${token.substringBefore('.')}.${alternateEncoding(token.substringAfter('.'))}"

        assertInvalid { codec.decode(alternate, context) }
    }

    @Test
    fun `canonical filters produce the same authenticated cursor`() {
        val reordered = context.copy(filters = canonical("""{"state":"ACTIVE","severity":["RED","YELLOW"]}"""))

        assertThat(codec.encode(reordered, tuple)).isEqualTo(codec.encode(context, tuple))
        assertThat(codec.decode(codec.encode(context, tuple), reordered)).isEqualTo(tuple)
    }

    @Test
    fun `rejects tampering expiry and context replay`() {
        val token = codec.encode(context, tuple)
        val altered = token.replaceRange(4, 5, if (token[4] == 'A') "B" else "A")
        val expiredCodec = CursorCodec(SECRET, Clock.fixed(now.plus(Duration.ofMinutes(10)), ZoneOffset.UTC), Duration.ofMinutes(10))
        val mismatches = listOf(
            context.copy(customerId = UUID.fromString("10000000-0000-0000-0000-000000000002")),
            context.copy(endpoint = "resource-schedule"),
            context.copy(filters = canonical("""{"severity":["RED"],"state":"ACTIVE"}""")),
            context.copy(sortName = "created-id"),
            context.copy(sortVersion = 3),
            context.copy(direction = CursorDirection.BACKWARD),
        )

        assertInvalid { codec.decode(altered, context) }
        assertInvalid { expiredCodec.decode(token, context) }
        mismatches.forEach { mismatch -> assertInvalid { codec.decode(token, mismatch) } }
    }

    @Test
    fun `rejects malformed encoding unknown fields and invalid payload values without parse details`() {
        val validPayload = payloadNode()
        val cases = listOf(
            "",
            "not-a-token",
            "a.b.c",
            "%%%.$$$",
            signedCanonical(validPayload.deepCopy().also { it.put("unknown", true) }),
            signedCanonical(validPayload.deepCopy().also { it.put("version", 99) }),
            signedCanonical(validPayload.deepCopy().also { it.put("customerId", "not-a-uuid") }),
            signedText("""{"version":1,"version":1}"""),
            signedText("not-json"),
        )

        cases.forEach { token ->
            assertThatThrownBy { codec.decode(token, context) }
                .isExactlyInstanceOf(InvalidCursorException::class.java)
                .hasMessage("Cursor is invalid")
                .hasNoCause()
        }
    }

    @Test
    fun `enforces token payload nesting and stable tuple limits`() {
        val oversizedToken = "a".repeat(CursorCodec.MAX_TOKEN_CHARS + 1)
        val oversizedPayload = payloadNode().also { it.put("endpoint", "x".repeat(CursorCodec.MAX_PAYLOAD_BYTES)) }
        val deepTuple = array().also { root ->
            var current = root
            repeat(CursorCodec.MAX_JSON_DEPTH) { current = array().also(current::add) }
            current.add("value")
        }
        val longTuple = array().also { values ->
            repeat(CursorCodec.MAX_TUPLE_ITEMS + 1) { values.add(it) }
        }

        assertInvalid { codec.decode(oversizedToken, context) }
        assertInvalid { codec.decode(signed(oversizedPayload), context) }
        assertInvalid { codec.encode(context, deepTuple) }
        assertInvalid { codec.decode(signed(payloadNode().set<ArrayNode>("tuple", deepTuple)), context) }
        assertInvalid { codec.encode(context, longTuple) }
        assertInvalid { codec.decode(signed(payloadNode().set<ArrayNode>("tuple", longTuple)), context) }
    }

    @Test
    fun `rejects signed expiry beyond maximum cursor lifetime`() {
        val farFuture = payloadNode().also { it.put("expiresAt", now.plus(Duration.ofHours(2)).epochSecond) }

        assertInvalid { codec.decode(signedCanonical(farFuture), context) }
    }

    @Test
    fun `rejects extreme tuple nesting without exposing stack exhaustion`() {
        val extreme = array()
        var current = extreme
        repeat(2_000) { current = array().also(current::add) }

        assertInvalid { codec.encode(context, extreme) }
    }

    @Test
    fun `requires strong bounded config tree secret and valid context`() {
        listOf("short", "x".repeat(CursorCodec.MAX_SECRET_BYTES + 1)).forEach { secret ->
            assertThatThrownBy { CursorCodec(secret, clock, Duration.ofMinutes(10)) }
                .isInstanceOf(IllegalArgumentException::class.java)
                .hasMessageNotContaining(secret)
        }
        listOf(
            context.copy(endpoint = ""),
            context.copy(endpoint = "e\u0301"),
            context.copy(sortName = ""),
            context.copy(sortVersion = 0),
        ).forEach { invalid -> assertInvalid { codec.encode(invalid, tuple) } }
    }

    @Test
    fun `config tree creates codec from strong mounted secret`() {
        Files.write(configTree.resolve("occ.cursor.secret"), SECRET.toByteArray(StandardCharsets.UTF_8))

        cursorContext().run { context ->
            assertThat(context).hasNotFailed()
            assertThat(context).hasSingleBean(CursorCodec::class.java)
        }
    }

    @Test
    fun `startup fails when config tree cursor secret is missing or weak`() {
        cursorContext().run { context -> assertThat(context).hasFailed() }
        Files.write(configTree.resolve("occ.cursor.secret"), "weak".toByteArray(StandardCharsets.UTF_8))
        cursorContext().run { context ->
            assertThat(context).hasFailed()
            assertThat(context.startupFailure).hasMessageNotContaining("weak")
        }
    }

    private fun payloadNode() = mapper.createObjectNode().apply {
        put("version", 1)
        put("endpoint", context.endpoint)
        put("customerId", context.customerId.toString())
        set<JsonNode>("filters", context.filters.toJsonNode())
        put("sortName", context.sortName)
        put("sortVersion", context.sortVersion)
        put("direction", context.direction.name)
        put("expiresAt", now.plus(Duration.ofMinutes(10)).epochSecond)
        set<ArrayNode>("tuple", tuple)
    }

    private fun signed(node: JsonNode): String = signedText(mapper.writeValueAsString(node))
    private fun signedCanonical(node: JsonNode): String = signedText(CanonicalJsonObject.from(node).canonicalText())

    private fun signedText(payload: String): String {
        val bytes = payload.toByteArray(StandardCharsets.UTF_8)
        val mac = Mac.getInstance("HmacSHA256").apply {
            init(SecretKeySpec(SECRET.toByteArray(StandardCharsets.UTF_8), "HmacSHA256"))
        }
        return "${ENCODER.encodeToString(bytes)}.${ENCODER.encodeToString(mac.doFinal(bytes))}"
    }

    private fun alternateEncoding(segment: String): String {
        val decoded = Base64.getUrlDecoder().decode(segment)
        return BASE64URL_ALPHABET.asSequence()
            .map { segment.dropLast(1) + it }
            .first { it != segment && runCatching { Base64.getUrlDecoder().decode(it) }.getOrNull()?.contentEquals(decoded) == true }
    }

    private fun cursorContext() = ApplicationContextRunner()
        .withInitializer(ConfigDataApplicationContextInitializer())
        .withInitializer { it.beanFactory.setConversionService(ApplicationConversionService.getSharedInstance()) }
        .withPropertyValues(
            "spring.config.name=cursor-codec-test",
            "spring.config.import=configtree:${configTree.toAbsolutePath().toString().replace('\\', '/')}/",
        )
        .withBean(Clock::class.java, { clock })
        .withUserConfiguration(CursorCodec::class.java)

    private fun canonical(json: String) = CanonicalJsonObject.from(mapper.readTree(json))
    private fun array(vararg values: Any): ArrayNode = mapper.valueToTree(values)
    private fun assertInvalid(action: () -> Unit) = assertThatThrownBy(action)
        .isExactlyInstanceOf(InvalidCursorException::class.java)
        .hasMessage("Cursor is invalid")

    private companion object {
        const val SECRET = "test-only-cursor-secret-material-32-bytes-minimum"
        const val BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        val ENCODER: Base64.Encoder = Base64.getUrlEncoder().withoutPadding()
    }
}
