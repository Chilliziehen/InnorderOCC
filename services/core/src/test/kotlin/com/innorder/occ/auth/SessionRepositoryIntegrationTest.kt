package com.innorder.occ.auth

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.support.JdbcTransactionManager
import org.springframework.test.annotation.DirtiesContext
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.transaction.support.TransactionTemplate
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import javax.sql.DataSource

@SpringBootTest
@Testcontainers(disabledWithoutDocker = true)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class SessionRepositoryIntegrationTest(
    @param:Autowired private val jdbcTemplate: JdbcTemplate,
    @param:Autowired private val dataSource: DataSource,
) {
    private val clock = MutableClock(BASE_TIME)
    private lateinit var repository: SessionRepository

    @BeforeEach
    fun reset() {
        jdbcTemplate.update("DELETE FROM iam.auth_session")
        jdbcTemplate.update("INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", PACKAGE_ID, "auth-test", "Auth Test", "ACTIVE")
        jdbcTemplate.update("INSERT INTO catalog.package_version(id, package_id, semver, status) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", VERSION_ID, PACKAGE_ID, "1.0.0", "DRAFT")
        jdbcTemplate.update("INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", TYPE_ID, PACKAGE_ID, "auth-user", "Auth User", "PRINCIPAL")
        jdbcTemplate.update("INSERT INTO catalog.entity_type_version(id, entity_type_id, package_version_id, schema_version, json_schema) VALUES (?, ?, ?, ?, '{}'::jsonb) ON CONFLICT DO NOTHING", TYPE_VERSION_ID, TYPE_ID, VERSION_ID, 1)
        jdbcTemplate.update("INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", PRINCIPAL_ID, TYPE_ID, TYPE_VERSION_ID, "auth:user", "ACTIVE")
        jdbcTemplate.update("INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", PRINCIPAL_ID, "USER", "Auth User", "ACTIVE")
        jdbcTemplate.update("INSERT INTO iam.user_account(principal_id, username) VALUES (?, ?) ON CONFLICT DO NOTHING", PRINCIPAL_ID, "auth.user")
        jdbcTemplate.update("UPDATE iam.principal SET status = 'ACTIVE' WHERE id = ?", PRINCIPAL_ID)
        jdbcTemplate.update("UPDATE authz.entity SET state = 'ACTIVE' WHERE id = ?", PRINCIPAL_ID)
        jdbcTemplate.update("UPDATE iam.user_account SET password_version = 0 WHERE principal_id = ?", PRINCIPAL_ID)
        clock.instant = BASE_TIME
        repository = repository(SequenceSecureRandom())
    }

    @Test
    fun `creates 256 bit URL safe token while database stores only its SHA-256 hash`() {
        jdbcTemplate.update("UPDATE iam.user_account SET password_version = 7 WHERE principal_id = ?", PRINCIPAL_ID)
        val issued = repository.create(PRINCIPAL_ID, 7, Duration.ofDays(7), "desktop:test")
        val rawToken = issued.refreshToken.exposeValue()
        val stored = jdbcTemplate.queryForObject("SELECT refresh_token_hash FROM iam.auth_session WHERE id = ?", String::class.java, issued.session.id)
        val expectedHash = MessageDigest.getInstance("SHA-256")
            .digest(rawToken.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

        assertThat(rawToken).hasSize(43).matches("^[A-Za-z0-9_-]{43}${'$'}")
        assertThat(issued.refreshToken.toString()).isEqualTo("RefreshToken([REDACTED])")
        assertThat(issued.toString()).doesNotContain(rawToken)
        assertThat(stored).isEqualTo(expectedHash).hasSize(64).matches("^[0-9a-f]{64}${'$'}").doesNotContain(rawToken)
        assertThat(issued.session.clientFingerprint).isEqualTo("desktop:test")
    }

    @Test
    fun `logout revokes an active session and makes subsequent validation generic invalid`() {
        val issued = repository.create(PRINCIPAL_ID, 0, Duration.ofHours(1), null)

        assertThat(repository.validate(issued.refreshToken)).isInstanceOf(SessionValidation.Active::class.java)
        assertThat(repository.revoke(issued.session.id)).isTrue()

        assertThat(jdbcTemplate.queryForObject(
            "SELECT revoked_at IS NOT NULL FROM iam.auth_session WHERE id = ?",
            Boolean::class.java,
            issued.session.id,
        )).isTrue()
        assertThat(repository.validate(issued.refreshToken)).isEqualTo(SessionValidation.Invalid)
    }

    @Test
    fun `revoking a rotated session revokes its active replacement`() {
        val first = repository.create(PRINCIPAL_ID, 0, Duration.ofHours(1), null)
        val replacement = (repository.rotate(first.refreshToken, Duration.ofHours(1)) as SessionRotation.Rotated).issued

        assertThat(repository.revoke(first.session.id)).isTrue()

        assertThat(repository.validate(replacement.refreshToken)).isEqualTo(SessionValidation.Invalid)
        assertThat(activeSessionCount()).isZero()
    }

    @Test
    fun `concurrent rotation followed by waiting revoke leaves no active replacement`() {
        val first = repository.create(PRINCIPAL_ID, 0, Duration.ofHours(1), null)
        val rotationEntered = CountDownLatch(1)
        val allowRotation = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        val futures = mutableListOf<Future<*>>()
        try {
            val rotation = pool.submit<SessionRotation> {
                repository(BlockingSecureRandom(rotationEntered, allowRotation))
                    .rotate(first.refreshToken, Duration.ofHours(1))
            }
            futures += rotation
            assertThat(rotationEntered.await(15, TimeUnit.SECONDS)).isTrue()
            val revocation = pool.submit<Boolean> { repository.revoke(first.session.id) }
            futures += revocation
            allowRotation.countDown()

            assertThat(rotation.get(15, TimeUnit.SECONDS)).isInstanceOf(SessionRotation.Rotated::class.java)
            assertThat(revocation.get(15, TimeUnit.SECONDS)).isTrue()
            assertThat(activeSessionCount()).isZero()
        } finally {
            allowRotation.countDown()
            shutdown(pool, futures)
        }
    }

    @Test
    fun `replacement chains beyond sixty four links revoke every active session for the principal`() {
        val longChainRepository = repository(SecureRandom())
        val root = longChainRepository.create(PRINCIPAL_ID, 0, Duration.ofHours(1), null)
        longChainRepository.create(PRINCIPAL_ID, 0, Duration.ofHours(1), null)
        var current = root
        repeat(65) {
            current = (longChainRepository.rotate(current.refreshToken, Duration.ofHours(1)) as SessionRotation.Rotated).issued
        }

        assertThat(longChainRepository.revoke(root.session.id)).isTrue()

        assertThat(activeSessionCount()).isZero()
    }

    @Test
    fun `rotation at chain overflow serializes with fail closed revocation`() {
        val longChainRepository = repository(SecureRandom())
        val root = longChainRepository.create(PRINCIPAL_ID, 0, Duration.ofHours(1), null)
        var current = root
        repeat(65) {
            current = (longChainRepository.rotate(current.refreshToken, Duration.ofHours(1)) as SessionRotation.Rotated).issued
        }
        val rotationEntered = CountDownLatch(1)
        val allowRotation = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        val futures = mutableListOf<Future<*>>()
        try {
            val rotation = pool.submit<SessionRotation> {
                repository(BlockingSecureRandom(rotationEntered, allowRotation))
                    .rotate(current.refreshToken, Duration.ofHours(1))
            }
            futures += rotation
            assertThat(rotationEntered.await(15, TimeUnit.SECONDS)).isTrue()
            val revocation = pool.submit<Boolean> { repository.revoke(root.session.id) }
            futures += revocation
            awaitSessionLockWait()
            allowRotation.countDown()

            assertThat(rotation.get(15, TimeUnit.SECONDS)).isInstanceOf(SessionRotation.Rotated::class.java)
            assertThat(revocation.get(15, TimeUnit.SECONDS)).isTrue()
            assertThat(activeSessionCount()).isZero()
        } finally {
            allowRotation.countDown()
            shutdown(pool, futures)
        }
    }

    @Test
    fun `rotation links lineage and replay revokes every replacement descendant`() {
        jdbcTemplate.update("UPDATE iam.user_account SET password_version = 2 WHERE principal_id = ?", PRINCIPAL_ID)
        val first = repository.create(PRINCIPAL_ID, 2, Duration.ofDays(7), null)
        clock.advance(Duration.ofMinutes(1))
        val second = (repository.rotate(first.refreshToken, Duration.ofDays(7)) as SessionRotation.Rotated).issued
        clock.advance(Duration.ofMinutes(1))
        val third = (repository.rotate(second.refreshToken, Duration.ofDays(7)) as SessionRotation.Rotated).issued

        assertThat(repository.rotate(first.refreshToken, Duration.ofDays(7))).isEqualTo(SessionRotation.Invalid)

        val rows = jdbcTemplate.queryForList(
            "SELECT id, revoked_at IS NOT NULL AS revoked, replaced_by_session_id FROM iam.auth_session ORDER BY created_at, id",
        )
        assertThat(rows).hasSize(3)
        assertThat(rows.single { it["id"] == first.session.id }["replaced_by_session_id"]).isEqualTo(second.session.id)
        assertThat(rows.single { it["id"] == second.session.id }["replaced_by_session_id"]).isEqualTo(third.session.id)
        assertThat(rows).allSatisfy { assertThat(it["revoked"]).isEqualTo(true) }
    }

    @Test
    fun `expired malformed and logged out sessions are generically invalid`() {
        val issued = repository.create(PRINCIPAL_ID, 0, Duration.ofMinutes(5), null)
        clock.advance(Duration.ofMinutes(5))

        assertThat(repository.validate(issued.refreshToken)).isEqualTo(SessionValidation.Invalid)
        assertThat(repository.validate("not-a-refresh-token")).isEqualTo(SessionValidation.Invalid)
        assertThat(repository.rotate("not-a-refresh-token", Duration.ofDays(7))).isEqualTo(SessionRotation.Invalid)
        assertThat(repository.rotate(issued.refreshToken, Duration.ofDays(7))).isEqualTo(SessionRotation.Invalid)
        assertThat(repository.revoke(issued.session.id)).isTrue()
        assertThat(repository.rotate(issued.refreshToken, Duration.ofDays(7))).isEqualTo(SessionRotation.Invalid)
        assertThat(repository.validate(issued.refreshToken)).isEqualTo(SessionValidation.Invalid)
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM iam.auth_session", Long::class.java)).isEqualTo(1L)
    }

    @Test
    fun `validation advances last use monotonically even when the injected clock moves backwards`() {
        val issued = repository.create(PRINCIPAL_ID, 0, Duration.ofHours(1), null)
        clock.advance(Duration.ofMinutes(10))
        assertThat(repository.validate(issued.refreshToken)).isInstanceOf(SessionValidation.Active::class.java)
        val advanced = lastUsed(issued.session.id)

        clock.instant = BASE_TIME.plusSeconds(60)
        assertThat(repository.validate(issued.refreshToken)).isInstanceOf(SessionValidation.Active::class.java)

        assertThat(lastUsed(issued.session.id)).isEqualTo(advanced)
    }

    @Test
    fun `access state validation requires matching active session principal entity and singleton without touching last use`() {
        jdbcTemplate.update("UPDATE iam.user_account SET password_version = 4 WHERE principal_id = ?", PRINCIPAL_ID)
        val issued = repository.create(PRINCIPAL_ID, 4, Duration.ofDays(7), null)
        val validator = AccessSessionPrincipalValidator(jdbcTemplate)
        val principal = AccessTokenPrincipal(PRINCIPAL_ID, INSTANCE_ID, issued.session.id, 4)

        assertThat(validator.validate(principal)).isEqualTo(principal)
        assertThat(lastUsed(issued.session.id)).isEqualTo(issued.session.lastUsedAt)
        assertThat(validator.validate(principal.copy(tokenVersion = 5))).isNull()
        assertThat(validator.validate(principal.copy(principalId = UUID.randomUUID()))).isNull()
        assertThat(validator.validate(principal.copy(customerInstanceId = UUID.randomUUID()))).isNull()

        jdbcTemplate.update("UPDATE iam.principal SET status = 'DISABLED' WHERE id = ?", PRINCIPAL_ID)
        assertThat(validator.validate(principal)).isNull()
        jdbcTemplate.update("UPDATE iam.principal SET status = 'ACTIVE' WHERE id = ?", PRINCIPAL_ID)
        jdbcTemplate.update("UPDATE authz.entity SET state = 'SUSPENDED' WHERE id = ?", PRINCIPAL_ID)
        assertThat(validator.validate(principal)).isNull()
        jdbcTemplate.update("UPDATE authz.entity SET state = 'ACTIVE' WHERE id = ?", PRINCIPAL_ID)

        assertThat(repository.revoke(issued.session.id)).isTrue()
        assertThat(validator.validate(principal)).isNull()
    }

    @Test
    fun `access state validation fails closed on database errors and database expiry`() {
        val validator = AccessSessionPrincipalValidator(jdbcTemplate)
        val missing = AccessTokenPrincipal(PRINCIPAL_ID, INSTANCE_ID, UUID.randomUUID(), 0)
        assertThat(validator.validate(missing)).isNull()

        val issued = repository.create(PRINCIPAL_ID, 0, Duration.ofSeconds(1), null)
        Thread.sleep(1100)
        assertThat(validator.validate(AccessTokenPrincipal(PRINCIPAL_ID, INSTANCE_ID, issued.session.id, 0))).isNull()
    }

    @Test
    fun `password version increment invalidates access refresh and descendants while new version works`() {
        val first = repository.create(PRINCIPAL_ID, 0, Duration.ofDays(7), null)
        val second = (repository.rotate(first.refreshToken, Duration.ofDays(7)) as SessionRotation.Rotated).issued
        val validator = AccessSessionPrincipalValidator(jdbcTemplate)
        val secondPrincipal = AccessTokenPrincipal(PRINCIPAL_ID, INSTANCE_ID, second.session.id, 0)
        assertThat(validator.validate(secondPrincipal)).isEqualTo(secondPrincipal)

        jdbcTemplate.update("UPDATE iam.user_account SET password_version = 1 WHERE principal_id = ?", PRINCIPAL_ID)

        assertThat(validator.validate(secondPrincipal)).isNull()
        assertThat(repository.validate(second.refreshToken)).isEqualTo(SessionValidation.Invalid)
        assertThat(repository.rotate(second.refreshToken, Duration.ofDays(7))).isEqualTo(SessionRotation.Invalid)
        assertThat(activeSessionCount()).isZero()

        val current = repository.create(PRINCIPAL_ID, 1, Duration.ofDays(7), null)
        val currentPrincipal = AccessTokenPrincipal(PRINCIPAL_ID, INSTANCE_ID, current.session.id, 1)
        assertThat(validator.validate(currentPrincipal)).isEqualTo(currentPrincipal)
        assertThat(repository.validate(current.refreshToken)).isInstanceOf(SessionValidation.Active::class.java)
        assertThat(repository.rotate(current.refreshToken, Duration.ofDays(7))).isInstanceOf(SessionRotation.Rotated::class.java)
    }

    @Test
    fun `stale refresh token is revoked without creating a replacement`() {
        val stale = repository.create(PRINCIPAL_ID, 0, Duration.ofDays(7), null)
        jdbcTemplate.update("UPDATE iam.user_account SET password_version = 1 WHERE principal_id = ?", PRINCIPAL_ID)

        assertThat(repository.rotate(stale.refreshToken, Duration.ofDays(7))).isEqualTo(SessionRotation.Invalid)

        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM iam.auth_session", Long::class.java)).isEqualTo(1L)
        assertThat(activeSessionCount()).isZero()
    }

    @Test
    fun `two concurrent rotations create one replacement and replay revokes the winner`() {
        val issued = repository.create(PRINCIPAL_ID, 0, Duration.ofDays(7), null)
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        val futures = mutableListOf<Future<*>>()
        try {
            val attempts = (1..2).map { index ->
                pool.submit<SessionRotation> {
                    start.await()
                    repository(SequenceSecureRandom(index)).rotate(issued.refreshToken, Duration.ofDays(7))
                }.also { futures += it }
            }
            start.countDown()
            val outcomes = attempts.map { it.get(15, TimeUnit.SECONDS) }

            assertThat(outcomes.count { it is SessionRotation.Rotated }).isEqualTo(1)
            assertThat(outcomes.count { it == SessionRotation.Invalid }).isEqualTo(1)
            assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM iam.auth_session", Long::class.java)).isEqualTo(2L)
            assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM iam.auth_session WHERE revoked_at IS NOT NULL", Long::class.java)).isEqualTo(2L)
        } finally {
            start.countDown()
            shutdown(pool, futures)
        }
    }

    private fun repository(random: SecureRandom): SessionRepository = SessionRepository(
        jdbcTemplate,
        TransactionTemplate(JdbcTransactionManager(dataSource)),
        clock,
        random,
    )

    private fun lastUsed(id: UUID): Instant = jdbcTemplate.queryForObject(
        "SELECT last_used_at FROM iam.auth_session WHERE id = ?",
        Instant::class.java,
        id,
    )!!

    private fun activeSessionCount(): Long = jdbcTemplate.queryForObject(
        "SELECT count(*) FROM iam.auth_session WHERE principal_id = ? AND revoked_at IS NULL",
        Long::class.java,
        PRINCIPAL_ID,
    )!!

    private fun awaitSessionLockWait() {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
        while (System.nanoTime() < deadline) {
            val waiting = jdbcTemplate.queryForObject(
                """SELECT EXISTS (
                       SELECT 1 FROM pg_stat_activity
                       WHERE datname = current_database()
                         AND pid <> pg_backend_pid()
                         AND wait_event_type = 'Lock'
                         AND (query LIKE '%iam.auth_session%' OR query LIKE '%iam.principal%')
                   )""",
                Boolean::class.java,
            ) == true
            if (waiting) return
            Thread.sleep(10)
        }
        error("Timed out waiting for a session operation to block on a database lock")
    }

    private fun shutdown(pool: ExecutorService, futures: List<Future<*>>) {
        futures.filterNot { it.isDone }.forEach { it.cancel(true) }
        pool.shutdownNow()
        assertThat(pool.awaitTermination(15, TimeUnit.SECONDS)).isTrue()
    }

    private class MutableClock(var instant: Instant) : Clock() {
        override fun instant(): Instant = instant
        override fun getZone(): ZoneId = ZoneOffset.UTC
        override fun withZone(zone: ZoneId): Clock = this
        fun advance(duration: Duration) { instant = instant.plus(duration) }
    }

    private class SequenceSecureRandom(private var next: Int = 0) : SecureRandom() {
        override fun nextBytes(bytes: ByteArray) {
            bytes.indices.forEach { bytes[it] = next++.toByte() }
        }
    }

    private class BlockingSecureRandom(
        private val entered: CountDownLatch,
        private val proceed: CountDownLatch,
    ) : SecureRandom() {
        override fun nextBytes(bytes: ByteArray) {
            entered.countDown()
            check(proceed.await(15, TimeUnit.SECONDS)) { "Timed out waiting to complete token generation" }
            bytes.indices.forEach { bytes[it] = (it + 97).toByte() }
        }
    }

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        private val BASE_TIME: Instant = Instant.parse("2026-07-30T12:00:00Z")
        private val PACKAGE_ID = UUID.fromString("41000000-0000-7000-8000-000000000001")
        private val VERSION_ID = UUID.fromString("41000000-0000-7000-8000-000000000002")
        private val TYPE_ID = UUID.fromString("41000000-0000-7000-8000-000000000003")
        private val TYPE_VERSION_ID = UUID.fromString("41000000-0000-7000-8000-000000000004")
        private val PRINCIPAL_ID = UUID.fromString("41000000-0000-7000-8000-000000000005")
        private val INSTANCE_ID = UUID.fromString("00000000-0000-7000-8000-000000000001")

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
