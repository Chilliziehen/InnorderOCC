package com.innorder.occ.api

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.MediaType
import org.springframework.http.HttpStatus
import org.springframework.http.HttpStatusCode
import org.springframework.http.ResponseEntity
import org.springframework.stereotype.Component
import java.net.URI

@JsonInclude(JsonInclude.Include.NON_NULL)
data class OccProblem(
    val type: URI,
    val title: String,
    val status: Int,
    val code: String,
    val correlationId: String,
    val detail: String? = null,
    val currentVersion: Long? = null,
    val resourceId: String? = null,
    val intervalStart: String? = null,
    val intervalEnd: String? = null,
    val reservationId: String? = null,
    val requesterEntityId: String? = null,
) {
    init {
        require(type.isAbsolute && PROBLEM_TYPE_PATTERN.matches(type.toString()))
        require(ApiContractValidation.hasCodePointLengthWithin(title, 1, MAX_TITLE_LENGTH))
        require(status in 400..599)
        require(code.length in 1..MAX_CODE_LENGTH)
        require(detail == null || ApiContractValidation.hasCodePointLengthWithin(detail, 0, MAX_DETAIL_LENGTH))
        require(ApiContractValidation.isStandardUuid(correlationId))
        require(currentVersion == null || currentVersion in 0..com.innorder.occ.command.CommandExecutor.MAX_SAFE_INTEGER)
        listOf(resourceId, reservationId, requesterEntityId).filterNotNull().forEach {
            require(ApiContractValidation.isStandardUuid(it))
        }
        require((intervalStart == null) == (intervalEnd == null))
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

    fun invalidCredentials(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 401, "invalid-credentials", "Invalid credentials", "OCC-AUTH-INVALID-CREDENTIALS")

    fun forbidden(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 403, "access-denied", "Access denied", "OCC-API-FORBIDDEN")

    fun conflict(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 409, "version-conflict", "Version conflict", "OCC-API-CONFLICT")

    fun invalidIdempotencyKey(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 400, "invalid-idempotency-key", "Invalid idempotency key", "OCC-COMMAND-IDEMPOTENCY-KEY")

    fun idempotencyConflict(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 409, "idempotency-conflict", "Idempotency conflict", "OCC-COMMAND-IDEMPOTENCY-CONFLICT")

    fun invalidCommandMetadata(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 400, "invalid-command-metadata", "Invalid command metadata", "OCC-COMMAND-METADATA")

    fun idempotencyInProgress(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 409, "idempotency-in-progress", "Command is in progress", "OCC-COMMAND-IDEMPOTENCY-IN-PROGRESS")

    fun idempotencyExpired(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(
            request, 409, "idempotency-expired", "Idempotency key expired", "OCC-COMMAND-IDEMPOTENCY-EXPIRED",
            "Use a new idempotency key.",
        )

    fun commandIntegrity(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 503, "command-integrity", "Command result unavailable", "OCC-COMMAND-INTEGRITY")

    fun optimisticConflict(request: HttpServletRequest, currentVersion: Long): ResponseEntity<OccProblem> =
        response(
            request, 409, "optimistic-conflict", "Version conflict", "OCC-COMMAND-OPTIMISTIC-CONFLICT",
            currentVersion = currentVersion,
        )

    fun reservationConflict(
        request: HttpServletRequest,
        resourceId: String,
        start: String,
        end: String,
        reservationId: String?,
        requesterEntityId: String?,
    ): ResponseEntity<OccProblem> = response(
        request, 409, "reservation-conflict", "Reservation conflict", "OCC-RESERVATION-CONFLICT",
        "Resource $resourceId is unavailable for interval [$start,$end).",
        resourceId = resourceId, intervalStart = start, intervalEnd = end,
        reservationId = reservationId, requesterEntityId = requesterEntityId,
    )

    fun reservationStateConflict(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 409, "reservation-state-conflict", "Reservation state conflict", "OCC-RESERVATION-STATE-CONFLICT")

    fun resourceQueryValidation(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 400, "resource-query-validation", "Invalid resource query", "OCC-RESOURCE-QUERY-VALIDATION")

    fun authorizationUnavailable(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 503, "authorization-unavailable", "Authorization unavailable", "OCC-AUTHZ-UNAVAILABLE")

    fun internal(request: HttpServletRequest): ResponseEntity<OccProblem> =
        response(request, 500, "internal-error", "Internal server error", "OCC-API-INTERNAL")

    fun requestError(request: HttpServletRequest, statusCode: HttpStatusCode): ResponseEntity<OccProblem> {
        val status = requireNotNull(HttpStatus.resolve(statusCode.value()))
        return response(request, status.value(), "request", status.reasonPhrase, "OCC-API-REQUEST")
    }

    fun correlationId(request: HttpServletRequest): String =
        request.getAttribute(CorrelationIdFilter.REQUEST_ATTRIBUTE) as? String
            ?: error("CorrelationIdFilter must run before problem response handling")

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
        currentVersion: Long? = null,
        resourceId: String? = null,
        intervalStart: String? = null,
        intervalEnd: String? = null,
        reservationId: String? = null,
        requesterEntityId: String? = null,
    ): ResponseEntity<OccProblem> {
        val problem = OccProblem(
            URI.create("${OccProblem.PROBLEM_TYPE_ROOT}$slug"),
            title,
            status,
            code,
            correlationId(request),
            detail,
            currentVersion,
            resourceId,
            intervalStart,
            intervalEnd,
            reservationId,
            requesterEntityId,
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
