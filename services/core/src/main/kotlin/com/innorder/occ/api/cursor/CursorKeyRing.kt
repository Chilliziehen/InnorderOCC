package com.innorder.occ.api.cursor

import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class CursorKeyConfigurationException : IllegalArgumentException("Cursor key configuration is unavailable or invalid")

class CursorKeyRing private constructor(
    val currentKeyId: String,
    private val current: SecretKeySpec,
    private val previousKeyId: String?,
    private val previous: SecretKeySpec?,
) {
    fun sign(payload: ByteArray): ByteArray = mac(current, payload)

    fun verify(keyId: String, payload: ByteArray, signature: ByteArray): Boolean {
        val key = when (keyId) {
            currentKeyId -> current
            previousKeyId -> previous
            else -> null
        } ?: return false
        return MessageDigest.isEqual(mac(key, payload), signature)
    }

    companion object {
        private const val ALGORITHM = "HmacSHA256"
        private const val MINIMUM_KEY_BYTES = 32L
        private const val MAXIMUM_KEY_BYTES = 4096L
        private val KEY_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}${'$'}")

        fun load(properties: CursorProperties): CursorKeyRing {
            try {
                require(KEY_ID.matches(properties.currentKeyId))
                val previousKeyId = properties.previousKeyId?.trim()?.takeIf(String::isNotEmpty)
                val previousKeyFile = properties.previousKeyFile?.trim()?.takeIf(String::isNotEmpty)
                val previousConfigured = previousKeyId != null || previousKeyFile != null
                require(!previousConfigured ||
                    (previousKeyId != null && previousKeyFile != null))
                require(previousKeyId == null ||
                    (KEY_ID.matches(previousKeyId) && previousKeyId != properties.currentKeyId))
                return CursorKeyRing(
                    properties.currentKeyId,
                    loadKey(properties.currentKeyFile),
                    previousKeyId,
                    previousKeyFile?.let(::loadKey),
                )
            } catch (_: Exception) {
                throw CursorKeyConfigurationException()
            }
        }

        private fun loadKey(file: String): SecretKeySpec {
            require(file.isNotBlank())
            val path = Path.of(file)
            val size = Files.size(path)
            require(size in MINIMUM_KEY_BYTES..MAXIMUM_KEY_BYTES)
            val bytes = Files.readAllBytes(path)
            return try {
                require(bytes.size.toLong() == size)
                require(bytes.toSet().size >= MINIMUM_DISTINCT_BYTES)
                SecretKeySpec(bytes, ALGORITHM)
            } finally {
                bytes.fill(0)
            }
        }

        private const val MINIMUM_DISTINCT_BYTES = 8

        private fun mac(key: SecretKeySpec, payload: ByteArray): ByteArray =
            Mac.getInstance(ALGORITHM).run {
                init(key)
                doFinal(payload)
            }
    }
}
