package com.innorder.occ.authz

import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.exc.MismatchedInputException
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.io.InputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

@ConfigurationProperties("occ.opa", ignoreUnknownFields = false)
data class OpaProperties(
    var baseUrl: String = "http://localhost:8181",
    var connectTimeout: Duration = Duration.ofMillis(500),
    var requestTimeout: Duration = Duration.ofSeconds(1),
)

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(OpaProperties::class)
class AuthorizationClientConfiguration {
    @Bean
    fun policyDecisionClient(mapper: ObjectMapper, properties: OpaProperties): PolicyDecisionClient =
        OpaClient(mapper, properties)
}

class OpaClient(
    objectMapper: ObjectMapper,
    properties: OpaProperties,
    private val client: HttpClient = buildClient(properties),
) : PolicyDecisionClient {
    private val mapper = objectMapper.copy()
        .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
        .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
    private val requestTimeout = properties.requestTimeout
    private val endpoint = endpoint(properties.baseUrl)

    init {
        require(!properties.connectTimeout.isNegative && !properties.connectTimeout.isZero)
        require(properties.connectTimeout <= Duration.ofMillis(500))
        require(!properties.requestTimeout.isNegative && !properties.requestTimeout.isZero)
        require(properties.requestTimeout <= Duration.ofSeconds(1))
    }

    override fun decide(snapshot: AuthorizationSnapshot): AuthorizationDecision {
        val body = try {
            mapper.writeValueAsBytes(OpaInput(snapshot))
        } catch (_: RuntimeException) {
            throw OpaClientException()
        }
        val request = HttpRequest.newBuilder(endpoint)
            .timeout(requestTimeout)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .POST(HttpRequest.BodyPublishers.ofByteArray(body))
            .build()
        try {
            val response = client.send(request, HttpResponse.BodyHandlers.ofInputStream())
            response.body().use { stream ->
                val responseBody = readBounded(stream)
                if (response.statusCode() != 200) throw OpaClientException()
                val wrapper = try {
                    mapper.readValue(responseBody, OpaResult::class.java)
                } catch (_: MismatchedInputException) {
                    throw OpaClientException()
                } catch (_: RuntimeException) {
                    throw OpaClientException()
                }
                return wrapper.result.also(::validateDecision)
            }
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            throw OpaClientException()
        } catch (_: OpaClientException) {
            throw OpaClientException()
        } catch (_: Exception) {
            throw OpaClientException()
        }
    }

    private fun readBounded(stream: InputStream): ByteArray {
        val bytes = stream.readNBytes(MAX_RESPONSE_BYTES + 1)
        if (bytes.size > MAX_RESPONSE_BYTES) throw OpaClientException()
        return bytes
    }

    private fun validateDecision(decision: AuthorizationDecision) {
        if (decision.contractVersion != 1 || !validUuid(decision.requestId) || decision.authorizationRevision < 0 ||
            decision.releases.keys !in setOf(
                setOf(PolicyLayer.PLATFORM),
                setOf(PolicyLayer.PLATFORM, PolicyLayer.DOMAIN),
                setOf(PolicyLayer.PLATFORM, PolicyLayer.CUSTOMER),
                setOf(PolicyLayer.PLATFORM, PolicyLayer.DOMAIN, PolicyLayer.CUSTOMER),
            ) || decision.releases.values.any { !validUuid(it) } ||
            decision.releases.values.toSet().size != decision.releases.size ||
            decision.decision == AuthorizationDecisionValue.ERROR ||
            decision.allow != (decision.decision == AuthorizationDecisionValue.ALLOW) ||
            decision.reasonCodes.size > 128 || decision.reasonIds.size > 256 || decision.matchedPolicyIds.size > 256 ||
            decision.reasonCodes.isEmpty() || decision.reasonCodes.any { !REASON_CODE.matches(it) } ||
            decision.reasonIds.any { !OPAQUE_REFERENCE.matches(it) } ||
            decision.matchedPolicyIds.any { !OPAQUE_REFERENCE.matches(it) } ||
            !decision.reasonIds.containsAll(decision.matchedPolicyIds) ||
            decision.reasonCodes != decision.reasonCodes.distinct().sorted() ||
            decision.reasonIds != decision.reasonIds.distinct().sorted() ||
            decision.matchedPolicyIds != decision.matchedPolicyIds.distinct().sorted()
        ) throw OpaClientException()
    }

    private fun validUuid(value: java.util.UUID): Boolean = value.version() in 1..8 && value.variant() == 2

    private data class OpaInput(val input: AuthorizationSnapshot)
    private data class OpaResult(val result: AuthorizationDecision)

    companion object {
        private const val MAX_RESPONSE_BYTES = 256 * 1024
        private const val DECISION_PATH = "/v1/data/innorder/platform/authz/decision"
        private val REASON_CODE = Regex("^[A-Z][A-Z0-9_]{0,127}${'$'}")
        private val OPAQUE_REFERENCE = Regex("^(grant|policy):[0-9a-f]{64}${'$'}")

        private fun buildClient(properties: OpaProperties): HttpClient {
            require(!properties.connectTimeout.isNegative && !properties.connectTimeout.isZero)
            require(properties.connectTimeout <= Duration.ofMillis(500))
            require(!properties.requestTimeout.isNegative && !properties.requestTimeout.isZero)
            require(properties.requestTimeout <= Duration.ofSeconds(1))
            return HttpClient.newBuilder()
                .connectTimeout(properties.connectTimeout)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build()
        }

        private fun endpoint(raw: String): URI {
            val base = try { URI(raw) } catch (_: Exception) { throw IllegalArgumentException("Invalid OPA base URI") }
            require(base.scheme?.lowercase() in setOf("http", "https")) { "Invalid OPA base URI" }
            require(base.isAbsolute && base.host != null && base.userInfo == null && base.query == null && base.fragment == null)
            require(base.path.isNullOrEmpty() || base.path == "/") { "Invalid OPA base URI" }
            return URI(base.scheme, null, base.host, base.port, DECISION_PATH, null, null)
        }
    }
}
