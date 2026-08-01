package com.innorder.occ.risk

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.databind.JsonNode
import com.innorder.occ.auth.AccessTokenPrincipal
import com.innorder.occ.command.CommandMetadata
import com.innorder.occ.command.CommandResult
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import org.springframework.format.annotation.DateTimeFormat
import org.springframework.http.ResponseEntity
import org.springframework.security.core.Authentication
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

@JsonIgnoreProperties(ignoreUnknown = false)
data class RiskReasonRequest(
    @field:NotBlank @field:Size(max = 1024) val reason: String,
)

@JsonIgnoreProperties(ignoreUnknown = false)
data class RiskAssignmentRequest(
    val ownerRelationshipId: UUID,
    @field:NotBlank @field:Size(max = 1024) val reason: String,
)

@JsonIgnoreProperties(ignoreUnknown = false)
data class RiskMitigationRequest(
    @field:NotBlank @field:Size(max = 1024) val reason: String,
    @field:Size(max = 32) val data: Map<@Size(max = 128) String, @Size(max = 512) String> = emptyMap(),
)

@JsonIgnoreProperties(ignoreUnknown = false)
data class RiskEscalationRequest(
    @field:Min(0) val level: Int,
    @field:NotBlank @field:Size(max = 1024) val reason: String,
    val ownerRelationshipId: UUID? = null,
    val severity: RiskSeverity? = null,
    val evaluatedAt: Instant,
)

data class RiskCommandResponse(
    val status: Int,
    val resourceId: UUID?,
    val replayed: Boolean,
    val body: JsonNode,
)

@RestController
@RequestMapping("/api/v1/risks")
class RiskController(private val risks: RiskService) {
    @GetMapping("/interventions")
    fun interventions(
        authentication: Authentication,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
        @RequestParam(required = false) severity: Set<RiskSeverity>?,
        @RequestParam(required = false) state: Set<RiskState>?,
        @RequestParam(required = false) slaStatus: RiskSlaStatus?,
        @RequestParam(required = false) targetEntityId: UUID?,
        @RequestParam(required = false) ownerRelationshipId: UUID?,
        @RequestParam(defaultValue = "50") @Min(1) @Max(100) limit: Int,
        @RequestParam(required = false) cursor: String?,
        @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) evaluatedAt: Instant,
    ): RiskQueuePage {
        val principal = accessTokenPrincipal(authentication)
        return risks.interventionQueue(
        principal.principalId,
        principal.customerInstanceId,
        correlationId,
        RiskQueueFilters(
            severity ?: setOf(RiskSeverity.YELLOW, RiskSeverity.RED),
            state ?: setOf(RiskState.OPEN, RiskState.ACKNOWLEDGED),
            slaStatus,
            targetEntityId,
            ownerRelationshipId,
        ),
        evaluatedAt,
        limit,
        cursor,
    )
    }

    @PostMapping("/{riskId}/acknowledge")
    fun acknowledge(
        authentication: Authentication,
        @PathVariable riskId: UUID,
        @Valid @RequestBody request: RiskReasonRequest,
        @RequestHeader("Idempotency-Key") idempotencyKey: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = response(risks.acknowledge(
        metadata(authentication, "risk.acknowledge", idempotencyKey, expectedVersion, correlationId), riskId, request.reason,
    ))

    @PostMapping("/{riskId}/assign")
    fun assign(
        authentication: Authentication,
        @PathVariable riskId: UUID,
        @Valid @RequestBody request: RiskAssignmentRequest,
        @RequestHeader("Idempotency-Key") idempotencyKey: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = response(risks.assign(
        metadata(authentication, "risk.assign", idempotencyKey, expectedVersion, correlationId),
        riskId, request.ownerRelationshipId, request.reason,
    ))

    @PostMapping("/{riskId}/mitigate")
    fun mitigate(
        authentication: Authentication,
        @PathVariable riskId: UUID,
        @Valid @RequestBody request: RiskMitigationRequest,
        @RequestHeader("Idempotency-Key") idempotencyKey: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = response(risks.mitigate(
        metadata(authentication, "risk.mitigate", idempotencyKey, expectedVersion, correlationId),
        riskId, request.reason, request.data,
    ))

    @PostMapping("/{riskId}/escalate")
    fun escalate(
        authentication: Authentication,
        @PathVariable riskId: UUID,
        @Valid @RequestBody request: RiskEscalationRequest,
        @RequestHeader("Idempotency-Key") idempotencyKey: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = response(risks.escalate(
        metadata(authentication, "risk.escalate", idempotencyKey, expectedVersion, correlationId),
        riskId, request.level, request.reason,
        request.ownerRelationshipId, request.severity, request.evaluatedAt,
    ))

    @PostMapping("/{riskId}/resolve")
    fun resolve(
        authentication: Authentication,
        @PathVariable riskId: UUID,
        @Valid @RequestBody request: RiskReasonRequest,
        @RequestHeader("Idempotency-Key") idempotencyKey: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = response(risks.resolve(
        metadata(authentication, "risk.resolve", idempotencyKey, expectedVersion, correlationId), riskId, request.reason,
    ))

    @PostMapping("/{riskId}/dismiss")
    fun dismiss(
        authentication: Authentication,
        @PathVariable riskId: UUID,
        @Valid @RequestBody request: RiskReasonRequest,
        @RequestHeader("Idempotency-Key") idempotencyKey: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = response(risks.dismiss(
        metadata(authentication, "risk.dismiss", idempotencyKey, expectedVersion, correlationId), riskId, request.reason,
    ))

    @PostMapping("/adjudications")
    fun adjudicate(
        authentication: Authentication,
        @Valid @RequestBody request: RiskAdjudicationRequest,
        @RequestHeader("Idempotency-Key") idempotencyKey: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = response(risks.adjudicate(
        metadata(authentication, "risk.adjudicate", idempotencyKey, expectedVersion, correlationId), request,
    ))

    @GetMapping("/metrics")
    fun metrics(
        @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) start: LocalDate,
        @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) end: LocalDate,
    ): RiskMetrics = risks.metrics(start, end)

    private fun response(result: CommandResult): ResponseEntity<RiskCommandResponse> = ResponseEntity.status(result.status).body(
        RiskCommandResponse(result.status, result.resourceId, result.replayed, result.body.toJsonNode()),
    )

    private fun metadata(
        authentication: Authentication,
        commandKey: String,
        idempotencyKey: String,
        expectedVersion: Long,
        correlationId: UUID,
    ) = CommandMetadata(principal(authentication), commandKey, idempotencyKey, expectedVersion, correlationId)
}

private fun principal(authentication: Authentication): UUID =
    accessTokenPrincipal(authentication).principalId

private fun accessTokenPrincipal(authentication: Authentication): AccessTokenPrincipal =
    authentication.principal as AccessTokenPrincipal
