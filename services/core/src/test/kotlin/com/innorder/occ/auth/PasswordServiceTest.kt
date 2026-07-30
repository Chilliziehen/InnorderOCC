package com.innorder.occ.auth

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatCode
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder

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
    fun `password policy counts Unicode code points from twelve through one hundred twenty eight`() {
        assertThat(service.isAllowed("a".repeat(11))).isFalse()
        assertThat(service.isAllowed("a".repeat(12))).isTrue()
        assertThat(service.isAllowed("\uD83D\uDD10".repeat(12))).isTrue()
        assertThat(service.isAllowed("\uD83D\uDD10".repeat(128))).isTrue()
        assertThat(service.isAllowed("\uD83D\uDD10".repeat(129))).isFalse()
    }

    @Test
    fun `weaker Argon2 parameters require rehash`() {
        val weaker = Argon2PasswordEncoder(16, 32, 1, 1 shl 14, 2)
            .encode("correct horse battery staple")
        val current = service.encode("correct horse battery staple")

        assertThat(service.needsRehash(weaker)).isTrue()
        assertThat(service.needsRehash(current)).isFalse()
    }

    @Test
    fun `password values are absent from objects and validation exceptions`() {
        val secret = "too-short"

        assertThat(service.toString()).doesNotContain(secret)
        assertThatThrownBy { service.encode(secret) }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageNotContaining(secret)
    }
}
