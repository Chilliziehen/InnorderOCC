package com.innorder.occ.ai

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

data class AiGrantClaimRequest(val operationId: UUID)

@RestController
@RequestMapping("/internal/v1/ai")
@ConditionalOnProperty(prefix = "occ.ai.grant", name = ["enabled"], havingValue = "true")
class AiServiceController(private val grants: AiGrantService) {
    @PostMapping("/grants/claim")
    fun claim(@RequestBody request: AiGrantClaimRequest): ResponseEntity<AiGrantClaimResponse> =
        ResponseEntity.ok(grants.claim(request.operationId))
}
