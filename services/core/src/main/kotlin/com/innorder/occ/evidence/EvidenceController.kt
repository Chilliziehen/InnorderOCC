package com.innorder.occ.evidence

import com.innorder.occ.auth.AccessTokenPrincipal
import com.innorder.occ.command.CommandMetadata
import jakarta.servlet.http.HttpServletRequest
import org.springframework.context.annotation.Profile
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.security.core.Authentication
import org.springframework.web.bind.annotation.*
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody
import java.util.Base64
import java.util.HexFormat
import java.util.UUID

@RestController
@Profile("!test & !flowable-init")
@RequestMapping("/api/v1/evidence")
class EvidenceController(private val evidence: EvidenceService) {
    @GetMapping("/requirements")
    fun requirements(
        authentication: Authentication,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
        @RequestParam(defaultValue = "50") limit: Int,
        @RequestParam(required = false) cursor: String?,
    ) = evidence.requirements(principal(authentication), correlationId, limit, cursor)

    @GetMapping("/requirements/{requirementId}")
    fun requirement(
        authentication: Authentication,
        @PathVariable requirementId: UUID,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = evidence.requirement(principal(authentication), correlationId, requirementId)

    @PostMapping("/upload-sessions")
    fun createSession(
        authentication: Authentication,
        @RequestBody request: CreateEvidenceSessionRequest,
        @RequestHeader("Idempotency-Key") key: String,
        @RequestHeader("Expected-Version", required = false) expectedVersion: Long?,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = response(
        evidence.createSession(metadata(authentication, "evidence.upload.create", key, expectedVersion, correlationId), request),
        correlationId,
    )

    @GetMapping("/upload-sessions/{uploadSessionId}")
    fun uploadStatus(
        authentication: Authentication,
        @PathVariable uploadSessionId: UUID,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = evidence.uploadStatus(principal(authentication), correlationId, uploadSessionId)

    @PutMapping("/upload-sessions/{uploadSessionId}/content", consumes = [MediaType.APPLICATION_OCTET_STREAM_VALUE])
    fun upload(
        authentication: Authentication,
        servletRequest: HttpServletRequest,
        @PathVariable uploadSessionId: UUID,
        @RequestHeader("Idempotency-Key") key: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = response(
        evidence.upload(
            metadata(authentication, "evidence.upload.content", key, expectedVersion, correlationId),
            uploadSessionId,
            servletRequest.inputStream,
        ),
        correlationId,
    )

    @GetMapping("/{evidenceId}")
    fun metadata(
        authentication: Authentication,
        @PathVariable evidenceId: UUID,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = evidence.metadata(principal(authentication), correlationId, evidenceId)

    @PostMapping("/{evidenceId}/submit")
    fun submit(
        authentication: Authentication,
        @PathVariable evidenceId: UUID,
        @RequestBody request: SubmitEvidenceRequest,
        @RequestHeader("Idempotency-Key") key: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = response(
        evidence.submit(metadata(authentication, "evidence.submit", key, expectedVersion, correlationId), evidenceId, request),
        correlationId,
    )

    @GetMapping("/{evidenceId}/reviews")
    fun reviews(
        authentication: Authentication,
        @PathVariable evidenceId: UUID,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
        @RequestParam(defaultValue = "50") limit: Int,
        @RequestParam(required = false) cursor: String?,
    ) = evidence.reviews(principal(authentication), correlationId, evidenceId, limit, cursor)

    @PostMapping("/{evidenceId}/reviews")
    fun review(
        authentication: Authentication,
        @PathVariable evidenceId: UUID,
        @RequestBody request: EvidenceReviewRequest,
        @RequestHeader("Idempotency-Key") key: String,
        @RequestHeader("Expected-Version") expectedVersion: Long,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = response(
        evidence.review(metadata(authentication, "evidence.review", key, expectedVersion, correlationId), evidenceId, request),
        correlationId,
    )

    @GetMapping("/{evidenceId}/versions")
    fun versions(
        authentication: Authentication,
        @PathVariable evidenceId: UUID,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
        @RequestParam(defaultValue = "50") limit: Int,
        @RequestParam(required = false) cursor: String?,
    ) = evidence.versions(principal(authentication), correlationId, evidenceId, limit, cursor)

    @GetMapping("/{evidenceId}/preview")
    fun previewMetadata(
        authentication: Authentication,
        @PathVariable evidenceId: UUID,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = evidence.previewMetadata(principal(authentication), correlationId, evidenceId)

    @GetMapping("/{evidenceId}/download-metadata")
    fun downloadMetadata(
        authentication: Authentication,
        @PathVariable evidenceId: UUID,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
    ) = evidence.downloadMetadata(principal(authentication), correlationId, evidenceId)

    @GetMapping("/{evidenceId}/download")
    fun download(
        authentication: Authentication,
        @PathVariable evidenceId: UUID,
        @RequestHeader("X-Correlation-ID") correlationId: UUID,
        @RequestHeader(HttpHeaders.RANGE, required = false) rangeHeader: String?,
    ): ResponseEntity<StreamingResponseBody> {
        val principal = principal(authentication)
        val metadata = evidence.downloadMetadata(principal, correlationId, evidenceId)
        val range = rangeHeader?.let { EvidenceHttpSupport.range(it, metadata.sizeBytes) }
        val download = evidence.download(principal, correlationId, evidenceId, range)
        val body = StreamingResponseBody { output -> download.use { it.read.stream.copyTo(output) } }
        val builder = ResponseEntity.status(if (range == null) HttpStatus.OK else HttpStatus.PARTIAL_CONTENT)
            .header(HttpHeaders.CONTENT_DISPOSITION, EvidenceHttpSupport.attachment(metadata.filename))
            .header("X-Content-Type-Options", "nosniff")
            .header("Digest", EvidenceHttpSupport.digest(metadata.sha256))
            .header(HttpHeaders.ACCEPT_RANGES, "bytes")
            .contentType(MediaType.APPLICATION_OCTET_STREAM)
            .contentLength(download.read.length)
        if (range != null) builder.header(
            HttpHeaders.CONTENT_RANGE, "bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.sizeBytes}",
        )
        return builder.body(body)
    }

    private fun metadata(authentication: Authentication, command: String, key: String, expected: Long?, correlation: UUID) =
        CommandMetadata(principal(authentication), command, key, expected, correlation)

    private fun principal(authentication: Authentication) = (authentication.principal as AccessTokenPrincipal).principalId

    private fun <T> response(result: EvidenceCommandResult<T>, correlationId: UUID): ResponseEntity<T> = ResponseEntity
        .status(result.status)
        .header("X-Correlation-ID", correlationId.toString())
        .header("Idempotency-Replayed", result.replayed.toString())
        .body(result.body)
}

object EvidenceHttpSupport {
    fun range(value: String, totalSize: Long): ObjectRange {
        if (totalSize <= 0 || !RANGE.matches(value)) throw EvidenceInvalidRangeException(totalSize)
        val specification = value.removePrefix("bytes=").takeIf { value.startsWith("bytes=") }
            ?: throw EvidenceInvalidRangeException(totalSize)
        if (specification.startsWith('-')) {
            val suffix = specification.substring(1).toLongOrNull()?.takeIf { it > 0 }
                ?: throw EvidenceInvalidRangeException(totalSize)
            if (suffix > MAX_SAFE_INTEGER) throw EvidenceInvalidRangeException(totalSize)
            val length = minOf(suffix, totalSize)
            return ObjectRange(totalSize - length, length)
        }
        val parts = specification.split('-', limit = 2)
        if (parts.size != 2) throw EvidenceInvalidRangeException(totalSize)
        val start = parts[0].toLongOrNull() ?: throw EvidenceInvalidRangeException(totalSize)
        val end = parts[1].takeIf(String::isNotEmpty)?.toLongOrNull() ?: (totalSize - 1)
        if (start > MAX_SAFE_INTEGER || end > MAX_SAFE_INTEGER || start < 0 || start >= totalSize || end < start || end >= totalSize) {
            throw EvidenceInvalidRangeException(totalSize)
        }
        return ObjectRange(start, end - start + 1)
    }

    fun digest(sha256: String): String = "sha-256=" + Base64.getEncoder().encodeToString(HexFormat.of().parseHex(sha256))

    fun attachment(fileName: String): String = "attachment; filename=\"${fileName.take(255).map {
        if (it.isISOControl() || it in setOf('/', '\\', '"', ':')) '_' else it
    }.joinToString("").ifBlank { "evidence" }}\""

    private val RANGE = Regex("^bytes=(?:[0-9]{1,16}-[0-9]{0,16}|-[1-9][0-9]{0,15})$")
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
}
