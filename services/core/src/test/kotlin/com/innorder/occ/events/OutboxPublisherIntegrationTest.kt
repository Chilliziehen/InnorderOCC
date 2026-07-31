package com.innorder.occ.events

import org.assertj.core.api.Assertions.assertThat
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.postgresql.ds.PGSimpleDataSource
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import java.sql.Timestamp
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@Testcontainers(disabledWithoutDocker = true)
class OutboxPublisherIntegrationTest {
    private lateinit var jdbc: JdbcTemplate
    private lateinit var admin: JdbcTemplate
    private lateinit var repository: OutboxPublishingRepository

    @BeforeEach
    fun reset() {
        jdbc = JdbcTemplate(runtimeDataSource())
        admin = JdbcTemplate(adminDataSource())
        admin.update("DELETE FROM audit.outbox_event WHERE aggregate_type = 'publisher-test'")
        repository = OutboxPublishingRepository(jdbc, DataSourceTransactionManager(jdbc.dataSource!!), OutboxProperties())
    }

    @AfterEach
    fun clearInterrupt() {
        Thread.interrupted()
    }

    @Test
    fun `claims due rows in deterministic order up to bounded batch and excludes future rows`() {
        val first = insert(nextAttemptAt = Instant.now().minusSeconds(30), createdAt = Instant.now().minusSeconds(40))
        val second = insert(nextAttemptAt = Instant.now().minusSeconds(20), createdAt = Instant.now().minusSeconds(30))
        insert(nextAttemptAt = Instant.now().plusSeconds(60))

        val claimed = repository.claim(2)

        assertThat(claimed.map { it.id }).containsExactly(first, second)
        assertThat(claimed).allMatch { it.attempts == 1 }
        assertThat(status(first)).isEqualTo("PUBLISHING")
    }

    @Test
    fun `two publisher connections never claim the same row`() {
        repeat(20) { insert(nextAttemptAt = Instant.now().minusSeconds(1)) }
        val otherJdbc = JdbcTemplate(runtimeDataSource())
        val other = OutboxPublishingRepository(otherJdbc, DataSourceTransactionManager(otherJdbc.dataSource!!), OutboxProperties())
        val ready = CountDownLatch(1)
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val a = pool.submit<List<ClaimedOutboxEvent>> { ready.countDown(); start.await(); repository.claim(20) }
            val b = pool.submit<List<ClaimedOutboxEvent>> { ready.countDown(); start.await(); other.claim(20) }
            ready.await(5, TimeUnit.SECONDS)
            start.countDown()
            val idsA = a.get(10, TimeUnit.SECONDS).map { it.id }.toSet()
            val idsB = b.get(10, TimeUnit.SECONDS).map { it.id }.toSet()

            assertThat(idsA.intersect(idsB)).isEmpty()
            assertThat(idsA + idsB).hasSize(20)
        } finally {
            pool.shutdownNow()
        }
    }

    @Test
    fun `publishes outside claim transaction and marks success only after acknowledgement`() {
        val id = insert(nextAttemptAt = Instant.now().minusSeconds(1))
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val sender = OutboxEventSender {
            entered.countDown()
            admin.queryForObject("SELECT id FROM audit.outbox_event WHERE id = ? FOR UPDATE NOWAIT", UUID::class.java, id)
            release.await(5, TimeUnit.SECONDS)
        }
        val publisher = OutboxPublisher(repository, sender, OutboxProperties())
        val pool = Executors.newSingleThreadExecutor()
        try {
            val task = pool.submit<PublishBatchResult> { publisher.publishBatch() }
            assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue()
            assertThat(publisher.publishBatch()).isEqualTo(PublishBatchResult(0, 0, 0, 0))
            assertThat(status(id)).isEqualTo("PUBLISHING")
            assertThat(publishedAt(id)).isNull()
            release.countDown()
            assertThat(task.get(10, TimeUnit.SECONDS).published).isEqualTo(1)
            assertThat(status(id)).isEqualTo("PUBLISHED")
            assertThat(publishedAt(id)).isNotNull()
            assertThat(claimedAt(id)).isNull()
        } finally {
            release.countDown()
            pool.shutdownNow()
        }
    }

    @Test
    fun `uses exact backoffs and sends attempt ten to dead with sanitized category`() {
        val id = insert(nextAttemptAt = Instant.now().minusSeconds(1))
        val publisher = OutboxPublisher(repository, OutboxEventSender { throw RuntimeException("broker:9092 password=hunter2") }, OutboxProperties())

        val expected = listOf(5L, 30L, 120L, 600L, 600L, 600L, 600L, 600L, 600L)
        expected.forEachIndexed { index, seconds ->
            publisher.publishBatch()
            val row = admin.queryForMap("SELECT status, attempts, last_error, extract(epoch from (next_attempt_at - claimed_at)) AS delay FROM audit.outbox_event WHERE id = ?", id)
            assertThat(row["status"]).isEqualTo("PENDING")
            assertThat(row["attempts"]).isEqualTo(index + 1)
            assertThat(row["last_error"]).isEqualTo("DELIVERY_FAILED")
            val next = admin.queryForObject("SELECT next_attempt_at FROM audit.outbox_event WHERE id = ?", Timestamp::class.java, id)!!.toInstant()
            val now = admin.queryForObject("SELECT statement_timestamp()", Timestamp::class.java)!!.toInstant()
            assertThat(Duration.between(now, next).seconds).isBetween(seconds - 2, seconds)
            admin.update("UPDATE audit.outbox_event SET next_attempt_at = statement_timestamp() WHERE id = ?", id)
        }

        publisher.publishBatch()
        assertThat(admin.queryForMap("SELECT status, attempts, last_error, claimed_at FROM audit.outbox_event WHERE id = ?", id))
            .containsEntry("status", "DEAD")
            .containsEntry("attempts", 10)
            .containsEntry("last_error", "DELIVERY_FAILED")
            .containsEntry("claimed_at", null)
    }

    @Test
    fun `recovers stale claims increments attempt and CAS prevents stale worker finalization`() {
        val id = insert(nextAttemptAt = Instant.now().minusSeconds(600), createdAt = Instant.now().minusSeconds(700))
        val stale = repository.claim(1).single()
        admin.update("UPDATE audit.outbox_event SET claimed_at = statement_timestamp() - interval '6 minutes' WHERE id = ?", id)

        val recovered = repository.claim(1).single()

        assertThat(recovered.id).isEqualTo(id)
        assertThat(recovered.attempts).isEqualTo(2)
        assertThat(repository.succeed(stale)).isEqualTo(FinalizeResult.CAS_LOST)
        assertThat(status(id)).isEqualTo("PUBLISHING")
        assertThat(repository.succeed(recovered)).isEqualTo(FinalizeResult.UPDATED)
        assertThat(status(id)).isEqualTo("PUBLISHED")
    }

    @Test
    fun `corrupt secret-bearing event fails without send and follows retry path`() {
        val id = insert(payload = """{"password":"must-not-send"}""", nextAttemptAt = Instant.now().minusSeconds(1))
        val sends = AtomicInteger()

        val result = OutboxPublisher(repository, OutboxEventSender { sends.incrementAndGet() }, OutboxProperties()).publishBatch()

        assertThat(result.failed).isEqualTo(1)
        assertThat(sends).hasValue(0)
        assertThat(admin.queryForMap("SELECT status, attempts, last_error FROM audit.outbox_event WHERE id = ?", id))
            .containsEntry("status", "PENDING")
            .containsEntry("attempts", 1)
            .containsEntry("last_error", "INVALID_EVENT")
    }

    @Test
    fun `interrupt is preserved and claimed row is retried`() {
        val id = insert(nextAttemptAt = Instant.now().minusSeconds(1))
        val publisher = OutboxPublisher(repository, OutboxEventSender { throw InterruptedException("stop") }, OutboxProperties())

        val result = publisher.publishBatch()

        assertThat(result.failed).isEqualTo(1)
        assertThat(Thread.currentThread().isInterrupted).isTrue()
        assertThat(status(id)).isEqualTo("PENDING")
    }

    private fun insert(
        payload: String = """{"value":"ok"}""",
        nextAttemptAt: Instant = Instant.now(),
        createdAt: Instant = Instant.now().minusSeconds(1),
    ): UUID {
        val id = UUID.randomUUID()
        val aggregate = UUID.randomUUID()
        val availableAt = minOf(createdAt, nextAttemptAt)
        admin.update(
            """INSERT INTO audit.outbox_event
               (id, customer_instance_id, aggregate_type, aggregate_id, aggregate_version, event_type,
                schema_version, payload, correlation_id, available_at, next_attempt_at, created_at, status)
               VALUES (?, ?, 'publisher-test', ?, 1, 'publisher-test.updated', 1, ?::jsonb, ?, ?, ?, ?, 'PENDING')""",
            id, OutboxRepository.DEFAULT_CUSTOMER_INSTANCE_ID, aggregate, payload, UUID.randomUUID(),
            Timestamp.from(availableAt), Timestamp.from(nextAttemptAt), Timestamp.from(createdAt),
        )
        return id
    }

    private fun status(id: UUID) = admin.queryForObject("SELECT status FROM audit.outbox_event WHERE id = ?", String::class.java, id)
    private fun publishedAt(id: UUID) = admin.queryForMap("SELECT published_at FROM audit.outbox_event WHERE id = ?", id)["published_at"]
    private fun claimedAt(id: UUID) = admin.queryForMap("SELECT claimed_at FROM audit.outbox_event WHERE id = ?", id)["claimed_at"]

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"

        @Container
        @JvmStatic
        val postgres: PostgreSQLContainer<*> = PostgreSQLContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("innorder_occ")
            .withUsername("innorder_admin")
            .withPassword("admin-test-only")
            .withCopyFileToContainer(MountableFile.forClasspathResource("postgres-test-init.sql"), "/docker-entrypoint-initdb.d/010-test-roles.sql")

        @BeforeAll
        @JvmStatic
        fun initializeDatabase() {
            Flyway.configure().dataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only")
                .locations("classpath:db/migration").load().migrate()
        }

        private fun runtimeDataSource() = PGSimpleDataSource().apply {
            setURL(postgres.jdbcUrl)
            user = "innorder_runtime"
            password = "runtime-test-only"
        }

        private fun adminDataSource() = PGSimpleDataSource().apply {
            setURL(postgres.jdbcUrl)
            user = postgres.username
            password = postgres.password
        }
    }
}
