package com.innorder.occ.auth

import org.springframework.security.crypto.argon2.Argon2PasswordEncoder
import java.util.Base64

class PasswordService {
    private val encoder = Argon2PasswordEncoder(SALT_LENGTH, HASH_LENGTH, PARALLELISM, MEMORY_KIB, ITERATIONS)

    fun encode(password: CharSequence): String {
        require(isAllowed(password)) { "Password must contain between $MIN_CODE_POINTS and $MAX_CODE_POINTS Unicode code points" }
        return encoder.encode(password)
    }

    fun matches(password: CharSequence, encoded: String): Boolean {
        if (encoded.length > MAX_ENCODED_LENGTH || !CURRENT_HASH.matches(encoded)) return false
        return try {
            encoder.matches(password, encoded)
        } catch (_: RuntimeException) {
            false
        }
    }

    fun needsRehash(encoded: String): Boolean {
        if (encoded.length > MAX_ENCODED_LENGTH) return true
        val match = CURRENT_HASH.matchEntire(encoded) ?: return true
        return try {
            match.groupValues[1].toInt() < MEMORY_KIB ||
                match.groupValues[2].toInt() < ITERATIONS ||
                match.groupValues[3].toInt() < PARALLELISM ||
                Base64.getDecoder().decode(match.groupValues[4]).size < SALT_LENGTH ||
                Base64.getDecoder().decode(match.groupValues[5]).size < HASH_LENGTH
        } catch (_: RuntimeException) {
            true
        }
    }

    fun isAllowed(password: CharSequence): Boolean {
        var codePoints = 0
        var offset = 0
        while (offset < password.length) {
            if (++codePoints > MAX_CODE_POINTS) return false
            offset += Character.charCount(Character.codePointAt(password, offset))
        }
        return codePoints >= MIN_CODE_POINTS
    }

    private companion object {
        const val SALT_LENGTH = 16
        const val HASH_LENGTH = 32
        const val PARALLELISM = 1
        const val MEMORY_KIB = 1 shl 16
        const val ITERATIONS = 3
        const val MIN_CODE_POINTS = 12
        const val MAX_CODE_POINTS = 128
        const val MAX_ENCODED_LENGTH = 1024
        val CURRENT_HASH = Regex("^\\${'$'}argon2id\\${'$'}v=19\\${'$'}m=(\\d+),t=(\\d+),p=(\\d+)\\${'$'}([A-Za-z0-9+/]+={0,2})\\${'$'}([A-Za-z0-9+/]+={0,2})${'$'}")
    }
}
