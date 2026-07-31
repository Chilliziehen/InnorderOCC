package com.innorder.occ.authz

import com.fasterxml.jackson.annotation.JsonIgnore
import java.time.OffsetDateTime
import java.util.UUID

enum class PolicyLayer { PLATFORM, DOMAIN, CUSTOMER }
enum class GrantEffect { ALLOW, DENY }
enum class AuthorizationDecisionValue { ALLOW, DENY, ERROR }

data class AuthorizationRequest(
    val requestId: UUID,
    val principalId: UUID,
    val action: String,
    val entityId: UUID,
    val resourceId: UUID,
    val context: Map<String, Any?> = emptyMap(),
    val correlationId: UUID = requestId,
)

data class AuthorizationPrincipal(val id: UUID, val enabled: Boolean)
data class AuthorizationEntity(val id: UUID)
data class AuthorizationResource(val id: UUID, val active: Boolean)

data class AuthorizationGrant(
    val id: String,
    val layer: PolicyLayer,
    val releaseId: UUID,
    val effect: GrantEffect,
    val action: String,
    val principalId: String,
    val entityId: String,
    val resourceId: String,
)

data class AuthorizationSnapshot(
    val contractVersion: Int,
    val requestId: UUID,
    val authorizationRevision: Long,
    val releases: Map<PolicyLayer, UUID>,
    val principal: AuthorizationPrincipal,
    val entity: AuthorizationEntity,
    val action: String,
    val resource: AuthorizationResource,
    val context: Map<String, Any?>,
    val forbiddenActions: List<String>,
    val grants: List<AuthorizationGrant>,
    @get:JsonIgnore val composedReleaseId: UUID,
    val opaRevision: String,
    @get:JsonIgnore val entityVersions: Map<UUID, Long>,
    @get:JsonIgnore val contextDigest: String,
    @get:JsonIgnore val snapshotAt: OffsetDateTime? = null,
    @get:JsonIgnore val principalRowVersion: Long = 0,
)

data class AuthorizationDecision(
    val contractVersion: Int,
    val opaRevision: String,
    val requestId: UUID,
    val authorizationRevision: Long,
    val releases: Map<PolicyLayer, UUID>,
    val decision: AuthorizationDecisionValue,
    val allow: Boolean,
    val reasonCodes: List<String>,
    val reasonIds: List<String>,
    val matchedPolicyIds: List<String>,
)

data class AuthorizationDecisionReference(
    val requestId: UUID,
    val authorizationRevision: Long,
    val releases: Map<PolicyLayer, UUID>,
    val matchedPolicyIds: List<String>,
)

data class DecisionLogEntry(
    val id: UUID,
    val requestId: UUID,
    val correlationId: UUID,
    val policyReleaseId: UUID,
    val authorizationRevision: Long,
    val principalEntityId: UUID,
    val action: String,
    val resourceEntityId: UUID?,
    val decision: AuthorizationDecisionValue,
    val reasonCodes: List<String>,
    val matchedPolicyIds: List<String>,
    val entityVersions: Map<UUID, Long>,
    val contextDigest: String,
    val resultDigest: String,
    val latencyMs: Int,
)

fun interface AuthorizationSnapshotSource {
    fun load(request: AuthorizationRequest): AuthorizationSnapshot
}

fun interface PolicyDecisionClient {
    fun decide(snapshot: AuthorizationSnapshot): AuthorizationDecision
}

interface DecisionAuditLog {
    fun persistInCallerTransaction(entry: DecisionLogEntry)
    fun persistIndependently(entry: DecisionLogEntry)
}

class AuthorizationDeniedException : RuntimeException("Authorization denied")
class AuthorizationAvailabilityException : RuntimeException("Authorization is unavailable")
class AuthorizationSnapshotException : RuntimeException("Authorization snapshot is invalid")
class OpaClientException : RuntimeException("Policy decision service is unavailable")
