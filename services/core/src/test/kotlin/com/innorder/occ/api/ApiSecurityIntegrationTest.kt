package com.innorder.occ.api

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.auth.AccessSessionPrincipalValidator
import com.innorder.occ.auth.AccessTokenPrincipal
import com.innorder.occ.auth.AccessTokenService
import com.innorder.occ.auth.AccessTokenSubject
import com.innorder.occ.auth.TestJwt
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.BeforeEach
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.http.MediaType
import org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.get
import org.springframework.boot.test.mock.mockito.MockBean
import org.mockito.Mockito.`when`
import java.security.KeyPair
import java.security.interfaces.RSAPrivateKey
import java.time.Clock
import java.time.Duration
import java.util.UUID

@SpringBootTest(
    properties = [
        "spring.datasource.url=jdbc:h2:mem:occ-core-test;DB_CLOSE_DELAY=-1",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "spring.datasource.hikari.connection-init-sql=CREATE SCHEMA IF NOT EXISTS \"flowable\"",
        "spring.flyway.enabled=false",
    ],
)
@AutoConfigureMockMvc
class ApiSecurityIntegrationTest(
    @param:Autowired private val mockMvc: MockMvc,
    @param:Autowired private val objectMapper: ObjectMapper,
    @param:Autowired private val accessTokenService: AccessTokenService,
    @param:Autowired private val keyPair: KeyPair,
    @param:Autowired private val clock: Clock,
) {
    @MockBean
    private lateinit var stateValidator: AccessSessionPrincipalValidator

    @BeforeEach
    fun allowValidSession() {
        `when`(stateValidator.validate(AccessTokenPrincipal(PRINCIPAL_ID, INSTANCE_ID, SESSION_ID, 0)))
            .thenReturn(AccessTokenPrincipal(PRINCIPAL_ID, INSTANCE_ID, SESSION_ID, 0))
    }

    @Test
    fun `anonymous protected GET returns correlated authentication problem`() {
        val result = mockMvc.get("/api/v1/protected")
            .andExpect {
                status { isUnauthorized() }
                content { contentType(MediaType.APPLICATION_PROBLEM_JSON) }
                jsonPath("$.code") { value("OCC-API-AUTHENTICATION") }
            }.andReturn()

        val header = result.response.getHeader(CorrelationIdFilter.HEADER_NAME)
        assertThat(UUID.fromString(header).version()).isEqualTo(7)
        assertThat(objectMapper.readTree(result.response.contentAsString)["correlationId"].asText()).isEqualTo(header)
    }

    @Test
    fun `authenticated principal without actuator authorization returns correlated forbidden problem`() {
        val result = mockMvc.get("/actuator/health") { with(user("operator")) }
            .andExpect {
                status { isForbidden() }
                content { contentType(MediaType.APPLICATION_PROBLEM_JSON) }
                jsonPath("$.code") { value("OCC-API-FORBIDDEN") }
            }.andReturn()

        val header = result.response.getHeader(CorrelationIdFilter.HEADER_NAME)
        assertThat(objectMapper.readTree(result.response.contentAsString)["correlationId"].asText()).isEqualTo(header)
    }

    @Test
    fun `authenticated missing API resource returns request problem through MVC`() {
        mockMvc.get("/api/v1/missing") { with(user("operator")) }
            .andExpect {
                status { isNotFound() }
                content { contentType(MediaType.APPLICATION_PROBLEM_JSON) }
                jsonPath("$.code") { value("OCC-API-REQUEST") }
                jsonPath("$.title") { value("Not Found") }
            }
    }

    @Test
    fun `status and readiness remain anonymous`() {
        mockMvc.get("/api/v1/system/status").andExpect { status { isOk() } }
        mockMvc.get("/actuator/health/readiness").andExpect { status { isOk() } }
    }

    @Test
    fun `valid bearer token authenticates request`() {
        mockMvc.get("/api/v1/missing") { header("Authorization", "Bearer ${validToken()}") }
            .andExpect { status { isNotFound() } }
    }

    @Test
    fun `wrong signature issuer audience and expired bearer tokens return correlated problems`() {
        val now = clock.instant()
        val signed = validToken()
        val parts = signed.split('.')
        val badSignature = (if (parts[2].first() == 'a') "b" else "a") + parts[2].drop(1)
        val tokens = listOf(
            "${parts[0]}.${parts[1]}.$badSignature",
            TestJwt.sign(keyPair.private as RSAPrivateKey, now, mapOf("iss" to "https://wrong.test")),
            TestJwt.sign(keyPair.private as RSAPrivateKey, now, mapOf("aud" to listOf("other"))),
            TestJwt.sign(keyPair.private as RSAPrivateKey, now.minus(Duration.ofMinutes(20)), emptyMap()),
        )
        tokens.forEach { assertCorrelatedUnauthorized(it) }
    }

    @Test
    fun `stale revoked and disabled database state return correlated problems`() {
        `when`(stateValidator.validate(AccessTokenPrincipal(PRINCIPAL_ID, INSTANCE_ID, SESSION_ID, 0))).thenReturn(null)
        repeat(3) { assertCorrelatedUnauthorized(validToken()) }
    }

    private fun validToken(): String = accessTokenService.issue(AccessTokenSubject(PRINCIPAL_ID, INSTANCE_ID, SESSION_ID, 0))

    private fun assertCorrelatedUnauthorized(token: String) {
        val result = mockMvc.get("/api/v1/missing") { header("Authorization", "Bearer $token") }
            .andExpect {
                status { isUnauthorized() }
                content { contentType(MediaType.APPLICATION_PROBLEM_JSON) }
                jsonPath("$.code") { value("OCC-API-AUTHENTICATION") }
            }.andReturn()
        assertThat(objectMapper.readTree(result.response.contentAsString)["correlationId"].asText())
            .isEqualTo(result.response.getHeader(CorrelationIdFilter.HEADER_NAME))
    }

    private companion object {
        val PRINCIPAL_ID: UUID = UUID.fromString("51000000-0000-7000-8000-000000000001")
        val INSTANCE_ID: UUID = UUID.fromString("00000000-0000-7000-8000-000000000001")
        val SESSION_ID: UUID = UUID.fromString("51000000-0000-7000-8000-000000000002")
    }
}
