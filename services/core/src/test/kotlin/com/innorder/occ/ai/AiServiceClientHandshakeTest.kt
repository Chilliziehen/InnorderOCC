package com.innorder.occ.ai

import com.sun.net.httpserver.HttpsConfigurator
import com.sun.net.httpserver.HttpsServer
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.core.io.FileSystemResource
import java.io.File
import java.net.InetSocketAddress
import java.net.URI
import java.security.KeyFactory
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.time.Clock
import java.time.Duration
import java.util.Base64
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext

class AiServiceClientHandshakeTest {
    private val operationId = UUID.fromString("11000000-0000-7000-8000-000000000003")

    @Test
    fun `wrong service identity fails the TLS handshake before HTTP is sent`() {
        val requests = AtomicInteger()
        withServer("core-server", requests) { port ->
            val client = client(port, listOf("current-ca.cert.pem"))

            assertThatThrownBy { client.status(operationId) }.isInstanceOf(AiServiceClientException::class.java)
            assertThat(requests).hasValue(0)
        }
    }

    @Test
    fun `accepts exact AI identity from current CA while overlap trust is configured`() =
        assertAccepted("ai-server")

    @Test
    fun `accepts exact AI identity from next CA while overlap trust is configured`() =
        assertAccepted("ai-server-next")

    private fun assertAccepted(server: String) {
        val requests = AtomicInteger()
        withServer(server, requests) { port ->
            val status = client(port, listOf("current-ca.cert.pem", "next-server-ca.cert.pem")).status(operationId)

            assertThat(status.path("status").asText()).isEqualTo("RUNNING")
            assertThat(requests).hasValue(1)
        }
    }

    private fun client(port: Int, trustFiles: List<String>) = AiServiceClient(
        AiServiceClientProperties(
            origin = URI("https://localhost:$port"),
            keyFile = fixtureResource("core-client.key.pem"),
            certificateFiles = listOf(fixtureResource("core-client.cert.pem")),
            trustFiles = trustFiles.map(::fixtureResource),
            connectTimeout = Duration.ofSeconds(2),
            requestTimeout = Duration.ofSeconds(5),
        ),
        Clock.systemUTC(),
    )

    private fun withServer(identity: String, requests: AtomicInteger, action: (Int) -> Unit) {
        val server = HttpsServer.create(InetSocketAddress("localhost", 0), 0).apply {
            httpsConfigurator = HttpsConfigurator(serverContext(identity))
            createContext("/") { exchange ->
                requests.incrementAndGet()
                val body = """{"operationId":"$operationId","status":"RUNNING"}""".toByteArray()
                exchange.responseHeaders.set("Content-Type", "application/json")
                exchange.sendResponseHeaders(200, body.size.toLong())
                exchange.responseBody.use { it.write(body) }
            }
            start()
        }
        try {
            action(server.address.port)
        } finally {
            server.stop(0)
        }
    }

    private fun serverContext(identity: String): SSLContext {
        val certificates = CertificateFactory.getInstance("X.509")
        val certificate = fixture("$identity.cert.pem").inputStream().use {
            certificates.generateCertificate(it) as X509Certificate
        }
        val privateKey = KeyFactory.getInstance("RSA").generatePrivate(
            PKCS8EncodedKeySpec(readPrivateKey(fixture("$identity.key.pem"))),
        )
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null)
            setKeyEntry("server", privateKey, CharArray(0), arrayOf(certificate))
        }
        val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
            init(store, CharArray(0))
        }
        return SSLContext.getInstance("TLSv1.3").apply { init(keys.keyManagers, null, null) }
    }

    private fun readPrivateKey(file: File): ByteArray = Base64.getDecoder().decode(
        file.readText(Charsets.US_ASCII).substringAfter("-----BEGIN PRIVATE KEY-----")
            .substringBefore("-----END PRIVATE KEY-----").replace(Regex("\\s"), ""),
    )

    private fun fixtureResource(name: String) = FileSystemResource(fixture(name))
    private fun fixture(name: String) = File("../../test-fixtures/service-tls", name).absoluteFile
}
