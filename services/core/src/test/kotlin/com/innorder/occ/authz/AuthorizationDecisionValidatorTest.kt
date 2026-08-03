package com.innorder.occ.authz

import org.assertj.core.api.Assertions.assertThatCode
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.util.UUID

class AuthorizationDecisionValidatorTest {
    private val validator = AuthorizationDecisionValidator()

    @Test
    fun `accepts exact allow deny baseline and canonical invalid envelopes`() {
        listOf(
            allow(),
            deny(
                reasonCodes = listOf("EXPLICIT_DENY", "PRINCIPAL_DISABLED"),
                reasonIds = listOf(GRANT_A, PRINCIPAL_DISABLED_POLICY).sorted(),
                matched = listOf(GRANT_A),
            ),
            deny(
                reasonCodes = listOf("ACTION_FORBIDDEN", "RESOURCE_INACTIVE"),
                reasonIds = listOf(ACTION_FORBIDDEN_POLICY, RESOURCE_INACTIVE_POLICY).sorted(),
            ),
            deny(
                reasonCodes = listOf("NO_MATCHING_ALLOW"),
                reasonIds = listOf(NO_MATCHING_ALLOW_POLICY),
            ),
            AuthorizationDecision(
                2,
                "",
                UUID(0, 0),
                0,
                emptyMap(),
                AuthorizationDecisionValue.DENY,
                false,
                listOf("INVALID_INPUT"),
                listOf(INVALID_INPUT_POLICY),
                emptyList(),
            ),
        ).forEach { decision -> assertThatCode { validator.validate(decision) }.doesNotThrowAnyException() }
    }

    @Test
    fun `rejects adversarial malformed allow envelopes`() {
        listOf(
            allow().copy(reasonCodes = emptyList()),
            allow().copy(reasonCodes = listOf("ALLOW_GRANT_MATCH", "EXPLICIT_DENY")),
            allow().copy(reasonCodes = listOf("UNKNOWN_REASON")),
            allow().copy(reasonIds = listOf(PRINCIPAL_DISABLED_POLICY, GRANT_A).sorted()),
            allow().copy(reasonIds = listOf(GRANT_B), matchedPolicyIds = listOf(GRANT_A)),
            allow().copy(reasonIds = emptyList()),
            allow().copy(matchedPolicyIds = emptyList()),
            allow().copy(reasonIds = listOf(GRANT_A, GRANT_A), matchedPolicyIds = listOf(GRANT_A)),
            allow().copy(reasonIds = listOf(GRANT_B, GRANT_A), matchedPolicyIds = listOf(GRANT_A, GRANT_B)),
            allow().copy(decision = AuthorizationDecisionValue.DENY),
            allow().copy(allow = false),
            allow().copy(requestId = UUID(0, 0)),
            allow().copy(opaRevision = ""),
            allow().copy(opaRevision = "bad revision"),
            allow().copy(opaRevision = "x".repeat(257)),
            allow().copy(authorizationRevision = 9_007_199_254_740_992L),
            allow().copy(releases = emptyMap()),
            allow().copy(releases = mapOf(PolicyLayer.DOMAIN to DOMAIN_RELEASE)),
            allow().copy(releases = mapOf(
                PolicyLayer.PLATFORM to PLATFORM_RELEASE,
                PolicyLayer.DOMAIN to PLATFORM_RELEASE,
            )),
        ).forEach { decision ->
            assertThatThrownBy { validator.validate(decision) }
                .isInstanceOf(OpaClientException::class.java)
                .hasMessage("Policy decision service is unavailable")
        }
    }

    @Test
    fun `rejects malformed deny and invalid-input envelopes`() {
        listOf(
            deny(reasonCodes = emptyList(), reasonIds = emptyList()),
            deny(reasonCodes = listOf("ALLOW_GRANT_MATCH"), reasonIds = emptyList()),
            deny(reasonCodes = listOf("EXPLICIT_DENY"), reasonIds = emptyList()),
            deny(reasonCodes = listOf("EXPLICIT_DENY"), reasonIds = listOf(GRANT_A), matched = emptyList()),
            deny(reasonCodes = listOf("PRINCIPAL_DISABLED"), reasonIds = emptyList()),
            deny(reasonCodes = listOf("PRINCIPAL_DISABLED"), reasonIds = listOf(RESOURCE_INACTIVE_POLICY)),
            deny(reasonCodes = listOf("NO_MATCHING_ALLOW", "PRINCIPAL_DISABLED"), reasonIds = listOf(NO_MATCHING_ALLOW_POLICY)),
            deny(reasonCodes = listOf("NO_MATCHING_ALLOW"), reasonIds = listOf(NO_MATCHING_ALLOW_POLICY, GRANT_A), matched = listOf(GRANT_A)),
            deny(reasonCodes = listOf("INVALID_INPUT"), reasonIds = listOf(INVALID_INPUT_POLICY)),
            canonicalInvalid().copy(requestId = REQUEST_ID),
            canonicalInvalid().copy(opaRevision = "platform-authz-v1"),
            canonicalInvalid().copy(authorizationRevision = 1),
            canonicalInvalid().copy(releases = mapOf(PolicyLayer.PLATFORM to PLATFORM_RELEASE)),
            canonicalInvalid().copy(reasonIds = emptyList()),
        ).forEach { decision -> assertThatThrownBy { validator.validate(decision) }
            .isInstanceOf(OpaClientException::class.java) }
    }

    private fun allow() = AuthorizationDecision(
        2,
        "platform-authz-v2",
        REQUEST_ID,
        17,
        mapOf(PolicyLayer.PLATFORM to PLATFORM_RELEASE),
        AuthorizationDecisionValue.ALLOW,
        true,
        listOf("ALLOW_GRANT_MATCH"),
        listOf(GRANT_A),
        listOf(GRANT_A),
    )

    private fun deny(
        reasonCodes: List<String>,
        reasonIds: List<String>,
        matched: List<String> = emptyList(),
    ) = allow().copy(
        decision = AuthorizationDecisionValue.DENY,
        allow = false,
        reasonCodes = reasonCodes,
        reasonIds = reasonIds,
        matchedPolicyIds = matched,
    )

    private fun canonicalInvalid() = AuthorizationDecision(
        2, "", UUID(0, 0), 0, emptyMap(), AuthorizationDecisionValue.DENY, false,
        listOf("INVALID_INPUT"), listOf(INVALID_INPUT_POLICY), emptyList(),
    )

    companion object {
        private val REQUEST_ID = UUID.fromString("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
        private val PLATFORM_RELEASE = UUID.fromString("550e8400-e29b-41d4-a716-446655440000")
        private val DOMAIN_RELEASE = UUID.fromString("6ba7b810-9dad-41d1-80b4-00c04fd430c8")
        private const val GRANT_A = "grant:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        private const val GRANT_B = "grant:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        private const val INVALID_INPUT_POLICY = "policy:318efe2bf46c41026f67dbd60026ad3a8056a0a70c468cd38210021dee7de176"
        private const val PRINCIPAL_DISABLED_POLICY = "policy:8941407440a3ec32c44afbc4ab1fb183748dbf7388cf926f594486cc1f8386a3"
        private const val RESOURCE_INACTIVE_POLICY = "policy:78a11476cd4e8cb5ba4afa073e8195510016228408013d8f27bfaafafad47876"
        private const val ACTION_FORBIDDEN_POLICY = "policy:105106f1faa19167cdeb0d067dd88443f361b15f20e14424553e14b7ea7e1a5f"
        private const val NO_MATCHING_ALLOW_POLICY = "policy:7ec3d68be5ac070a6d48cb53daaf85bf7b4d76d09985923af422194f7735ab7b"
    }
}
