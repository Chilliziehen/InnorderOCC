package com.innorder.occ.authz

import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.MapperFeature
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.cfg.CoercionAction
import com.fasterxml.jackson.databind.cfg.CoercionInputShape
import com.fasterxml.jackson.databind.exc.MismatchedInputException
import com.fasterxml.jackson.databind.type.LogicalType
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
    private val decisionValidator: AuthorizationDecisionValidator = AuthorizationDecisionValidator(),
) : PolicyDecisionClient {
    private val mapper = objectMapper.copy().apply {
        setConfig(deserializationConfig.without(MapperFeature.ALLOW_COERCION_OF_SCALARS))
        coercionConfigFor(LogicalType.Boolean)
            .setCoercion(CoercionInputShape.String, CoercionAction.Fail)
            .setCoercion(CoercionInputShape.Integer, CoercionAction.Fail)
            .setCoercion(CoercionInputShape.Float, CoercionAction.Fail)
        coercionConfigFor(LogicalType.Integer)
            .setCoercion(CoercionInputShape.String, CoercionAction.Fail)
            .setCoercion(CoercionInputShape.Boolean, CoercionAction.Fail)
            .setCoercion(CoercionInputShape.Float, CoercionAction.Fail)
        coercionConfigFor(LogicalType.Enum)
            .setCoercion(CoercionInputShape.Integer, CoercionAction.Fail)
            .setCoercion(CoercionInputShape.Boolean, CoercionAction.Fail)
            .setCoercion(CoercionInputShape.Float, CoercionAction.Fail)
    }
        .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
        .enable(DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
        .enable(DeserializationFeature.FAIL_ON_NUMBERS_FOR_ENUMS)
        .disable(DeserializationFeature.ACCEPT_SINGLE_VALUE_AS_ARRAY)
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
                    val root = mapper.readTree(responseBody)
                    if (!root.isObject || root.fieldNames().asSequence().toSet() != setOf("result")) {
                        throw OpaClientException()
                    }
                    decisionValidator.validateRaw(root.path("result"))
                    mapper.treeToValue(root, OpaResult::class.java)
                } catch (_: MismatchedInputException) {
                    throw OpaClientException()
                } catch (_: RuntimeException) {
                    throw OpaClientException()
                }
                return wrapper.result.also(decisionValidator::validate)
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

    private data class OpaInput(val input: AuthorizationSnapshot)
    private data class OpaResult(val result: AuthorizationDecision)

    companion object {
        private const val MAX_RESPONSE_BYTES = 256 * 1024
        private const val DECISION_PATH = "/v1/data/innorder/platform/authz/decision"
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
