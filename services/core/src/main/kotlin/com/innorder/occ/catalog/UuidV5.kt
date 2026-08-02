package com.innorder.occ.catalog

import java.nio.ByteBuffer
import java.security.MessageDigest
import java.text.Normalizer
import java.util.Locale
import java.util.UUID

object UuidV5 {
    fun from(namespace: UUID, name: String): UUID {
        val normalizedName = Normalizer.normalize(name.trim(), Normalizer.Form.NFC).lowercase(Locale.ROOT)
        require(normalizedName.isNotEmpty()) { "UUIDv5 name must not be blank" }
        val namespaceBytes = ByteBuffer.allocate(16)
            .putLong(namespace.mostSignificantBits)
            .putLong(namespace.leastSignificantBits)
            .array()
        val bytes = MessageDigest.getInstance("SHA-1").run {
            update(namespaceBytes)
            update(normalizedName.toByteArray(Charsets.UTF_8))
            digest().copyOf(16)
        }
        bytes[6] = ((bytes[6].toInt() and 0x0f) or 0x50).toByte()
        bytes[8] = ((bytes[8].toInt() and 0x3f) or 0x80).toByte()
        val value = ByteBuffer.wrap(bytes)
        return UUID(value.long, value.long)
    }
}
