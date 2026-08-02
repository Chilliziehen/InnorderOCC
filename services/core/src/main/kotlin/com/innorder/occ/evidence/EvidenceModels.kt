package com.innorder.occ.evidence

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.databind.JsonNode
import java.time.Instant
import java.util.UUID

data class EvidenceRequirementPolicy(
    val content: EvidencePolicy,
    val minimumCount: Int,
    val hardGate: Boolean,
    val conditionalAdvancement: Boolean,
    val conditionalFollowUpHours: Int,
) {
    companion object {
        const val MAXIMUM_BYTES = 100L * 1024 * 1024
        private val ROOT_FIELDS = setOf(
            "allowedExtensions", "allowedMediaTypes", "maximumBytes", "minimumCount", "hardGate",
            "conditionalAdvancement", "conditionalFollowUpHours", "archive",
        )
        private val ARCHIVE_FIELDS = setOf("maximumEntries", "maximumExpandedBytes", "maximumCompressionRatio")

        fun parse(schema: JsonNode): EvidenceRequirementPolicy = invalidOnFailure {
            require(schema.isObject && schema.fieldNames().asSequence().toSet() == ROOT_FIELDS)
            val extensions = strings(schema.required("allowedExtensions")) {
                EXTENSION.matches(it)
            }
            val mediaTypes = strings(schema.required("allowedMediaTypes")) {
                it.length in 1..128 && it == it.trim() && it.none(Char::isISOControl)
            }
            val maximumBytes = schema.requiredPositiveLong("maximumBytes").also { require(it <= MAXIMUM_BYTES) }
            val minimumCount = schema.requiredPositiveInt("minimumCount").also { require(it <= 100) }
            val hardGate = schema.requiredBoolean("hardGate")
            val conditionalAdvancement = schema.requiredBoolean("conditionalAdvancement")
            val followUpHours = schema.requiredPositiveInt("conditionalFollowUpHours").also { require(it <= 8760) }
            val archive = schema.required("archive")
            require(archive.isObject && archive.fieldNames().asSequence().toSet() == ARCHIVE_FIELDS)
            val entries = archive.requiredPositiveInt("maximumEntries").also { require(it <= 1000) }
            val expanded = archive.requiredPositiveLong("maximumExpandedBytes").also { require(it <= MAXIMUM_BYTES * 2) }
            val ratio = archive.required("maximumCompressionRatio").also { require(it.isNumber) }.doubleValue()
                .also { require(it.isFinite() && it > 0.0 && it <= 100.0) }
            EvidenceRequirementPolicy(
                EvidencePolicy(extensions, mediaTypes, maximumBytes, ArchiveLimits(entries, expanded, ratio)),
                minimumCount, hardGate, conditionalAdvancement, followUpHours,
            )
        }

        private fun strings(node: JsonNode, valid: (String) -> Boolean): Set<String> {
            require(node.isArray && node.size() in 1..32 && node.all(JsonNode::isTextual))
            return node.map(JsonNode::textValue).also { require(it.all(valid)) }
                .toCollection(linkedSetOf()).also { require(it.size == node.size()) }
        }

        private val EXTENSION = Regex("^[a-z0-9][a-z0-9._-]{0,31}$")

        private inline fun <T> invalidOnFailure(block: () -> T): T = try {
            block()
        } catch (_: Exception) {
            throw InvalidEvidenceRequirementException()
        }
    }
}

data class EvidenceRequirement(
    val id: UUID,
    val code: String,
    val allowedExtensions: List<String>,
    val allowedMediaTypes: List<String>,
    val maximumBytes: Long,
    val minimumCount: Int,
    val hardGate: Boolean,
    val conditionalAdvancement: Boolean,
    val conditionalFollowUpHours: Int,
    val archive: EvidenceArchivePolicy,
)

data class EvidenceArchivePolicy(
    val maximumEntries: Int,
    val maximumExpandedBytes: Long,
    val maximumCompressionRatio: Double,
)

data class EvidenceRequirementPage(
    val items: List<EvidenceRequirement>,
    val nextCursor: String? = null,
    val previousCursor: String? = null,
)

@JsonIgnoreProperties(ignoreUnknown = false)
data class CreateEvidenceSessionRequest(
    val requirementId: UUID,
    val targetEntityId: UUID,
    val evidenceId: UUID? = null,
    val slotKey: String,
    val extension: String,
    val expectedSha256: String,
    val expectedSizeBytes: Long,
)

enum class UploadSessionStatus { CREATED, UPLOADED, STREAMING, INSPECTING, SCANNING, PROMOTING, CONFIRMED, FAILED, EXPIRED }
enum class EvidenceState { PENDING, SUBMITTED, ACCEPTED, REJECTED, ARCHIVED }
enum class EvidenceReviewOutcome { ACCEPTED, REJECTED, CONDITIONAL }

@JsonInclude(JsonInclude.Include.NON_NULL)
data class EvidenceSession(
    val id: UUID,
    val evidenceId: UUID,
    val status: UploadSessionStatus,
    val expectedSha256: String,
    val expectedSizeBytes: Long,
    val actualSha256: String? = null,
    val actualSizeBytes: Long? = null,
    val detectedMediaType: String? = null,
    val failureCode: String? = null,
    val createdAt: Instant,
    val expiresAt: Instant,
    val version: Long,
)

sealed interface EvidenceContentResult {
    val uploadSessionId: UUID
    val evidenceId: UUID
    val status: UploadSessionStatus
    val version: Long
}

data class ConfirmedEvidenceContentResult(
    override val uploadSessionId: UUID,
    override val evidenceId: UUID,
    override val status: UploadSessionStatus = UploadSessionStatus.CONFIRMED,
    val sha256: String,
    val sizeBytes: Long,
    val detectedMediaType: String,
    val evidenceVersion: Int,
    override val version: Long,
) : EvidenceContentResult

data class FailedEvidenceContentResult(
    override val uploadSessionId: UUID,
    override val evidenceId: UUID,
    override val status: UploadSessionStatus = UploadSessionStatus.FAILED,
    val failureCode: String,
    override val version: Long,
) : EvidenceContentResult

data class EvidenceMetadata(
    val id: UUID,
    val requirementId: UUID,
    val targetEntityId: UUID,
    val slotKey: String,
    val state: EvidenceState,
    val currentVersion: Int? = null,
    val version: Long,
    val createdAt: Instant,
    val updatedAt: Instant,
)

@JsonIgnoreProperties(ignoreUnknown = false)
data class SubmitEvidenceRequest(val evidenceVersion: Int)

data class EvidenceReviewCondition(val code: String, val detail: String)

@JsonIgnoreProperties(ignoreUnknown = false)
data class EvidenceReviewRequest(
    val evidenceVersion: Int,
    val decision: EvidenceReviewOutcome,
    val reason: String,
    val conditions: List<EvidenceReviewCondition>? = null,
)

data class EvidenceVersion(
    val id: UUID,
    val evidenceId: UUID,
    val version: Int,
    val uploadSessionId: UUID,
    val sha256: String,
    val mediaType: String,
    val extension: String,
    val sizeBytes: Long,
    val submittedAt: Instant,
)

data class EvidenceReview(
    val id: UUID,
    val evidenceId: UUID,
    val evidenceVersion: Int,
    val decision: EvidenceReviewOutcome,
    val reason: String,
    val conditions: List<EvidenceReviewCondition>,
    val followUpDueAt: Instant? = null,
    val gateSatisfied: Boolean,
    val reviewedAt: Instant,
)

data class EvidenceVersionPage(
    val items: List<EvidenceVersion>,
    val nextCursor: String? = null,
    val previousCursor: String? = null,
)

data class EvidenceReviewPage(
    val items: List<EvidenceReview>,
    val nextCursor: String? = null,
    val previousCursor: String? = null,
)

data class EvidencePreviewMetadata(
    val evidenceId: UUID,
    val evidenceVersion: Int,
    val mediaType: String,
    val sizeBytes: Long,
    val generatedAt: Instant,
)

data class EvidenceDownloadMetadata(
    val evidenceId: UUID,
    val evidenceVersion: Int,
    val filename: String,
    val mediaType: String,
    val sizeBytes: Long,
    val sha256: String,
    val disposition: String = "attachment",
)

data class EvidenceCommandResult<T>(val status: Int, val replayed: Boolean, val body: T)

class InvalidEvidenceRequirementException : RuntimeException("Evidence requirement policy is invalid")
class EvidenceNotFoundException : RuntimeException("Evidence was not found")
class EvidenceSessionNotFoundException : RuntimeException("Evidence upload session was not found")
open class InvalidEvidenceRequestException : RuntimeException("Evidence request is invalid")
class EvidenceTooLargeException : InvalidEvidenceRequestException()
class EvidenceDigestMismatchException : InvalidEvidenceRequestException()
class EvidenceInvalidContentException : InvalidEvidenceRequestException()
class EvidenceInvalidRangeException(val completeLength: Long) : InvalidEvidenceRequestException()
class EvidenceStateConflictException : RuntimeException("Evidence state does not allow this operation")
class EvidenceUploadConflictException : RuntimeException("Evidence upload cannot be replayed or reclaimed")
class EvidenceSubmitConflictException : RuntimeException("Evidence cannot be submitted in its current state")
class EvidenceReviewConflictException : RuntimeException("Evidence cannot be reviewed in its current state")
class EvidenceReviewSegregationException : RuntimeException("Reviewer must differ from creator and submitter")

private fun JsonNode.requiredPositiveLong(name: String): Long = required(name).also {
    require(it.isIntegralNumber && it.canConvertToLong() && it.longValue() > 0)
}.longValue()

private fun JsonNode.requiredPositiveInt(name: String): Int = required(name).also {
    require(it.isIntegralNumber && it.canConvertToInt() && it.intValue() > 0)
}.intValue()

private fun JsonNode.requiredBoolean(name: String): Boolean = required(name).also { require(it.isBoolean) }.booleanValue()
