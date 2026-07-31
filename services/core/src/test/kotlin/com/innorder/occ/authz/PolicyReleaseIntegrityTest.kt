package com.innorder.occ.authz

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.util.UUID

class PolicyReleaseIntegrityTest {
    @Test
    fun `canonical release hash binds revision and sorted exact release items`() {
        val item = PolicyReleaseItemIntegrity(
            PolicyLayer.PLATFORM,
            UUID.fromString("00000000-0000-7000-8000-000000000030"),
            UUID.fromString("00000000-0000-7000-8000-000000000031"),
            "c6ecc47c163e9ac50f2f23efedf7e93cddae7dbb3e5e3792eb5a7cb2b0e2c246",
        )

        assertThat(PolicyReleaseIntegrity.contentHash("platform-authz-v1", listOf(item)))
            .isEqualTo("8665c69d1d8ca3c0e5f71854d10f1d466c94cc3aae6ee919881e23c63bd45fdf")
        assertThat(PolicyReleaseIntegrity.canonicalJson("platform-authz-v1", listOf(item)))
            .isEqualTo(
                """{"opaRevision":"platform-authz-v1","releaseItems":[{"bundleContentHash":"c6ecc47c163e9ac50f2f23efedf7e93cddae7dbb3e5e3792eb5a7cb2b0e2c246","bundleId":"00000000-0000-7000-8000-000000000030","bundleVersionId":"00000000-0000-7000-8000-000000000031","layer":"PLATFORM"}]}""",
            )
    }

    @Test
    fun `canonical release hash is independent of input item order`() {
        val platform = PolicyReleaseItemIntegrity(
            PolicyLayer.PLATFORM,
            UUID.fromString("00000000-0000-7000-8000-000000000030"),
            UUID.fromString("00000000-0000-7000-8000-000000000031"),
            "a".repeat(64),
        )
        val domain = PolicyReleaseItemIntegrity(
            PolicyLayer.DOMAIN,
            UUID.fromString("00000000-0000-7000-8000-000000000040"),
            UUID.fromString("00000000-0000-7000-8000-000000000041"),
            "b".repeat(64),
        )

        assertThat(PolicyReleaseIntegrity.contentHash("revision", listOf(platform, domain)))
            .isEqualTo(PolicyReleaseIntegrity.contentHash("revision", listOf(domain, platform)))
    }
}
