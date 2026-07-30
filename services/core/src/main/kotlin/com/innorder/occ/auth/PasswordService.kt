package com.innorder.occ.auth

import org.springframework.security.crypto.argon2.Argon2PasswordEncoder
import org.springframework.security.crypto.password.PasswordEncoder
import java.util.Base64

class PasswordService internal constructor(private val encoder: PasswordEncoder) {
    constructor() : this(Argon2PasswordEncoder(SALT_LENGTH, HASH_LENGTH, PARALLELISM, MEMORY_KIB, ITERATIONS))

    fun encode(password: CharSequence): String {
        require(isAllowed(password)) { "Password must contain between $MIN_CODE_POINTS and $MAX_CODE_POINTS Unicode code points" }
        return encoder.encode(password)
    }

    fun matches(password: CharSequence, encoded: String): Boolean {
        if (parse(encoded) == null) return false
        return try {
            encoder.matches(password, encoded)
        } catch (_: RuntimeException) {
            false
        }
    }

    fun needsRehash(encoded: String): Boolean {
        val parameters = parse(encoded) ?: return true
        return parameters.memoryKib != MEMORY_KIB || parameters.iterations != ITERATIONS
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

    private fun parse(encoded: String): Argon2Parameters? {
        if (encoded.length > MAX_ENCODED_LENGTH) return null
        val match = ARGON2ID_HASH.matchEntire(encoded) ?: return null
        val memoryKib = match.groupValues[1].toIntOrNull() ?: return null
        val iterations = match.groupValues[2].toIntOrNull() ?: return null
        val parallelism = match.groupValues[3].toIntOrNull() ?: return null
        if (memoryKib !in MIN_MEMORY_KIB..MEMORY_KIB || iterations !in 1..ITERATIONS || parallelism != PARALLELISM) {
            return null
        }
        return try {
            if (Base64.getDecoder().decode(match.groupValues[4]).size != SALT_LENGTH ||
                Base64.getDecoder().decode(match.groupValues[5]).size != HASH_LENGTH
            ) {
                null
            } else {
                Argon2Parameters(memoryKib, iterations)
            }
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private data class Argon2Parameters(val memoryKib: Int, val iterations: Int)

    private companion object {
        const val SALT_LENGTH = 16
        const val HASH_LENGTH = 32
        const val PARALLELISM = 1
        const val MIN_MEMORY_KIB = 8192
        const val MEMORY_KIB = 1 shl 16
        const val ITERATIONS = 3
        const val MIN_CODE_POINTS = 12
        const val MAX_CODE_POINTS = 128
        const val MAX_ENCODED_LENGTH = 1024
        val ARGON2ID_HASH = Regex("^\\${'$'}argon2id\\${'$'}v=19\\${'$'}m=([0-9]+),t=([0-9]+),p=([0-9]+)\\${'$'}([A-Za-z0-9+/]+={0,2})\\${'$'}([A-Za-z0-9+/]+={0,2})${'$'}")
    }
}
