package com.innorder.occ.ai

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.test.system.CapturedOutput
import org.springframework.boot.test.system.OutputCaptureExtension
import org.junit.jupiter.api.extension.ExtendWith
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.KeyFactory
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory

@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "spring.datasource.url=jdbc:h2:mem:core-service-tls;DB_CLOSE_DELAY=-1",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.hikari.connection-init-sql=CREATE SCHEMA IF NOT EXISTS \"flowable\"",
        "spring.flyway.enabled=false",
        "flowable.database-schema-update=true",
        "occ.status-probes.external-enabled=false",
        "occ.outbox.enabled=false",
        "server.ssl.enabled=true",
        "server.ssl.certificate=file:../../test-fixtures/service-tls/core-server.cert.pem",
        "server.ssl.certificate-private-key=file:../../test-fixtures/service-tls/core-server.key.pem",
        "server.ssl.trust-certificate=file:../../test-fixtures/service-tls/trust-bundle.cert.pem",
        "server.ssl.client-auth=want",
        "server.ssl.enabled-protocols=TLSv1.3",
        "occ.ai.service-security.revoked-serials-file=file:../../test-fixtures/service-tls/ai-revoked-serials.txt",
    ],
)
@ExtendWith(OutputCaptureExtension::class)
class CoreServiceTlsIntegrationTest(@param:LocalServerPort private val port: Int) {
    @Test
    fun `embedded HTTPS listener requires exact verified AI SPIFFE identity`(output: CapturedOutput) {
        assertThat(send("ai-client")).isEqualTo(404)
        assertThat(send("ai-client-next")).isEqualTo(404)
        assertThat(send(null)).isEqualTo(401)
        assertThat(send("ai-client-wrong-san")).isEqualTo(401)
        assertThat(send("ai-client-revoked")).isEqualTo(401)
        assertRejected("ai-client-wrong-eku")
        assertRejected("ai-client-wrong-issuer")
        assertRejected("ai-client-expired")
        assertThat(send("ai-client", "Bearer end-user-secret")).isEqualTo(400)
        assertThat(output.all).doesNotContain("end-user-secret", "BEGIN PRIVATE KEY", "core-server.key.pem")
    }

    private fun assertRejected(name: String) {
        val result = runCatching { send(name) }
        assertThat(result.isFailure || result.getOrNull() == 401).isTrue()
        assertThat(result.exceptionOrNull()?.message.orEmpty()).doesNotContain("PRIVATE KEY", "service-tls", "end-user-secret")
    }

    private fun send(identity: String?, authorization: String? = null): Int {
        val request = HttpRequest.newBuilder(URI("https://localhost:$port/internal/v1/ai/tls-probe"))
            .apply { if (authorization != null) header("Authorization", authorization) }.GET().build()
        return HttpClient.newBuilder().sslContext(sslContext(identity)).build()
            .send(request, HttpResponse.BodyHandlers.discarding()).statusCode()
    }

    private fun sslContext(identity: String?): SSLContext {
        val certificates = CertificateFactory.getInstance("X.509")
        val trustStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null)
            fixture("current-ca.cert.pem").inputStream().use {
                setCertificateEntry("server-ca", certificates.generateCertificate(it))
            }
        }
        val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(trustStore) }
        val keys = identity?.let { name ->
            val privateKey = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(readPrivateKey(fixture("$name.key.pem"))))
            val certificate = fixture("$name.cert.pem").inputStream().use { certificates.generateCertificate(it) as X509Certificate }
            val keyStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
                load(null)
                setKeyEntry("client", privateKey, CharArray(0), arrayOf(certificate))
            }
            KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(keyStore, CharArray(0)) }.keyManagers
        }
        return SSLContext.getInstance("TLSv1.3").apply { init(keys, trust.trustManagers, null) }
    }

    private fun readPrivateKey(file: File): ByteArray {
        val text = file.readText(Charsets.US_ASCII)
        return Base64.getDecoder().decode(text.substringAfter("-----BEGIN PRIVATE KEY-----")
            .substringBefore("-----END PRIVATE KEY-----").replace(Regex("\\s"), ""))
    }

    private fun fixture(name: String): File = File("../../test-fixtures/service-tls", name).absoluteFile
}
