package com.innorder.occ.evidence

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import java.time.Instant
import java.util.UUID

data class EvidenceRequirementPolicy(
    val content: EvidencePolicy,
    val conditionalHardGate: Boolean,
) {
    companion object {
        private val ROOT_FIELDS = setOf(
            "allowedExtensions", "allowedMediaTypes", "maximumBytes", "archive", "conditionalHardGate",
        )
        private val ARCHIVE_FIELDS = setOf(
            "maximumEntries", "maximumExpandedBytes", "maximumCompressionRatio",
        )

        fun parse(schema: JsonNode, catalogMaximumBytes: Long?): EvidenceRequirementPolicy = invalidOnFailure {
            require(schema.isObject && schema.fieldNames().asSequence().toSet() == ROOT_FIELDS)
            val extensions = strings(schema.required("allowedExtensions"))
            val mediaTypes = strings(schema.required("allowedMediaTypes"))
            val maximumBytes = schema.requiredPositiveLong("maximumBytes")
            require(catalogMaximumBytes != null && maximumBytes <= catalogMaximumBytes)
            val archive = schema.required("archive")
            require(archive.isObject && archive.fieldNames().asSequence().toSet() == ARCHIVE_FIELDS)
            val ratio = archive.required("maximumCompressionRatio").also { require(it.isNumber) }.doubleValue()
            val hardGate = schema.required("conditionalHardGate").also { require(it.isBoolean) }.booleanValue()
            EvidenceRequirementPolicy(
                EvidencePolicy(
                    extensions,
                    mediaTypes,
                    maximumBytes,
                    ArchiveLimits(
                        archive.requiredPositiveInt("maximumEntries"),
                        archive.requiredPositiveLong("maximumExpandedBytes"),
                        ratio,
                    ),
                ),
                hardGate,
            )
        }

        private fun strings(node: JsonNode): Set<String> {
            require(node.isArray && node.size() in 1..32 && node.all(JsonNode::isTextual))
            return node.map(JsonNode::textValue).toCollection(linkedSetOf()).also { require(it.size == node.size()) }
        }

        private inline fun <T> invalidOnFailure(block: () -> T): T = try {
            block()
        } catch (_: Exception) {
            throw InvalidEvidenceRequirementException()
        }
    }
}

class InvalidEvidenceRequirementException : RuntimeException("Evidence requirement policy is invalid")

@JsonIgnoreProperties(ignoreUnknown = false)
data class CreateEvidenceSessionRequest(
    val targetEntityId: UUID,
    val requirementId: UUID,
    val slotKey: String,
    val fileName: String,
    val sha256: String,
    val sizeBytes: Long,
    val recipientSelector: String,
)

enum class UploadSessionStatus { CREATED, STREAMING, INSPECTING, SCANNING, PROMOTING, CONFIRMED, FAILED, EXPIRED }
enum class EvidenceState { PENDING, SUBMITTED, ACCEPTED, REJECTED, ARCHIVED }
enum class EvidenceReviewOutcome { ACCEPTED, REJECTED, CONDITIONAL }

data class EvidenceSession(
    val id: UUID,
    val evidenceId: UUID,
    val status: UploadSessionStatus,
    val expiresAt: Instant,
    val expectedEvidenceVersion: Long,
)

data class EvidenceVersion(
    val id: UUID,
    val evidenceId: UUID,
    val version: Int,
    val mediaType: String,
    val sizeBytes: Long,
    val evidenceRowVersion: Long,
)

data class EvidenceMetadata(
    val id: UUID,
    val targetEntityId: UUID,
    val requirementId: UUID,
    val slotKey: String,
    val state: EvidenceState,
    val currentVersion: Int?,
    val rowVersion: Long,
)

@JsonIgnoreProperties(ignoreUnknown = false)
data class EvidenceReviewRequest(
    val outcome: EvidenceReviewOutcome,
    val reason: String,
    val conditions: Map<String, String>,
    val followUpDueAt: Instant?,
    val priorAssigneeId: UUID?,
)

data class EvidenceReviewResult(
    val reviewId: UUID,
    val evidenceId: UUID,
    val evidenceVersion: Int,
    val outcome: EvidenceReviewOutcome,
    val gateSatisfied: Boolean,
    val followUpRequired: Boolean,
    val evidenceRowVersion: Long,
)

data class EvidenceHistoryItem(
    val version: Int,
    val submittedBy: UUID,
    val submittedAt: Instant,
    val mediaType: String,
    val sizeBytes: Long,
    val review: EvidenceReviewHistory?,
)

data class EvidenceReviewHistory(
    val reviewerId: UUID,
    val outcome: EvidenceReviewOutcome,
    val reason: String?,
    val gateSatisfied: Boolean,
    val followUpDueAt: Instant?,
    val reviewedAt: Instant,
)

data class EvidenceHistoryPage(val items: List<EvidenceHistoryItem>, val nextCursor: String?)
data class EvidenceCommandResult<T>(val status: Int, val replayed: Boolean, val body: T)

class EvidenceNotFoundException : RuntimeException("Evidence was not found")
class EvidenceSessionNotFoundException : RuntimeException("Evidence upload session was not found")
class InvalidEvidenceRequestException : RuntimeException("Evidence request is invalid")
class EvidenceStateConflictException : RuntimeException("Evidence state does not allow this operation")
class EvidenceUploadConflictException : RuntimeException("Evidence upload cannot be replayed or reclaimed")
class EvidenceReviewSegregationException : RuntimeException("Reviewer must differ from creator and submitter")

private fun JsonNode.requiredPositiveLong(name: String): Long = required(name).also {
    require(it.isIntegralNumber && it.canConvertToLong() && it.longValue() > 0)
}.longValue()

private fun JsonNode.requiredPositiveInt(name: String): Int = required(name).also {
    require(it.isIntegralNumber && it.canConvertToInt() && it.intValue() > 0)
}.intValue()
