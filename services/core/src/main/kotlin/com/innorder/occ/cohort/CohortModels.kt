package com.innorder.occ.cohort

import com.fasterxml.jackson.annotation.JsonAnySetter
import com.fasterxml.jackson.annotation.JsonIgnore
import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonSetter
import jakarta.validation.constraints.AssertTrue
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

enum class CohortStatus { DRAFT, ACTIVE, ARCHIVED }
enum class CohortMemberRole { OWNER, TEACHER, PARTICIPANT }

@JsonIgnoreProperties(ignoreUnknown = false)
data class CreateCohortRequest(
    @field:NotBlank
    @field:Size(max = 64)
    @field:Pattern(regexp = "^[a-z0-9]+(?:-[a-z0-9]+)*${'$'}")
    val code: String,
    @field:NotBlank
    @field:Size(max = 256)
    val name: String,
    val packageVersionId: UUID,
    val ownerPrincipalId: UUID,
    val startDate: LocalDate,
    val endDate: LocalDate? = null,
) {
    @get:AssertTrue(message = "endDate must not precede startDate")
    @get:JsonIgnore
    val dateRangeValid: Boolean get() = endDate == null || !endDate.isBefore(startDate)

    @JsonAnySetter
    fun rejectUnknown(name: String, value: Any?): Nothing = throw IllegalArgumentException("Unknown request field")
}

@JsonIgnoreProperties(ignoreUnknown = false)
class UpdateCohortRequest(
    @field:Min(0)
    @field:Max(9_007_199_254_740_991)
    var expectedVersion: Long = -1,
    @field:Size(min = 1, max = 256)
    var name: String? = null,
    var startDate: LocalDate? = null,
) {
    var endDate: LocalDate? = null
        private set

    @get:JsonIgnore
    var endDateSpecified: Boolean = false
        private set

    @JsonSetter("endDate")
    fun assignEndDate(value: LocalDate?) {
        endDate = value
        endDateSpecified = true
    }

    @get:AssertTrue(message = "at least one mutable field is required")
    @get:JsonIgnore
    val hasMutation: Boolean get() = name != null || startDate != null || endDateSpecified

    @get:AssertTrue(message = "endDate must not precede startDate")
    @get:JsonIgnore
    val suppliedDateRangeValid: Boolean get() = startDate == null || !endDateSpecified || endDate == null || !endDate!!.isBefore(startDate)

    @JsonAnySetter
    fun rejectUnknown(name: String, value: Any?): Nothing = throw IllegalArgumentException("Unknown request field")
}

@JsonIgnoreProperties(ignoreUnknown = false)
data class AddCohortMemberRequest(
    @field:Min(0) @field:Max(9_007_199_254_740_991) val expectedVersion: Long,
    val principalId: UUID,
    val role: CohortMemberRole,
    val validUntil: Instant? = null,
) {
    @get:AssertTrue(message = "role must be TEACHER or PARTICIPANT")
    @get:JsonIgnore
    val roleValid: Boolean get() = role != CohortMemberRole.OWNER

    @JsonAnySetter
    fun rejectUnknown(name: String, value: Any?): Nothing = throw IllegalArgumentException("Unknown request field")
}

@JsonIgnoreProperties(ignoreUnknown = false)
data class RemoveCohortMemberRequest(
    @field:Min(0) @field:Max(9_007_199_254_740_991) val expectedVersion: Long,
    val principalId: UUID,
    val role: CohortMemberRole,
) {
    @get:AssertTrue(message = "role must be TEACHER or PARTICIPANT")
    @get:JsonIgnore
    val roleValid: Boolean get() = role != CohortMemberRole.OWNER

    @JsonAnySetter
    fun rejectUnknown(name: String, value: Any?): Nothing = throw IllegalArgumentException("Unknown request field")
}

@JsonIgnoreProperties(ignoreUnknown = false)
data class TransferCohortOwnerRequest(
    @field:Min(0) @field:Max(9_007_199_254_740_991) val expectedVersion: Long,
    val ownerPrincipalId: UUID,
    @field:NotBlank @field:Size(max = 1024) val reason: String,
) {
    @JsonAnySetter
    fun rejectUnknown(name: String, value: Any?): Nothing = throw IllegalArgumentException("Unknown request field")
}

@JsonIgnoreProperties(ignoreUnknown = false)
data class ArchiveCohortRequest(
    @field:Min(0) @field:Max(9_007_199_254_740_991) val expectedVersion: Long,
    @field:NotBlank @field:Size(max = 1024) val reason: String,
) {
    @JsonAnySetter
    fun rejectUnknown(name: String, value: Any?): Nothing = throw IllegalArgumentException("Unknown request field")
}

data class CohortMember(
    val principalId: UUID,
    val role: CohortMemberRole,
    val validFrom: Instant,
    @get:JsonInclude(JsonInclude.Include.NON_NULL) val validUntil: Instant?,
)

data class CohortSummary(
    val id: UUID,
    val code: String,
    val name: String,
    val packageVersionId: UUID,
    val ownerPrincipalId: UUID,
    val startDate: LocalDate,
    val endDate: LocalDate?,
    val status: CohortStatus,
    val version: Long,
    val createdAt: Instant,
    val updatedAt: Instant,
)

data class CohortDetail(
    val id: UUID,
    val code: String,
    val name: String,
    val packageVersionId: UUID,
    val ownerPrincipalId: UUID,
    val startDate: LocalDate,
    val endDate: LocalDate?,
    val status: CohortStatus,
    val version: Long,
    val createdAt: Instant,
    val updatedAt: Instant,
    val members: List<CohortMember>,
)

data class CursorPageInfo(@get:JsonInclude(JsonInclude.Include.NON_NULL) val nextCursor: String? = null)
data class CohortPage(val items: List<CohortSummary>, val page: CursorPageInfo)

data class ParticipantProcessStart(
    val cohortId: UUID,
    val participantId: UUID,
    val actorId: UUID,
    val idempotencyKey: String,
    val expectedCohortVersion: Long,
    val correlationId: UUID,
)

data class ParticipantProcessStartResult(
    val processId: UUID,
    val cohortId: UUID,
    val participantId: UUID,
    val version: Long,
    val replayed: Boolean,
)

fun interface ParticipantProcessStarter {
    fun start(request: ParticipantProcessStart): ParticipantProcessStartResult
}
