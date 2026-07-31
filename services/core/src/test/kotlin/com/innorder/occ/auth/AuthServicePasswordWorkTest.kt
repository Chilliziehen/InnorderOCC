package com.innorder.occ.auth

import com.innorder.occ.iam.LockedAccount
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
            `when`(principals.lockAccount(username)).thenReturn(account)

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

    private class RecordingEncoder : PasswordEncoder {
        val encoded = mutableListOf<String>()
        override fun encode(rawPassword: CharSequence): String = error("not used")
        override fun matches(rawPassword: CharSequence, encodedPassword: String): Boolean {
            encoded += encodedPassword
            return false
        }
    }

    companion object {
        private const val SUPPORTED_HASH = "${'$'}argon2id${'$'}v=19${'$'}m=65536,t=3,p=1${'$'}AQEBAQEBAQEBAQEBAQEBAQ==${'$'}AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="
    }
}
