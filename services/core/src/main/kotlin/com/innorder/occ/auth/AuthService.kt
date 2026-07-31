package com.innorder.occ.auth

import com.innorder.occ.iam.CurrentUser
import com.innorder.occ.iam.AccountCredentialSnapshot
import com.innorder.occ.iam.LockedAccount
import com.innorder.occ.iam.PrincipalRepository
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.security.authentication.BadCredentialsException
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.security.SecureRandom
import java.time.Clock
import java.time.Duration
import java.util.Locale
import java.util.UUID

class TokenResponse(
    val tokenType: String,
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Long,
    val user: CurrentUser,
) {
    override fun toString(): String = "TokenResponse(tokenType=$tokenType, accessToken=[REDACTED], refreshToken=[REDACTED], expiresIn=$expiresIn, user=$user)"
}

class InvalidCredentialsException : BadCredentialsException("Invalid credentials")

class RefreshCompensationException : RuntimeException()

@Service
class AuthService(
    private val principals: PrincipalRepository,
    private val passwords: PasswordService,
    private val sessions: SessionRepository,
    private val accessTokens: AccessTokenService,
    private val transactions: TransactionTemplate,
    private val clock: Clock,
) {
    fun login(rawUsername: String, password: String): TokenResponse {
        val username = rawUsername.trim().lowercase(Locale.ROOT)
        if (!CANONICAL_USERNAME.matches(username) || username.length > MAX_USERNAME_LENGTH) {
            passwords.matches(password, DUMMY_HASH)
            throw invalidCredentials()
        }
        val snapshot = principals.credentialSnapshot(username)
        val supportedHash = snapshot?.passwordHash?.takeIf(passwords::isSupportedHash)
        val passwordMatches = passwords.matches(password, supportedHash ?: DUMMY_HASH) && supportedHash != null
        if (snapshot == null) throw invalidCredentials()
        val now = clock.instant()
        val snapshotLocked = snapshot.lockedUntil?.let { now < it } == true
        val snapshotActive = snapshot.principalStatus == "ACTIVE" && snapshot.entityState == "ACTIVE"
        val replacementHash = if (
            passwordMatches && !snapshotLocked && snapshotActive && passwords.needsRehash(snapshot.passwordHash!!)
        ) {
            passwords.encode(password)
        } else {
            null
        }
        val response = transactions.execute {
            val account = principals.lockAccount(snapshot.principalId)
            if (account == null || !account.matches(snapshot)) return@execute null
            val locked = account.lockedUntil?.let { now < it } == true
            val active = account.principalStatus == "ACTIVE" && account.entityState == "ACTIVE"
            if (!passwordMatches || locked || !active) {
                if (!locked && active && account.passwordHash != null) principals.recordFailure(account, now)
                return@execute null
            }
            principals.recordSuccess(account, replacementHash, now)
            val tokenVersion = account.tokenVersion + if (replacementHash == null) 0 else 1
            val issued = sessions.create(account.principalId, tokenVersion, REFRESH_LIFETIME, null)
            tokenResponse(issued, requireNotNull(principals.currentUser(account.principalId)))
        }
        return response ?: throw invalidCredentials()
    }

    fun refresh(rawRefreshToken: String): TokenResponse {
        try {
            val response = transactions.execute {
                when (val rotation = sessions.rotate(rawRefreshToken, REFRESH_LIFETIME)) {
                    SessionRotation.Invalid -> null
                    is SessionRotation.Rotated -> {
                        val user = principals.lockCurrentUser(rotation.issued.session.principalId)
                        if (user == null) {
                            sessions.revoke(rotation.issued.session.id)
                            null
                        } else {
                            tokenResponse(rotation.issued, user)
                        }
                    }
                }
            }
            return response ?: throw invalidCredentials()
        } catch (failure: Exception) {
            try {
                transactions.execute { sessions.revoke(rawRefreshToken) }
            } catch (_: Exception) {
                throw RefreshCompensationException()
            }
            throw failure
        }
    }

    fun logout(principal: AccessTokenPrincipal, rawRefreshToken: String) {
        val revoked = transactions.execute {
            sessions.revokeOwned(rawRefreshToken, principal.sessionId, principal.principalId)
        } == true
        if (!revoked) throw invalidCredentials()
    }

    fun currentUser(principalId: UUID): CurrentUser = transactions.execute {
        principals.lockCurrentUser(principalId)
    } ?: throw invalidCredentials()

    private fun tokenResponse(issued: IssuedSession, user: CurrentUser): TokenResponse {
        val subject = AccessTokenSubject(
            user.id,
            principals.customerInstanceId(),
            issued.session.id,
            issued.session.tokenVersion,
        )
        return TokenResponse(
            "Bearer",
            accessTokens.issue(subject),
            issued.refreshToken.exposeValue(),
            accessTokens.expiresInSeconds(),
            user,
        )
    }

    private fun invalidCredentials() = InvalidCredentialsException()

    private fun LockedAccount.matches(snapshot: AccountCredentialSnapshot): Boolean =
        principalId == snapshot.principalId &&
            username == snapshot.username &&
            principalStatus == snapshot.principalStatus &&
            entityState == snapshot.entityState &&
            passwordHash == snapshot.passwordHash &&
            tokenVersion == snapshot.tokenVersion &&
            failedAttempts == snapshot.failedAttempts &&
            failedWindowStartedAt == snapshot.failedWindowStartedAt &&
            lockedUntil == snapshot.lockedUntil

    companion object {
        private const val MAX_USERNAME_LENGTH = 128
        private val REFRESH_LIFETIME = Duration.ofDays(7)
        private val CANONICAL_USERNAME = Regex("^[a-z0-9][a-z0-9._@-]*${'$'}")
        private const val DUMMY_HASH = "${'$'}argon2id${'$'}v=19${'$'}m=65536,t=3,p=1${'$'}AAAAAAAAAAAAAAAAAAAAAA==${'$'}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    }
}

@Configuration
class AuthConfiguration {
    @Bean
    fun passwordService(): PasswordService = PasswordService()

    @Bean
    fun authTransactions(manager: PlatformTransactionManager): TransactionTemplate = TransactionTemplate(manager)

    @Bean
    fun sessionRepository(
        jdbc: JdbcTemplate,
        authTransactions: TransactionTemplate,
        clock: Clock,
    ): SessionRepository = SessionRepository(jdbc, authTransactions, clock, SecureRandom())
}
