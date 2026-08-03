package com.innorder.occ.cohort

import com.innorder.occ.api.CorrelationIdFilter
import com.innorder.occ.auth.AccessTokenPrincipal
import com.innorder.occ.api.cursor.CursorCodec
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import org.springframework.http.ResponseEntity
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean
import org.springframework.security.core.Authentication
import org.springframework.validation.annotation.Validated
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.net.URI
import java.time.Instant
import java.util.UUID

@Validated
@RestController
@RequestMapping("/api/v1/cohorts")
@ConditionalOnBean(CursorCodec::class)
class CohortController(
    private val commands: CohortCommandService,
    private val queries: CohortQueryService,
) {
    @GetMapping
    fun list(
        authentication: Authentication,
        request: HttpServletRequest,
        @RequestParam(required = false) status: CohortStatus?,
        @RequestParam(required = false) packageVersionId: UUID?,
        @RequestParam(required = false) updatedBefore: Instant?,
        @RequestParam(required = false) cursor: String?,
        @RequestParam(defaultValue = "25") @Min(1) @Max(100) pageSize: Int,
    ): CohortPage = queries.list(
        principal(authentication), correlation(request),
        CohortListFilter(status, packageVersionId, updatedBefore), pageSize, cursor,
    )

    @PostMapping
    fun create(
        authentication: Authentication,
        request: HttpServletRequest,
        @RequestHeader("Idempotency-Key") idempotencyKey: String,
        @Valid @RequestBody body: CreateCohortRequest,
    ): ResponseEntity<CohortDetail> {
        val result = commands.create(principal(authentication), idempotencyKey, correlation(request), body)
        return ResponseEntity.created(URI.create("/api/v1/cohorts/${result.value.id}"))
            .header(REPLAY_HEADER, result.replayed.toString())
            .body(result.value)
    }

    @GetMapping("/{cohortId}")
    fun get(
        authentication: Authentication,
        request: HttpServletRequest,
        @PathVariable cohortId: UUID,
    ): CohortDetail = queries.get(principal(authentication), correlation(request), cohortId)

    @PatchMapping("/{cohortId}")
    fun update(
        authentication: Authentication,
        request: HttpServletRequest,
        @PathVariable cohortId: UUID,
        @RequestHeader("Idempotency-Key") idempotencyKey: String,
        @Valid @RequestBody body: UpdateCohortRequest,
    ): ResponseEntity<CohortDetail> = commandResponse(
        commands.update(principal(authentication), idempotencyKey, correlation(request), cohortId, body),
    )

    @PostMapping("/{cohortId}/members")
    fun addMember(
        authentication: Authentication,
        request: HttpServletRequest,
        @PathVariable cohortId: UUID,
        @RequestHeader("Idempotency-Key") idempotencyKey: String,
        @Valid @RequestBody body: AddCohortMemberRequest,
    ): ResponseEntity<CohortDetail> = commandResponse(
        commands.addMember(principal(authentication), idempotencyKey, correlation(request), cohortId, body),
    )

    @DeleteMapping("/{cohortId}/members")
    fun removeMember(
        authentication: Authentication,
        request: HttpServletRequest,
        @PathVariable cohortId: UUID,
        @RequestHeader("Idempotency-Key") idempotencyKey: String,
        @Valid @RequestBody body: RemoveCohortMemberRequest,
    ): ResponseEntity<CohortDetail> = commandResponse(
        commands.removeMember(principal(authentication), idempotencyKey, correlation(request), cohortId, body),
    )

    @PostMapping("/{cohortId}/owner")
    fun transferOwner(
        authentication: Authentication,
        request: HttpServletRequest,
        @PathVariable cohortId: UUID,
        @RequestHeader("Idempotency-Key") idempotencyKey: String,
        @Valid @RequestBody body: TransferCohortOwnerRequest,
    ): ResponseEntity<CohortDetail> = commandResponse(
        commands.transferOwner(principal(authentication), idempotencyKey, correlation(request), cohortId, body),
    )

    @PostMapping("/{cohortId}/archive")
    fun archive(
        authentication: Authentication,
        request: HttpServletRequest,
        @PathVariable cohortId: UUID,
        @RequestHeader("Idempotency-Key") idempotencyKey: String,
        @Valid @RequestBody body: ArchiveCohortRequest,
    ): ResponseEntity<CohortDetail> = commandResponse(
        commands.archive(principal(authentication), idempotencyKey, correlation(request), cohortId, body),
    )

    private fun commandResponse(result: CohortCommandResult): ResponseEntity<CohortDetail> = ResponseEntity
        .status(result.status)
        .header(REPLAY_HEADER, result.replayed.toString())
        .body(result.value)

    private fun principal(authentication: Authentication): UUID =
        (authentication.principal as AccessTokenPrincipal).principalId

    private fun correlation(request: HttpServletRequest): UUID = UUID.fromString(
        request.getAttribute(CorrelationIdFilter.REQUEST_ATTRIBUTE) as String,
    )

    private companion object {
        const val REPLAY_HEADER = "X-Idempotent-Replay"
    }
}
