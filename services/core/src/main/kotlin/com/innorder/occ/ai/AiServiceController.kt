package com.innorder.occ.ai

import com.fasterxml.jackson.annotation.JsonAnySetter
import com.fasterxml.jackson.databind.JsonNode
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RestController
import java.util.UUID
import com.innorder.occ.command.InvalidIdempotencyKeyException

data class AiGrantClaimRequest(val operationId: UUID) {
    @JsonAnySetter
    fun rejectUnknown(name: String, value: JsonNode): Nothing = throw IllegalArgumentException("Unknown claim field")
}

@RestController
@RequestMapping("/internal/v1/ai")
@ConditionalOnProperty(prefix = "occ.ai.grant", name = ["enabled"], havingValue = "true")
class AiServiceController(private val grants: AiGrantService) {
    @PostMapping("/grants/claim")
    fun claim(
        @RequestHeader("Idempotency-Key", required = false) idempotencyKey: String?,
        @RequestBody request: AiGrantClaimRequest,
    ): ResponseEntity<AiGrantClaimResponse> = ResponseEntity.ok(
        grants.claim(request.operationId, idempotencyKey ?: throw InvalidIdempotencyKeyException()),
    )
}
