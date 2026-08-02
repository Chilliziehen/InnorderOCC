package com.innorder.occ.evidence

import com.innorder.occ.auth.AccessTokenPrincipal
import com.innorder.occ.command.CommandMetadata
import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.context.annotation.Profile
import org.springframework.security.core.Authentication
import org.springframework.web.bind.annotation.*
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody
import java.util.UUID

@RestController
@Profile("!test & !flowable-init")
@RequestMapping("/api/v1/evidence")
class EvidenceController(private val evidence: EvidenceService) {
    @PostMapping("/upload-sessions")
    fun createSession(
        authentication: Authentication,
        @RequestBody request: CreateEvidenceSessionRequest,
        @RequestHeader("Idempotency-Key") key: String,
        @RequestHeader("Expected-Version", required = false) expectedVersion: Long?,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = response(evidence.createSession(metadata(authentication, "evidence.upload.create", key, expectedVersion, correlationId), request))

    @PutMapping("/upload-sessions/{sessionId}/content", consumes = [MediaType.APPLICATION_OCTET_STREAM_VALUE])
    fun upload(
        authentication: Authentication,
        servletRequest: HttpServletRequest,
        @PathVariable sessionId: UUID,
        @RequestHeader("Idempotency-Key") key: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = response(evidence.upload(
        metadata(authentication, "evidence.upload.confirm", key, expectedVersion, correlationId),
        sessionId,
        servletRequest.inputStream,
    ))

    @PostMapping("/{evidenceId}/submit")
    fun submit(
        authentication: Authentication,
        @PathVariable evidenceId: UUID,
        @RequestHeader("Idempotency-Key") key: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = response(evidence.submit(
        metadata(authentication, "evidence.submit", key, expectedVersion, correlationId), evidenceId,
    ))

    @PostMapping("/{evidenceId}/reviews")
    fun review(
        authentication: Authentication,
        @PathVariable evidenceId: UUID,
        @RequestBody request: EvidenceReviewRequest,
        @RequestHeader("Idempotency-Key") key: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = response(evidence.review(
        metadata(authentication, "evidence.review", key, expectedVersion, correlationId), evidenceId, request,
    ))

    @GetMapping("/{evidenceId}")
    fun metadata(
        authentication: Authentication,
        @PathVariable evidenceId: UUID,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = evidence.metadata(principal(authentication), correlationId, evidenceId)

    @GetMapping("/{evidenceId}/history")
    fun history(
        authentication: Authentication,
        @PathVariable evidenceId: UUID,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
        @RequestParam(defaultValue = "50") limit: Int,
        @RequestParam(required = false) cursor: String?,
    ) = evidence.history(principal(authentication), correlationId, evidenceId, limit, cursor)

    @GetMapping("/{evidenceId}/versions/{version}/download")
    fun download(
        authentication: Authentication,
        @PathVariable evidenceId: UUID,
        @PathVariable version: Int,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
        @RequestHeader(HttpHeaders.RANGE, required = false) rangeHeader: String?,
    ): ResponseEntity<StreamingResponseBody> {
        val principal = principal(authentication)
        var download = evidence.download(principal, correlationId, evidenceId, version)
        val range = rangeHeader?.let { EvidenceHttpSupport.range(it, download.totalSize) }
        if (range != null) {
            download.close()
            download = evidence.download(principal, correlationId, evidenceId, version, range)
        }
        val selected = download
        val body = StreamingResponseBody { output -> selected.use { it.read.stream.copyTo(output) } }
        val builder = ResponseEntity.status(if (range == null) HttpStatus.OK else HttpStatus.PARTIAL_CONTENT)
            .header(HttpHeaders.CONTENT_DISPOSITION, EvidenceHttpSupport.attachment(download.fileName))
            .header("X-Content-Type-Options", "nosniff")
            .header(HttpHeaders.ACCEPT_RANGES, "bytes")
            .contentType(MediaType.parseMediaType(download.mediaType))
            .contentLength(download.read.length)
        if (range != null) builder.header(
            HttpHeaders.CONTENT_RANGE,
            "bytes ${range.offset}-${range.offset + range.length - 1}/${download.totalSize}",
        )
        return builder.body(body)
    }

    @GetMapping("/{evidenceId}/versions/{version}/preview", produces = [MediaType.TEXT_PLAIN_VALUE])
    fun preview(
        authentication: Authentication,
        @PathVariable evidenceId: UUID,
        @PathVariable version: Int,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ): ResponseEntity<String> = evidence.preview(principal(authentication), correlationId, evidenceId, version)
        ?.let { ResponseEntity.ok().header("X-Content-Type-Options", "nosniff").body(it) }
        ?: ResponseEntity.notFound().build()

    private fun metadata(authentication: Authentication, command: String, key: String, expected: Long?, correlation: UUID) =
        CommandMetadata(principal(authentication), command, key, expected, correlation)

    private fun principal(authentication: Authentication): UUID =
        (authentication.principal as AccessTokenPrincipal).principalId

    private fun <T> response(result: EvidenceCommandResult<T>): ResponseEntity<T> = ResponseEntity.status(result.status)
        .header("X-Idempotent-Replay", result.replayed.toString()).body(result.body)
}

object EvidenceHttpSupport {
    fun range(value: String, totalSize: Long): ObjectRange {
        if (totalSize <= 0 || ',' in value) throw InvalidEvidenceRequestException()
        val match = RANGE.matchEntire(value) ?: throw InvalidEvidenceRequestException()
        val start = match.groupValues[1].toLongOrNull() ?: throw InvalidEvidenceRequestException()
        val end = match.groupValues[2].takeIf(String::isNotEmpty)?.toLongOrNull() ?: (totalSize - 1)
        if (start < 0 || start >= totalSize || end < start || end >= totalSize) throw InvalidEvidenceRequestException()
        return ObjectRange(start, end - start + 1)
    }

    fun attachment(fileName: String): String = "attachment; filename=\"${fileName.take(255).map {
        if (it.isISOControl() || it in setOf('/', '\\', '"', ':')) '_' else it
    }.joinToString("").ifBlank { "evidence" }}\""

    private val RANGE = Regex("^bytes=([0-9]+)-([0-9]*)$")
}
