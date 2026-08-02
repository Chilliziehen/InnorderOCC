package com.innorder.occ.api.cursor

import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Clock
import java.time.Duration
import java.time.Instant
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.slf4j.LoggerFactory

class CursorKeyConfigurationException : IllegalArgumentException("Cursor key configuration is unavailable or invalid")

class CursorKeyRing private constructor(
    val currentKeyId: String,
    private val current: SecretKeySpec,
    private val previousKeyId: String?,
    private val previous: SecretKeySpec?,
    private val previousKeyNotAfter: Instant?,
) {
    fun sign(payload: ByteArray): ByteArray = mac(current, payload)

    fun verify(keyId: String, payload: ByteArray, signature: ByteArray, now: Instant, issuedAt: Instant): Boolean {
        val key = when (keyId) {
            currentKeyId -> current
            previousKeyId -> previous
            else -> null
        } ?: return false
        if (!MessageDigest.isEqual(mac(key, payload), signature)) return false
        return keyId == currentKeyId || previousKeyNotAfter?.let { deadline ->
            !now.isAfter(deadline) && !issuedAt.isAfter(deadline)
        } == true
    }

    companion object {
        private const val ALGORITHM = "HmacSHA256"
        private const val MINIMUM_KEY_BYTES = 32L
        private const val MAXIMUM_KEY_BYTES = 4096L
        private val KEY_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}${'$'}")

        fun load(properties: CursorProperties, clock: Clock): CursorKeyRing {
            try {
                require(KEY_ID.matches(properties.currentKeyId))
                val previousKeyId = properties.previousKeyId?.trim()?.takeIf(String::isNotEmpty)
                val previousKeyFile = properties.previousKeyFile?.trim()?.takeIf(String::isNotEmpty)
                val previousKeyNotAfter = properties.previousKeyNotAfter
                val previousConfigured = previousKeyId != null || previousKeyFile != null || previousKeyNotAfter != null
                require(!previousConfigured ||
                    (previousKeyId != null && previousKeyFile != null && previousKeyNotAfter != null))
                require(previousKeyId == null ||
                    (KEY_ID.matches(previousKeyId) && previousKeyId != properties.currentKeyId))
                if (previousKeyNotAfter != null) {
                    val now = clock.instant()
                    if (previousKeyNotAfter.isBefore(now)) {
                        logger.info("Previous cursor key overlap expired; remove previous cursor key configuration")
                        return CursorKeyRing(
                            properties.currentKeyId,
                            loadKey(properties.currentKeyFile),
                            null,
                            null,
                            null,
                        )
                    }
                    require(!previousKeyNotAfter.isAfter(now.plus(MAXIMUM_OVERLAP)))
                }
                return CursorKeyRing(
                    properties.currentKeyId,
                    loadKey(properties.currentKeyFile),
                    previousKeyId,
                    previousKeyFile?.let(::loadKey),
                    previousKeyNotAfter,
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
        private val MAXIMUM_OVERLAP = Duration.ofHours(24)
        private val logger = LoggerFactory.getLogger(CursorKeyRing::class.java)

        private fun mac(key: SecretKeySpec, payload: ByteArray): ByteArray =
            Mac.getInstance(ALGORITHM).run {
                init(key)
                doFinal(payload)
            }
    }
}
