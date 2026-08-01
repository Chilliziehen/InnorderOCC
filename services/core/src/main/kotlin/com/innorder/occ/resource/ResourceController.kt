package com.innorder.occ.resource

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.api.CorrelationIdFilter
import com.innorder.occ.auth.AccessTokenPrincipal
import com.innorder.occ.command.CommandMetadata
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import org.springframework.http.ResponseEntity
import org.springframework.security.core.Authentication
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.time.OffsetDateTime
import java.util.UUID

@RestController
@RequestMapping("/api/v1")
class ResourceController(private val resources: ResourceService, private val mapper: ObjectMapper) {
    @PostMapping("/resources")
    fun create(
        authentication: Authentication,
        servletRequest: HttpServletRequest,
        @RequestHeader("Idempotency-Key") key: String,
        @Valid @RequestBody request: CreateResourceRequest,
    ) = response(resources.create(metadata(authentication, servletRequest, key, null), bytes(request), request))

    @PatchMapping("/resources/{id}")
    fun update(
        authentication: Authentication,
        servletRequest: HttpServletRequest,
        @PathVariable id: UUID,
        @RequestHeader("Idempotency-Key") key: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @Valid @RequestBody request: UpdateResourceRequest,
    ) = response(
        resources.update(id, metadata(authentication, servletRequest, key, expectedVersion), bytes(request), request),
    )

    @PostMapping("/resources/{id}/availability")
    fun addAvailability(
        authentication: Authentication,
        servletRequest: HttpServletRequest,
        @PathVariable id: UUID,
        @RequestHeader("Idempotency-Key") key: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @Valid @RequestBody request: AddAvailabilityRequest,
    ) = response(
        resources.addAvailability(id, metadata(authentication, servletRequest, key, expectedVersion), bytes(request), request),
    )

    @PostMapping("/resources/{id}/reservations")
    fun reserve(
        authentication: Authentication,
        servletRequest: HttpServletRequest,
        @PathVariable id: UUID,
        @RequestHeader("Idempotency-Key") key: String,
        @Valid @RequestBody request: ReserveResourceRequest,
    ) = response(resources.reserve(id, metadata(authentication, servletRequest, key, null), bytes(request), request))

    @PatchMapping("/reservations/{id}")
    fun change(
        authentication: Authentication,
        servletRequest: HttpServletRequest,
        @PathVariable id: UUID,
        @RequestHeader("Idempotency-Key") key: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @Valid @RequestBody request: ChangeReservationRequest,
    ) = response(
        resources.change(id, metadata(authentication, servletRequest, key, expectedVersion), bytes(request), request),
    )

    @PostMapping("/reservations/{id}/cancel")
    fun cancel(
        authentication: Authentication,
        servletRequest: HttpServletRequest,
        @PathVariable id: UUID,
        @RequestHeader("Idempotency-Key") key: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
    ) = response(
        resources.cancel(id, metadata(authentication, servletRequest, key, expectedVersion), "{}".toByteArray()),
    )

    @GetMapping("/resources")
    fun inventory(
        authentication: Authentication,
        servletRequest: HttpServletRequest,
        @RequestParam(defaultValue = "50") limit: Int,
        @RequestParam(required = false) cursor: String?,
    ) = ResponseEntity.ok(resources.inventory(principal(authentication).principalId, correlation(servletRequest), limit, cursor))

    @GetMapping("/resources/{id}/availability")
    fun availability(
        authentication: Authentication,
        servletRequest: HttpServletRequest,
        @PathVariable id: UUID,
        @RequestParam start: OffsetDateTime,
        @RequestParam end: OffsetDateTime,
    ) = ResponseEntity.ok(resources.availability(principal(authentication).principalId, correlation(servletRequest), id, start, end))

    @GetMapping("/resources/{id}/schedule")
    fun schedule(
        authentication: Authentication,
        servletRequest: HttpServletRequest,
        @PathVariable id: UUID,
        @RequestParam start: OffsetDateTime,
        @RequestParam end: OffsetDateTime,
        @RequestParam(defaultValue = "50") limit: Int,
        @RequestParam(required = false) cursor: String?,
    ) = ResponseEntity.ok(
        resources.schedule(principal(authentication).principalId, correlation(servletRequest), id, start, end, limit, cursor),
    )

    private fun metadata(
        authentication: Authentication,
        request: HttpServletRequest,
        key: String,
        expectedVersion: Long?,
    ) = CommandMetadata(principal(authentication).principalId, "resource.command", key, expectedVersion, correlation(request))

    private fun principal(authentication: Authentication) = authentication.principal as AccessTokenPrincipal
    private fun correlation(request: HttpServletRequest) =
        UUID.fromString(request.getAttribute(CorrelationIdFilter.REQUEST_ATTRIBUTE) as String)
    private fun bytes(value: Any) = mapper.writeValueAsBytes(value)
    private fun <T> response(result: ResourceCommandResult<T>): ResponseEntity<T> = ResponseEntity
        .status(result.status)
        .header("X-Idempotent-Replay", result.replayed.toString())
        .body(result.body)
}
