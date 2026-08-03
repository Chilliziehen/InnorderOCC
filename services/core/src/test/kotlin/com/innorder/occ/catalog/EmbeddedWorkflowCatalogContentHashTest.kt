package com.innorder.occ.catalog

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class EmbeddedWorkflowCatalogContentHashTest {
    @Test
    fun `production semantic catalog has a stable golden hash`() {
        assertThat(EmbeddedWorkflowCatalogContentHash.contentHash())
            .isEqualTo("0eb199a63dab8fc33334ae0721db16f8cbd42e849a4a5851111575ad4214f05b")
    }

    @Test
    fun `canonical hash is independent of map insertion order`() {
        val first = linkedMapOf(
            "status" to "PUBLISHED",
            "manifest" to linkedMapOf("version" to 1, "catalog" to "embedded-workflow"),
        )
        val second = linkedMapOf(
            "manifest" to linkedMapOf("catalog" to "embedded-workflow", "version" to 1),
            "status" to "PUBLISHED",
        )

        assertThat(EmbeddedWorkflowCatalogContentHash.hash(first))
            .isEqualTo(EmbeddedWorkflowCatalogContentHash.hash(second))
    }

    @Test
    fun `changing a persisted semantic field changes the hash`() {
        val baseline = linkedMapOf(
            "cardinality" to "ONE_TO_MANY",
            "acyclic" to false,
            "authRelevant" to true,
        )
        val changed = LinkedHashMap(baseline).also { it["authRelevant"] = false }

        assertThat(EmbeddedWorkflowCatalogContentHash.hash(changed))
            .isNotEqualTo(EmbeddedWorkflowCatalogContentHash.hash(baseline))
    }
}
