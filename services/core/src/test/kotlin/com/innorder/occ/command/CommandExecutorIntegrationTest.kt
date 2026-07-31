package com.innorder.occ.command

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.authz.AuthorizationDecision
import com.innorder.occ.authz.AuthorizationDecisionValue
import com.innorder.occ.authz.AuthorizationEntity
import com.innorder.occ.authz.AuthorizationPrincipal
import com.innorder.occ.authz.AuthorizationRequest
import com.innorder.occ.authz.AuthorizationResource
import com.innorder.occ.authz.AuthorizationService
import com.innorder.occ.authz.AuthorizationSnapshot
import com.innorder.occ.authz.AuthorizationSnapshotSource
import com.innorder.occ.authz.DecisionAuditLog
import com.innorder.occ.authz.DecisionLogEntry
import com.innorder.occ.authz.PolicyLayer
import com.innorder.occ.events.OutboxRepository
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.flywaydb.core.Flyway
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
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.springframework.transaction.support.TransactionTemplate
import java.security.MessageDigest

@Testcontainers(disabledWithoutDocker = true)
class CommandExecutorIntegrationTest {
    private lateinit var jdbc: JdbcTemplate
    private lateinit var authorization: AuthorizationService
    private lateinit var snapshots: RecordingSnapshots
    private lateinit var executor: CommandExecutor
    private val executions = AtomicInteger()

    @BeforeEach
    fun reset() {
        jdbc = JdbcTemplate(runtimeDataSource())
        jdbc.update("DELETE FROM audit.outbox_event WHERE aggregate_id = ?", AGGREGATE_ID)
        JdbcTemplate(adminDataSource()).execute("TRUNCATE audit.audit_record")
        jdbc.update("DELETE FROM audit.idempotency_record WHERE principal_id = ?", PRINCIPAL_ID)
        jdbc.update("DELETE FROM occ.command_kernel_test")
        jdbc.update("INSERT INTO occ.command_kernel_test(id, value, row_version) VALUES (?, 'before', 3)", AGGREGATE_ID)
        executions.set(0)
        snapshots = RecordingSnapshots()
        authorization = AuthorizationService(
            snapshots,
            { snapshot ->
                val outcome = snapshots.outcome
                AuthorizationDecision(
                    1, "kernel-v1", snapshot.requestId, 1, snapshot.releases,
                    outcome, outcome == AuthorizationDecisionValue.ALLOW,
                    listOf(if (outcome == AuthorizationDecisionValue.ALLOW) "ALLOW_TEST" else "DENY_TEST"),
                    listOf(POLICY_REFERENCE), if (outcome == AuthorizationDecisionValue.ALLOW) listOf(POLICY_REFERENCE) else emptyList(),
                )
            },
            object : DecisionAuditLog {
                override fun persistInCallerTransaction(entry: DecisionLogEntry) = Unit
                override fun persistIndependently(entry: DecisionLogEntry) = Unit
            },
        )
        val mapper = ObjectMapper().findAndRegisterModules()
        executor = CommandExecutor(
            DataSourceTransactionManager(jdbc.dataSource!!),
            authorization,
            IdempotencyRepository(jdbc, mapper),
            AuditRepository(jdbc, mapper),
            OutboxRepository(jdbc, mapper),
            mapper,
            jdbc,
        )
    }

    @Test
    fun `success writes aggregate audit outbox and completed idempotency then reordered JSON replays exactly`() {
        val metadata = metadata("replay-key")

        val first = executor.execute(metadata, """{"secret":"request-only","z":1,"a":{"y":2,"x":1}}""".toByteArray(), command())
        val replay = executor.execute(metadata, """{ "a": {"x":1,"y":2}, "z":1, "secret":"request-only" }""".toByteArray(), command())

        assertThat(first.status).isEqualTo(200)
        assertThat(first.body).isEqualTo(JSON.readTree("""{"result":"after"}"""))
        assertThat(first.replayed).isFalse()
        assertThat(replay).isEqualTo(first.copy(replayed = true))
        assertThat(executions).hasValue(1)
        assertThat(snapshots.calls).hasValue(1)
        assertThat(jdbc.queryForObject("SELECT value FROM occ.command_kernel_test WHERE id = ?", String::class.java, AGGREGATE_ID)).isEqualTo("after")
        assertThat(jdbc.queryForObject("SELECT row_version FROM occ.command_kernel_test WHERE id = ?", Long::class.java, AGGREGATE_ID)).isEqualTo(4)
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.audit_record WHERE target_entity_id = ?", Long::class.java, RESOURCE_ID)).isEqualTo(1)
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.outbox_event WHERE aggregate_id = ?", Long::class.java, AGGREGATE_ID)).isEqualTo(1)
        assertThat(jdbc.queryForObject("SELECT state FROM audit.idempotency_record WHERE principal_id = ?", String::class.java, PRINCIPAL_ID)).isEqualTo("COMPLETED")
        val persisted = jdbc.queryForObject("SELECT response_body::text FROM audit.idempotency_record WHERE principal_id = ?", String::class.java, PRINCIPAL_ID)!!
        assertThat(JSON.readTree(persisted)).isEqualTo(first.body)
        val idempotency = jdbc.queryForMap(
            """SELECT response_status, response_digest, resource_id,
                      extract(epoch from (expires_at - created_at))::bigint AS ttl_seconds
               FROM audit.idempotency_record WHERE principal_id = ?""",
            PRINCIPAL_ID,
        )
        assertThat(idempotency["response_status"]).isEqualTo(200)
        assertThat(idempotency["response_digest"]).isEqualTo(sha256(JSON.writeValueAsBytes(first.body)))
        assertThat(idempotency["resource_id"]).isEqualTo(RESOURCE_ID)
        assertThat(idempotency["ttl_seconds"]).isEqualTo(86_400L)
        val audit = jdbc.queryForMap(
            """SELECT transaction_id, actor_entity_id, action_key, target_entity_id, before_version,
                      after_version, reason, correlation_id
               FROM audit.audit_record WHERE target_entity_id = ?""",
            RESOURCE_ID,
        )
        assertThat(audit).containsEntry("actor_entity_id", PRINCIPAL_ID)
            .containsEntry("action_key", "test.update")
            .containsEntry("target_entity_id", RESOURCE_ID)
            .containsEntry("before_version", 3L)
            .containsEntry("after_version", 4L)
            .containsEntry("reason", "test")
            .containsEntry("correlation_id", CORRELATION_ID)
        val outbox = jdbc.queryForMap(
            """SELECT customer_instance_id, aggregate_type, aggregate_version, event_type, schema_version,
                      actor_entity_id, correlation_id, causation_id, status, attempts,
                      (next_attempt_at = available_at) AS initially_available
               FROM audit.outbox_event WHERE aggregate_id = ?""",
            AGGREGATE_ID,
        )
        assertThat(outbox).containsEntry("customer_instance_id", OutboxRepository.DEFAULT_CUSTOMER_INSTANCE_ID)
            .containsEntry("aggregate_type", "kernel-test")
            .containsEntry("aggregate_version", 4L)
            .containsEntry("event_type", "kernel-test.updated")
            .containsEntry("schema_version", 1)
            .containsEntry("actor_entity_id", PRINCIPAL_ID)
            .containsEntry("correlation_id", CORRELATION_ID)
            .containsEntry("causation_id", audit["transaction_id"])
            .containsEntry("status", "PENDING")
            .containsEntry("attempts", 0)
            .containsEntry("initially_available", true)
        assertThat(jdbc.queryForObject("SELECT detail::text FROM audit.audit_record WHERE target_entity_id = ?", String::class.java, RESOURCE_ID))
            .doesNotContain("secret", "request-only")
        assertThat(jdbc.queryForObject("SELECT payload::text FROM audit.outbox_event WHERE aggregate_id = ?", String::class.java, AGGREGATE_ID))
            .doesNotContain("secret", "request-only")
        assertThat(snapshots.lastRequest!!.context.keys).containsExactlyInAnyOrder("commandKey", "expectedVersion", "requestDigest")
    }

    @Test
    fun `same key with a different canonical request conflicts before authorization or execution`() {
        val metadata = metadata("conflict-key")
        executor.execute(metadata, """{"value":1}""".toByteArray(), command())

        assertThatThrownBy { executor.execute(metadata, """{"value":2}""".toByteArray(), command()) }
            .isInstanceOf(IdempotencyConflictException::class.java)
        assertThat(executions).hasValue(1)
        assertThat(snapshots.calls).hasValue(1)
    }

    @Test
    fun `metadata and strict request validation fail before a transaction is mutated`() {
        assertThatThrownBy { metadata("") }.isInstanceOf(InvalidIdempotencyKeyException::class.java)
        assertThatThrownBy { metadata("x\nunsafe") }.isInstanceOf(InvalidIdempotencyKeyException::class.java)
        assertThatThrownBy { metadata("x".repeat(129)) }.isInstanceOf(InvalidIdempotencyKeyException::class.java)
        assertThatThrownBy { executor.execute(metadata("dup"), """{"a":1,"a":2}""".toByteArray(), command()) }
            .isInstanceOf(InvalidCommandRequestException::class.java)
        assertThatThrownBy { executor.execute(metadata("scalar"), "1".toByteArray(), command()) }
            .isInstanceOf(InvalidCommandRequestException::class.java)
        assertThatThrownBy { executor.execute(metadata("trailing"), "{}{}".toByteArray(), command()) }
            .isInstanceOf(InvalidCommandRequestException::class.java)
        assertThatThrownBy { executor.execute(metadata("unicode"), """{"value":"e\u0301"}""".toByteArray(), command()) }
            .isInstanceOf(InvalidCommandRequestException::class.java)
        assertThatThrownBy { executor.execute(metadata("large"), ByteArray(256 * 1024 + 1) { 'x'.code.toByte() }, command()) }
            .isInstanceOf(InvalidCommandRequestException::class.java)
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.idempotency_record WHERE principal_id = ?", Long::class.java, PRINCIPAL_ID)).isZero()
    }

    @Test
    fun `twenty concurrent duplicates on separate connections execute once and all observe one response`() {
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(20)
        try {
            val futures = (1..20).map {
                pool.submit<CommandResult> {
                    assertThat(start.await(10, TimeUnit.SECONDS)).isTrue()
                    executor.execute(metadata("race-key"), """{"value":1}""".toByteArray(), command())
                }
            }
            start.countDown()
            val results = futures.map { it.get(30, TimeUnit.SECONDS) }
            assertThat(results.count { !it.replayed }).isEqualTo(1)
            assertThat(results.count { it.replayed }).isEqualTo(19)
            assertThat(results.map { it.body }).containsOnly(JSON.readTree("""{"result":"after"}"""))
            assertThat(executions).hasValue(1)
            assertThat(snapshots.calls).hasValue(1)
        } finally {
            pool.shutdownNow()
            assertThat(pool.awaitTermination(10, TimeUnit.SECONDS)).isTrue()
        }
    }

    @Test
    fun `missing negative and stale expected versions roll back ownership and never execute`() {
        listOf(null, -1L, 2L).forEachIndexed { index, version ->
            assertThatThrownBy {
                executor.execute(metadata("version-$index").copy(expectedVersion = version), "{}".toByteArray(), command())
            }.isInstanceOfAny(InvalidExpectedVersionException::class.java, OptimisticConflictException::class.java)
        }
        assertThat(executions).hasValue(0)
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.idempotency_record WHERE principal_id = ?", Long::class.java, PRINCIPAL_ID)).isZero()
        assertThat(jdbc.queryForObject("SELECT row_version FROM occ.command_kernel_test WHERE id = ?", Long::class.java, AGGREGATE_ID)).isEqualTo(3)
    }

    @Test
    fun `authorization deny and error roll back idempotency before aggregate mutation`() {
        listOf(AuthorizationDecisionValue.DENY, AuthorizationDecisionValue.ERROR).forEachIndexed { index, outcome ->
            configureAuthorization(outcome)
            assertThatThrownBy { executor.execute(metadata("auth-$index"), "{}".toByteArray(), command()) }
                .isInstanceOfAny(
                    com.innorder.occ.authz.AuthorizationDeniedException::class.java,
                    com.innorder.occ.authz.AuthorizationAvailabilityException::class.java,
                )
        }
        assertThat(executions).hasValue(0)
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.idempotency_record WHERE principal_id = ?", Long::class.java, PRINCIPAL_ID)).isZero()
    }

    @Test
    fun `handler response and audit failures roll back aggregate idempotency audit and outbox`() {
        val throwing = object : AuthorizedCommand by command() {
            override fun execute(context: CommandContext): CommandMutation {
                context.jdbc.update("UPDATE occ.command_kernel_test SET value = 'unsafe', row_version = 4 WHERE id = ?", AGGREGATE_ID)
                throw IllegalStateException("request-secret")
            }
        }
        assertThatThrownBy { executor.execute(metadata("handler-fail"), "{}".toByteArray(), throwing) }
            .isInstanceOf(IllegalStateException::class.java)

        val oversized = object : AuthorizedCommand by command() {
            override fun execute(context: CommandContext): CommandMutation = successMutation(
                JSON.createObjectNode().put("value", "x".repeat(64 * 1024)),
            )
        }
        assertThatThrownBy { executor.execute(metadata("response-fail"), "{}".toByteArray(), oversized) }
            .isInstanceOf(InvalidCommandRequestException::class.java)

        val auditFailure = object : AuthorizedCommand by command() {
            override fun execute(context: CommandContext): CommandMutation = successMutation().copy(resourceId = UUID.randomUUID())
        }
        assertThatThrownBy { executor.execute(metadata("audit-fail"), "{}".toByteArray(), auditFailure) }
            .isInstanceOf(RuntimeException::class.java)

        assertRolledBack()
    }

    @Test
    fun `outer forced rollback removes every kernel write`() {
        TransactionTemplate(DataSourceTransactionManager(jdbc.dataSource!!)).executeWithoutResult { status ->
            executor.execute(metadata("outer-rollback"), "{}".toByteArray(), command())
            status.setRollbackOnly()
        }
        assertRolledBack()
    }

    @Test
    fun `outbox insertion failure rolls back aggregate audit and idempotency`() {
        val fixtureId = UUID.randomUUID()
        jdbc.update(
            """INSERT INTO audit.outbox_event
               (id, aggregate_type, aggregate_id, aggregate_version, event_type, schema_version, payload,
                correlation_id, available_at, next_attempt_at)
               VALUES (?, 'kernel-test', ?, 4, 'kernel-test.updated', 1, '{}'::jsonb, ?,
                       statement_timestamp(), statement_timestamp())""",
            fixtureId, AGGREGATE_ID, CORRELATION_ID,
        )
        try {
            assertThatThrownBy { executor.execute(metadata("outbox-fail"), "{}".toByteArray(), command()) }
                .isInstanceOf(RuntimeException::class.java)
            assertThat(jdbc.queryForObject("SELECT value FROM occ.command_kernel_test WHERE id = ?", String::class.java, AGGREGATE_ID)).isEqualTo("before")
            assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.idempotency_record WHERE principal_id = ?", Long::class.java, PRINCIPAL_ID)).isZero()
            assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.audit_record WHERE target_entity_id = ?", Long::class.java, RESOURCE_ID)).isZero()
            assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.outbox_event WHERE aggregate_id = ?", Long::class.java, AGGREGATE_ID)).isEqualTo(1)
        } finally {
            jdbc.update("DELETE FROM audit.outbox_event WHERE id = ?", fixtureId)
        }
    }

    private fun metadata(key: String) = CommandMetadata(PRINCIPAL_ID, "test.update", key, 3, CORRELATION_ID)

    private fun configureAuthorization(outcome: AuthorizationDecisionValue) {
        snapshots.outcome = outcome
    }

    private fun assertRolledBack() {
        assertThat(jdbc.queryForObject("SELECT value FROM occ.command_kernel_test WHERE id = ?", String::class.java, AGGREGATE_ID)).isEqualTo("before")
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.idempotency_record WHERE principal_id = ?", Long::class.java, PRINCIPAL_ID)).isZero()
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.audit_record WHERE target_entity_id = ?", Long::class.java, RESOURCE_ID)).isZero()
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.outbox_event WHERE aggregate_id = ?", Long::class.java, AGGREGATE_ID)).isZero()
    }

    private fun successMutation(body: JsonNode = JSON.readTree("""{"result":"after"}""")) = CommandMutation(
        200, body, RESOURCE_ID, AGGREGATE_ID, "kernel-test", 3, 4, "test",
        JSON.readTree("""{"changed":"value"}"""),
        listOf(PendingEventSpec("kernel-test.updated", 1, JSON.readTree("""{"value":"after"}"""), 4)),
    )

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }

    private fun command() = object : AuthorizedCommand {
        override val action = "test.update"
        override val entityId = ENTITY_ID
        override val resourceId = RESOURCE_ID
        override val expectedVersionRequired = true

        override fun currentVersion(context: CommandContext): Long = context.jdbc.queryForObject(
            "SELECT row_version FROM occ.command_kernel_test WHERE id = ? FOR UPDATE",
            Long::class.java,
            AGGREGATE_ID,
        )!!

        override fun execute(context: CommandContext): CommandMutation {
            executions.incrementAndGet()
            context.jdbc.update(
                "UPDATE occ.command_kernel_test SET value = 'after', row_version = row_version + 1 WHERE id = ?",
                AGGREGATE_ID,
            )
            return CommandMutation(
                status = 200,
                body = JSON.readTree("""{"result":"after"}"""),
                resourceId = RESOURCE_ID,
                aggregateId = AGGREGATE_ID,
                aggregateType = "kernel-test",
                beforeVersion = 3,
                afterVersion = 4,
                auditReason = "test",
                auditDetail = JSON.readTree("""{"changed":"value"}"""),
                events = listOf(PendingEventSpec("kernel-test.updated", 1, JSON.readTree("""{"value":"after"}"""), 4)),
            )
        }
    }

    private class RecordingSnapshots : AuthorizationSnapshotSource {
        val calls = AtomicInteger()
        var lastRequest: AuthorizationRequest? = null
        var outcome = AuthorizationDecisionValue.ALLOW

        override fun load(request: AuthorizationRequest): AuthorizationSnapshot {
            calls.incrementAndGet()
            lastRequest = request
            return AuthorizationSnapshot(
                1, request.requestId, 1, mapOf(PolicyLayer.PLATFORM to RELEASE_ID),
                AuthorizationPrincipal(request.principalId, true), AuthorizationEntity(request.entityId),
                request.action, AuthorizationResource(request.resourceId, true), request.context,
                emptyList(), emptyList(), RELEASE_ID, "kernel-v1",
                mapOf(request.entityId to 0), "a".repeat(64),
            )
        }
    }

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        private val JSON = ObjectMapper().findAndRegisterModules()
        private val PRINCIPAL_ID = UUID.fromString("81000000-0000-7000-8000-000000000001")
        private val ENTITY_ID = UUID.fromString("81000000-0000-7000-8000-000000000002")
        private val RESOURCE_ID = UUID.fromString("81000000-0000-7000-8000-000000000003")
        private val AGGREGATE_ID = UUID.fromString("81000000-0000-7000-8000-000000000004")
        private val CORRELATION_ID = UUID.fromString("81000000-0000-7000-8000-000000000005")
        private val RELEASE_ID = UUID.fromString("81000000-0000-7000-8000-000000000006")
        private const val POLICY_REFERENCE = "policy:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

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
            val admin = JdbcTemplate(adminDataSource())
            val packageId = UUID.randomUUID()
            val packageVersionId = UUID.randomUUID()
            val typeId = UUID.randomUUID()
            val typeVersionId = UUID.randomUUID()
            admin.update("INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, ?, 'Kernel test', 'ACTIVE')", packageId, "kernel-${UUID.randomUUID()}")
            admin.update("INSERT INTO catalog.package_version(id, package_id, semver, status) VALUES (?, ?, '1.0.0', 'DRAFT')", packageVersionId, packageId)
            admin.update("INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind, authorizable) VALUES (?, ?, 'kernel.test', 'Kernel Test', 'PRINCIPAL', true)", typeId, packageId)
            admin.update("INSERT INTO catalog.entity_type_version(id, entity_type_id, package_version_id, schema_version, json_schema) VALUES (?, ?, ?, 1, '{}'::jsonb)", typeVersionId, typeId, packageVersionId)
            listOf(PRINCIPAL_ID, ENTITY_ID, RESOURCE_ID).forEachIndexed { index, id ->
                admin.update("INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state) VALUES (?, ?, ?, ?, 'ACTIVE')", id, typeId, typeVersionId, "kernel:$index")
            }
            admin.update("INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, 'USER', 'Kernel User', 'ACTIVE')", PRINCIPAL_ID)
            admin.execute("CREATE TABLE occ.command_kernel_test(id uuid PRIMARY KEY, value text NOT NULL, row_version bigint NOT NULL)")
            admin.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON occ.command_kernel_test TO innorder_runtime")
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
