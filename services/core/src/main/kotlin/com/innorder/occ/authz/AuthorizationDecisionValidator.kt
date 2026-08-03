package com.innorder.occ.authz

import com.fasterxml.jackson.databind.JsonNode
import java.util.UUID

class AuthorizationDecisionValidator {
    fun validateRaw(result: JsonNode) {
        if (!result.isObject ||
            result.fieldNames().asSequence().toSet() != OUTPUT_FIELDS ||
            !result.path("contractVersion").isIntegralNumber ||
            !result.path("contractVersion").canConvertToInt() ||
            result.path("contractVersion").intValue() != CONTRACT_VERSION ||
            !result.path("opaRevision").isTextual ||
            result.path("opaRevision").textValue().length > OPA_REVISION_MAX_LENGTH ||
            result.path("opaRevision").textValue().let { it.isNotEmpty() && !OPA_REVISION.matches(it) } ||
            !result.path("requestId").isTextual ||
            !OUTPUT_UUID.matches(result.path("requestId").textValue()) ||
            !result.path("authorizationRevision").isIntegralNumber ||
            !result.path("authorizationRevision").canConvertToLong() ||
            result.path("authorizationRevision").longValue() !in 0..MAX_SAFE_INTEGER ||
            !result.path("decision").isTextual ||
            result.path("decision").textValue() !in setOf("ALLOW", "DENY") ||
            !result.path("allow").isBoolean
        ) fail()
        val releases = result.path("releases")
        if (!releases.isObject || releases.fieldNames().asSequence().any { it !in RELEASE_KEYS }) fail()
        val releaseIds = releases.fields().asSequence().map { (_, value) ->
            if (!value.isTextual || !NON_NIL_UUID.matches(value.textValue())) fail()
            value.textValue().lowercase()
        }.toList()
        if (releaseIds.toSet().size != releaseIds.size) fail()
        validateTextArray(result.path("reasonCodes"), REASON_CODES_MAX)
        validateTextArray(result.path("reasonIds"), REASON_IDS_MAX)
        validateTextArray(result.path("matchedPolicyIds"), MATCHED_IDS_MAX)
    }

    private fun validateTextArray(node: JsonNode, maximum: Int) {
        if (!node.isArray || node.size() > maximum || node.any { !it.isTextual }) fail()
    }

    fun validate(output: AuthorizationDecision) {
        if (output.contractVersion != CONTRACT_VERSION ||
            output.opaRevision.length > OPA_REVISION_MAX_LENGTH ||
            output.opaRevision.let { it.isNotEmpty() && !OPA_REVISION.matches(it) } ||
            output.authorizationRevision !in 0..MAX_SAFE_INTEGER ||
            output.decision == AuthorizationDecisionValue.ERROR ||
            output.allow != (output.decision == AuthorizationDecisionValue.ALLOW) ||
            output.reasonCodes.size > REASON_CODES_MAX ||
            output.reasonIds.size > REASON_IDS_MAX ||
            output.matchedPolicyIds.size > MATCHED_IDS_MAX ||
            output.reasonCodes.any { it !in REASON_CODES } ||
            output.reasonIds.any { !REASON_ID.matches(it) } ||
            output.matchedPolicyIds.any { !GRANT_ID.matches(it) } ||
            !sortedDistinct(output.reasonCodes) ||
            !sortedDistinct(output.reasonIds) ||
            !sortedDistinct(output.matchedPolicyIds) ||
            output.releases.values.toSet().size != output.releases.size ||
            output.releases.values.any { !validUuid(it) }
        ) fail()

        val grantReasonIds = output.reasonIds.filter { it.startsWith("grant:") }
        val policyReasonIds = output.reasonIds.filter { it.startsWith("policy:") }
        if (grantReasonIds != output.matchedPolicyIds) fail()

        if ("INVALID_INPUT" in output.reasonCodes) {
            if (output.opaRevision.isNotEmpty() || output.requestId != NIL_UUID || output.authorizationRevision != 0L || output.releases.isNotEmpty() ||
                output.decision != AuthorizationDecisionValue.DENY || output.allow ||
                output.reasonCodes != listOf("INVALID_INPUT") ||
                output.reasonIds != listOf(POLICY_REASON_IDS.getValue("INVALID_INPUT")) ||
                output.matchedPolicyIds.isNotEmpty()
            ) fail()
            return
        }

        if (output.opaRevision.isEmpty() || !validUuid(output.requestId) || PolicyLayer.PLATFORM !in output.releases) fail()
        when (output.decision) {
            AuthorizationDecisionValue.ALLOW -> validateAllow(output, policyReasonIds)
            AuthorizationDecisionValue.DENY -> validateDeny(output, policyReasonIds)
            AuthorizationDecisionValue.ERROR -> fail()
        }
    }

    private fun validateAllow(output: AuthorizationDecision, policyReasonIds: List<String>) {
        if (output.reasonCodes != listOf("ALLOW_GRANT_MATCH") ||
            output.matchedPolicyIds.isEmpty() || policyReasonIds.isNotEmpty()
        ) fail()
    }

    private fun validateDeny(output: AuthorizationDecision, policyReasonIds: List<String>) {
        if ("NO_MATCHING_ALLOW" in output.reasonCodes) {
            if (output.reasonCodes != listOf("NO_MATCHING_ALLOW") ||
                output.matchedPolicyIds.isNotEmpty() ||
                policyReasonIds != listOf(POLICY_REASON_IDS.getValue("NO_MATCHING_ALLOW"))
            ) fail()
            return
        }

        val hasExplicitDeny = "EXPLICIT_DENY" in output.reasonCodes
        val baselineCodes = BASELINE_CODES.filter { it in output.reasonCodes }
        if (output.reasonCodes.any { it != "EXPLICIT_DENY" && it !in BASELINE_CODES } ||
            !hasExplicitDeny && baselineCodes.isEmpty() ||
            hasExplicitDeny && output.matchedPolicyIds.isEmpty()
        ) fail()
        val expectedPolicyIds = baselineCodes.map(POLICY_REASON_IDS::getValue).sorted()
        if (policyReasonIds != expectedPolicyIds) fail()
    }

    private fun sortedDistinct(values: List<String>): Boolean =
        values.indices.all { index -> index == 0 || values[index - 1] < values[index] }

    private fun validUuid(value: UUID): Boolean = value != NIL_UUID && value.version() in 1..8 && value.variant() == 2

    private fun fail(): Nothing = throw OpaClientException()

    companion object {
        const val CONTRACT_VERSION = 2
        const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        const val REASON_CODES_MAX = 7
        const val REASON_IDS_MAX = 260
        const val MATCHED_IDS_MAX = 256
        const val OPA_REVISION_MAX_LENGTH = 256
        val NIL_UUID: UUID = UUID(0, 0)

        val REASON_CODES = setOf(
            "INVALID_INPUT",
            "PRINCIPAL_DISABLED",
            "RESOURCE_INACTIVE",
            "ACTION_FORBIDDEN",
            "EXPLICIT_DENY",
            "ALLOW_GRANT_MATCH",
            "NO_MATCHING_ALLOW",
        )
        val BASELINE_CODES = listOf("PRINCIPAL_DISABLED", "RESOURCE_INACTIVE", "ACTION_FORBIDDEN")
        val POLICY_REASON_IDS = mapOf(
            "INVALID_INPUT" to "policy:318efe2bf46c41026f67dbd60026ad3a8056a0a70c468cd38210021dee7de176",
            "PRINCIPAL_DISABLED" to "policy:8941407440a3ec32c44afbc4ab1fb183748dbf7388cf926f594486cc1f8386a3",
            "RESOURCE_INACTIVE" to "policy:78a11476cd4e8cb5ba4afa073e8195510016228408013d8f27bfaafafad47876",
            "ACTION_FORBIDDEN" to "policy:105106f1faa19167cdeb0d067dd88443f361b15f20e14424553e14b7ea7e1a5f",
            "NO_MATCHING_ALLOW" to "policy:7ec3d68be5ac070a6d48cb53daaf85bf7b4d76d09985923af422194f7735ab7b",
        )

        private val REASON_ID = Regex("^(grant|policy):[0-9a-f]{64}${'$'}")
        private val GRANT_ID = Regex("^grant:[0-9a-f]{64}${'$'}")
        private val OPA_REVISION = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]*${'$'}")
        private val NON_NIL_UUID = Regex(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}${'$'}",
        )
        private val OUTPUT_UUID = Regex(
            "^(00000000-0000-0000-0000-000000000000|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})${'$'}",
        )
        private val RELEASE_KEYS = setOf("PLATFORM", "DOMAIN", "CUSTOMER")
        private val OUTPUT_FIELDS = setOf(
            "contractVersion", "opaRevision", "requestId", "authorizationRevision", "releases", "decision", "allow",
            "reasonCodes", "reasonIds", "matchedPolicyIds",
        )
    }
}
