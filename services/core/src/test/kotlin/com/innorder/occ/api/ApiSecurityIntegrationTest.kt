package com.innorder.occ.api

import com.fasterxml.jackson.databind.ObjectMapper
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.http.MediaType
import org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.get
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
) {
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
}
