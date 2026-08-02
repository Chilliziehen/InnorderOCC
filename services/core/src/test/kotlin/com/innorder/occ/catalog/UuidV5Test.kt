package com.innorder.occ.catalog

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.util.UUID

class UuidV5Test {
    @Test
    fun `matches the RFC 4122 DNS SHA-1 standard vector`() {
        assertThat(UuidV5.from(DNS_NAMESPACE, "www.widgets.com"))
            .isEqualTo(UUID.fromString("21f7f8de-8051-5b89-8680-0195ef798b6a"))
    }

    @Test
    fun `normalizes names before deriving stable identifiers`() {
        val canonical = UuidV5.from(DNS_NAMESPACE, "workflow.catalog")

        assertThat(UuidV5.from(DNS_NAMESPACE, "  WORKFLOW.CATALOG  ")).isEqualTo(canonical)
        assertThat(UuidV5.from(DNS_NAMESPACE, "workflow.catalog")).isEqualTo(canonical)
    }

    @Test
    fun `different normalized names derive different version five identifiers`() {
        val first = UuidV5.from(DNS_NAMESPACE, "entity-type:cohort")
        val second = UuidV5.from(DNS_NAMESPACE, "entity-type:task")

        assertThat(first).isNotEqualTo(second)
        assertThat(first.version()).isEqualTo(5)
        assertThat(first.variant()).isEqualTo(2)
    }

    companion object {
        private val DNS_NAMESPACE = UUID.fromString("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
    }
}
