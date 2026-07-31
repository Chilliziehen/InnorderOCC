package com.innorder.occ.authz

import com.fasterxml.jackson.databind.ObjectMapper
import java.security.MessageDigest
import java.util.UUID

data class PolicyReleaseItemIntegrity(
    val layer: PolicyLayer,
    val bundleId: UUID,
    val bundleVersionId: UUID,
    val bundleContentHash: String,
)

object PolicyReleaseIntegrity {
    private val mapper = ObjectMapper()

    fun contentHash(opaRevision: String, items: List<PolicyReleaseItemIntegrity>): String =
        MessageDigest.getInstance("SHA-256")
            .digest(canonicalJson(opaRevision, items).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    fun canonicalJson(opaRevision: String, items: List<PolicyReleaseItemIntegrity>): String {
        require(opaRevision.isNotBlank() && opaRevision.length <= 256)
        require(items.isNotEmpty() && items.size <= PolicyLayer.entries.size)
        require(items.map { it.layer }.toSet().size == items.size)
        require(items.all { HASH.matches(it.bundleContentHash) })
        val sortedItems = items.sortedWith(
            compareBy<PolicyReleaseItemIntegrity>({ it.layer.name }, { it.bundleId.toString() }, { it.bundleVersionId.toString() }),
        )
        val root = linkedMapOf<String, Any>(
            "opaRevision" to opaRevision,
            "releaseItems" to sortedItems.map { item ->
                linkedMapOf(
                    "bundleContentHash" to item.bundleContentHash,
                    "bundleId" to item.bundleId.toString(),
                    "bundleVersionId" to item.bundleVersionId.toString(),
                    "layer" to item.layer.name,
                )
            },
        )
        return mapper.writeValueAsString(root)
    }

    private val HASH = Regex("^[0-9a-f]{64}${'$'}")
}
