package com.innorder.occ.api

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.stereotype.Component
import java.net.URI
import java.util.UUID

@JsonInclude(JsonInclude.Include.NON_NULL)
data class OccProblem(
    val type: URI,
    val title: String,
    val status: Int,
    val code: String,
    val correlationId: String,
    val detail: String? = null,
) {
    init {
        require(type.isAbsolute && PROBLEM_TYPE_PATTERN.matches(type.toString()))
        require(title.length in 1..MAX_TITLE_LENGTH)
        require(status in 400..599)
        require(code.length in 1..MAX_CODE_LENGTH)
        require(detail == null || detail.length <= MAX_DETAIL_LENGTH)
        val parsedCorrelationId = runCatching { UUID.fromString(correlationId) }.getOrNull()
        require(parsedCorrelationId != null && parsedCorrelationId != UUID(0, 0))
    }

    companion object {
        const val PROBLEM_TYPE_ROOT = "https://innorder.local/problems/"
        const val MAX_TITLE_LENGTH = 256
        const val MAX_CODE_LENGTH = 128
        const val MAX_DETAIL_LENGTH = 4096
        private val PROBLEM_TYPE_PATTERN = Regex("^https://innorder\\.local/problems/[a-z0-9]+(?:-[a-z0-9]+)*$")
    }
}

@Component
class OccProblemResponses(private val objectMapper: ObjectMapper) {
    fun validation(request: HttpServletRequest, detail: String): ResponseEntity<OccProblem> =
        response(request, 400, "validation", "Invalid request", "OCC-API-VALIDATION", detail)

    fun authentication(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 401, "authentication-required", "Authentication required", "OCC-API-AUTHENTICATION")

    fun forbidden(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 403, "access-denied", "Access denied", "OCC-API-FORBIDDEN")

    fun conflict(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 409, "version-conflict", "Version conflict", "OCC-API-CONFLICT")

    fun internal(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 500, "internal-error", "Internal server error", "OCC-API-INTERNAL")

    fun writeAuthenticationRequired(request: HttpServletRequest, response: HttpServletResponse) {
        write(response, authentication(request))
    }

    fun writeAccessDenied(request: HttpServletRequest, response: HttpServletResponse) {
        write(response, forbidden(request))
    }

    private fun response(
        request: HttpServletRequest,
        status: Int,
        slug: String,
        title: String,
        code: String,
        detail: String? = null,
    ): ResponseEntity<OccProblem> {
        val correlationId = request.getAttribute(CorrelationIdFilter.REQUEST_ATTRIBUTE) as? String
            ?: error("CorrelationIdFilter must run before problem response handling")
        val problem = OccProblem(
            URI.create("${OccProblem.PROBLEM_TYPE_ROOT}$slug"),
            title,
            status,
            code,
            correlationId,
            detail,
        )
        return ResponseEntity.status(status).contentType(MediaType.APPLICATION_PROBLEM_JSON).body(problem)
    }

    private fun write(response: HttpServletResponse, entity: ResponseEntity<OccProblem>) {
        val problem = requireNotNull(entity.body)
        response.status = entity.statusCode.value()
        response.contentType = MediaType.APPLICATION_PROBLEM_JSON_VALUE
        response.setHeader(CorrelationIdFilter.HEADER_NAME, problem.correlationId)
        objectMapper.writeValue(response.outputStream, problem)
    }
}
