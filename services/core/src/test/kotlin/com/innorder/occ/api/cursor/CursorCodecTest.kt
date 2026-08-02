package com.innorder.occ.api.cursor

import com.fasterxml.jackson.databind.ObjectMapper
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.boot.env.YamlPropertySourceLoader
import org.springframework.core.io.ClassPathResource
import java.nio.file.Files
import java.nio.file.Path
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.util.Base64
import java.util.UUID
import java.util.function.Supplier
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class CursorCodecTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `canonical filter digest is stable across object order and insignificant whitespace`() {
        val digest = CursorFilterDigest(ObjectMapper())

        assertThat(digest.fromJson("""{"state":"active","page":2}"""))
            .isEqualTo(digest.fromJson(""" { "page" : 2, "state" : "active" } """))
            .matches("[0-9a-f]{64}")
        assertThatThrownBy { digest.fromJson("""{"state":"active","state":"draft"}""") }
            .isInstanceOf(InvalidCursorException::class.java)
    }

    @Test
    fun `round trip emits opaque bounded canonical payload and binds subject endpoint and filter`() {
        val codec = codec(key("current.key", 0x31), "current")
        val payload = payload()
        val encoded = codec.encode(payload)

        assertThat(encoded).doesNotContain("{").hasSizeLessThanOrEqualTo(4096)
        assertThat(codec.decode(encoded, binding())).isEqualTo(payload)
        listOf(
            binding().copy(subjectId = UUID.randomUUID()),
            binding().copy(endpoint = "/api/v1/processes"),
            binding().copy(filterDigest = "b".repeat(64)),
        ).forEach { mismatched ->
            assertThatThrownBy { codec.decode(encoded, mismatched) }
                .isInstanceOf(InvalidCursorException::class.java)
        }
    }

    @Test
    fun `rotated codec accepts current and previous keys and rejects unknown key`() {
        val oldPath = key("old.key", 0x42)
        val newPath = key("new.key", 0x53)
        val oldCursor = codec(oldPath, "old").encode(payload(keyId = "old"))
        val newCursor = codec(newPath, "new").encode(payload(keyId = "new"))
        val rotated = codec(newPath, "new", oldPath, "old")

        assertThat(rotated.decode(oldCursor, binding()).keyId).isEqualTo("old")
        assertThat(rotated.decode(newCursor, binding()).keyId).isEqualTo("new")
        assertThatThrownBy {
            rotated.decode(codec(key("unknown.key", 0x64), "unknown").encode(payload(keyId = "unknown")), binding())
        }.isInstanceOf(InvalidCursorException::class.java)
    }

    @Test
    fun `cursor expires at 24 hours and rejects future issuance`() {
        val key = key("expiry.key", 0x25)
        val issued = NOW.minus(Duration.ofHours(24))
        val source = codec(key, "current", clock = Clock.fixed(issued, ZoneOffset.UTC))
        val cursor = source.encode(payload(issuedAt = issued))

        assertThat(codec(key, "current", clock = Clock.fixed(NOW.minusNanos(1), ZoneOffset.UTC))
            .decode(cursor, binding()).issuedAt).isEqualTo(issued)
        assertThatThrownBy { codec(key, "current").decode(cursor, binding()) }
            .isInstanceOf(InvalidCursorException::class.java)

        val futureCodec = codec(key, "current", clock = Clock.fixed(NOW.plusSeconds(1), ZoneOffset.UTC))
        val futureCursor = futureCodec.encode(payload(issuedAt = NOW.plusSeconds(1)))
        assertThatThrownBy { codec(key, "current").decode(futureCursor, binding()) }
            .isInstanceOf(InvalidCursorException::class.java)
    }

    @Test
    fun `bad signature malformed duplicate and unsafe typed payloads are rejected`() {
        val keyPath = key("strict.key", 0x16)
        val codec = codec(keyPath, "current")
        val valid = codec.encode(payload())
        val damaged = Base64.getUrlDecoder().decode(valid).also { it[it.lastIndex] = (it.last() xor 1) }
        assertThatThrownBy { codec.decode(Base64.getUrlEncoder().withoutPadding().encodeToString(damaged), binding()) }
            .isInstanceOf(InvalidCursorException::class.java)
        assertThatThrownBy { codec.decode("not_base64!", binding()) }
            .isInstanceOf(InvalidCursorException::class.java)

        listOf(
            canonicalJson().replaceFirst("\"version\":1", "\"version\":1,\"version\":1"),
            canonicalJson().replace(SUBJECT.toString(), "not-a-uuid"),
            canonicalJson().replace(NOW.toString(), "not-an-instant"),
            canonicalJson().dropLast(1) + ",\"extra\":true}",
        ).forEach { json ->
            assertThatThrownBy { codec.decode(sign(json, keyPath), binding()) }
                .isInstanceOf(InvalidCursorException::class.java)
        }
    }

    @Test
    fun `weak missing and inconsistent key configuration fails without exposing material`() {
        val missing = directory.resolve("missing.key")
        val weak = directory.resolve("weak.key").also { Files.write(it, ByteArray(31) { 1 }) }
        val lowEntropy = directory.resolve("low-entropy.key").also { Files.write(it, ByteArray(32) { 1 }) }
        listOf(
            CursorProperties("current", missing.toString()),
            CursorProperties("current", weak.toString()),
            CursorProperties("current", lowEntropy.toString()),
            CursorProperties("current", key("valid.key", 0x77).toString(), previousKeyId = "old"),
        ).forEach { properties ->
            assertThatThrownBy { CursorKeyRing.load(properties) }
                .isInstanceOf(CursorKeyConfigurationException::class.java)
                .hasMessageNotContaining("119")
        }
    }

    @Test
    fun `blank optional previous configuration is treated as absent`() {
        val ring = CursorKeyRing.load(
            CursorProperties("current", key("current-only.key", 0x37).toString(), "", ""),
        )

        assertThat(ring.currentKeyId).isEqualTo("current")
    }

    @Test
    fun `configured codec loads keys during context startup while absent configuration stays optional`() {
        val context = ApplicationContextRunner()
            .withUserConfiguration(CursorConfiguration::class.java)
            .withBean(ObjectMapper::class.java, Supplier { ObjectMapper().findAndRegisterModules() })
            .withBean(Clock::class.java, Supplier { Clock.fixed(NOW, ZoneOffset.UTC) })

        context.run { assertThat(it).hasNotFailed().doesNotHaveBean(CursorCodec::class.java) }
        context.withPropertyValues(
            "occ.cursor.current-key-id=current",
            "occ.cursor.current-key-file=${key("context.key", 0x48)}",
        ).run { assertThat(it).hasNotFailed().hasSingleBean(CursorCodec::class.java) }
        context.withPropertyValues(
            "occ.cursor.current-key-id=current",
            "occ.cursor.current-key-file=${directory.resolve("missing-context.key")}",
        ).run {
            assertThat(it).hasFailed()
            assertThat(it.startupFailure).hasStackTraceContaining("Cursor key configuration is unavailable or invalid")
        }
    }

    @Test
    fun `production configuration exposes file paths and key ids without secret defaults`() {
        val source = YamlPropertySourceLoader().load("application", ClassPathResource("application.yml")).single()

        assertThat(source.getProperty("occ.cursor.current-key-id")).isEqualTo("${'$'}{OCC_CURSOR_CURRENT_KEY_ID:current}")
        assertThat(source.getProperty("occ.cursor.current-key-file")).isEqualTo("${'$'}{OCC_CURSOR_CURRENT_KEY_FILE:}")
        assertThat(source.getProperty("occ.cursor.previous-key-id")).isEqualTo("${'$'}{OCC_CURSOR_PREVIOUS_KEY_ID:}")
        assertThat(source.getProperty("occ.cursor.previous-key-file")).isEqualTo("${'$'}{OCC_CURSOR_PREVIOUS_KEY_FILE:}")
    }

    @Test
    fun `encode and decode enforce total cursor size bound`() {
        val keyPath = key("bounded.key", 0x28)
        val codec = codec(keyPath, "current")
        assertThatThrownBy { codec.encode(payload(endpoint = "/" + "x".repeat(4096))) }
            .isInstanceOf(InvalidCursorException::class.java)
        assertThatThrownBy { codec.decode("a".repeat(4097), binding()) }
            .isInstanceOf(InvalidCursorException::class.java)
    }

    private fun codec(
        currentPath: Path,
        currentId: String,
        previousPath: Path? = null,
        previousId: String? = null,
        clock: Clock = Clock.fixed(NOW, ZoneOffset.UTC),
    ): CursorCodec = HmacCursorCodec(
        CursorKeyRing.load(
            CursorProperties(currentId, currentPath.toString(), previousId, previousPath?.toString()),
        ),
        ObjectMapper().findAndRegisterModules(),
        clock,
    )

    private fun key(name: String, byte: Int): Path = directory.resolve(name).also {
        Files.write(it, ByteArray(32) { index -> (byte + index * 17).toByte() })
    }

    private fun payload(
        keyId: String = "current",
        issuedAt: Instant = NOW,
        endpoint: String = ENDPOINT,
    ) = CursorPayload(1, SUBJECT, endpoint, FILTER, SORT_TIME, LAST_ID, issuedAt, keyId)

    private fun binding() = CursorBinding(SUBJECT, ENDPOINT, FILTER)

    private fun canonicalJson(): String =
        """{"version":1,"subjectId":"$SUBJECT","endpoint":"$ENDPOINT","filterDigest":"$FILTER","sortTimestamp":"$SORT_TIME","lastId":"$LAST_ID","issuedAt":"$NOW","keyId":"current"}"""

    private fun sign(json: String, keyPath: Path): String {
        val payload = json.toByteArray(Charsets.UTF_8)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(Files.readAllBytes(keyPath), "HmacSHA256"))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(payload + mac.doFinal(payload))
    }

    private infix fun Byte.xor(value: Int): Byte = (toInt() xor value).toByte()

    companion object {
        private val SUBJECT = UUID.fromString("11111111-1111-4111-8111-111111111111")
        private val LAST_ID = UUID.fromString("22222222-2222-4222-8222-222222222222")
        private val NOW = Instant.parse("2026-08-02T12:00:00Z")
        private val SORT_TIME = Instant.parse("2026-08-01T09:30:00Z")
        private const val ENDPOINT = "/api/v1/tasks"
        private const val FILTER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
}
