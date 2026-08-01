package com.innorder.occ.ai

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.time.Instant
import java.net.URI
import java.time.Duration

class AiServiceTlsTest {
    private val now = Instant.parse("2026-08-02T12:00:00Z")

    @Test
    fun `accepts only current AI URI SAN client EKU and non-revoked serial`() {
        val valid = ServiceCertificateFacts(
            uriSans = setOf("spiffe://innorder/ai"),
            extendedKeyUsage = setOf("1.3.6.1.5.5.7.3.2"),
            serialNumber = "01AB",
            notBefore = now.minusSeconds(60),
            notAfter = now.plusSeconds(60),
        )

        assertThat(validateServiceCertificate(valid, "spiffe://innorder/ai", emptySet(), now)).isTrue()
        assertThat(validateServiceCertificate(
            valid.copy(extendedKeyUsage = setOf("1.3.6.1.5.5.7.3.1")),
            "spiffe://innorder/ai", emptySet(), now, "1.3.6.1.5.5.7.3.1",
        )).isTrue()
        assertThat(validateServiceCertificate(valid.copy(uriSans = setOf("spiffe://innorder/core")), "spiffe://innorder/ai", emptySet(), now)).isFalse()
        assertThat(validateServiceCertificate(valid.copy(uriSans = emptySet()), "spiffe://innorder/ai", emptySet(), now)).isFalse()
        assertThat(validateServiceCertificate(valid.copy(extendedKeyUsage = setOf("1.3.6.1.5.5.7.3.1")), "spiffe://innorder/ai", emptySet(), now)).isFalse()
        assertThat(validateServiceCertificate(valid.copy(notAfter = now), "spiffe://innorder/ai", emptySet(), now)).isFalse()
        assertThat(validateServiceCertificate(valid, "spiffe://innorder/ai", setOf("01AB"), now)).isFalse()
    }

    @Test
    fun `rejects extra URI identities and never falls back to common name`() {
        val facts = ServiceCertificateFacts(
            uriSans = setOf("spiffe://innorder/ai", "spiffe://innorder/admin"),
            extendedKeyUsage = setOf("1.3.6.1.5.5.7.3.2"),
            serialNumber = "02",
            notBefore = now.minusSeconds(1),
            notAfter = now.plusSeconds(1),
        )

        assertThat(validateServiceCertificate(facts, "spiffe://innorder/ai", emptySet(), now)).isFalse()
    }

    @Test
    fun `outbound client accepts only exact HTTPS origins and bounded timeouts`() {
        val valid = AiServiceClientProperties(
            origin = URI("https://occ-ai.internal:3100"),
            keyFile = org.springframework.core.io.ByteArrayResource(byteArrayOf(1)),
            certificateFiles = listOf(org.springframework.core.io.ByteArrayResource(byteArrayOf(1))),
            trustFiles = listOf(org.springframework.core.io.ByteArrayResource(byteArrayOf(1))),
            connectTimeout = Duration.ofMillis(500),
            requestTimeout = Duration.ofSeconds(2),
        )

        assertThat(valid.validate()).isSameAs(valid)
        assertThat(runCatching { valid.copy(origin = URI("http://occ-ai.internal")).validate() }.isFailure).isTrue()
        assertThat(runCatching { valid.copy(origin = URI("https://occ-ai.internal/path")).validate() }.isFailure).isTrue()
        assertThat(runCatching { valid.copy(requestTimeout = Duration.ofSeconds(31)).validate() }.isFailure).isTrue()
    }
}
