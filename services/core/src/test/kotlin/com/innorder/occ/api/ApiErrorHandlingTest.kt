package com.innorder.occ.api

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.ConstraintViolationException
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.MethodSource
import org.slf4j.MDC
import org.springframework.http.MediaType
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.security.access.AccessDeniedException
import org.springframework.security.authentication.BadCredentialsException
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.post
import org.springframework.test.web.servlet.setup.StandaloneMockMvcBuilder
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.validation.BindException
import org.springframework.validation.MapBindingResult
import org.springframework.validation.beanvalidation.LocalValidatorFactoryBean
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.servlet.resource.NoResourceFoundException
import org.springframework.http.HttpMethod
import java.net.URI
import java.security.SecureRandom
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID
import java.util.stream.Stream

class ApiErrorHandlingTest {
    private val objectMapper = ObjectMapper().registerKotlinModule().findAndRegisterModules()
    private val clock = Clock.fixed(Instant.parse("2026-07-30T12:34:56.789Z"), ZoneOffset.UTC)
    private val filter = CorrelationIdFilter(clock, SequenceSecureRandom())
    private val responses = OccProblemResponses(objectMapper)
    private val failureReporter = Slf4jApiFailureReporter()
    private val controller = TestController()
    private val mockMvc: MockMvc = MockMvcBuilders.standaloneSetup(controller)
        .setControllerAdvice(ApiExceptionHandler(responses, failureReporter))
        .setValidator(LocalValidatorFactoryBean().also { it.afterPropertiesSet() })
        .addFilters<StandaloneMockMvcBuilder>(filter)
        .build()

    @AfterEach
    fun clearMdc() {
        MDC.clear()
    }

    @Test
    fun `valid canonical correlation ID is echoed in error header and body`() {
        val correlationId = "018f30c0-7a86-7f8b-a6e0-3c5477bb7e1a"

        mockMvc.get("/test/conflict") { header(CorrelationIdFilter.HEADER_NAME, correlationId) }
            .andExpect {
                status { isConflict() }
                header { string(CorrelationIdFilter.HEADER_NAME, correlationId) }
                content { contentType(MediaType.APPLICATION_PROBLEM_JSON) }
                jsonPath("$.correlationId") { value(correlationId) }
                jsonPath("$.code") { value("OCC-API-CONFLICT") }
            }
    }

    @Test
    fun `uppercase canonical correlation ID is accepted and echoed exactly`() {
        val correlationId = "018F30C0-7A86-7F8B-A6E0-3C5477BB7E1A"

        mockMvc.get("/test/conflict") { header(CorrelationIdFilter.HEADER_NAME, correlationId) }
            .andExpect {
                status { isConflict() }
                header { string(CorrelationIdFilter.HEADER_NAME, correlationId) }
                jsonPath("$.correlationId") { value(correlationId) }
            }
    }

    @ParameterizedTest(name = "accepts UUID version {0}")
    @MethodSource("standardUuidVersions")
    fun `canonical RFC UUID versions one through eight are accepted`(version: Int, correlationId: String) {
        val request = MockHttpServletRequest().also { it.addHeader(CorrelationIdFilter.HEADER_NAME, correlationId) }
        val response = MockHttpServletResponse()

        filter.doFilter(request, response, FilterChain { _, _ -> })

        assertThat(UUID.fromString(correlationId).version()).isEqualTo(version)
        assertThat(response.getHeader(CorrelationIdFilter.HEADER_NAME)).isEqualTo(correlationId)
    }

    @ParameterizedTest(name = "replaces invalid header case {0}")
    @MethodSource("invalidHeaders")
    fun `invalid correlation headers are replaced by one generated UUIDv7`(description: String, values: List<String>) {
        val request = MockHttpServletRequest()
        values.forEach { request.addHeader(CorrelationIdFilter.HEADER_NAME, it) }
        val response = MockHttpServletResponse()

        filter.doFilter(request, response, FilterChain { _, _ -> })

        val generated = UUID.fromString(response.getHeader(CorrelationIdFilter.HEADER_NAME))
        assertThat(generated.version()).isEqualTo(7)
        assertThat(generated.variant()).isEqualTo(2)
        assertThat(request.getAttribute(CorrelationIdFilter.REQUEST_ATTRIBUTE)).isEqualTo(generated.toString())
    }

    @Test
    fun `generated UUIDv7 IDs use clock timestamp and are unique with deterministic random source`() {
        val ids = (1..2).map {
            val request = MockHttpServletRequest()
            val response = MockHttpServletResponse()
            filter.doFilter(request, response, FilterChain { _, _ -> })
            UUID.fromString(response.getHeader(CorrelationIdFilter.HEADER_NAME))
        }

        assertThat(ids).doesNotHaveDuplicates()
        ids.forEach { id ->
            assertThat(id.version()).isEqualTo(7)
            assertThat(id.variant()).isEqualTo(2)
            assertThat(id.mostSignificantBits ushr 16).isEqualTo(clock.millis())
        }
    }

    @Test
    fun `correlation ID is available in request and MDC while preserving prior MDC afterward`() {
        val request = MockHttpServletRequest()
        val response = MockHttpServletResponse()
        MDC.put(CorrelationIdFilter.MDC_KEY, "prior")
        var observedAttribute: Any? = null
        var observedMdc: String? = null

        filter.doFilter(request, response, FilterChain { servletRequest, _ ->
            observedAttribute = servletRequest.getAttribute(CorrelationIdFilter.REQUEST_ATTRIBUTE)
            observedMdc = MDC.get(CorrelationIdFilter.MDC_KEY)
        })

        assertThat(observedAttribute).isEqualTo(observedMdc)
        assertThat(MDC.get(CorrelationIdFilter.MDC_KEY)).isEqualTo("prior")
    }

    @Test
    fun `MDC is cleared after an exceptional request`() {
        val request = MockHttpServletRequest()
        val response = MockHttpServletResponse()

        org.junit.jupiter.api.assertThrows<IllegalStateException> {
            filter.doFilter(request, response, FilterChain { _, _ -> throw IllegalStateException("failure") })
        }

        assertThat(MDC.get(CorrelationIdFilter.MDC_KEY)).isNull()
        assertThat(response.getHeader(CorrelationIdFilter.HEADER_NAME)).isNotBlank()
    }

    @Test
    fun `request attribute and MDC are available during controller execution and restored after its exception`() {
        MDC.put(CorrelationIdFilter.MDC_KEY, "prior-controller-value")

        mockMvc.get("/test/context").andExpect { status { isConflict() } }

        assertThat(controller.observedAttribute).isNotNull().isEqualTo(controller.observedMdc)
        assertThat(MDC.get(CorrelationIdFilter.MDC_KEY)).isEqualTo("prior-controller-value")
    }

    @Test
    fun `bean validation returns a strict bounded problem without rejected secrets`() {
        val secret = "Bearer top-secret-password-refresh-token"

        val result = mockMvc.post("/test/validated") {
            contentType = MediaType.APPLICATION_JSON
            content = objectMapper.writeValueAsString(mapOf("username" to "", "password" to secret))
        }.andExpect {
            status { isBadRequest() }
            content { contentType(MediaType.APPLICATION_PROBLEM_JSON) }
            jsonPath("$.code") { value("OCC-API-VALIDATION") }
            jsonPath("$.detail") { exists() }
        }.andReturn()

        assertStrictProblem(result.response.contentAsString)
        assertSafe(result.response.contentAsString, secret)
        assertThat(objectMapper.readTree(result.response.contentAsString)["detail"].asText().length).isLessThanOrEqualTo(4096)
    }

    @Test
    fun `malformed JSON returns a safe validation problem`() {
        val raw = "{\"username\":\"jdbc:postgresql://db/private\",\"password\":\"secret\""

        val result = mockMvc.post("/test/validated") {
            contentType = MediaType.APPLICATION_JSON
            content = raw
        }.andExpect {
            status { isBadRequest() }
            content { contentType(MediaType.APPLICATION_PROBLEM_JSON) }
            jsonPath("$.code") { value("OCC-API-VALIDATION") }
        }.andReturn()

        assertStrictProblem(result.response.contentAsString)
        assertSafe(result.response.contentAsString, "jdbc:postgresql", "secret")
    }

    @Test
    fun `binding errors return a safe validation problem`() {
        val result = mockMvc.get("/test/binding").andExpect {
            status { isBadRequest() }
            content { contentType(MediaType.APPLICATION_PROBLEM_JSON) }
            jsonPath("$.code") { value("OCC-API-VALIDATION") }
        }.andReturn()

        assertSafe(result.response.contentAsString, "refresh-token-secret")
    }

    @Test
    fun `authentication access conflict and unknown failures have stable generic mappings`() {
        val expectations = listOf(
            Triple("/test/authentication", 401, "OCC-API-AUTHENTICATION"),
            Triple("/test/access-denied", 403, "OCC-API-FORBIDDEN"),
            Triple("/test/conflict", 409, "OCC-API-CONFLICT"),
            Triple("/test/failure", 500, "OCC-API-INTERNAL"),
        )

        expectations.forEach { (path, status, code) ->
            val result = mockMvc.get(path).andExpect {
                status { isEqualTo(status) }
                content { contentType(MediaType.APPLICATION_PROBLEM_JSON) }
                jsonPath("$.code") { value(code) }
            }.andReturn()
            assertStrictProblem(result.response.contentAsString)
            assertSafe(
                result.response.contentAsString,
                "jdbc:postgresql://admin:password@secret-db/occ",
                "Bearer access-token",
                "refresh-token",
                "BadCredentialsException",
                "RuntimeException",
                "at com.innorder",
            )
        }
    }

    @Test
    fun `common MVC client errors retain safe HTTP statuses without error logs`() {
        withFailureLogs { events ->
            val results = listOf(
                "not found" to Triple(mockMvc.get("/test/not-found").andReturn(), 404, "Not Found"),
                "method" to Triple(mockMvc.post("/test/conflict").andReturn(), 405, "Method Not Allowed"),
                "media type" to Triple(
                    mockMvc.post("/test/validated") {
                        contentType = MediaType.TEXT_PLAIN
                        content = "Bearer rejected-secret"
                    }.andReturn(),
                    415,
                    "Unsupported Media Type",
                ),
                "missing parameter" to Triple(mockMvc.get("/test/required").andReturn(), 400, "Bad Request"),
                "conversion failure" to Triple(
                    mockMvc.get("/test/required") { param("count", "password-secret") }.andReturn(),
                    400,
                    "Bad Request",
                ),
            )

            results.forEach { (case, expectation) ->
                val (result, status, title) = expectation
                assertThat(result.response.status).`as`(case).isEqualTo(status)
                assertThat(result.response.contentType).`as`(case).isEqualTo(MediaType.APPLICATION_PROBLEM_JSON_VALUE)
                val problem = objectMapper.readTree(result.response.contentAsString)
                assertThat(problem["code"].asText()).isEqualTo("OCC-API-REQUEST")
                assertThat(problem["title"].asText()).isEqualTo(title)
                assertStrictProblem(result.response.contentAsString)
                assertSafe(result.response.contentAsString, "Bearer rejected-secret", "password-secret")
            }
            assertThat(events).isEmpty()
        }
    }

    @Test
    fun `unknown failure logs one sanitized correlated event while MDC is populated`() {
        val correlationId = "018f30c0-7a86-7f8b-a6e0-3c5477bb7e1a"

        withFailureLogs { events ->
            mockMvc.get("/test/failure") { header(CorrelationIdFilter.HEADER_NAME, correlationId) }
                .andExpect { status { isInternalServerError() } }

            assertThat(events).hasSize(1)
            val event = events.single()
            assertThat(event.formattedMessage)
                .isEqualTo("Unhandled API failure correlationId=$correlationId exceptionClass=java.lang.RuntimeException")
                .doesNotContain("jdbc:postgresql", "password", "Bearer", "refresh-token")
            assertThat(event.throwableProxy).isNull()
            assertThat(event.mdcPropertyMap[CorrelationIdFilter.MDC_KEY]).isEqualTo(correlationId)
        }
    }

    @Test
    fun `constraint violations map to validation without exposing invalid values`() {
        val result = mockMvc.get("/test/constraint").andExpect {
            status { isBadRequest() }
            content { contentType(MediaType.APPLICATION_PROBLEM_JSON) }
            jsonPath("$.code") { value("OCC-API-VALIDATION") }
        }.andReturn()

        assertSafe(result.response.contentAsString, "Bearer constrained-secret")
    }

    @Test
    fun `reusable writer emits the same strict problem contract for security filters`() {
        val request = MockHttpServletRequest().also {
            it.setAttribute(CorrelationIdFilter.REQUEST_ATTRIBUTE, "018f30c0-7a86-7f8b-a6e0-3c5477bb7e1a")
        }
        val response = MockHttpServletResponse()

        responses.writeAuthenticationRequired(request, response)

        assertThat(response.status).isEqualTo(401)
        assertThat(response.contentType).isEqualTo(MediaType.APPLICATION_PROBLEM_JSON_VALUE)
        assertStrictProblem(response.contentAsString)
        assertThat(objectMapper.readTree(response.contentAsString)["code"].asText()).isEqualTo("OCC-API-AUTHENTICATION")

        val deniedResponse = MockHttpServletResponse()
        responses.writeAccessDenied(request, deniedResponse)
        assertThat(deniedResponse.status).isEqualTo(403)
        assertThat(deniedResponse.contentType).isEqualTo(MediaType.APPLICATION_PROBLEM_JSON_VALUE)
        assertStrictProblem(deniedResponse.contentAsString)
        assertThat(objectMapper.readTree(deniedResponse.contentAsString)["code"].asText()).isEqualTo("OCC-API-FORBIDDEN")
    }

    @Test
    fun `problem type rejects paths that are not one stable slug`() {
        org.junit.jupiter.api.assertThrows<IllegalArgumentException> {
            OccProblem(
                URI.create("https://innorder.local/problems/not/a-slug"),
                "Invalid request",
                400,
                "OCC-API-VALIDATION",
                "018f30c0-7a86-7f8b-a6e0-3c5477bb7e1a",
            )
        }
    }

    @ParameterizedTest(name = "rejects non-standard UUID {0}")
    @MethodSource("nonStandardUuidTexts")
    fun `problem correlation ID requires a standard UUID`(correlationId: String) {
        org.junit.jupiter.api.assertThrows<IllegalArgumentException> {
            problem(correlationId = correlationId)
        }
    }

    @Test
    fun `problem title and detail accept astral characters at code point maxima`() {
        val problem = problem(
            title = ASTRAL_CHARACTER.repeat(OccProblem.MAX_TITLE_LENGTH),
            detail = ASTRAL_CHARACTER.repeat(OccProblem.MAX_DETAIL_LENGTH),
        )

        assertThat(problem.title.codePointCount(0, problem.title.length)).isEqualTo(OccProblem.MAX_TITLE_LENGTH)
        assertThat(problem.detail!!.codePointCount(0, problem.detail.length)).isEqualTo(OccProblem.MAX_DETAIL_LENGTH)
    }

    @Test
    fun `problem title and detail reject astral characters above code point maxima`() {
        org.junit.jupiter.api.assertThrows<IllegalArgumentException> {
            problem(title = ASTRAL_CHARACTER.repeat(OccProblem.MAX_TITLE_LENGTH + 1))
        }
        org.junit.jupiter.api.assertThrows<IllegalArgumentException> {
            problem(detail = ASTRAL_CHARACTER.repeat(OccProblem.MAX_DETAIL_LENGTH + 1))
        }
    }

    private fun problem(
        title: String = "Invalid request",
        detail: String? = null,
        correlationId: String = "018f30c0-7a86-7f8b-a6e0-3c5477bb7e1a",
    ) = OccProblem(
        URI.create("https://innorder.local/problems/validation"),
        title,
        400,
        "OCC-API-VALIDATION",
        correlationId,
        detail,
    )

    private fun assertStrictProblem(json: String) {
        assertThat(objectMapper.readTree(json).fieldNames().asSequence().toSet())
            .isSubsetOf("type", "title", "status", "code", "correlationId", "detail")
            .contains("type", "title", "status", "code", "correlationId")
        assertThat(objectMapper.readTree(json)["type"].asText()).startsWith("https://innorder.local/problems/")
    }

    private fun assertSafe(json: String, vararg forbidden: String) {
        forbidden.forEach { assertThat(json).doesNotContain(it) }
        assertThat(json).doesNotContain("stackTrace").doesNotContain("exception")
    }

    private fun withFailureLogs(assertions: (List<ILoggingEvent>) -> Unit) {
        val logger = org.slf4j.LoggerFactory.getLogger(Slf4jApiFailureReporter::class.java) as Logger
        val appender = ListAppender<ILoggingEvent>().also {
            it.start()
            logger.addAppender(it)
        }
        try {
            assertions(appender.list)
        } finally {
            logger.detachAppender(appender)
            appender.stop()
        }
    }

    @RestController
    @RequestMapping("/test")
    private class TestController {
        var observedAttribute: Any? = null
        var observedMdc: String? = null

        @PostMapping("/validated")
        fun validated(@Valid @RequestBody request: SecretRequest): Map<String, String> = mapOf("username" to request.username)

        @GetMapping("/authentication")
        fun authentication(): Nothing =
            throw BadCredentialsException("Bearer access-token jdbc:postgresql://admin:password@secret-db/occ")

        @GetMapping("/access-denied")
        fun accessDenied(): Nothing = throw AccessDeniedException("refresh-token")

        @GetMapping("/conflict")
        fun conflict(): Nothing = throw OptimisticConflictException("database version and password")

        @GetMapping("/failure")
        fun failure(): Nothing = throw RuntimeException("jdbc:postgresql://admin:password@secret-db/occ Bearer access-token refresh-token")

        @GetMapping("/constraint")
        fun constraint(): Nothing = throw ConstraintViolationException("Bearer constrained-secret", emptySet())

        @GetMapping("/binding")
        fun binding(): Nothing {
            val bindingResult = MapBindingResult(mapOf("token" to "refresh-token-secret"), "request")
            bindingResult.rejectValue("token", "invalid", "refresh-token-secret")
            throw BindException(bindingResult)
        }

        @GetMapping("/context")
        fun context(request: HttpServletRequest): Nothing {
            observedAttribute = request.getAttribute(CorrelationIdFilter.REQUEST_ATTRIBUTE)
            observedMdc = MDC.get(CorrelationIdFilter.MDC_KEY)
            throw OptimisticConflictException()
        }

        @GetMapping("/required")
        fun required(@RequestParam count: Int): Map<String, Int> = mapOf("count" to count)

        @GetMapping("/not-found")
        fun notFound(): Nothing = throw NoResourceFoundException(HttpMethod.GET, "/Bearer-not-found-secret")
    }

    private data class SecretRequest(
        @field:NotBlank val username: String,
        @field:Size(min = 12, max = 128) val password: String,
    )

    private class SequenceSecureRandom : SecureRandom() {
        private var next = 1

        override fun nextBytes(bytes: ByteArray) {
            bytes.indices.forEach { index -> bytes[index] = next++.toByte() }
        }
    }

    companion object {
        private const val ASTRAL_CHARACTER = "\uD83D\uDE00"
        private val NON_STANDARD_UUIDS = listOf(
            "123e4567-e89b-02d3-a456-426614174000",
            "123e4567-e89b-f2d3-a456-426614174000",
            "123e4567-e89b-72d3-0456-426614174000",
            "123e4567-e89b-72d3-7456-426614174000",
        )

        @JvmStatic
        fun standardUuidVersions(): Stream<org.junit.jupiter.params.provider.Arguments> = (1..8)
            .map { version ->
                org.junit.jupiter.params.provider.Arguments.of(
                    version,
                    "123e4567-e89b-${version}2d3-a456-426614174000",
                )
            }.stream()

        @JvmStatic
        fun nonStandardUuidTexts(): Stream<String> = (NON_STANDARD_UUIDS + "00000000-0000-0000-0000-000000000000").stream()

        @JvmStatic
        fun invalidHeaders(): Stream<org.junit.jupiter.params.provider.Arguments> = Stream.of(
            org.junit.jupiter.params.provider.Arguments.of("missing", emptyList<String>()),
            org.junit.jupiter.params.provider.Arguments.of("malformed", listOf("not-a-uuid")),
            org.junit.jupiter.params.provider.Arguments.of(
                "multiple",
                listOf("018f30c0-7a86-7f8b-a6e0-3c5477bb7e1a", "018f30c0-7a86-7f8b-a6e0-3c5477bb7e1b"),
            ),
            org.junit.jupiter.params.provider.Arguments.of(
                "comma separated",
                listOf("018f30c0-7a86-7f8b-a6e0-3c5477bb7e1a,018f30c0-7a86-7f8b-a6e0-3c5477bb7e1b"),
            ),
            org.junit.jupiter.params.provider.Arguments.of("oversized", listOf("a".repeat(300))),
            org.junit.jupiter.params.provider.Arguments.of("nil", listOf("00000000-0000-0000-0000-000000000000")),
            org.junit.jupiter.params.provider.Arguments.of("control character", listOf("018f30c0-7a86-7f8b-a6e0-3c5477bb7e1a\r")),
            org.junit.jupiter.params.provider.Arguments.of("version zero", listOf(NON_STANDARD_UUIDS[0])),
            org.junit.jupiter.params.provider.Arguments.of("version f", listOf(NON_STANDARD_UUIDS[1])),
            org.junit.jupiter.params.provider.Arguments.of("non-RFC variant zero", listOf(NON_STANDARD_UUIDS[2])),
            org.junit.jupiter.params.provider.Arguments.of("non-RFC variant seven", listOf(NON_STANDARD_UUIDS[3])),
        )
    }
}
