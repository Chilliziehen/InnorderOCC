package com.innorder.occ.evidence

import java.util.Collections

data class ArchiveLimits(
    val maximumEntries: Int,
    val maximumExpandedBytes: Long,
    val maximumCompressionRatio: Double,
) {
    init {
        require(maximumEntries in 1..ABSOLUTE_MAXIMUM_ENTRIES)
        require(maximumExpandedBytes in 1..ABSOLUTE_MAXIMUM_EXPANDED_BYTES)
        require(maximumCompressionRatio.isFinite() && maximumCompressionRatio > 0.0 &&
            maximumCompressionRatio <= ABSOLUTE_MAXIMUM_COMPRESSION_RATIO)
    }

    companion object {
        const val ABSOLUTE_MAXIMUM_ENTRIES = 10_000
        const val ABSOLUTE_MAXIMUM_EXPANDED_BYTES = 1_073_741_824L
        const val ABSOLUTE_MAXIMUM_COMPRESSION_RATIO = 1_000.0
    }
}

class EvidencePolicy(
    allowedExtensions: Set<String>,
    allowedMediaTypes: Set<String>,
    val maximumBytes: Long,
    val archiveLimits: ArchiveLimits,
) {
    val allowedExtensions: Set<String> = immutableCopy(allowedExtensions)
    val allowedMediaTypes: Set<String> = immutableCopy(allowedMediaTypes)

    init {
        require(this.allowedExtensions.isNotEmpty())
        require(this.allowedMediaTypes.isNotEmpty())
        require(maximumBytes in 1..ABSOLUTE_MAXIMUM_BYTES)
        require(this.allowedExtensions.all { EXTENSION.matches(it) && it in MEDIA_BY_EXTENSION })
        require(this.allowedMediaTypes.all { MEDIA_TYPE.matches(it) && it in MEDIA_BY_EXTENSION.values })
        require(this.allowedMediaTypes == this.allowedExtensions.mapTo(linkedSetOf(), MEDIA_BY_EXTENSION::getValue))
    }

    companion object {
        const val ABSOLUTE_MAXIMUM_BYTES = 104_857_600L

        internal val MEDIA_BY_EXTENSION = mapOf(
            "txt" to "text/plain",
            "md" to "text/markdown",
            "pdf" to "application/pdf",
            "zip" to "application/zip",
            "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        )

        private val EXTENSION = Regex("^[a-z0-9][a-z0-9]{0,15}$")
        private val MEDIA_TYPE = Regex("^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$")

        private fun immutableCopy(values: Set<String>): Set<String> =
            Collections.unmodifiableSet(LinkedHashSet(values))
    }
}
