package com.innorder.occ.cohort

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.api.CorrelationIdFilter
import com.innorder.occ.auth.AccessTokenPrincipal
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.Mockito.`when`
import org.springframework.http.MediaType
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.test.web.servlet.post
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

class CohortControllerTest {
    private val commands = mock(CohortCommandService::class.java)
    private val queries = mock(CohortQueryService::class.java)
    private val controller = CohortController(commands, queries)
    private val mapper = ObjectMapper().findAndRegisterModules()
    private val principal = AccessTokenPrincipal(PRINCIPAL_ID, CUSTOMER_ID, UUID.randomUUID(), 1)
    private val authentication = UsernamePasswordAuthenticationToken(principal, null)
    private val detail = CohortDetail(
        COHORT_ID, "alpha", "Alpha", PACKAGE_ID, PRINCIPAL_ID,
        LocalDate.parse("2026-08-02"), null, CohortStatus.DRAFT, 1,
        Instant.parse("2026-08-02T12:00:00Z"), Instant.parse("2026-08-02T12:00:00Z"), emptyList(),
    )

    @Test
    fun `POST create extracts principal and headers and exposes replay response header`() {
        val expected = CreateCohortRequest(
            "alpha", "Alpha", PACKAGE_ID, PRINCIPAL_ID, LocalDate.parse("2026-08-02"), null,
        )
        `when`(commands.create(PRINCIPAL_ID, "create-key", CORRELATION_ID, expected))
            .thenReturn(CohortCommandResult(detail, true, 201))

        mvc().post("/api/v1/cohorts") {
            principal = authentication
            header("Idempotency-Key", "create-key")
            requestAttr(CorrelationIdFilter.REQUEST_ATTRIBUTE, CORRELATION_ID.toString())
            contentType = MediaType.APPLICATION_JSON
            content = """{"code":"alpha","name":"Alpha","packageVersionId":"$PACKAGE_ID","ownerPrincipalId":"$PRINCIPAL_ID","startDate":"2026-08-02"}"""
        }.andExpect {
            status { isCreated() }
            header { string("X-Idempotent-Replay", "true") }
            jsonPath("$.id") { value(COHORT_ID.toString()) }
            jsonPath("$.version") { value(1) }
        }

        verify(commands).create(PRINCIPAL_ID, "create-key", CORRELATION_ID, expected)
    }

    @Test
    fun `POST create rejects unknown JSON fields before command execution`() {
        mvc().post("/api/v1/cohorts") {
            principal = authentication
            header("Idempotency-Key", "unknown-key")
            requestAttr(CorrelationIdFilter.REQUEST_ATTRIBUTE, CORRELATION_ID.toString())
            contentType = MediaType.APPLICATION_JSON
            content = """{"code":"alpha","name":"Alpha","packageVersionId":"$PACKAGE_ID","ownerPrincipalId":"$PRINCIPAL_ID","startDate":"2026-08-02","packageId":"$PACKAGE_ID"}"""
        }.andExpect { status { isBadRequest() } }

        verifyNoInteractions(commands)
    }

    private fun mvc() = MockMvcBuilders.standaloneSetup(controller)
        .setMessageConverters(MappingJackson2HttpMessageConverter(mapper))
        .build()

    private companion object {
        val PRINCIPAL_ID: UUID = UUID.fromString("62000000-0000-7000-8000-000000000001")
        val CUSTOMER_ID: UUID = UUID.fromString("00000000-0000-7000-8000-000000000001")
        val COHORT_ID: UUID = UUID.fromString("62000000-0000-7000-8000-000000000002")
        val PACKAGE_ID: UUID = UUID.fromString("62000000-0000-7000-8000-000000000003")
        val CORRELATION_ID: UUID = UUID.fromString("62000000-0000-4000-8000-000000000004")
    }
}
