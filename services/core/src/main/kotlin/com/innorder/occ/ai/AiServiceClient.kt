package com.innorder.occ.ai

import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.core.io.Resource
import org.springframework.stereotype.Component
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import java.net.URI
import java.net.Socket
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.KeyFactory
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.time.Duration
import java.time.Clock
import java.util.Base64
import java.util.Date
import java.util.UUID
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLParameters
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedTrustManager

@ConfigurationProperties("occ.ai.client")
data class AiServiceClientProperties(
    val origin: URI,
    val keyFile: Resource,
    val certificateFiles: List<Resource>,
    val trustFiles: List<Resource>,
    val connectTimeout: Duration = Duration.ofMillis(500),
    val requestTimeout: Duration = Duration.ofSeconds(2),
    val revokedSerialsFile: Resource? = null,
) {
    fun validate(): AiServiceClientProperties {
        require(origin.scheme == "https" && origin.host != null && origin.userInfo == null && origin.path.isNullOrEmpty() &&
            origin.query == null && origin.fragment == null) { "AI service origin must be an exact HTTPS origin" }
        require(certificateFiles.size in 1..2 && trustFiles.size in 1..2)
        require(connectTimeout > Duration.ZERO && connectTimeout <= Duration.ofSeconds(2))
        require(requestTimeout >= connectTimeout && requestTimeout <= Duration.ofSeconds(30))
        return this
    }
}

@Component
@ConditionalOnProperty(prefix = "occ.ai.client", name = ["enabled"], havingValue = "true")
class AiServiceClient(private val properties: AiServiceClientProperties, private val clock: Clock) {
    private val mapper = ObjectMapper().enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
    private val client = HttpClient.newBuilder().connectTimeout(properties.validate().connectTimeout)
        .followRedirects(HttpClient.Redirect.NEVER).sslContext(sslContext(properties))
        .sslParameters(SSLParameters().apply {
            protocols = arrayOf("TLSv1.3")
            endpointIdentificationAlgorithm = "HTTPS"
        })
        .build()

    fun status(operationId: UUID): JsonNode = exchange("GET", "/internal/v1/ai/operations/$operationId/status", null)
    fun cancel(operationId: UUID): JsonNode = exchange("POST", "/internal/v1/ai/operations/$operationId/cancel", ByteArray(0))

    private fun exchange(method: String, path: String, body: ByteArray?): JsonNode {
        val builder = HttpRequest.newBuilder(properties.origin.resolve(path)).timeout(properties.requestTimeout)
            .header("Accept", "application/json")
        if (body == null) builder.GET() else builder.header("Content-Type", "application/json")
            .method(method, HttpRequest.BodyPublishers.ofByteArray(body))
        try {
            val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream())
            response.body().use { stream ->
                val bytes = stream.readNBytes(MAX_RESPONSE_BYTES + 1)
                if (bytes.size > MAX_RESPONSE_BYTES || response.statusCode() !in 200..299) throw AiServiceClientException()
                return mapper.readTree(bytes) ?: throw AiServiceClientException()
            }
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            throw AiServiceClientException()
        } catch (_: AiServiceClientException) {
            throw AiServiceClientException()
        } catch (_: Exception) {
            throw AiServiceClientException()
        }
    }

    private fun sslContext(config: AiServiceClientProperties): SSLContext = try {
        val keyBytes = readPem(config.keyFile, "PRIVATE KEY")
        val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(keyBytes))
        val factory = CertificateFactory.getInstance("X.509")
        val chain = config.certificateFiles.map { resource -> resource.inputStream.use { factory.generateCertificate(it) as X509Certificate } }
        val keyStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setKeyEntry("client", key, CharArray(0), chain.toTypedArray()) }
        val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(keyStore, CharArray(0)) }
        val trustStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null)
            config.trustFiles.forEachIndexed { index, resource ->
                resource.inputStream.use { setCertificateEntry("ca-$index", factory.generateCertificate(it)) }
            }
        }
        val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(trustStore) }
        val delegate = trust.trustManagers.filterIsInstance<X509ExtendedTrustManager>().single()
        val identityTrust = AiServiceServerTrustManager(
            delegate, readRevokedSerials(config.revokedSerialsFile), clock,
        )
        SSLContext.getInstance("TLSv1.3").apply { init(keys.keyManagers, arrayOf(identityTrust), null) }
    } catch (_: Exception) { throw IllegalArgumentException("AI service TLS material is unavailable or invalid") }

    private fun readPem(resource: Resource, type: String): ByteArray {
        val bytes = resource.inputStream.use { it.readNBytes(MAX_TLS_FILE_BYTES + 1) }
        require(bytes.size <= MAX_TLS_FILE_BYTES && bytes.none { it == 0.toByte() })
        val text = bytes.toString(Charsets.US_ASCII)
        return Base64.getDecoder().decode(text.substringAfter("-----BEGIN $type-----").substringBefore("-----END $type-----")
            .replace(Regex("\\s"), ""))
    }

    private companion object {
        const val MAX_TLS_FILE_BYTES = 64 * 1024
        const val MAX_RESPONSE_BYTES = 256 * 1024
    }
}

private class AiServiceServerTrustManager(
    private val delegate: X509ExtendedTrustManager,
    private val revokedSerials: Set<String>,
    private val clock: Clock,
) : X509ExtendedTrustManager() {
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String, socket: Socket) {
        delegate.checkServerTrusted(chain, authType, socket)
        checkIdentity(chain)
    }

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String, engine: SSLEngine) {
        delegate.checkServerTrusted(chain, authType, engine)
        checkIdentity(chain)
    }

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        delegate.checkServerTrusted(chain, authType)
        checkIdentity(chain)
    }

    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String, socket: Socket) =
        delegate.checkClientTrusted(chain, authType, socket)

    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String, engine: SSLEngine) =
        delegate.checkClientTrusted(chain, authType, engine)

    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
        delegate.checkClientTrusted(chain, authType)

    override fun getAcceptedIssuers(): Array<X509Certificate> = delegate.acceptedIssuers

    private fun checkIdentity(chain: Array<X509Certificate>) {
        val leaf = chain.firstOrNull() ?: throw CertificateException("AI service certificate is unavailable")
        try {
            leaf.checkValidity(Date.from(clock.instant()))
            if (!validateServiceCertificate(
                    serviceCertificateFacts(leaf), EXPECTED_AI_IDENTITY, revokedSerials, clock.instant(), SERVER_AUTH_EKU,
                )) throw CertificateException("AI service certificate identity is invalid")
        } catch (exception: CertificateException) {
            throw exception
        } catch (exception: Exception) {
            throw CertificateException("AI service certificate identity is invalid", exception)
        }
    }

    private companion object {
        const val EXPECTED_AI_IDENTITY = "spiffe://innorder/ai"
        const val SERVER_AUTH_EKU = "1.3.6.1.5.5.7.3.1"
    }
}

class AiServiceClientException : RuntimeException("OCC-AI-SERVICE-UNAVAILABLE")
