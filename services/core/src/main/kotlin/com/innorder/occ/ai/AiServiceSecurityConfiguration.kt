package com.innorder.occ.ai

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.core.annotation.Order
import org.springframework.core.io.Resource
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.web.SecurityFilterChain
import org.springframework.security.web.authentication.preauth.AbstractPreAuthenticatedProcessingFilter
import org.springframework.web.filter.OncePerRequestFilter
import java.security.cert.X509Certificate
import java.time.Clock
import java.time.Instant

data class ServiceCertificateFacts(
    val uriSans: Set<String>,
    val extendedKeyUsage: Set<String>,
    val serialNumber: String,
    val notBefore: Instant,
    val notAfter: Instant,
)

fun validateServiceCertificate(
    facts: ServiceCertificateFacts,
    expectedUriSan: String,
    revokedSerials: Set<String>,
    now: Instant,
    requiredExtendedKeyUsage: String = CLIENT_AUTH_EKU,
): Boolean = facts.uriSans == setOf(expectedUriSan) && requiredExtendedKeyUsage in facts.extendedKeyUsage &&
    now >= facts.notBefore && now < facts.notAfter && facts.serialNumber.uppercase() !in revokedSerials.map(String::uppercase)

private const val CLIENT_AUTH_EKU = "1.3.6.1.5.5.7.3.2"

fun serviceCertificateFacts(certificate: X509Certificate): ServiceCertificateFacts = ServiceCertificateFacts(
    uriSans = certificate.subjectAlternativeNames.orEmpty()
        .filter { it.size >= 2 && it[0] == 6 && it[1] is String }.map { it[1] as String }.toSet(),
    extendedKeyUsage = certificate.extendedKeyUsage.orEmpty().toSet(),
    serialNumber = certificate.serialNumber.toString(16).uppercase().padStart(2, '0'),
    notBefore = certificate.notBefore.toInstant(),
    notAfter = certificate.notAfter.toInstant(),
)

fun readRevokedSerials(resource: Resource?): Set<String> {
    if (resource == null) return emptySet()
    val bytes = resource.inputStream.use { it.readNBytes(64 * 1024 + 1) }
    require(bytes.size <= 64 * 1024 && bytes.none { it == 0.toByte() })
    return bytes.toString(Charsets.US_ASCII).lineSequence().map(String::trim).filter(String::isNotEmpty)
        .onEach { require(it.matches(Regex("^[A-Fa-f0-9]{1,64}${'$'}"))) }.map(String::uppercase).toSet()
}

@ConfigurationProperties("occ.ai.service-security")
data class AiServiceSecurityProperties(
    val revokedSerialsFile: Resource? = null,
    val expectedAiIdentity: String = "spiffe://innorder/ai",
)

class AiServiceIdentityFilter(
    private val properties: AiServiceSecurityProperties,
    private val clock: Clock,
) : OncePerRequestFilter() {
    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        if (request.getHeader("Authorization") != null) {
            response.status = HttpServletResponse.SC_BAD_REQUEST
            return
        }
        val certificates = request.getAttribute("jakarta.servlet.request.X509Certificate") as? Array<*>
        val leaf = certificates?.firstOrNull() as? X509Certificate
        if (leaf == null || !valid(leaf)) {
            response.status = HttpServletResponse.SC_UNAUTHORIZED
            return
        }
        val authentication = UsernamePasswordAuthenticationToken.authenticated(
            properties.expectedAiIdentity, null, listOf(SimpleGrantedAuthority("OCC_AI_SERVICE")),
        )
        SecurityContextHolder.getContext().authentication = authentication
        chain.doFilter(request, response)
    }

    private fun valid(certificate: X509Certificate): Boolean = try {
        validateServiceCertificate(
            serviceCertificateFacts(certificate),
            properties.expectedAiIdentity,
            readRevokedSerials(properties.revokedSerialsFile),
            clock.instant(),
        )
    } catch (_: Exception) { false }
}

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(AiServiceSecurityProperties::class)
class AiServiceSecurityConfiguration {
    @Bean
    @Order(1)
    fun aiInternalSecurityFilterChain(
        http: HttpSecurity,
        properties: AiServiceSecurityProperties,
        clock: Clock,
    ): SecurityFilterChain = http.securityMatcher("/internal/v1/ai/**")
        .csrf { it.disable() }.requestCache { it.disable() }
        .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
        .addFilterBefore(AiServiceIdentityFilter(properties, clock), AbstractPreAuthenticatedProcessingFilter::class.java)
        .authorizeHttpRequests { it.anyRequest().hasAuthority("OCC_AI_SERVICE") }
        .build()
}

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "occ.ai.grant", name = ["enabled"], havingValue = "true")
@EnableConfigurationProperties(AiGrantTokenProperties::class)
class AiGrantConfiguration

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "occ.ai.client", name = ["enabled"], havingValue = "true")
@EnableConfigurationProperties(AiServiceClientProperties::class)
class AiServiceClientConfiguration
