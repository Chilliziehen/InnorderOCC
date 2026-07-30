package com.innorder.occ.auth

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.transaction.support.TransactionTemplate
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.sql.ResultSet
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.Base64
import java.util.UUID

class SessionRepository(
    private val jdbc: JdbcTemplate,
    private val transactions: TransactionTemplate,
    private val clock: Clock,
    private val secureRandom: SecureRandom = SecureRandom(),
) {
    fun create(
        principalId: UUID,
        tokenVersion: Int,
        lifetime: Duration,
        clientFingerprint: String?,
    ): IssuedSession = inTransaction {
        createSession(principalId, tokenVersion, lifetime, clientFingerprint, clock.instant())
    }

    fun validate(rawToken: String): SessionValidation =
        RefreshToken.parse(rawToken)?.let(::validate) ?: SessionValidation.Invalid

    fun validate(token: RefreshToken): SessionValidation = inTransaction {
        val row = lockByToken(token) ?: return@inTransaction SessionValidation.Invalid
        val now = clock.instant()
        if (row.session.revokedAt != null) {
            row.session.replacedBySessionId?.let { revokeReplacementChain(it, row.session.principalId, now) }
            return@inTransaction SessionValidation.Invalid
        }
        if (now >= row.session.expiresAt) return@inTransaction SessionValidation.Invalid

        val lastUsed = maxOf(row.session.lastUsedAt, now)
        jdbc.update("UPDATE iam.auth_session SET last_used_at = ? WHERE id = ?", lastUsed.toSqlTimestamp(), row.session.id)
        SessionValidation.Active(row.session.copy(lastUsedAt = lastUsed))
    }

    fun rotate(rawToken: String, lifetime: Duration, clientFingerprint: String? = null): SessionRotation =
        RefreshToken.parse(rawToken)?.let { rotate(it, lifetime, clientFingerprint) } ?: SessionRotation.Invalid

    fun rotate(token: RefreshToken, lifetime: Duration, clientFingerprint: String? = null): SessionRotation = inTransaction {
        val old = lockByToken(token) ?: return@inTransaction SessionRotation.Invalid
        val now = clock.instant()
        if (old.session.revokedAt != null) {
            old.session.replacedBySessionId?.let { revokeReplacementChain(it, old.session.principalId, now) }
            return@inTransaction SessionRotation.Invalid
        }
        if (now >= old.session.expiresAt) return@inTransaction SessionRotation.Invalid

        val replacementCreatedAt = maxOf(now, old.session.lastUsedAt, old.session.createdAt)
        val replacement = createSession(
            old.session.principalId,
            old.session.tokenVersion,
            lifetime,
            clientFingerprint ?: old.session.clientFingerprint,
            replacementCreatedAt,
        )
        jdbc.update(
            "UPDATE iam.auth_session SET revoked_at = ?, replaced_by_session_id = ? WHERE id = ?",
            replacementCreatedAt.toSqlTimestamp(),
            replacement.session.id,
            old.session.id,
        )
        SessionRotation.Rotated(replacement)
    }

    fun revoke(sessionId: UUID): Boolean = inTransaction {
        val session = lockById(sessionId) ?: return@inTransaction false
        val now = clock.instant()
        if (session.revokedAt == null) {
            jdbc.update(
                "UPDATE iam.auth_session SET revoked_at = ? WHERE id = ?",
                revocationTime(session, now).toSqlTimestamp(),
                session.id,
            )
        }
        session.replacedBySessionId?.let { revokeReplacementChain(it, session.principalId, now) }
        true
    }

    private fun createSession(
        principalId: UUID,
        tokenVersion: Int,
        lifetime: Duration,
        clientFingerprint: String?,
        createdAt: Instant,
    ): IssuedSession {
        require(!lifetime.isZero && !lifetime.isNegative) { "Session lifetime must be positive" }
        val tokenBytes = ByteArray(TOKEN_BYTES)
        secureRandom.nextBytes(tokenBytes)
        val token = RefreshToken.generated(Base64.getUrlEncoder().withoutPadding().encodeToString(tokenBytes))
        tokenBytes.fill(0)
        val tokenHash = hash(token)
        val session = AuthSession(
            id = UUID.randomUUID(),
            principalId = principalId,
            tokenVersion = tokenVersion,
            createdAt = createdAt,
            lastUsedAt = createdAt,
            expiresAt = createdAt.plus(lifetime),
            revokedAt = null,
            replacedBySessionId = null,
            clientFingerprint = clientFingerprint,
        )
        jdbc.update(
            """INSERT INTO iam.auth_session
                (id, principal_id, token_version, refresh_token_hash, created_at, last_used_at, expires_at, client_fingerprint)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            session.id,
            session.principalId,
            session.tokenVersion,
            tokenHash.hex,
            session.createdAt.toSqlTimestamp(),
            session.lastUsedAt.toSqlTimestamp(),
            session.expiresAt.toSqlTimestamp(),
            session.clientFingerprint,
        )
        return IssuedSession(session, token)
    }

    private fun lockByToken(token: RefreshToken): StoredSession? {
        val expected = hash(token)
        val rows = jdbc.query(
            """SELECT id, principal_id, token_version, refresh_token_hash, created_at, last_used_at,
                      expires_at, revoked_at, replaced_by_session_id, client_fingerprint
               FROM iam.auth_session WHERE refresh_token_hash = ? FOR UPDATE""",
            { rs, _ -> mapStoredSession(rs) },
            expected.hex,
        )
        val selected = rows.singleOrNull() ?: return null
        return if (MessageDigest.isEqual(expected.bytes, decodeHex(selected.tokenHash))) selected else null
    }

    private fun lockById(id: UUID): AuthSession? = jdbc.query(
        """SELECT id, principal_id, token_version, refresh_token_hash, created_at, last_used_at,
                  expires_at, revoked_at, replaced_by_session_id, client_fingerprint
           FROM iam.auth_session WHERE id = ? FOR UPDATE""",
        { rs, _ -> mapStoredSession(rs).session },
        id,
    ).singleOrNull()

    private fun revokeReplacementChain(firstId: UUID, principalId: UUID, now: Instant) {
        val visited = HashSet<UUID>(MAX_REPLACEMENT_CHAIN)
        var nextId: UUID? = firstId
        repeat(MAX_REPLACEMENT_CHAIN) {
            val id = nextId ?: return
            if (!visited.add(id)) {
                revokeAllActiveForPrincipal(principalId, now)
                return
            }
            val descendant = lockById(id)
            if (descendant == null || descendant.principalId != principalId) {
                revokeAllActiveForPrincipal(principalId, now)
                return
            }
            if (descendant.revokedAt == null) {
                jdbc.update(
                    "UPDATE iam.auth_session SET revoked_at = ? WHERE id = ?",
                    revocationTime(descendant, now).toSqlTimestamp(),
                    descendant.id,
                )
            }
            nextId = descendant.replacedBySessionId
        }
        if (nextId != null) revokeAllActiveForPrincipal(principalId, now)
    }

    private fun revokeAllActiveForPrincipal(principalId: UUID, now: Instant) {
        jdbc.update(
            """UPDATE iam.auth_session
               SET revoked_at = LEAST(GREATEST(?::timestamptz, created_at, last_used_at), expires_at)
               WHERE principal_id = ? AND revoked_at IS NULL""",
            now.toSqlTimestamp(),
            principalId,
        )
    }

    private fun revocationTime(session: AuthSession, now: Instant): Instant =
        minOf(maxOf(now, session.createdAt, session.lastUsedAt), session.expiresAt)

    private fun hash(token: RefreshToken): TokenHash {
        val tokenBytes = token.exposeValue().toByteArray(StandardCharsets.UTF_8)
        val digest = MessageDigest.getInstance("SHA-256").digest(tokenBytes)
        tokenBytes.fill(0)
        return TokenHash(digest, digest.toHex())
    }

    private fun mapStoredSession(rs: ResultSet): StoredSession = StoredSession(
        AuthSession(
            id = rs.getObject("id", UUID::class.java),
            principalId = rs.getObject("principal_id", UUID::class.java),
            tokenVersion = rs.getInt("token_version"),
            createdAt = rs.instant("created_at")!!,
            lastUsedAt = rs.instant("last_used_at")!!,
            expiresAt = rs.instant("expires_at")!!,
            revokedAt = rs.instant("revoked_at"),
            replacedBySessionId = rs.getObject("replaced_by_session_id", UUID::class.java),
            clientFingerprint = rs.getString("client_fingerprint"),
        ),
        rs.getString("refresh_token_hash"),
    )

    private fun ResultSet.instant(column: String): Instant? =
        getObject(column, OffsetDateTime::class.java)?.withOffsetSameInstant(ZoneOffset.UTC)?.toInstant()

    private fun Instant.toSqlTimestamp(): OffsetDateTime = OffsetDateTime.ofInstant(this, ZoneOffset.UTC)

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    private fun decodeHex(value: String): ByteArray =
        ByteArray(value.length / 2) { index -> value.substring(index * 2, index * 2 + 2).toInt(16).toByte() }

    private fun <T : Any> inTransaction(action: () -> T): T =
        requireNotNull(transactions.execute { action() }) { "Transaction returned no result" }

    private data class StoredSession(val session: AuthSession, val tokenHash: String)
    private data class TokenHash(val bytes: ByteArray, val hex: String)

    private companion object {
        const val TOKEN_BYTES = 32
        const val MAX_REPLACEMENT_CHAIN = 64
    }
}
