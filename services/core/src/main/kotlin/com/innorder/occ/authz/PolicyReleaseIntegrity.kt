package com.innorder.occ.authz

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.MapperFeature
import com.fasterxml.jackson.databind.SerializationFeature
import java.security.MessageDigest
import java.util.UUID

data class PolicyReleaseItemIntegrity(
    val layer: PolicyLayer,
    val bundleId: UUID,
    val bundleVersionId: UUID,
    val bundleContentHash: String,
)

object PolicyReleaseIntegrity {
    private val mapper = ObjectMapper().apply {
        setConfig(serializationConfig.with(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY))
    }.enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
        .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)

    fun contentHash(opaRevision: String, items: List<PolicyReleaseItemIntegrity>): String =
        sha256(canonicalJson(opaRevision, items).toByteArray(Charsets.UTF_8))

    fun manifestContentHash(manifest: String): String {
        val normalized = mapper.convertValue(mapper.readTree(manifest), Any::class.java)
        return sha256(mapper.writeValueAsBytes(normalized))
    }

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

    private fun sha256(value: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(value)
        .joinToString("") { "%02x".format(it) }
}
