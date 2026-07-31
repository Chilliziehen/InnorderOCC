package com.innorder.occ.auth

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.iam.CurrentUser
import com.innorder.occ.iam.PrincipalRepository
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Import
import org.springframework.context.annotation.Primary
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.test.annotation.DirtiesContext
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.servlet.MockMvc
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.post
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.mockito.Mockito.mock
import org.mockito.Mockito.RETURNS_DEFAULTS
import org.mockito.Mockito.`when`
import org.springframework.security.crypto.password.PasswordEncoder

@SpringBootTest
@AutoConfigureMockMvc
@Testcontainers(disabledWithoutDocker = true)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Import(AuthControllerIntegrationTest.ClockConfiguration::class)
class AuthControllerIntegrationTest(
    @param:Autowired private val mockMvc: MockMvc,
    @param:Autowired private val objectMapper: ObjectMapper,
    @param:Autowired private val jdbc: JdbcTemplate,
    @param:Autowired private val clock: MutableClock,
    @param:Autowired private val transactions: TransactionTemplate,
    @param:Autowired private val principals: PrincipalRepository,
) {
    private val passwords = PasswordService()

    @BeforeEach
    fun reset() {
        jdbc.update("UPDATE authz.relationship SET revoked_at = statement_timestamp() WHERE subject_entity_id = ? AND revoked_at IS NULL", USER_ID)
        jdbc.update("DELETE FROM iam.auth_session WHERE principal_id IN (?, ?, ?)", USER_ID, ROLE_ID, SECOND_USER_ID)
        jdbc.update("DELETE FROM iam.user_account WHERE principal_id = ?", SECOND_USER_ID)
        jdbc.update("DELETE FROM iam.principal WHERE id = ?", SECOND_USER_ID)
        jdbc.update("DELETE FROM authz.entity WHERE id = ?", SECOND_USER_ID)
        seedCatalog()
        clock.current = BASE_TIME
        if (jdbc.queryForObject("SELECT count(*) FROM iam.user_account WHERE principal_id = ?", Long::class.java, USER_ID) == 0L) {
            val hash = passwords.encode(PASSWORD)
            if (jdbc.queryForObject("SELECT count(*) FROM iam.principal WHERE id = ?", Long::class.java, USER_ID) == 0L) {
                seedUser(hash)
            } else {
                jdbc.update("UPDATE authz.entity SET state = 'ACTIVE' WHERE id = ?", USER_ID)
                jdbc.update("UPDATE iam.principal SET display_name = 'Alice Operator', status = 'ACTIVE' WHERE id = ?", USER_ID)
                jdbc.update("INSERT INTO iam.user_account(principal_id, username, password_hash) VALUES (?, ?, ?)", USER_ID, USERNAME, hash)
            }
        } else {
            jdbc.update("UPDATE authz.entity SET state = 'ACTIVE' WHERE id = ?", USER_ID)
            jdbc.update("UPDATE iam.principal SET display_name = 'Alice Operator', status = 'ACTIVE' WHERE id = ?", USER_ID)
            jdbc.update(
                """UPDATE iam.user_account SET password_hash = ?, failed_attempts = 0,
                       failed_window_started_at = NULL, locked_until = NULL, last_login_at = NULL
                   WHERE principal_id = ?""",
                passwords.encode(PASSWORD),
                USER_ID,
            )
        }
    }

    @Test
    fun `login normalizes username and returns only contract token and user fields`() {
        val response = postJson("/api/v1/auth/login", """{"username":"  ALICE@example.COM  ","password":"$PASSWORD"}""", 200)

        assertThat(response.fieldNames().asSequence().toSet())
            .containsExactlyInAnyOrder("tokenType", "accessToken", "refreshToken", "expiresIn", "user")
        assertThat(response["tokenType"].asText()).isEqualTo("Bearer")
        assertThat(response["accessToken"].asText()).isNotBlank().doesNotContain(PASSWORD)
        assertThat(response["refreshToken"].asText()).matches("^[A-Za-z0-9_-]{43}${'$'}")
        assertThat(response["expiresIn"].asLong()).isEqualTo(900)
        assertThat(response["user"].fieldNames().asSequence().toSet())
            .containsExactlyInAnyOrder("id", "username", "displayName", "status", "capabilities")
        assertThat(response["user"]["id"].asText()).isEqualTo(USER_ID.toString())
        assertThat(response["user"]["username"].asText()).isEqualTo(USERNAME)
        assertThat(response["user"]["displayName"].asText()).isEqualTo("Alice Operator")
        assertThat(response["user"]["status"].asText()).isEqualTo("ACTIVE")
        assertThat(response["user"]["capabilities"]).isEmpty()
        assertThat(response.toString()).doesNotContain("password_hash").doesNotContain("profile").doesNotContain("sessionId")
    }

    @Test
    fun `unknown wrong canonical invalid locked disabled and archived users share one credential failure`() {
        val failures = mutableListOf<JsonNode>()
        failures.add(postJson("/api/v1/auth/login", """{"username":"missing@example.com","password":"$PASSWORD"}""", 401))
        failures.add(postJson("/api/v1/auth/login", """{"username":"$USERNAME","password":"wrong password value"}""", 401))
        failures.add(postJson("/api/v1/auth/login", """{"username":"+invalid","password":"$PASSWORD"}""", 401))
        jdbc.update("UPDATE iam.user_account SET failed_attempts = 5, failed_window_started_at = ?, locked_until = ? WHERE principal_id = ?", sql(BASE_TIME), sql(BASE_TIME.plusSeconds(900)), USER_ID)
        failures.add(postJson("/api/v1/auth/login", """{"username":"$USERNAME","password":"$PASSWORD"}""", 401))
        jdbc.update("UPDATE iam.user_account SET failed_attempts = 0, failed_window_started_at = NULL, locked_until = NULL WHERE principal_id = ?", USER_ID)
        jdbc.update("UPDATE iam.principal SET status = 'DISABLED' WHERE id = ?", USER_ID)
        failures.add(postJson("/api/v1/auth/login", """{"username":"$USERNAME","password":"$PASSWORD"}""", 401))
        jdbc.update("UPDATE iam.principal SET status = 'ACTIVE' WHERE id = ?", USER_ID)
        jdbc.update("UPDATE authz.entity SET state = 'ARCHIVED' WHERE id = ?", USER_ID)
        failures.add(postJson("/api/v1/auth/login", """{"username":"$USERNAME","password":"$PASSWORD"}""", 401))

        failures.forEach { problem ->
            assertThat(problem.fieldNames().asSequence().toSet())
                .containsExactlyInAnyOrder("type", "title", "status", "code", "correlationId")
            assertInvalidCredentials(problem)
            assertThat(problem.toString()).doesNotContain(USERNAME).doesNotContain("LOCKED").doesNotContain("DISABLED")
        }
    }

    @Test
    fun `fifth failure inside window locks and locked attempts do not extend it`() {
        repeat(4) { postJson("/api/v1/auth/login", """{"username":"$USERNAME","password":"wrong password value"}""", 401) }
        assertThat(accountLong("failed_attempts")).isEqualTo(4)
        assertThat(accountInstant("locked_until")).isNull()

        clock.advance(Duration.ofMinutes(14))
        postJson("/api/v1/auth/login", """{"username":"$USERNAME","password":"wrong password value"}""", 401)
        val lockedUntil = accountInstant("locked_until")
        assertThat(accountLong("failed_attempts")).isEqualTo(5)
        assertThat(lockedUntil).isEqualTo(clock.instant().plus(Duration.ofMinutes(15)))

        clock.advance(Duration.ofMinutes(1))
        postJson("/api/v1/auth/login", """{"username":"$USERNAME","password":"wrong password value"}""", 401)
        assertThat(accountLong("failed_attempts")).isEqualTo(5)
        assertThat(accountInstant("locked_until")).isEqualTo(lockedUntil)
    }

    @Test
    fun `failure after prior window starts a new window at one`() {
        jdbc.update(
            "UPDATE iam.user_account SET failed_attempts = 4, failed_window_started_at = ?, locked_until = NULL WHERE principal_id = ?",
            sql(BASE_TIME.minus(Duration.ofMinutes(16))),
            USER_ID,
        )

        postJson("/api/v1/auth/login", """{"username":"$USERNAME","password":"wrong password value"}""", 401)

        assertThat(accountLong("failed_attempts")).isEqualTo(1)
        assertThat(accountInstant("failed_window_started_at")).isEqualTo(BASE_TIME)
        assertThat(accountInstant("locked_until")).isNull()
    }

    @Test
    fun `failure window includes the tick before fifteen minutes and expires at the exact boundary`() {
        jdbc.update(
            "UPDATE iam.user_account SET failed_attempts = 4, failed_window_started_at = ?, locked_until = NULL WHERE principal_id = ?",
            sql(BASE_TIME),
            USER_ID,
        )
        clock.current = BASE_TIME.plus(Duration.ofMinutes(15)).minusNanos(1_000)

        postJson("/api/v1/auth/login", """{"username":"$USERNAME","password":"wrong password value"}""", 401)

        assertThat(accountLong("failed_attempts")).isEqualTo(5)
        assertThat(accountInstant("failed_window_started_at")).isEqualTo(BASE_TIME)
        assertThat(accountInstant("locked_until")).isEqualTo(clock.instant().plus(Duration.ofMinutes(15)))

        jdbc.update(
            "UPDATE iam.user_account SET failed_attempts = 4, failed_window_started_at = ?, locked_until = NULL WHERE principal_id = ?",
            sql(BASE_TIME),
            USER_ID,
        )
        clock.current = BASE_TIME.plus(Duration.ofMinutes(15))

        postJson("/api/v1/auth/login", """{"username":"$USERNAME","password":"wrong password value"}""", 401)

        assertThat(accountLong("failed_attempts")).isEqualTo(1)
        assertThat(accountInstant("failed_window_started_at")).isEqualTo(clock.instant())
        assertThat(accountInstant("locked_until")).isNull()
    }

    @Test
    fun `five concurrent wrong passwords from one snapshot are all counted and lock the account`() {
        val verificationEntered = CountDownLatch(5)
        val releaseVerification = CountDownLatch(1)
        val concurrentService = AuthService(
            principals,
            PasswordService(ConcurrentWrongPasswordEncoder(verificationEntered, releaseVerification)),
            mock(SessionRepository::class.java),
            mock(AccessTokenService::class.java),
            transactions,
            clock,
        )
        val pool = Executors.newFixedThreadPool(5)
        try {
            val attempts = (1..5).map {
                pool.submit { runCatching { concurrentService.login(USERNAME, "wrong password value") } }
            }

            assertThat(verificationEntered.await(15, TimeUnit.SECONDS)).isTrue()
            assertThat(accountLong("failed_attempts")).isZero()
            releaseVerification.countDown()
            attempts.forEach { it.get(20, TimeUnit.SECONDS) }

            assertThat(accountLong("failed_attempts")).isEqualTo(5)
            assertThat(accountInstant("failed_window_started_at")).isEqualTo(BASE_TIME)
            assertThat(accountInstant("locked_until")).isEqualTo(BASE_TIME.plus(Duration.ofMinutes(15)))
        } finally {
            releaseVerification.countDown()
            pool.shutdownNow()
            assertThat(pool.awaitTermination(15, TimeUnit.SECONDS)).isTrue()
        }
    }

    @Test
    fun `successful login resets failures updates last login and rehashes a weaker accepted password`() {
        val weaker = org.springframework.security.crypto.argon2.Argon2PasswordEncoder(16, 32, 1, 1 shl 14, 2).encode(PASSWORD)
        jdbc.update(
            "UPDATE iam.user_account SET password_hash = ?, failed_attempts = 3, failed_window_started_at = ? WHERE principal_id = ?",
            weaker,
            sql(BASE_TIME.minusSeconds(60)),
            USER_ID,
        )

        postJson("/api/v1/auth/login", """{"username":"$USERNAME","password":"$PASSWORD"}""", 200)

        assertThat(accountLong("failed_attempts")).isZero()
        assertThat(accountInstant("failed_window_started_at")).isNull()
        assertThat(accountInstant("locked_until")).isNull()
        assertThat(accountInstant("last_login_at")).isEqualTo(BASE_TIME)
        val rehashed = jdbc.queryForObject("SELECT password_hash FROM iam.user_account WHERE principal_id = ?", String::class.java, USER_ID)!!
        assertThat(rehashed).isNotEqualTo(weaker)
        assertThat(passwords.matches(PASSWORD, rehashed)).isTrue()
        assertThat(passwords.needsRehash(rehashed)).isFalse()
    }

    @Test
    fun `login rejects unknown fields and malformed JSON with existing validation problem`() {
        listOf(
            """{"username":"$USERNAME","password":"$PASSWORD","admin":true}""",
            """{"username":"$USERNAME","password":"$PASSWORD""",
        ).forEach { body ->
            val problem = postJson("/api/v1/auth/login", body, 400)
            assertThat(problem["code"].asText()).isEqualTo("OCC-API-VALIDATION")
            assertThat(problem["detail"].asText()).isNotBlank()
        }
    }

    @Test
    fun `null and malformed password hashes fail generically without creating sessions`() {
        listOf(null, "not-an-argon-hash").forEach { hash ->
            jdbc.update("UPDATE iam.user_account SET password_hash = ? WHERE principal_id = ?", hash, USER_ID)
            assertInvalidCredentials(postJson(
                "/api/v1/auth/login",
                """{"username":"$USERNAME","password":"$PASSWORD"}""",
                401,
            ))
        }
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM iam.auth_session WHERE principal_id = ?",
            Long::class.java,
            USER_ID,
        )).isZero()
    }

    @Test
    fun `request and response DTO strings redact credentials and tokens`() {
        val token = "a".repeat(43)
        assertThat(LoginRequest(USERNAME, PASSWORD).toString()).doesNotContain(PASSWORD)
        assertThat(RefreshRequest(token).toString()).doesNotContain(token)
        assertThat(TokenResponse("Bearer", "access-secret", token, 900, com.innorder.occ.iam.CurrentUser(
            USER_ID, USERNAME, "Alice Operator", "ACTIVE", emptyList(),
        )).toString()).doesNotContain("access-secret").doesNotContain(token)
    }

    @Test
    fun `refresh rotates tokens and replay revokes the replacement chain`() {
        val login = login()
        val firstRefresh = login["refreshToken"].asText()

        val rotated = postJson("/api/v1/auth/refresh", """{"refreshToken":"$firstRefresh"}""", 200)
        assertTokenResponse(rotated)
        assertThat(rotated["refreshToken"].asText()).isNotEqualTo(firstRefresh)
        assertThat(rotated["accessToken"].asText()).isNotEqualTo(login["accessToken"].asText())

        assertInvalidCredentials(postJson("/api/v1/auth/refresh", """{"refreshToken":"$firstRefresh"}""", 401))
        assertInvalidCredentials(postJson("/api/v1/auth/refresh", """{"refreshToken":"${rotated["refreshToken"].asText()}"}""", 401))
    }

    @Test
    fun `concurrent refresh returns at most one token response and replay leaves none usable`() {
        val refreshToken = login()["refreshToken"].asText()
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val requests = (1..2).map {
                pool.submit<Pair<Int, JsonNode>> {
                    start.await()
                    rawPost("/api/v1/auth/refresh", """{"refreshToken":"$refreshToken"}""")
                }
            }
            start.countDown()
            val results = requests.map { it.get(20, TimeUnit.SECONDS) }
            assertThat(results.map { it.first }.sorted()).containsExactly(200, 401)
            val winner = results.single { it.first == 200 }.second
            assertInvalidCredentials(postJson(
                "/api/v1/auth/refresh",
                """{"refreshToken":"${winner["refreshToken"].asText()}"}""",
                401,
            ))
        } finally {
            start.countDown()
            pool.shutdownNow()
            assertThat(pool.awaitTermination(15, TimeUnit.SECONDS)).isTrue()
        }
    }

    @Test
    fun `refresh state failure consumes the old token and leaves no replacement usable`() {
        val refreshToken = login()["refreshToken"].asText()
        jdbc.update("UPDATE iam.principal SET status = 'DISABLED' WHERE id = ?", USER_ID)

        assertInvalidCredentials(postJson("/api/v1/auth/refresh", """{"refreshToken":"$refreshToken"}""", 401))
        jdbc.update("UPDATE iam.principal SET status = 'ACTIVE' WHERE id = ?", USER_ID)
        assertInvalidCredentials(postJson("/api/v1/auth/refresh", """{"refreshToken":"$refreshToken"}""", 401))
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM iam.auth_session WHERE principal_id = ? AND revoked_at IS NULL",
            Long::class.java,
            USER_ID,
        )).isZero()
    }

    @Test
    fun `expired refresh token fails generically without creating a replacement`() {
        val refreshToken = login()["refreshToken"].asText()
        clock.advance(Duration.ofDays(7))

        assertInvalidCredentials(postJson("/api/v1/auth/refresh", """{"refreshToken":"$refreshToken"}""", 401))
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM iam.auth_session WHERE principal_id = ?",
            Long::class.java,
            USER_ID,
        )).isEqualTo(1L)
    }

    @Test
    fun `post rotation exceptions commit independent fail closed revocation`() {
        val scenarios = listOf<(PrincipalRepository) -> AccessTokenService>(
            { principals ->
                `when`(principals.lockCurrentUser(USER_ID)).thenThrow(IllegalStateException("current user lookup failed"))
                mock(AccessTokenService::class.java)
            },
            { principals ->
                `when`(principals.lockCurrentUser(USER_ID)).thenReturn(currentUser())
                `when`(principals.customerInstanceId()).thenThrow(IllegalStateException("customer lookup failed"))
                mock(AccessTokenService::class.java)
            },
            { principals ->
                `when`(principals.lockCurrentUser(USER_ID)).thenReturn(currentUser())
                `when`(principals.customerInstanceId()).thenReturn(INSTANCE_ID)
                mock(AccessTokenService::class.java) { invocation ->
                    if (invocation.method.name == "issue") throw IllegalStateException("JWT issuance failed")
                    RETURNS_DEFAULTS.answer(invocation)
                }
            },
            { principals ->
                `when`(principals.lockCurrentUser(USER_ID)).thenReturn(currentUser())
                `when`(principals.customerInstanceId()).thenReturn(INSTANCE_ID)
                mock(AccessTokenService::class.java) { invocation ->
                    when (invocation.method.name) {
                        "issue" -> "access-token"
                        "expiresInSeconds" -> throw IllegalStateException("response construction failed")
                        else -> RETURNS_DEFAULTS.answer(invocation)
                    }
                }
            },
        )

        scenarios.forEach { configureFailure ->
            jdbc.update("DELETE FROM iam.auth_session WHERE principal_id = ?", USER_ID)
            val deterministicSessions = SessionRepository(jdbc, transactions, clock, SequenceSecureRandom())
            val original = deterministicSessions.create(USER_ID, 0, Duration.ofDays(7), null)
            val replacementToken = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(ByteArray(32) { index -> (index + 32).toByte() })
            val principals = mock(PrincipalRepository::class.java)
            val tokens = configureFailure(principals)
            val service = AuthService(principals, passwords, deterministicSessions, tokens, transactions, clock)

            assertThatThrownBy { service.refresh(original.refreshToken.exposeValue()) }
                .isInstanceOf(IllegalStateException::class.java)

            assertThat(deterministicSessions.validate(original.refreshToken)).isEqualTo(SessionValidation.Invalid)
            assertThat(deterministicSessions.validate(replacementToken)).isEqualTo(SessionValidation.Invalid)
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM iam.auth_session WHERE principal_id = ? AND revoked_at IS NULL",
                Long::class.java,
                USER_ID,
            )).isZero()
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM iam.auth_session WHERE principal_id = ?",
                Long::class.java,
                USER_ID,
            )).isEqualTo(1L)
        }
    }

    @Test
    fun `logout requires token ownership revokes descendants and repeated bearer use is unauthorized`() {
        val alice = login()
        seedSecondUser()
        val bob = postJson("/api/v1/auth/login", """{"username":"bob@example.com","password":"$PASSWORD"}""", 200)

        val mismatch = authenticatedPost(
            "/api/v1/auth/logout",
            alice["accessToken"].asText(),
            """{"refreshToken":"${bob["refreshToken"].asText()}"}""",
        )
        assertThat(mismatch.first).isEqualTo(401)
        assertInvalidCredentials(mismatch.second)
        assertThat(postJson("/api/v1/auth/refresh", """{"refreshToken":"${bob["refreshToken"].asText()}"}""", 200)["user"]["username"].asText())
            .isEqualTo("bob@example.com")

        val logout = authenticatedPost(
            "/api/v1/auth/logout",
            alice["accessToken"].asText(),
            """{"refreshToken":"${alice["refreshToken"].asText()}"}""",
        )
        assertThat(logout.first).isEqualTo(204)
        assertThat(logout.second.isMissingNode || logout.second.isNull || logout.second.toString().isEmpty()).isTrue()

        val repeated = authenticatedPost(
            "/api/v1/auth/logout",
            alice["accessToken"].asText(),
            """{"refreshToken":"${alice["refreshToken"].asText()}"}""",
        )
        assertThat(repeated.first).isEqualTo(401)
        assertBearerAuthenticationFailure(repeated.second)
    }

    @Test
    fun `me reads current database truth and sorted capabilities from active role relationships`() {
        val relationshipId = seedOperatorRole()
        try {
            val login = login()
            jdbc.update("UPDATE iam.principal SET display_name = 'Alice Renamed' WHERE id = ?", USER_ID)

            val result = mockMvc.get("/api/v1/me") {
                header("Authorization", "Bearer ${login["accessToken"].asText()}")
            }.andExpect { status { isOk() } }.andReturn()
            val me = objectMapper.readTree(result.response.contentAsString)

            assertThat(me.fieldNames().asSequence().toSet())
                .containsExactlyInAnyOrder("id", "username", "displayName", "status", "capabilities")
            assertThat(me["id"].asText()).isEqualTo(USER_ID.toString())
            assertThat(me["username"].asText()).isEqualTo(USERNAME)
            assertThat(me["displayName"].asText()).isEqualTo("Alice Renamed")
            assertThat(me["status"].asText()).isEqualTo("ACTIVE")
            assertThat(me["capabilities"].map(JsonNode::asText)).containsExactly("occ.execute", "occ.read")
            assertThat(me.toString()).doesNotContain("profile").doesNotContain("password").doesNotContain("session")
        } finally {
            jdbc.update("UPDATE authz.relationship SET revoked_at = statement_timestamp() WHERE id = ? AND revoked_at IS NULL", relationshipId)
        }
    }

    @Test
    fun `different key auth relevant relationship to administrator role grants no capabilities`() {
        val relationshipId = seedUnrelatedAdministratorRole()
        try {
            val login = login()
            assertThat(login["user"]["capabilities"]).isEmpty()

            val result = mockMvc.get("/api/v1/me") {
                header("Authorization", "Bearer ${login["accessToken"].asText()}")
            }.andExpect { status { isOk() } }.andReturn()
            assertThat(objectMapper.readTree(result.response.contentAsString)["capabilities"]).isEmpty()
        } finally {
            jdbc.update("UPDATE authz.relationship SET revoked_at = statement_timestamp() WHERE id = ? AND revoked_at IS NULL", relationshipId)
        }
    }

    @Test
    fun `same role assignment key under a different definition ID grants no capabilities`() {
        val relationshipId = seedSameKeyOtherPackageAdministratorRole()
        try {
            val login = login()
            assertThat(login["user"]["capabilities"]).isEmpty()

            val result = mockMvc.get("/api/v1/me") {
                header("Authorization", "Bearer ${login["accessToken"].asText()}")
            }.andExpect { status { isOk() } }.andReturn()
            assertThat(objectMapper.readTree(result.response.contentAsString)["capabilities"]).isEmpty()
        } finally {
            jdbc.update("UPDATE authz.relationship SET revoked_at = statement_timestamp() WHERE id = ? AND revoked_at IS NULL", relationshipId)
        }
    }

    @Test
    fun `me database credential failure uses business code while invalid bearer stays security code`() {
        val login = login()
        val authenticated = authenticatedPrincipal()
        jdbc.update("DELETE FROM iam.user_account WHERE principal_id = ?", USER_ID)

        val businessResult = mockMvc.get("/api/v1/me") {
            with(authentication(authenticated))
        }.andExpect { status { isUnauthorized() } }.andReturn()
        assertInvalidCredentials(objectMapper.readTree(businessResult.response.contentAsString))

        val bearerResult = mockMvc.get("/api/v1/me") {
            header("Authorization", "Bearer not-a-valid-jwt")
        }.andExpect { status { isUnauthorized() } }.andReturn()
        assertBearerAuthenticationFailure(objectMapper.readTree(bearerResult.response.contentAsString))
    }

    @Test
    fun `all endpoint business credential failures have one identical problem shape`() {
        val problems = mutableListOf<JsonNode>()
        problems.add(postJson(
            "/api/v1/auth/login",
            """{"username":"missing@example.com","password":"$PASSWORD"}""",
            401,
        ))

        val login = login()
        val authenticated = authenticatedPrincipal()
        problems.add(postJson(
            "/api/v1/auth/refresh",
            """{"refreshToken":"${"a".repeat(43)}"}""",
            401,
        ))
        val logout = authenticatedPost(
            "/api/v1/auth/logout",
            login["accessToken"].asText(),
            """{"refreshToken":"${"b".repeat(43)}"}""",
        )
        assertThat(logout.first).isEqualTo(401)
        problems.add(logout.second)

        jdbc.update("DELETE FROM iam.user_account WHERE principal_id = ?", USER_ID)
        val me = mockMvc.get("/api/v1/me") {
            with(authentication(authenticated))
        }.andExpect { status { isUnauthorized() } }.andReturn()
        problems.add(objectMapper.readTree(me.response.contentAsString))

        problems.forEach(::assertInvalidCredentials)
        val normalized = problems.map { problem ->
            problem.fields().asSequence()
                .filter { it.key != "correlationId" }
                .associate { it.key to it.value }
        }
        assertThat(normalized.distinct()).hasSize(1)
    }

    @Test
    fun `refresh and logout reject unknown fields without token disclosure`() {
        val login = login()
        val refresh = login["refreshToken"].asText()
        val refreshProblem = postJson("/api/v1/auth/refresh", """{"refreshToken":"$refresh","extra":true}""", 400)
        assertThat(refreshProblem["code"].asText()).isEqualTo("OCC-API-VALIDATION")
        assertThat(refreshProblem.toString()).doesNotContain(refresh)

        val logout = authenticatedPost(
            "/api/v1/auth/logout",
            login["accessToken"].asText(),
            """{"refreshToken":"$refresh","extra":true}""",
        )
        assertThat(logout.first).isEqualTo(400)
        assertThat(logout.second["code"].asText()).isEqualTo("OCC-API-VALIDATION")
        assertThat(logout.second.toString()).doesNotContain(refresh)
    }

    private fun seedCatalog() {
        if (jdbc.queryForObject("SELECT count(*) FROM catalog.entity_type_version WHERE id = ?", Long::class.java, TYPE_VERSION_ID) == 1L) return
        jdbc.update("INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", PACKAGE_ID, "auth-lifecycle", "Auth Lifecycle", "ACTIVE")
        jdbc.update("INSERT INTO catalog.package_version(id, package_id, semver, status) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", VERSION_ID, PACKAGE_ID, "1.0.0", "DRAFT")
        jdbc.update("INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", TYPE_ID, PACKAGE_ID, "auth-lifecycle-user", "Auth Lifecycle User", "PRINCIPAL")
        jdbc.update("INSERT INTO catalog.entity_type_version(id, entity_type_id, package_version_id, schema_version, json_schema) VALUES (?, ?, ?, ?, '{}'::jsonb) ON CONFLICT DO NOTHING", TYPE_VERSION_ID, TYPE_ID, VERSION_ID, 1)
        jdbc.update("INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, ?, ?, ?)", OTHER_PACKAGE_ID, "auth-lifecycle-other", "Auth Lifecycle Other", "ACTIVE")
        jdbc.update("INSERT INTO catalog.package_version(id, package_id, semver, status) VALUES (?, ?, ?, ?)", OTHER_VERSION_ID, OTHER_PACKAGE_ID, "1.0.0", "DRAFT")
        jdbc.update(
            """INSERT INTO catalog.relation_definition(id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality, auth_relevant)
               VALUES (?, ?, 'platform.role-assignment', ?, ?, 'MANY_TO_MANY', true),
                      (?, ?, 'platform.unrelated-admin-link', ?, ?, 'MANY_TO_MANY', true),
                      (?, ?, 'platform.role-assignment', ?, ?, 'MANY_TO_MANY', true)""",
            RELATION_DEFINITION_ID,
            VERSION_ID,
            TYPE_ID,
            TYPE_ID,
            UNRELATED_RELATION_DEFINITION_ID,
            VERSION_ID,
            TYPE_ID,
            TYPE_ID,
            SAME_KEY_OTHER_RELATION_DEFINITION_ID,
            OTHER_VERSION_ID,
            TYPE_ID,
            TYPE_ID,
        )
    }

    private fun seedUser(hash: String?) {
        jdbc.update("INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state) VALUES (?, ?, ?, ?, ?)", USER_ID, TYPE_ID, TYPE_VERSION_ID, "user:$USERNAME", "ACTIVE")
        jdbc.update("INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, ?, ?, ?)", USER_ID, "USER", "Alice Operator", "ACTIVE")
        jdbc.update("INSERT INTO iam.user_account(principal_id, username, password_hash) VALUES (?, ?, ?)", USER_ID, USERNAME, hash)
    }

    private fun seedSecondUser() {
        jdbc.update("INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state) VALUES (?, ?, ?, ?, ?)", SECOND_USER_ID, TYPE_ID, TYPE_VERSION_ID, "user:bob@example.com", "ACTIVE")
        jdbc.update("INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, ?, ?, ?)", SECOND_USER_ID, "USER", "Bob Viewer", "ACTIVE")
        jdbc.update("INSERT INTO iam.user_account(principal_id, username, password_hash) VALUES (?, ?, ?)", SECOND_USER_ID, "bob@example.com", passwords.encode(PASSWORD))
    }

    private fun seedOperatorRole(): UUID {
        jdbc.update(
            """UPDATE catalog.package_version SET status = 'PUBLISHED', content_hash = repeat('a', 64), published_at = statement_timestamp()
               WHERE id = ? AND status IN ('DRAFT', 'VALIDATED')""",
            VERSION_ID,
        )
        jdbc.update("INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", ROLE_ID, TYPE_ID, TYPE_VERSION_ID, "role:operator", "ACTIVE")
        jdbc.update("INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", ROLE_ID, "ROLE", "Operator", "ACTIVE")
        val relationshipId = UUID.randomUUID()
        jdbc.update(
            """INSERT INTO authz.relationship(id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref)
               VALUES (?, ?, ?, ?, 'ADMIN', 'auth-test')""",
            relationshipId,
            RELATION_DEFINITION_ID,
            USER_ID,
            ROLE_ID,
        )
        return relationshipId
    }

    private fun seedUnrelatedAdministratorRole(): UUID {
        jdbc.update(
            """UPDATE catalog.package_version SET status = 'PUBLISHED', content_hash = repeat('a', 64), published_at = statement_timestamp()
               WHERE id = ? AND status IN ('DRAFT', 'VALIDATED')""",
            VERSION_ID,
        )
        jdbc.update("INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", ADMIN_ROLE_ID, TYPE_ID, TYPE_VERSION_ID, "role:administrator", "ACTIVE")
        jdbc.update("INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", ADMIN_ROLE_ID, "ROLE", "Administrator", "ACTIVE")
        val relationshipId = UUID.randomUUID()
        jdbc.update(
            """INSERT INTO authz.relationship(id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref)
               VALUES (?, ?, ?, ?, 'ADMIN', 'auth-test-unrelated')""",
            relationshipId,
            UNRELATED_RELATION_DEFINITION_ID,
            USER_ID,
            ADMIN_ROLE_ID,
        )
        return relationshipId
    }

    private fun seedSameKeyOtherPackageAdministratorRole(): UUID {
        jdbc.update(
            """UPDATE catalog.package_version SET status = 'PUBLISHED', content_hash = repeat('a', 64), published_at = statement_timestamp()
               WHERE id = ? AND status IN ('DRAFT', 'VALIDATED')""",
            VERSION_ID,
        )
        jdbc.update(
            """UPDATE catalog.package_version SET status = 'PUBLISHED', content_hash = repeat('b', 64), published_at = statement_timestamp()
               WHERE id = ? AND status IN ('DRAFT', 'VALIDATED')""",
            OTHER_VERSION_ID,
        )
        jdbc.update("INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", ADMIN_ROLE_ID, TYPE_ID, TYPE_VERSION_ID, "role:administrator", "ACTIVE")
        jdbc.update("INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", ADMIN_ROLE_ID, "ROLE", "Administrator", "ACTIVE")
        val relationshipId = UUID.randomUUID()
        jdbc.update(
            """INSERT INTO authz.relationship(id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref)
               VALUES (?, ?, ?, ?, 'ADMIN', 'auth-test-same-key-other-package')""",
            relationshipId,
            SAME_KEY_OTHER_RELATION_DEFINITION_ID,
            USER_ID,
            ADMIN_ROLE_ID,
        )
        return relationshipId
    }

    private fun login(): JsonNode = postJson(
        "/api/v1/auth/login",
        """{"username":"$USERNAME","password":"$PASSWORD"}""",
        200,
    )

    private fun currentUser(): CurrentUser = CurrentUser(
        USER_ID,
        USERNAME,
        "Alice Operator",
        "ACTIVE",
        emptyList(),
    )

    private fun authenticatedPrincipal(): UsernamePasswordAuthenticationToken {
        val sessionId = jdbc.queryForObject(
            "SELECT id FROM iam.auth_session WHERE principal_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
            UUID::class.java,
            USER_ID,
        )!!
        val tokenVersion = jdbc.queryForObject(
            "SELECT password_version FROM iam.user_account WHERE principal_id = ?",
            Int::class.java,
            USER_ID,
        )!!
        return UsernamePasswordAuthenticationToken.authenticated(
            AccessTokenPrincipal(USER_ID, INSTANCE_ID, sessionId, tokenVersion),
            null,
            emptyList(),
        )
    }

    private fun assertTokenResponse(response: JsonNode) {
        assertThat(response.fieldNames().asSequence().toSet())
            .containsExactlyInAnyOrder("tokenType", "accessToken", "refreshToken", "expiresIn", "user")
        assertThat(response["user"].fieldNames().asSequence().toSet())
            .containsExactlyInAnyOrder("id", "username", "displayName", "status", "capabilities")
    }

    private fun assertInvalidCredentials(problem: JsonNode) {
        assertThat(problem.fieldNames().asSequence().toSet())
            .containsExactlyInAnyOrder("type", "title", "status", "code", "correlationId")
        assertThat(problem["type"].asText()).isEqualTo("https://innorder.local/problems/invalid-credentials")
        assertThat(problem["title"].asText()).isEqualTo("Invalid credentials")
        assertThat(problem["status"].asInt()).isEqualTo(401)
        assertThat(problem["code"].asText()).isEqualTo("OCC-AUTH-INVALID-CREDENTIALS")
        assertThat(problem.toString()).doesNotContain(USERNAME).doesNotContain("refreshToken")
    }

    private fun assertBearerAuthenticationFailure(problem: JsonNode) {
        assertThat(problem["status"].asInt()).isEqualTo(401)
        assertThat(problem["code"].asText()).isEqualTo("OCC-API-AUTHENTICATION")
    }

    private fun postJson(path: String, body: String, expectedStatus: Int): JsonNode {
        val result = mockMvc.post(path) {
            contentType = MediaType.APPLICATION_JSON
            content = body
        }.andExpect { status { isEqualTo(expectedStatus) } }.andReturn()
        return objectMapper.readTree(result.response.contentAsString)
    }

    private fun rawPost(path: String, body: String): Pair<Int, JsonNode> {
        val result = mockMvc.post(path) {
            contentType = MediaType.APPLICATION_JSON
            content = body
        }.andReturn()
        return result.response.status to objectMapper.readTree(result.response.contentAsString)
    }

    private fun authenticatedPost(path: String, accessToken: String, body: String): Pair<Int, JsonNode> {
        val result = mockMvc.post(path) {
            header("Authorization", "Bearer $accessToken")
            contentType = MediaType.APPLICATION_JSON
            content = body
        }.andReturn()
        val node = if (result.response.contentAsByteArray.isEmpty()) objectMapper.missingNode() else objectMapper.readTree(result.response.contentAsString)
        return result.response.status to node
    }

    private fun accountLong(column: String): Long = jdbc.queryForObject(
        "SELECT $column FROM iam.user_account WHERE principal_id = ?",
        Long::class.java,
        USER_ID,
    )!!

    private fun accountInstant(column: String): Instant? = jdbc.queryForObject(
        "SELECT $column FROM iam.user_account WHERE principal_id = ?",
        Instant::class.java,
        USER_ID,
    )

    private fun sql(instant: Instant): OffsetDateTime = OffsetDateTime.ofInstant(instant, ZoneOffset.UTC)

    @TestConfiguration
    class ClockConfiguration {
        @Bean
        @Primary
        fun authTestClock(): MutableClock = MutableClock(BASE_TIME)
    }

    class MutableClock(var current: Instant) : Clock() {
        override fun instant(): Instant = current
        override fun getZone(): ZoneId = ZoneOffset.UTC
        override fun withZone(zone: ZoneId): Clock = this
        fun advance(duration: Duration) { current = current.plus(duration) }
    }

    private class SequenceSecureRandom(private var next: Int = 0) : SecureRandom() {
        override fun nextBytes(bytes: ByteArray) {
            bytes.indices.forEach { bytes[it] = next++.toByte() }
        }
    }

    private class ConcurrentWrongPasswordEncoder(
        private val entered: CountDownLatch,
        private val release: CountDownLatch,
    ) : PasswordEncoder {
        override fun encode(rawPassword: CharSequence): String = error("not used")
        override fun matches(rawPassword: CharSequence, encodedPassword: String): Boolean {
            entered.countDown()
            check(release.await(15, TimeUnit.SECONDS)) { "Timed out waiting to release concurrent password checks" }
            return false
        }
    }

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        private const val USERNAME = "alice@example.com"
        private const val PASSWORD = "correct horse battery staple"
        private val BASE_TIME = Instant.parse("2026-07-31T12:00:00Z")
        private val PACKAGE_ID = UUID.fromString("61000000-0000-7000-8000-000000000001")
        private val VERSION_ID = UUID.fromString("61000000-0000-7000-8000-000000000002")
        private val TYPE_ID = UUID.fromString("61000000-0000-7000-8000-000000000003")
        private val TYPE_VERSION_ID = UUID.fromString("61000000-0000-7000-8000-000000000004")
        private val USER_ID = UUID.fromString("61000000-0000-7000-8000-000000000005")
        private val INSTANCE_ID = UUID.fromString("00000000-0000-7000-8000-000000000001")
        private val ROLE_ID = UUID.fromString("61000000-0000-7000-8000-000000000006")
        private val SECOND_USER_ID = UUID.fromString("61000000-0000-7000-8000-000000000007")
        private val RELATION_DEFINITION_ID = PrincipalRepository.PLATFORM_ROLE_ASSIGNMENT_RELATION_DEFINITION_ID
        private val ADMIN_ROLE_ID = UUID.fromString("61000000-0000-7000-8000-000000000009")
        private val UNRELATED_RELATION_DEFINITION_ID = UUID.fromString("61000000-0000-7000-8000-000000000010")
        private val OTHER_PACKAGE_ID = UUID.fromString("61000000-0000-7000-8000-000000000011")
        private val OTHER_VERSION_ID = UUID.fromString("61000000-0000-7000-8000-000000000012")
        private val SAME_KEY_OTHER_RELATION_DEFINITION_ID = UUID.fromString("61000000-0000-7000-8000-000000000013")

        @Container
        @JvmStatic
        val postgres: PostgreSQLContainer<*> = PostgreSQLContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("innorder_occ")
            .withUsername("innorder_admin")
            .withPassword("admin-test-only")
            .withCopyFileToContainer(MountableFile.forClasspathResource("postgres-test-init.sql"), "/docker-entrypoint-initdb.d/010-test-roles.sql")

        @DynamicPropertySource
        @JvmStatic
        fun databaseProperties(registry: DynamicPropertyRegistry) {
            registry.add("spring.datasource.url", postgres::getJdbcUrl)
            registry.add("spring.datasource.username") { "innorder_runtime" }
            registry.add("spring.datasource.password") { "runtime-test-only" }
            registry.add("spring.flyway.url", postgres::getJdbcUrl)
            registry.add("spring.flyway.user") { "innorder_flyway" }
            registry.add("spring.flyway.password") { "flyway-test-only" }
            registry.add("flowable.database-schema") { "flowable" }
            registry.add("occ.status-probes.external-enabled") { "false" }
        }
    }
}
