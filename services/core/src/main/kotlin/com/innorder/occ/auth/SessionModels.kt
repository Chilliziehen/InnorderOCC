package com.innorder.occ.auth

import java.time.Instant
import java.util.UUID

class RefreshToken private constructor(private val value: String) {
    fun exposeValue(): String = value

    override fun toString(): String = "RefreshToken([REDACTED])"

    companion object {
        private val FORMAT = Regex("^[A-Za-z0-9_-]{43}${'$'}")

        fun parse(value: String): RefreshToken? = if (FORMAT.matches(value)) RefreshToken(value) else null

        internal fun generated(value: String): RefreshToken =
            requireNotNull(parse(value)) { "Generated refresh token has an invalid format" }
    }
}

data class AuthSession(
    val id: UUID,
    val principalId: UUID,
    val tokenVersion: Int,
    val createdAt: Instant,
    val lastUsedAt: Instant,
    val expiresAt: Instant,
    val revokedAt: Instant?,
    val replacedBySessionId: UUID?,
    val clientFingerprint: String?,
) {
    init {
        require(tokenVersion >= 0) { "Token version cannot be negative" }
        require(expiresAt > createdAt) { "Session expiry must follow creation" }
        require(lastUsedAt >= createdAt && lastUsedAt <= expiresAt) { "Session last use is outside its lifetime" }
        require(revokedAt == null || revokedAt in lastUsedAt..expiresAt) { "Session revocation is outside its lifetime" }
        require(replacedBySessionId == null || revokedAt != null) { "A replacement requires revocation" }
        require(replacedBySessionId != id) { "A session cannot replace itself" }
        require(clientFingerprint == null || validFingerprint(clientFingerprint)) { "Client fingerprint is invalid" }
    }

    private fun validFingerprint(value: String): Boolean {
        if (value.isEmpty() || value.first() == ' ' || value.last() == ' ') return false
        var bytes = 0
        var offset = 0
        while (offset < value.length) {
            val codePoint = Character.codePointAt(value, offset)
            if (Character.isISOControl(codePoint)) return false
            bytes += when {
                codePoint <= 0x7f -> 1
                codePoint <= 0x7ff -> 2
                codePoint <= 0xffff -> 3
                else -> 4
            }
            if (bytes > 256) return false
            offset += Character.charCount(codePoint)
        }
        return true
    }
}

data class IssuedSession(val session: AuthSession, val refreshToken: RefreshToken)

sealed interface SessionValidation {
    data class Active(val session: AuthSession) : SessionValidation
    data object Invalid : SessionValidation
}

sealed interface SessionRotation {
    data class Rotated(val issued: IssuedSession) : SessionRotation
    data object Invalid : SessionRotation
}
