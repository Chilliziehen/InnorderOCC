package com.innorder.occ.auth

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatCode
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder
import org.springframework.security.crypto.password.PasswordEncoder
import java.util.Base64

class PasswordServiceTest {
    private val service = PasswordService()

    @Test
    fun `argon2id hash verifies only the correct password and does not disclose it`() {
        val password = "correct horse battery staple"

        val encoded = service.encode(password)

        assertThat(encoded).startsWith("${'$'}argon2id${'$'}")
        assertThat(encoded).doesNotContain(password)
        assertThat(service.matches(password, encoded)).isTrue()
        assertThat(service.matches("incorrect password", encoded)).isFalse()
    }

    @Test
    fun `malformed unsupported and oversized hashes fail safely`() {
        val candidates = listOf(
            "not-an-encoded-hash",
            "${'$'}argon2i${'$'}v=19${'$'}m=65536,t=3,p=1${'$'}invalid${'$'}invalid",
            "${'$'}argon2id${'$'}v=19${'$'}m=nope,t=3,p=1${'$'}invalid${'$'}invalid",
            "x".repeat(4097),
        )

        candidates.forEach { encoded ->
            assertThatCode { service.matches("correct horse battery staple", encoded) }.doesNotThrowAnyException()
            assertThat(service.matches("correct horse battery staple", encoded)).isFalse()
            assertThatCode { service.needsRehash(encoded) }.doesNotThrowAnyException()
            assertThat(service.needsRehash(encoded)).isTrue()
        }
    }

    @Test
    fun `rejected Argon2 parameters and malformed payloads never invoke password crypto`() {
        val encoder = RecordingPasswordEncoder()
        val guardedService = PasswordService(encoder)
        val salt = Base64.getEncoder().encodeToString(ByteArray(16))
        val hash = Base64.getEncoder().encodeToString(ByteArray(32))
        val rejected = listOf(
            argonHash(memory = "999999999999999999999", salt = salt, hash = hash),
            argonHash(memory = "65537", salt = salt, hash = hash),
            argonHash(iterations = "999999999999999999999", salt = salt, hash = hash),
            argonHash(iterations = "4", salt = salt, hash = hash),
            argonHash(parallelism = "999999999999999999999", salt = salt, hash = hash),
            argonHash(parallelism = "2", salt = salt, hash = hash),
            argonHash(memory = "0", salt = salt, hash = hash),
            argonHash(memory = "-1", salt = salt, hash = hash),
            argonHash(salt = "not-base64!", hash = hash),
            argonHash(salt = Base64.getEncoder().encodeToString(ByteArray(15)), hash = hash),
            argonHash(salt = salt, hash = "not-base64!"),
            argonHash(salt = salt, hash = Base64.getEncoder().encodeToString(ByteArray(31))),
            "${'$'}argon2id${'$'}v=19${'$'}m=65536,t=3,t=3,p=1${'$'}${salt}${'$'}$hash",
            "${'$'}argon2id${'$'}v=19${'$'}m=65536,t=3${'$'}${salt}${'$'}$hash",
            "${'$'}argon2i${'$'}v=19${'$'}m=65536,t=3,p=1${'$'}${salt}${'$'}$hash",
            "${'$'}argon2id${'$'}v=16${'$'}m=65536,t=3,p=1${'$'}${salt}${'$'}$hash",
        )

        rejected.forEach { encoded ->
            assertThat(guardedService.matches("correct horse battery staple", encoded)).isFalse()
            assertThat(guardedService.needsRehash(encoded)).isTrue()
        }
        assertThat(encoder.matchInvocations).isZero()
    }

    @Test
    fun `passwords outside Unicode policy never invoke password crypto`() {
        val encoder = RecordingPasswordEncoder()
        val guardedService = PasswordService(encoder)
        val salt = Base64.getEncoder().encodeToString(ByteArray(16))
        val hash = Base64.getEncoder().encodeToString(ByteArray(32))
        val encoded = argonHash(salt = salt, hash = hash)
        val rejected = listOf(
            "a".repeat(11),
            "a".repeat(129),
            "\uD83D\uDD10".repeat(129),
            "a".repeat(12) + '\uD83D',
            "a".repeat(12) + '\uDD10',
        )

        rejected.forEach { password ->
            assertThat(guardedService.matches(password, encoded)).isFalse()
        }
        assertThat(encoder.matchInvocations).isZero()
    }

    @Test
    fun `password policy counts Unicode code points from twelve through one hundred twenty eight`() {
        assertThat(service.isAllowed("a".repeat(11))).isFalse()
        assertThat(service.isAllowed("a".repeat(12))).isTrue()
        assertThat(service.isAllowed("\uD83D\uDD10".repeat(12))).isTrue()
        assertThat(service.isAllowed("\uD83D\uDD10".repeat(128))).isTrue()
        assertThat(service.isAllowed("\uD83D\uDD10".repeat(129))).isFalse()
        assertThat(service.isAllowed("a".repeat(12) + '\uD83D')).isFalse()
        assertThat(service.isAllowed("a".repeat(12) + '\uDD10')).isFalse()
    }

    @Test
    fun `weaker Argon2 parameters require rehash`() {
        val weaker = Argon2PasswordEncoder(16, 32, 1, 1 shl 14, 2)
            .encode("correct horse battery staple")
        val current = service.encode("correct horse battery staple")

        assertThat(service.matches("correct horse battery staple", weaker)).isTrue()
        assertThat(service.needsRehash(weaker)).isTrue()
        assertThat(service.needsRehash(current)).isFalse()
    }

    @Test
    fun `rehash requires every encoded parameter to match the configured target exactly`() {
        val salt = Base64.getEncoder().encodeToString(ByteArray(16))
        val hash = Base64.getEncoder().encodeToString(ByteArray(32))
        val exact = argonHash(salt = salt, hash = hash)
        val notCurrent = listOf(
            argonHash(memory = "8192", salt = salt, hash = hash),
            argonHash(iterations = "1", salt = salt, hash = hash),
            argonHash(memory = "65537", salt = salt, hash = hash),
            argonHash(iterations = "4", salt = salt, hash = hash),
            argonHash(parallelism = "2", salt = salt, hash = hash),
            argonHash(salt = Base64.getEncoder().encodeToString(ByteArray(15)), hash = hash),
            argonHash(salt = salt, hash = Base64.getEncoder().encodeToString(ByteArray(31))),
        )

        assertThat(service.needsRehash(exact)).isFalse()
        notCurrent.forEach { assertThat(service.needsRehash(it)).isTrue() }
    }

    @Test
    fun `password values are absent from objects and validation exceptions`() {
        val secret = "too-short"

        assertThat(service.toString()).doesNotContain(secret)
        assertThatThrownBy { service.encode(secret) }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageNotContaining(secret)
    }

    private fun argonHash(
        memory: String = "65536",
        iterations: String = "3",
        parallelism: String = "1",
        salt: String,
        hash: String,
    ): String = "${'$'}argon2id${'$'}v=19${'$'}m=$memory,t=$iterations,p=$parallelism${'$'}${salt}${'$'}$hash"

    private class RecordingPasswordEncoder : PasswordEncoder {
        var matchInvocations = 0

        override fun encode(rawPassword: CharSequence): String = error("not used")

        override fun matches(rawPassword: CharSequence, encodedPassword: String): Boolean {
            matchInvocations++
            return true
        }
    }
}
