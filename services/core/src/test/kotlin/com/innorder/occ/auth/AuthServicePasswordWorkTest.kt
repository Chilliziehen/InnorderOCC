package com.innorder.occ.auth

import com.innorder.occ.iam.LockedAccount
import com.innorder.occ.iam.AccountCredentialSnapshot
import com.innorder.occ.iam.PrincipalRepository
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.mock
import org.mockito.Mockito.RETURNS_DEFAULTS
import org.mockito.Mockito.reset
import org.mockito.Mockito.`when`
import org.springframework.security.authentication.BadCredentialsException
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.dao.DataAccessResourceFailureException
import org.springframework.transaction.TransactionStatus
import org.springframework.transaction.support.TransactionCallback
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class AuthServicePasswordWorkTest {
    private val principals = mock(PrincipalRepository::class.java)
    private val sessions = mock(SessionRepository::class.java)
    private val accessTokens = mock(AccessTokenService::class.java)
    private val transactions = mock(TransactionTemplate::class.java)
    private val encoder = RecordingEncoder()
    private val service = AuthService(
        principals,
        PasswordService(encoder),
        sessions,
        accessTokens,
        transactions,
        Clock.fixed(Instant.parse("2026-07-31T12:00:00Z"), ZoneOffset.UTC),
    )

    init {
        @Suppress("UNCHECKED_CAST")
        `when`(transactions.execute<TokenResponse?>(any())).thenAnswer { invocation ->
            val callback = invocation.getArgument<TransactionCallback<TokenResponse?>>(0)
            callback.doInTransaction(mock(TransactionStatus::class.java))
        }
    }

    @Test
    fun `every credential rejection performs exactly one supported Argon2 match`() {
        val cases = listOf(
            "+invalid" to null,
            "missing@example.com" to null,
            "alice@example.com" to account(null),
            "alice@example.com" to account("not-an-argon-hash"),
            "alice@example.com" to account(SUPPORTED_HASH),
        )

        cases.forEach { (username, account) ->
            reset(principals)
            encoder.encoded.clear()
            `when`(principals.credentialSnapshot(username)).thenReturn(account?.snapshot())
            if (account != null) `when`(principals.lockAccount(account.principalId)).thenReturn(account)

            assertThatThrownBy { service.login(username, "wrong password value") }
                .isInstanceOf(BadCredentialsException::class.java)

            assertThat(encoder.encoded).hasSize(1)
            assertThat(encoder.encoded.single()).matches(
                "^\\${'$'}argon2id\\${'$'}v=19\\${'$'}m=65536,t=3,p=1\\${'$'}.*",
            )
        }
    }

    @Test
    fun `compensation database failure becomes a message free operational exception`() {
        var transactionCalls = 0
        val failingTransactions = mock(TransactionTemplate::class.java) { invocation ->
            if (invocation.method.name == "execute") {
                transactionCalls++
                if (transactionCalls == 1) throw IllegalStateException("refresh secret")
                throw DataAccessResourceFailureException("jdbc:postgresql://secret")
            }
            RETURNS_DEFAULTS.answer(invocation)
        }
        val failingService = AuthService(
            principals,
            PasswordService(encoder),
            sessions,
            accessTokens,
            failingTransactions,
            Clock.fixed(Instant.parse("2026-07-31T12:00:00Z"), ZoneOffset.UTC),
        )

        assertThatThrownBy { failingService.refresh("a".repeat(43)) }
            .isInstanceOf(RefreshCompensationException::class.java)
            .hasMessage(null)
            .hasNoCause()
        assertThat(transactionCalls).isEqualTo(2)
    }

    @Test
    fun `refresh does not catch JVM errors or attempt compensation`() {
        var transactionCalls = 0
        val errorTransactions = mock(TransactionTemplate::class.java) { invocation ->
            if (invocation.method.name == "execute") {
                transactionCalls++
                throw AssertionError("fatal")
            }
            RETURNS_DEFAULTS.answer(invocation)
        }
        val errorService = AuthService(
            principals,
            PasswordService(encoder),
            sessions,
            accessTokens,
            errorTransactions,
            Clock.fixed(Instant.parse("2026-07-31T12:00:00Z"), ZoneOffset.UTC),
        )

        assertThatThrownBy { errorService.refresh("a".repeat(43)) }
            .isInstanceOf(AssertionError::class.java)
        assertThat(transactionCalls).isEqualTo(1)
    }

    @Test
    fun `same username password verification overlaps before either locked account update`() {
        val verificationEntered = CountDownLatch(2)
        val releaseVerification = CountDownLatch(1)
        val lockInvocations = AtomicInteger()
        val overlapEncoder = BlockingPasswordEncoder(verificationEntered, releaseVerification)
        val overlapPrincipals = mock(PrincipalRepository::class.java)
        val overlapTransactions = mock(TransactionTemplate::class.java)
        @Suppress("UNCHECKED_CAST")
        `when`(overlapTransactions.execute<TokenResponse?>(any())).thenAnswer { invocation ->
            val callback = invocation.getArgument<TransactionCallback<TokenResponse?>>(0)
            callback.doInTransaction(mock(TransactionStatus::class.java))
        }
        val overlapAccount = account(SUPPORTED_HASH)
        `when`(overlapPrincipals.credentialSnapshot("alice@example.com")).thenReturn(overlapAccount.snapshot())
        `when`(overlapPrincipals.lockAccount(overlapAccount.principalId)).thenAnswer {
            lockInvocations.incrementAndGet()
            overlapAccount
        }
        val overlapService = AuthService(
            overlapPrincipals,
            PasswordService(overlapEncoder),
            sessions,
            accessTokens,
            overlapTransactions,
            Clock.fixed(Instant.parse("2026-07-31T12:00:00Z"), ZoneOffset.UTC),
        )
        val pool = Executors.newFixedThreadPool(2)
        try {
            val calls = (1..2).map {
                pool.submit {
                    runCatching { overlapService.login("alice@example.com", "wrong password value") }
                }
            }

            assertThat(verificationEntered.await(15, TimeUnit.SECONDS)).isTrue()
            assertThat(lockInvocations.get()).isZero()
            releaseVerification.countDown()
            calls.forEach { it.get(15, TimeUnit.SECONDS) }
            assertThat(lockInvocations.get()).isEqualTo(2)
        } finally {
            releaseVerification.countDown()
            pool.shutdownNow()
            assertThat(pool.awaitTermination(15, TimeUnit.SECONDS)).isTrue()
        }
    }

    @Test
    fun `changed credential snapshot fails without applying stale counters`() {
        val mutations = AtomicInteger()
        val stalePrincipals = mock(PrincipalRepository::class.java) { invocation ->
            if (invocation.method.name in setOf("recordFailure", "recordSuccess")) mutations.incrementAndGet()
            RETURNS_DEFAULTS.answer(invocation)
        }
        val snapshotAccount = account(SUPPORTED_HASH)
        `when`(stalePrincipals.credentialSnapshot("alice@example.com")).thenReturn(snapshotAccount.snapshot())
        `when`(stalePrincipals.lockAccount(snapshotAccount.principalId))
            .thenReturn(snapshotAccount.copy(failedAttempts = 1, failedWindowStartedAt = Instant.parse("2026-07-31T12:00:00Z")))
        val staleTransactions = callbackTransactions()
        val staleService = AuthService(
            stalePrincipals,
            PasswordService(RecordingEncoder()),
            sessions,
            accessTokens,
            staleTransactions,
            Clock.fixed(Instant.parse("2026-07-31T12:00:00Z"), ZoneOffset.UTC),
        )

        assertThatThrownBy { staleService.login("alice@example.com", "wrong password value") }
            .isInstanceOf(InvalidCredentialsException::class.java)
        assertThat(mutations.get()).isZero()
    }

    @Test
    fun `weaker hash re encoding completes before locked account update`() {
        val encodeEntered = CountDownLatch(1)
        val releaseEncode = CountDownLatch(1)
        val lockInvocations = AtomicInteger()
        val rehashAccount = account(WEAKER_HASH)
        val rehashPrincipals = mock(PrincipalRepository::class.java)
        `when`(rehashPrincipals.credentialSnapshot("alice@example.com")).thenReturn(rehashAccount.snapshot())
        `when`(rehashPrincipals.lockAccount(rehashAccount.principalId)).thenAnswer {
            lockInvocations.incrementAndGet()
            rehashAccount
        }
        val rehashService = AuthService(
            rehashPrincipals,
            PasswordService(BlockingRehashEncoder(encodeEntered, releaseEncode)),
            sessions,
            accessTokens,
            callbackTransactions(),
            Clock.fixed(Instant.parse("2026-07-31T12:00:00Z"), ZoneOffset.UTC),
        )
        val pool = Executors.newSingleThreadExecutor()
        try {
            val call = pool.submit { runCatching { rehashService.login("alice@example.com", "correct password value") } }

            assertThat(encodeEntered.await(15, TimeUnit.SECONDS)).isTrue()
            assertThat(lockInvocations.get()).isZero()
            releaseEncode.countDown()
            call.get(15, TimeUnit.SECONDS)
            assertThat(lockInvocations.get()).isEqualTo(1)
        } finally {
            releaseEncode.countDown()
            pool.shutdownNow()
            assertThat(pool.awaitTermination(15, TimeUnit.SECONDS)).isTrue()
        }
    }

    private fun callbackTransactions(): TransactionTemplate = mock(TransactionTemplate::class.java).also { template ->
        @Suppress("UNCHECKED_CAST")
        `when`(template.execute<TokenResponse?>(any())).thenAnswer { invocation ->
            val callback = invocation.getArgument<TransactionCallback<TokenResponse?>>(0)
            callback.doInTransaction(mock(TransactionStatus::class.java))
        }
    }

    private fun account(hash: String?): LockedAccount = LockedAccount(
        UUID.fromString("71000000-0000-7000-8000-000000000001"),
        "alice@example.com",
        "Alice",
        "ACTIVE",
        "ACTIVE",
        hash,
        0,
        0,
        null,
        null,
    )

    private fun LockedAccount.snapshot(): AccountCredentialSnapshot = AccountCredentialSnapshot(
        principalId,
        username,
        principalStatus,
        entityState,
        passwordHash,
        tokenVersion,
        failedAttempts,
        failedWindowStartedAt,
        lockedUntil,
    )

    private class RecordingEncoder : PasswordEncoder {
        val encoded = mutableListOf<String>()
        override fun encode(rawPassword: CharSequence): String = error("not used")
        override fun matches(rawPassword: CharSequence, encodedPassword: String): Boolean {
            encoded += encodedPassword
            return false
        }
    }

    private class BlockingPasswordEncoder(
        private val entered: CountDownLatch,
        private val release: CountDownLatch,
    ) : PasswordEncoder {
        override fun encode(rawPassword: CharSequence): String = error("not used")
        override fun matches(rawPassword: CharSequence, encodedPassword: String): Boolean {
            entered.countDown()
            check(release.await(15, TimeUnit.SECONDS)) { "Timed out waiting to release password verification" }
            return false
        }
    }

    private class BlockingRehashEncoder(
        private val entered: CountDownLatch,
        private val release: CountDownLatch,
    ) : PasswordEncoder {
        override fun encode(rawPassword: CharSequence): String {
            entered.countDown()
            check(release.await(15, TimeUnit.SECONDS)) { "Timed out waiting to release password rehash" }
            return SUPPORTED_HASH
        }

        override fun matches(rawPassword: CharSequence, encodedPassword: String): Boolean = true
    }

    companion object {
        private const val SUPPORTED_HASH = "${'$'}argon2id${'$'}v=19${'$'}m=65536,t=3,p=1${'$'}AQEBAQEBAQEBAQEBAQEBAQ==${'$'}AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="
        private const val WEAKER_HASH = "${'$'}argon2id${'$'}v=19${'$'}m=8192,t=1,p=1${'$'}AQEBAQEBAQEBAQEBAQEBAQ==${'$'}AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="
    }
}
