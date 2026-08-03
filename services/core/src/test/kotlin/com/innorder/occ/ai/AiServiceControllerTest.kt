package com.innorder.occ.ai

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.api.ApiExceptionHandler
import com.innorder.occ.api.ApiFailureReporter
import com.innorder.occ.api.CorrelationIdFilter
import com.innorder.occ.api.OccProblemResponses
import com.innorder.occ.command.IdempotencyConflictException
import com.innorder.occ.command.InvalidIdempotencyKeyException
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.`when`
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.post
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.test.web.servlet.setup.StandaloneMockMvcBuilder
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID

class AiServiceControllerTest {
    private val operationId = UUID.fromString("11000000-0000-7000-8000-000000000003")
    private val grants = mock(AiGrantService::class.java)
    private val mapper = ObjectMapper().findAndRegisterModules()
    private val responses = OccProblemResponses(mapper)
    private val mvc = MockMvcBuilders.standaloneSetup(AiServiceController(grants))
        .setControllerAdvice(ApiExceptionHandler(responses, ApiFailureReporter { _, _ -> }))
        .addFilters<StandaloneMockMvcBuilder>(
            CorrelationIdFilter(Clock.fixed(Instant.parse("2026-08-02T12:00:00Z"), ZoneOffset.UTC)),
        )
        .build()

    @Test
    fun `claim requires one valid idempotency key and rejects unknown body fields`() {
        `when`(grants.claim(operationId, "bad key")).thenThrow(InvalidIdempotencyKeyException())

        mvc.post("/internal/v1/ai/grants/claim") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"operationId":"$operationId"}"""
        }.andExpect {
            status { isBadRequest() }
            content { contentType(MediaType.APPLICATION_PROBLEM_JSON) }
            jsonPath("$.code") { value("OCC-COMMAND-IDEMPOTENCY-KEY") }
        }
        mvc.post("/internal/v1/ai/grants/claim") {
            header("Idempotency-Key", "bad key")
            contentType = MediaType.APPLICATION_JSON
            content = """{"operationId":"$operationId"}"""
        }.andExpect {
            status { isBadRequest() }
            jsonPath("$.code") { value("OCC-COMMAND-IDEMPOTENCY-KEY") }
        }
        mvc.post("/internal/v1/ai/grants/claim") {
            header("Idempotency-Key", "valid-key")
            contentType = MediaType.APPLICATION_JSON
            content = """{"operationId":"$operationId","extra":true}"""
        }.andExpect {
            status { isBadRequest() }
            content { contentType(MediaType.APPLICATION_PROBLEM_JSON) }
        }
    }

    @Test
    fun `different claim key returns stable idempotency conflict problem`() {
        `when`(grants.claim(operationId, "different-key")).thenThrow(IdempotencyConflictException())

        mvc.post("/internal/v1/ai/grants/claim") {
            header("Idempotency-Key", "different-key")
            contentType = MediaType.APPLICATION_JSON
            content = """{"operationId":"$operationId"}"""
        }.andExpect {
            status { isConflict() }
            content { contentType(MediaType.APPLICATION_PROBLEM_JSON) }
            jsonPath("$.code") { value("OCC-COMMAND-IDEMPOTENCY-CONFLICT") }
        }
    }
}
