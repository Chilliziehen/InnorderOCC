package com.innorder.occ.events

import org.assertj.core.api.Assertions.assertThat
import org.awaitility.Awaitility.await
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
import java.util.Collections
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

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
        val ready = CountDownLatch(2)
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val a = pool.submit<List<ClaimedOutboxEvent>> { ready.countDown(); start.await(); repository.claim(20) }
            val b = pool.submit<List<ClaimedOutboxEvent>> { ready.countDown(); start.await(); other.claim(20) }
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue()
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
    fun `two complete publishers concurrently process disjoint batches exactly once`() {
        repeat(20) { insert(nextAttemptAt = Instant.now().minusSeconds(1)) }
        val properties = OutboxProperties(batchSize = 10)
        val otherJdbc = JdbcTemplate(runtimeDataSource())
        val otherRepository = OutboxPublishingRepository(
            otherJdbc, DataSourceTransactionManager(otherJdbc.dataSource!!), properties,
        )
        val deliveries = ConcurrentHashMap<UUID, AtomicInteger>()
        val sender = OutboxEventSender { event -> deliveries.computeIfAbsent(event.id) { AtomicInteger() }.incrementAndGet() }
        val publishers = listOf(
            OutboxPublisher(repositoryFor(properties), sender, properties),
            OutboxPublisher(otherRepository, sender, properties),
        )
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val results = publishers.map { publisher -> pool.submit<PublishBatchResult> { start.await(); publisher.publishBatch() } }
            start.countDown()
            val completed = results.map { it.get(10, TimeUnit.SECONDS) }

            assertThat(completed.map { it.published }).containsExactlyInAnyOrder(10, 10)
            assertThat(deliveries).hasSize(20)
            assertThat(deliveries.values).allMatch { it.get() == 1 }
            assertThat(admin.queryForObject("SELECT count(*) FROM audit.outbox_event WHERE aggregate_type = 'publisher-test' AND status = 'PUBLISHED'", Long::class.java)).isEqualTo(20)
        } finally {
            pool.shutdownNow()
        }
    }

    @Test
    fun `later queued claim is renewed or skipped after another publisher recovers its stale lease`() {
        val first = insert(nextAttemptAt = Instant.now().minusSeconds(20), createdAt = Instant.now().minusSeconds(700))
        val second = insert(nextAttemptAt = Instant.now().minusSeconds(10), createdAt = Instant.now().minusSeconds(700))
        val deliveries = ConcurrentHashMap<UUID, AtomicInteger>()
        val otherJdbc = JdbcTemplate(runtimeDataSource())
        val otherRepository = OutboxPublishingRepository(
            otherJdbc, DataSourceTransactionManager(otherJdbc.dataSource!!), OutboxProperties(),
        )
        val otherPublisher = OutboxPublisher(otherRepository, OutboxEventSender { event ->
            deliveries.computeIfAbsent(event.id) { AtomicInteger() }.incrementAndGet()
        }, OutboxProperties())
        val publisher = OutboxPublisher(repository, OutboxEventSender { event ->
            deliveries.computeIfAbsent(event.id) { AtomicInteger() }.incrementAndGet()
            if (event.id == first) {
                admin.update(
                    "UPDATE audit.outbox_event SET claimed_at = statement_timestamp() - interval '6 minutes' WHERE id = ?",
                    second,
                )
                otherPublisher.publishBatch()
            }
        }, OutboxProperties(batchSize = 2))

        publisher.publishBatch()

        assertThat(deliveries[first]?.get()).isEqualTo(1)
        assertThat(deliveries[second]?.get()).isEqualTo(1)
        assertThat(status(first)).isEqualTo("PUBLISHED")
        assertThat(status(second)).isEqualTo("PUBLISHED")
    }

    @Test
    fun `later aggregate version cannot publish before earlier version is terminal`() {
        val aggregateId = UUID.randomUUID()
        val versionOne = insert(
            nextAttemptAt = Instant.now().minusSeconds(2), createdAt = Instant.now().minusSeconds(10),
            aggregateId = aggregateId, aggregateVersion = 1,
        )
        val versionTwo = insert(
            nextAttemptAt = Instant.now().minusSeconds(1), createdAt = Instant.now().minusSeconds(9),
            aggregateId = aggregateId, aggregateVersion = 2,
        )
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val sent = Collections.synchronizedList(mutableListOf<UUID>())
        val firstPublisher = OutboxPublisher(repositoryFor(OutboxProperties(batchSize = 1)), OutboxEventSender { event ->
            sent.add(event.id)
            entered.countDown()
            release.await(5, TimeUnit.SECONDS)
        }, OutboxProperties(batchSize = 1))
        val otherJdbc = JdbcTemplate(runtimeDataSource())
        val secondProperties = OutboxProperties(batchSize = 1)
        val secondPublisher = OutboxPublisher(
            OutboxPublishingRepository(otherJdbc, DataSourceTransactionManager(otherJdbc.dataSource!!), secondProperties),
            OutboxEventSender { event -> sent.add(event.id) }, secondProperties,
        )
        val pool = Executors.newSingleThreadExecutor()
        try {
            val firstRun = pool.submit<PublishBatchResult> { firstPublisher.publishBatch() }
            assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue()

            assertThat(secondPublisher.publishBatch().claimed).isZero()
            assertThat(sent).containsExactly(versionOne)

            release.countDown()
            firstRun.get(10, TimeUnit.SECONDS)
            assertThat(secondPublisher.publishBatch().published).isEqualTo(1)
            assertThat(sent).containsExactly(versionOne, versionTwo)
        } finally {
            release.countDown()
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
    fun `acknowledged crash is recovered with duplicate stable event id then published`() {
        val id = insert(nextAttemptAt = Instant.now().minusSeconds(600), createdAt = Instant.now().minusSeconds(700))
        val deliveries = mutableListOf<UUID>()
        val crashPublisher = OutboxPublisher(repository, OutboxEventSender { event ->
            deliveries.add(event.id)
            throw SimulatedProcessCrash()
        }, OutboxProperties())

        org.assertj.core.api.Assertions.assertThatThrownBy { crashPublisher.publishBatch() }
            .isInstanceOf(SimulatedProcessCrash::class.java)
        assertThat(status(id)).isEqualTo("PUBLISHING")
        admin.update("UPDATE audit.outbox_event SET claimed_at = statement_timestamp() - interval '6 minutes' WHERE id = ?", id)

        OutboxPublisher(repository, OutboxEventSender { event -> deliveries.add(event.id) }, OutboxProperties()).publishBatch()

        assertThat(deliveries).containsExactly(id, id)
        assertThat(status(id)).isEqualTo("PUBLISHED")
    }

    @Test
    fun `overlapping scheduled polls permit one claim and send`() {
        val id = insert(nextAttemptAt = Instant.now().minusSeconds(1))
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val sends = AtomicInteger()
        val publisher = OutboxPublisher(repository, OutboxEventSender {
            sends.incrementAndGet()
            entered.countDown()
            release.await(5, TimeUnit.SECONDS)
        }, OutboxProperties())
        val pool = Executors.newSingleThreadExecutor()
        try {
            val first = pool.submit { publisher.poll() }
            assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue()
            publisher.poll()
            assertThat(sends).hasValue(1)
            release.countDown()
            first.get(10, TimeUnit.SECONDS)
            assertThat(status(id)).isEqualTo("PUBLISHED")
        } finally {
            release.countDown()
            pool.shutdownNow()
        }
    }

    @Test
    fun `shutdown waits bounded and releases claimed unvisited events while active send remains publishing`() {
        repeat(3) { insert(nextAttemptAt = Instant.now().minusSeconds(1)) }
        val properties = OutboxProperties(batchSize = 3, ackTimeout = Duration.ofSeconds(1))
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val activeId = AtomicReference<UUID>()
        val publisher = OutboxPublisher(repositoryFor(properties), OutboxEventSender { event ->
            activeId.set(event.id)
            entered.countDown()
            release.await(10, TimeUnit.SECONDS)
        }, properties)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val publishing = pool.submit<PublishBatchResult> { publisher.publishBatch() }
            assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue()
            val shutdown = pool.submit { publisher.shutdown() }

            await().atMost(500, TimeUnit.MILLISECONDS).untilAsserted {
                assertThat(admin.queryForObject(
                    "SELECT count(*) FROM audit.outbox_event WHERE aggregate_type = 'publisher-test' AND status = 'PENDING' AND last_error = 'SHUTDOWN'",
                    Long::class.java,
                )).isEqualTo(2)
            }
            assertThat(shutdown.isDone).isFalse()

            shutdown.get(3, TimeUnit.SECONDS)

            val rows = admin.queryForList(
                "SELECT id, status, attempts, last_error FROM audit.outbox_event WHERE aggregate_type = 'publisher-test' ORDER BY id",
            )
            assertThat(rows.single { it["id"] == activeId.get() })
                .containsEntry("status", "PUBLISHING")
                .containsEntry("attempts", 1)
            assertThat(rows.filter { it["id"] != activeId.get() }).allSatisfy {
                assertThat(it).containsEntry("status", "PENDING").containsEntry("attempts", 0).containsEntry("last_error", "SHUTDOWN")
            }
            release.countDown()
            publishing.get(10, TimeUnit.SECONDS)
        } finally {
            release.countDown()
            pool.shutdownNow()
        }
    }

    @Test
    fun `repeated shutdown release does not consume target attempts and eventual send succeeds`() {
        val target = insert(nextAttemptAt = Instant.now().minusSeconds(1), createdAt = Instant.now().minusSeconds(100))
        repeat(10) {
            admin.update("UPDATE audit.outbox_event SET next_attempt_at = statement_timestamp() WHERE id = ?", target)
            val blocker = insert(
                nextAttemptAt = Instant.now().minusSeconds(10),
                createdAt = Instant.now().minusSeconds(20),
            )
            val properties = OutboxProperties(batchSize = 2, ackTimeout = Duration.ofSeconds(1))
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            val publisher = OutboxPublisher(repositoryFor(properties), OutboxEventSender { event ->
                assertThat(event.id).isEqualTo(blocker)
                entered.countDown()
                release.await(5, TimeUnit.SECONDS)
            }, properties)
            val pool = Executors.newFixedThreadPool(2)
            try {
                val publishing = pool.submit<PublishBatchResult> { publisher.publishBatch() }
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue()
                val shutdown = pool.submit { publisher.shutdown() }
                await().atMost(1, TimeUnit.SECONDS).untilAsserted {
                    assertThat(admin.queryForMap("SELECT status, attempts, last_error FROM audit.outbox_event WHERE id = ?", target))
                        .containsEntry("status", "PENDING")
                        .containsEntry("attempts", 0)
                        .containsEntry("last_error", "SHUTDOWN")
                }
                release.countDown()
                publishing.get(10, TimeUnit.SECONDS)
                shutdown.get(10, TimeUnit.SECONDS)
            } finally {
                release.countDown()
                pool.shutdownNow()
            }
        }

        val sends = AtomicInteger()
        OutboxPublisher(repository, OutboxEventSender { event ->
            assertThat(event.id).isEqualTo(target)
            sends.incrementAndGet()
        }, OutboxProperties()).publishBatch()

        assertThat(sends).hasValue(1)
        assertThat(status(target)).isEqualTo("PUBLISHED")
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
    fun `stale attempt nine is claimed as attempt ten sent once and failed dead`() {
        val id = stalePublishing(attempts = 9)
        val sends = AtomicInteger()
        val publisher = OutboxPublisher(repository, OutboxEventSender {
            sends.incrementAndGet()
            throw RuntimeException("delivery failed")
        }, OutboxProperties())

        publisher.publishBatch()

        assertThat(sends).hasValue(1)
        assertThat(admin.queryForMap("SELECT status, attempts, last_error FROM audit.outbox_event WHERE id = ?", id))
            .containsEntry("status", "DEAD")
            .containsEntry("attempts", 10)
            .containsEntry("last_error", "DELIVERY_FAILED")
    }

    @Test
    fun `stale attempt ten is dead without attempt eleven or send`() {
        val id = stalePublishing(attempts = 10)
        val sends = AtomicInteger()

        OutboxPublisher(repository, OutboxEventSender { sends.incrementAndGet() }, OutboxProperties()).publishBatch()

        assertThat(sends).hasValue(0)
        assertThat(admin.queryForMap("SELECT status, attempts, last_error, claimed_at FROM audit.outbox_event WHERE id = ?", id))
            .containsEntry("status", "DEAD")
            .containsEntry("attempts", 10)
            .containsEntry("last_error", "STALE_ATTEMPT_LIMIT")
            .containsEntry("claimed_at", null)
    }

    @Test
    fun `locked exhausted rows do not block another publisher claiming due work or create attempt eleven`() {
        val exhausted = listOf(stalePublishing(attempts = 10), stalePublishing(attempts = 10))
        val due = insert(nextAttemptAt = Instant.now().minusSeconds(1))
        val lockConnection = adminDataSource().connection
        val pool = Executors.newSingleThreadExecutor()
        try {
            lockConnection.autoCommit = false
            lockConnection.prepareStatement(
                "SELECT id FROM audit.outbox_event WHERE id IN (?, ?) ORDER BY id FOR UPDATE",
            ).use { statement ->
                statement.setObject(1, exhausted[0])
                statement.setObject(2, exhausted[1])
                statement.executeQuery().use { rows -> assertThat(rows.next()).isTrue() }
            }
            val otherJdbc = JdbcTemplate(runtimeDataSource())
            val otherRepository = OutboxPublishingRepository(
                otherJdbc, DataSourceTransactionManager(otherJdbc.dataSource!!), OutboxProperties(),
            )

            val claimed = pool.submit<List<ClaimedOutboxEvent>> { otherRepository.claim() }
                .get(2, TimeUnit.SECONDS)

            assertThat(claimed.map { it.id }).containsExactly(due)
            assertThat(claimed.single().attempts).isEqualTo(1)
            assertThat(exhausted.map { admin.queryForMap("SELECT status, attempts FROM audit.outbox_event WHERE id = ?", it) })
                .allSatisfy { assertThat(it).containsEntry("status", "PUBLISHING").containsEntry("attempts", 10) }
        } finally {
            lockConnection.rollback()
            lockConnection.close()
            pool.shutdownNow()
        }

        repository.claim()

        assertThat(exhausted.map { admin.queryForMap("SELECT status, attempts, last_error FROM audit.outbox_event WHERE id = ?", it) })
            .allSatisfy {
                assertThat(it)
                    .containsEntry("status", "DEAD")
                    .containsEntry("attempts", 10)
                    .containsEntry("last_error", "STALE_ATTEMPT_LIMIT")
            }
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
    fun `corrupt legacy sensitive field union never sends`() {
        val fields = listOf(
            "password", "pass-phrase", "SECRET", "to_ken", "authori-zation",
            "cookie", "api_Key", "credential", "private.key",
        )
        val ids = fields.map { field ->
            insert(payload = """{"$field":"legacy-value"}""", nextAttemptAt = Instant.now().minusSeconds(1))
        }
        val sends = AtomicInteger()

        OutboxPublisher(repository, OutboxEventSender { sends.incrementAndGet() }, OutboxProperties()).publishBatch()

        assertThat(sends).hasValue(0)
        assertThat(ids.map { admin.queryForMap("SELECT status, last_error FROM audit.outbox_event WHERE id = ?", it) })
            .allSatisfy { assertThat(it).containsEntry("status", "PENDING").containsEntry("last_error", "INVALID_EVENT") }
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
        aggregateId: UUID = UUID.randomUUID(),
        aggregateVersion: Long = 1,
    ): UUID {
        val id = UUID.randomUUID()
        val availableAt = minOf(createdAt, nextAttemptAt)
        admin.update(
            """INSERT INTO audit.outbox_event
               (id, customer_instance_id, aggregate_type, aggregate_id, aggregate_version, event_type,
                schema_version, payload, correlation_id, available_at, next_attempt_at, created_at, status)
               VALUES (?, ?, 'publisher-test', ?, ?, 'publisher-test.updated', 1, ?::jsonb, ?, ?, ?, ?, 'PENDING')""",
            id, OutboxRepository.DEFAULT_CUSTOMER_INSTANCE_ID, aggregateId, aggregateVersion, payload, UUID.randomUUID(),
            Timestamp.from(availableAt), Timestamp.from(nextAttemptAt), Timestamp.from(createdAt),
        )
        return id
    }

    private fun stalePublishing(attempts: Int): UUID {
        val id = insert(nextAttemptAt = Instant.now().minusSeconds(700), createdAt = Instant.now().minusSeconds(800))
        admin.update(
            """UPDATE audit.outbox_event
               SET status = 'PUBLISHING', attempts = ?, claimed_at = statement_timestamp() - interval '6 minutes'
               WHERE id = ?""",
            attempts, id,
        )
        return id
    }

    private fun repositoryFor(properties: OutboxProperties) =
        OutboxPublishingRepository(jdbc, DataSourceTransactionManager(jdbc.dataSource!!), properties)

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

    private class SimulatedProcessCrash : Error("simulated process crash after broker acknowledgement")
}
