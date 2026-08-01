package com.innorder.occ.command

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.authz.AuthorizationDecision
import com.innorder.occ.authz.AuthorizationDecisionValue
import com.innorder.occ.authz.AuthorizationEntity
import com.innorder.occ.authz.AuthorizationPrincipal
import com.innorder.occ.authz.AuthorizationRequest
import com.innorder.occ.authz.AuthorizationResource
import com.innorder.occ.authz.AuthorizationRevisionLockRepository
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
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.MethodSource
import org.junit.jupiter.params.provider.ValueSource
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
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

@Testcontainers(disabledWithoutDocker = true)
class CommandExecutorIntegrationTest {
    private lateinit var jdbc: JdbcTemplate
    private lateinit var authorization: AuthorizationService
    private lateinit var snapshots: RecordingSnapshots
    private lateinit var executor: CommandExecutor
    private val executions = AtomicInteger()
    private val lockOrder = mutableListOf<AggregateReference>()

    @BeforeEach
    fun reset() {
        jdbc = JdbcTemplate(runtimeDataSource())
        jdbc.update("DELETE FROM audit.outbox_event WHERE aggregate_id = ?", AGGREGATE_ID)
        JdbcTemplate(adminDataSource()).execute("TRUNCATE audit.audit_record")
        jdbc.update("DELETE FROM audit.idempotency_record WHERE principal_id = ?", PRINCIPAL_ID)
        jdbc.update("DELETE FROM occ.command_kernel_test")
        jdbc.update("INSERT INTO occ.command_kernel_test(id, value, row_version) VALUES (?, 'before', 3)", AGGREGATE_ID)
        executions.set(0)
        lockOrder.clear()
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
        executor = CommandExecutor(
            DataSourceTransactionManager(jdbc.dataSource!!),
            authorization,
            AuthorizationRevisionLockRepository(jdbc),
            IdempotencyRepository(jdbc),
            AuditRepository(jdbc),
            OutboxRepository(jdbc),
            lockRegistry(),
            jdbc,
        )
    }

    @Test
    fun `success writes aggregate audit outbox and completed idempotency then reordered JSON replays exactly`() {
        val metadata = metadata("replay-key")

        val first = executor.execute(metadata, """{"secret":"request-only","z":1,"a":{"y":2,"x":1}}""".toByteArray(), command())
        val replay = executor.execute(metadata, """{ "a": {"x":1,"y":2}, "z":1, "secret":"request-only" }""".toByteArray(), command())

        assertThat(first.status).isEqualTo(200)
        assertThat(first.body.toJsonNode()).isEqualTo(JSON.readTree("""{"result":"after"}"""))
        first.body.toJsonNode().put("mutated", true)
        assertThat(first.body.toJsonNode().has("mutated")).isFalse()
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
        assertThat(JSON.readTree(persisted)).isEqualTo(first.body.toJsonNode())
        val idempotency = jdbc.queryForMap(
            """SELECT response_status, response_digest, resource_id,
                      extract(epoch from (expires_at - created_at))::bigint AS ttl_seconds
               FROM audit.idempotency_record WHERE principal_id = ?""",
            PRINCIPAL_ID,
        )
        assertThat(idempotency["response_status"]).isEqualTo(200)
        assertThat(idempotency["response_digest"]).isEqualTo(first.body.digest)
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
    fun `descriptor is captured once and stateful getters cannot redirect authorization or persistence`() {
        val reads = java.util.concurrent.ConcurrentHashMap<String, AtomicInteger>()
        fun <T> once(name: String, first: T, later: T): T =
            if (reads.computeIfAbsent(name) { AtomicInteger() }.incrementAndGet() == 1) first else later
        val malicious = object : AuthorizedCommand {
            override val action get() = once("action", "test.update", "iam.redirect")
            override val entityId get() = once("entity", ENTITY_ID, UUID.randomUUID())
            override val resourceId get() = once("resource", RESOURCE_ID, ENTITY_ID)
            override val aggregateType get() = once("aggregateType", "kernel-test", "authz.entity")
            override val aggregateId get() = once("aggregateId", AGGREGATE_ID, UUID.randomUUID())
            override val expectedVersionRequired get() = once("expected", true, false)
            override val changesAuthorizationFacts get() = once("authFacts", false, true)
            override val lockPlan get() = once(
                "lockPlan",
                AggregateLockPlan(existing = listOf(AggregateReference("kernel-test", AGGREGATE_ID))),
                AggregateLockPlan(existing = listOf(AggregateReference("unknown", UUID.randomUUID()))),
            )

            override fun execute(context: CommandContext): CommandMutation {
                context.jdbc.update(
                    "UPDATE occ.command_kernel_test SET value = 'after', row_version = 4 WHERE id = ?",
                    context.descriptor.aggregateId,
                )
                return successMutation()
            }
        }

        val result = executor.execute(metadata("stateful-command"), "{}".toByteArray(), malicious)

        assertThat(result.status).isEqualTo(200)
        assertThat(reads.values).allMatch { it.get() == 1 }
        assertThat(snapshots.lastRequest!!.action).isEqualTo("test.update")
        assertThat(jdbc.queryForObject("SELECT aggregate_type FROM audit.outbox_event WHERE aggregate_id = ?", String::class.java, AGGREGATE_ID))
            .isEqualTo("kernel-test")
    }

    @Test
    fun `same idempotency key and body conflict when behavior target or expected version changes`() {
        data class Variant(val name: String, val metadata: CommandMetadata, val command: AuthorizedCommand)
        val variants = listOf(
            Variant("action", metadata("fingerprint-action"), object : AuthorizedCommand by command() {
                override val action = "test.other"
            }),
            Variant("resource", metadata("fingerprint-resource"), object : AuthorizedCommand by command() {
                override val resourceId = ENTITY_ID
            }),
            Variant("aggregate", metadata("fingerprint-aggregate"), object : AuthorizedCommand by command() {
                override val aggregateId = SECOND_AGGREGATE_ID
                override val lockPlan = AggregateLockPlan(
                    existing = listOf(AggregateReference(aggregateType, aggregateId)),
                )
            }),
            Variant("expected", metadata("fingerprint-expected").copy(expectedVersion = 4), command()),
        )
        variants.forEach { variant ->
            jdbc.update("DELETE FROM audit.outbox_event WHERE aggregate_id = ?", AGGREGATE_ID)
            jdbc.update("UPDATE occ.command_kernel_test SET value = 'before', row_version = 3 WHERE id = ?", AGGREGATE_ID)
            val originalMetadata = metadata(variant.metadata.idempotencyKey)
            executor.execute(originalMetadata, "{}".toByteArray(), command())

            assertThatThrownBy { executor.execute(variant.metadata, "{}".toByteArray(), variant.command) }
                .describedAs(variant.name)
                .isInstanceOf(IdempotencyConflictException::class.java)
        }
    }

    @Test
    fun `command context exposes descriptor and digest but no raw request`() {
        assertThat(CommandContext::class.java.methods.map { it.name })
            .doesNotContain("getRequest")
            .contains("getDescriptor", "getRequestDigest", "getLockedVersions", "getCreatedAggregates")
    }

    @Test
    fun `lock plan resolves existing aggregates in deterministic order and exposes immutable context`() {
        jdbc.update("INSERT INTO occ.command_kernel_test(id, value, row_version) VALUES (?, 'second', 7)", SECOND_AGGREGATE_ID)
        lateinit var capturedVersions: Map<AggregateReference, Long>
        lateinit var capturedCreated: Set<AggregateReference>
        val primary = AggregateReference("kernel-test", AGGREGATE_ID)
        val secondary = AggregateReference("kernel-secondary", SECOND_AGGREGATE_ID)
        val created = AggregateReference("kernel-created", CREATED_AGGREGATE_ID)
        val multi = object : AuthorizedCommand by command() {
            override val lockPlan = AggregateLockPlan(
                existing = listOf(secondary, primary),
                created = listOf(created),
            )

            override fun execute(context: CommandContext): CommandMutation {
                capturedVersions = context.lockedVersions
                capturedCreated = context.createdAggregates
                return command().execute(context)
            }
        }

        executor.execute(metadata("ordered-locks"), "{}".toByteArray(), multi)

        assertThat(lockOrder).containsExactly(secondary, primary)
        assertThat(capturedVersions).containsExactlyInAnyOrderEntriesOf(mapOf(primary to 3L, secondary to 7L))
        assertThat(capturedCreated).containsExactly(created)
        assertThatThrownBy {
            @Suppress("UNCHECKED_CAST")
            (capturedVersions as MutableMap<AggregateReference, Long>).clear()
        }.isInstanceOf(UnsupportedOperationException::class.java)
        assertThatThrownBy {
            @Suppress("UNCHECKED_CAST")
            (capturedCreated as MutableSet<AggregateReference>).clear()
        }.isInstanceOf(UnsupportedOperationException::class.java)
    }

    @Test
    fun `invalid lock plans fail before command execution`() {
        val primary = AggregateReference("kernel-test", AGGREGATE_ID)
        val missing = AggregateReference("kernel-test", UUID.fromString("81000000-0000-7000-8000-000000000009"))
        val invalidPlans = listOf<AggregateLockPlan?>(
            null,
            AggregateLockPlan(existing = listOf(AggregateReference("unknown", AGGREGATE_ID))),
            AggregateLockPlan(existing = listOf(primary, primary)),
            AggregateLockPlan(existing = listOf(missing)),
            AggregateLockPlan(existing = listOf(primary), created = listOf(primary)),
        )

        invalidPlans.forEachIndexed { index, plan ->
            val invalid = object : AuthorizedCommand by command() {
                override val lockPlan: AggregateLockPlan? = plan
            }
            assertThatThrownBy { executor.execute(metadata("invalid-plan-$index"), "{}".toByteArray(), invalid) }
                .describedAs("plan $index")
                .isInstanceOf(InvalidCommandRequestException::class.java)
        }
        assertThat(executions).hasValue(0)
    }

    @Test
    fun `authorization aggregate command without change declaration fails before idempotency`() {
        listOf("authz.entity", "iam.principal", "relationship", "policy.release").forEachIndexed { index, type ->
            val undeclared = object : AuthorizedCommand by command() {
                override val aggregateType = type
            }

            assertThatThrownBy {
                executor.execute(metadata("undeclared-auth-change-$index"), "{}".toByteArray(), undeclared)
            }.isInstanceOf(InvalidCommandMetadataException::class.java)
        }
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM audit.idempotency_record WHERE principal_id = ?",
            Long::class.java,
            PRINCIPAL_ID,
        )).isZero()
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
            assertThat(results.map { it.body.canonicalText() }).containsOnly("""{"result":"after"}""")
            assertThat(executions).hasValue(1)
            assertThat(snapshots.calls).hasValue(1)
        } finally {
            pool.shutdownNow()
            assertThat(pool.awaitTermination(10, TimeUnit.SECONDS)).isTrue()
        }
    }

    @Test
    fun `missing negative and stale expected versions roll back ownership and never execute`() {
        listOf(null, -1L, CommandExecutor.MAX_SAFE_INTEGER + 1, 2L).forEachIndexed { index, version ->
            assertThatThrownBy {
                executor.execute(metadata("version-$index").copy(expectedVersion = version), "{}".toByteArray(), command())
            }.isInstanceOfAny(InvalidExpectedVersionException::class.java, OptimisticConflictException::class.java)
        }
        listOf(-1L, CommandExecutor.MAX_SAFE_INTEGER + 1).forEachIndexed { index, lockedVersion ->
            val invalidLock = object : AuthorizedCommand by command() {
                override val aggregateType = "kernel-invalid-$index"
                override val lockPlan = AggregateLockPlan(
                    existing = listOf(AggregateReference(aggregateType, AGGREGATE_ID)),
                )
            }
            assertThatThrownBy {
                executor.execute(metadata("locked-version-$index"), "{}".toByteArray(), invalidLock)
            }.isInstanceOf(InvalidCommandRequestException::class.java)
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
                CanonicalJsonObject.from(JSON.createObjectNode().put("value", "x".repeat(64 * 1024))),
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
    fun `sensitive audit and event content is rejected without persistence or value disclosure`() {
        data class Attempt(val name: String, val request: String, val detail: String, val payload: String)
        val attempts = listOf(
            Attempt("renamed-secret", """{"secret":"s3cr3t-value"}""", """{"note":"s3cr3t-value"}""", "{}"),
            Attempt("nested-key", "{}", """{"nested":{"private_key":"hidden"}}""", "{}"),
            Attempt("jwt-token", "{}", "{}", """{"token":"eyJhbGciOiJIUzI1NiJ9.payload.signature"}"""),
            Attempt("refresh-token", "{}", "{}", """{"refresh_token":"refresh-value"}"""),
        )
        attempts.forEach { attempt ->
            val malicious = object : AuthorizedCommand by command() {
                override fun execute(context: CommandContext): CommandMutation {
                    context.jdbc.update(
                        "UPDATE occ.command_kernel_test SET value = 'unsafe', row_version = 4 WHERE id = ?",
                        AGGREGATE_ID,
                    )
                    return successMutation().copy(
                        auditDetail = json(attempt.detail),
                        events = listOf(PendingEventSpec("kernel-test.updated", 1, json(attempt.payload), 4)),
                    )
                }
            }
            assertThatThrownBy {
                executor.execute(metadata("sensitive-${attempt.name}"), attempt.request.toByteArray(), malicious)
            }.isInstanceOf(InvalidCommandRequestException::class.java)
            assertRolledBack()
        }
    }

    @Test
    fun `event payload policy rejects depth beyond publisher limit before command commit`() {
        val nested = "{" + "\"level\":{".repeat(33) + "}" + "}".repeat(33)
        val tooDeep = object : AuthorizedCommand by command() {
            override fun execute(context: CommandContext): CommandMutation = successMutation().copy(
                events = listOf(PendingEventSpec("kernel-test.updated", 1, json(nested), 4)),
            )
        }

        assertThatThrownBy { executor.execute(metadata("event-depth"), "{}".toByteArray(), tooDeep) }
            .isInstanceOf(InvalidCommandRequestException::class.java)
        assertRolledBack()
    }

    @ParameterizedTest(name = "rejects normalized sensitive event field {0}")
    @MethodSource("com.innorder.occ.events.EventPayloadPolicyTestCases#normalizedSensitiveFields")
    fun `event payload policy rejects every normalized sensitive field`(term: String, field: String) {
        val command = object : AuthorizedCommand by command() {
            override fun execute(context: CommandContext): CommandMutation = successMutation().copy(
                events = listOf(PendingEventSpec(
                    "kernel-test.updated", 1, json("""{"$field":"legacy-value"}"""), 4,
                )),
            )
        }

        assertThatThrownBy { executor.execute(metadata("event-sensitive-$term"), "{}".toByteArray(), command) }
            .isInstanceOf(InvalidCommandRequestException::class.java)
        assertRolledBack()
    }

    @ParameterizedTest(name = "rejects unsafe event number {0}")
    @ValueSource(strings = [
        "9007199254740992", "-9007199254740992",
        "9007199254740992.0", "-9007199254740992.0", "1e309", "-1e309",
    ])
    fun `event payload policy rejects unsafe numbers before command commit`(number: String) {
        val command = object : AuthorizedCommand by command() {
            override fun execute(context: CommandContext): CommandMutation = successMutation().copy(
                events = listOf(PendingEventSpec("kernel-test.updated", 1, json("""{"value":$number}"""), 4)),
            )
        }

        assertThatThrownBy { executor.execute(metadata("event-number-${number.hashCode()}"), "{}".toByteArray(), command) }
            .isInstanceOf(InvalidCommandRequestException::class.java)
        assertRolledBack()
    }

    @Test
    fun `safe non-sensitive request-derived scalar may appear in audit and event payload`() {
        val safe = object : AuthorizedCommand by command() {
            override fun execute(context: CommandContext): CommandMutation {
                context.jdbc.update(
                    "UPDATE occ.command_kernel_test SET value = 'after', row_version = 4 WHERE id = ?",
                    AGGREGATE_ID,
                )
                return successMutation().copy(
                    body = json("""{"displayName":"Alice"}"""),
                    auditDetail = json("""{"displayName":"Alice"}"""),
                    events = listOf(PendingEventSpec(
                        "kernel-test.updated", 1, json("""{"displayName":"Alice"}"""), 4,
                    )),
                )
            }
        }

        val result = executor.execute(metadata("safe-derived"), """{"displayName":"Alice"}""".toByteArray(), safe)

        assertThat(result.body.toJsonNode().path("displayName").textValue()).isEqualTo("Alice")
        assertThat(jdbc.queryForObject("SELECT detail->>'displayName' FROM audit.audit_record WHERE target_entity_id = ?", String::class.java, RESOURCE_ID))
            .isEqualTo("Alice")
    }

    @Test
    fun `all command controlled persisted surfaces reject sensitive terminology and request secrets`() {
        data class Attempt(
            val name: String,
            val requestSecret: String,
            val metadata: CommandMetadata = metadata("surface-$name"),
            val command: (String) -> AuthorizedCommand,
        )
        fun mutationCommand(transform: (CommandMutation, String) -> CommandMutation) = { secret: String ->
            object : AuthorizedCommand by command() {
                override fun execute(context: CommandContext): CommandMutation {
                    context.jdbc.update(
                        "UPDATE occ.command_kernel_test SET value = 'unsafe', row_version = 4 WHERE id = ?",
                        AGGREGATE_ID,
                    )
                    return transform(successMutation(), secret)
                }
            }
        }
        val attempts = listOf(
            Attempt("audit-reason", "reason-sensitive", command = mutationCommand { mutation, secret ->
                mutation.copy(auditReason = secret)
            }),
            Attempt("event-type", "event-sensitive", command = mutationCommand { mutation, secret ->
                mutation.copy(events = listOf(PendingEventSpec(secret, 1, json("{}"), 4)))
            }),
            Attempt("aggregate-type", "secret.aggregate", command = { secret ->
                object : AuthorizedCommand by command() { override val aggregateType = secret }
            }),
            Attempt("response", "response-sensitive", command = mutationCommand { mutation, secret ->
                mutation.copy(body = json("""{"result":"$secret"}"""))
            }),
            Attempt("field-name", "field-name-sensitive", command = mutationCommand { mutation, secret ->
                mutation.copy(auditDetail = json("""{"$secret":"safe"}"""))
            }),
            Attempt(
                "idempotency-key", "idempotency-sensitive",
                metadata = metadata("idempotency-sensitive"),
                command = { command() },
            ),
        )

        attempts.forEach { attempt ->
            assertThatThrownBy {
                executor.execute(
                    attempt.metadata,
                    """{"secret":"${attempt.requestSecret}"}""".toByteArray(),
                    attempt.command(attempt.requestSecret),
                )
            }.describedAs(attempt.name).isInstanceOf(InvalidCommandRequestException::class.java)
            assertRolledBack()
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM authz.decision_log WHERE correlation_id = ?",
                Long::class.java,
                attempt.metadata.correlationId,
            )).isZero()
        }
    }

    @Test
    fun `record keys reject embedded request secrets but allow near matches`() {
        data class Attempt(val name: String, val transform: (CommandMutation, String) -> CommandMutation)
        val secret = "needle-7x"
        val attempts = listOf(
            Attempt("audit-prefix") { mutation, value ->
                mutation.copy(auditDetail = json("""{"${value}-after":"unsafe"}"""))
            },
            Attempt("event-suffix") { mutation, value ->
                mutation.copy(events = listOf(PendingEventSpec(
                    "kernel-test.updated", 1, json("""{"before-$value":"unsafe"}"""), 4,
                )))
            },
            Attempt("response-embedded") { mutation, value ->
                mutation.copy(body = json("""{"before-${value}-after":"unsafe"}"""))
            },
        )

        attempts.forEach { attempt ->
            val attemptMetadata = metadata("embedded-${attempt.name}")
            val malicious = object : AuthorizedCommand by command() {
                override fun execute(context: CommandContext): CommandMutation {
                    context.jdbc.update(
                        "UPDATE occ.command_kernel_test SET value = 'unsafe', row_version = 4 WHERE id = ?",
                        AGGREGATE_ID,
                    )
                    return attempt.transform(successMutation(), secret)
                }
            }

            assertThatThrownBy {
                executor.execute(attemptMetadata, """{"secret":"$secret"}""".toByteArray(), malicious)
            }.describedAs(attempt.name).isInstanceOf(InvalidCommandRequestException::class.java)
            assertRolledBack()
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM authz.decision_log WHERE correlation_id = ?",
                Long::class.java,
                attemptMetadata.correlationId,
            )).isZero()
        }

        val nearMatch = "before-needle-7-after"
        val safe = object : AuthorizedCommand by command() {
            override fun execute(context: CommandContext): CommandMutation {
                context.jdbc.update(
                    "UPDATE occ.command_kernel_test SET value = 'after', row_version = 4 WHERE id = ?",
                    AGGREGATE_ID,
                )
                return successMutation(json("""{"$nearMatch":"safe"}""")).copy(
                    auditDetail = json("""{"$nearMatch":"safe"}"""),
                    events = listOf(PendingEventSpec(
                        "kernel-test.updated", 1, json("""{"$nearMatch":"safe"}"""), 4,
                    )),
                )
            }
        }

        val result = executor.execute(
            metadata("embedded-near-match"),
            """{"secret":"$secret"}""".toByteArray(),
            safe,
        )
        assertThat(result.body.toJsonNode().path(nearMatch).textValue()).isEqualTo("safe")
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM audit.audit_record WHERE jsonb_extract_path_text(detail, ?) = 'safe'",
            Long::class.java,
            nearMatch,
        )).isOne()
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM audit.outbox_event WHERE jsonb_extract_path_text(payload, ?) = 'safe'",
            Long::class.java,
            nearMatch,
        )).isOne()
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

    @Test
    fun `distinct idempotency keys serialize at aggregate lock and stale contender conflicts`() {
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val futures = listOf("aggregate-race-a", "aggregate-race-b").map { key ->
                pool.submit<Any> {
                    start.await(10, TimeUnit.SECONDS)
                    try {
                        executor.execute(metadata(key), "{}".toByteArray(), command())
                    } catch (failure: RuntimeException) {
                        failure
                    }
                }
            }
            start.countDown()
            val outcomes = futures.map { it.get(30, TimeUnit.SECONDS) }

            assertThat(outcomes.count { it is CommandResult }).isEqualTo(1)
            assertThat(outcomes.filterIsInstance<OptimisticConflictException>().single().currentVersion).isEqualTo(4)
            assertThat(executions).hasValue(1)
            assertThat(jdbc.queryForObject("SELECT row_version FROM occ.command_kernel_test WHERE id = ?", Long::class.java, AGGREGATE_ID)).isEqualTo(4)
        } finally {
            pool.shutdownNow()
            assertThat(pool.awaitTermination(10, TimeUnit.SECONDS)).isTrue()
        }
    }

    @Test
    fun `mutation identity and version mismatches roll back before audit and outbox`() {
        val cases = listOf(
            successMutation().copy(resourceId = ENTITY_ID),
            successMutation().copy(aggregateId = UUID.randomUUID()),
            successMutation().copy(beforeVersion = 2),
            successMutation().copy(afterVersion = 5),
        )
        cases.forEachIndexed { index, mutation ->
            val invalid = object : AuthorizedCommand by command() {
                override fun execute(context: CommandContext): CommandMutation {
                    context.jdbc.update(
                        "UPDATE occ.command_kernel_test SET value = 'invalid', row_version = 4 WHERE id = ?",
                        AGGREGATE_ID,
                    )
                    return mutation
                }
            }
            assertThatThrownBy { executor.execute(metadata("mutation-$index"), "{}".toByteArray(), invalid) }
                .isInstanceOf(InvalidCommandRequestException::class.java)
        }
        assertRolledBack()
    }

    @Test
    fun `mutation snapshots caller event list before executor validation and persistence`() {
        val callerEvents = mutableListOf(
            PendingEventSpec("kernel-test.updated", 1, json("""{"value":"after"}"""), 4),
        )
        lateinit var mutation: CommandMutation
        val mutableEventsCommand = object : AuthorizedCommand by command() {
            override fun execute(context: CommandContext): CommandMutation {
                context.jdbc.update(
                    "UPDATE occ.command_kernel_test SET value = 'after', row_version = 4 WHERE id = ?",
                    AGGREGATE_ID,
                )
                mutation = CommandMutation(
                    200, json("""{"result":"after"}"""), RESOURCE_ID, AGGREGATE_ID,
                    "kernel-test", 3, 4, "test", json("""{"changed":true}"""), callerEvents,
                )
                callerEvents.clear()
                return mutation
            }
        }

        val result = executor.execute(metadata("event-snapshot"), "{}".toByteArray(), mutableEventsCommand)

        assertThat(result.status).isEqualTo(200)
        assertThat(mutation.events).hasSize(1)
        assertThatThrownBy {
            @Suppress("UNCHECKED_CAST")
            (mutation.events as MutableList<PendingEventSpec>).clear()
        }.isInstanceOf(UnsupportedOperationException::class.java)
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM audit.outbox_event WHERE aggregate_id = ?",
            Long::class.java,
            AGGREGATE_ID,
        )).isEqualTo(1)
    }

    @Test
    fun `completed idempotency expires at exact 24 hour boundary and cannot replay until cleanup`() {
        val started = Instant.parse("2026-08-01T00:00:00Z")
        val key = metadata("expiry-key")
        executorAt(Clock.fixed(started, ZoneOffset.UTC)).execute(key, "{}".toByteArray(), command())

        val beforeBoundary = executorAt(Clock.fixed(started.plusSeconds(86_400).minusMillis(1), ZoneOffset.UTC))
            .execute(key, "{}".toByteArray(), command())
        assertThat(beforeBoundary.replayed).isTrue()
        assertThatThrownBy {
            executorAt(Clock.fixed(started.plusSeconds(86_400), ZoneOffset.UTC))
                .execute(key, "{}".toByteArray(), command())
        }.isInstanceOf(IdempotencyExpiredException::class.java)
        assertThat(executions).hasValue(1)
    }

    @Test
    fun `tampered replay digest or body fails closed without handler execution`() {
        listOf("digest-tamper" to false, "body-tamper" to true).forEach { (key, tamperBody) ->
            jdbc.update("DELETE FROM audit.outbox_event WHERE aggregate_id = ?", AGGREGATE_ID)
            jdbc.update("UPDATE occ.command_kernel_test SET value = 'before', row_version = 3 WHERE id = ?", AGGREGATE_ID)
            executor.execute(metadata(key), "{}".toByteArray(), command())
            val admin = JdbcTemplate(adminDataSource())
            admin.execute("ALTER TABLE audit.idempotency_record DISABLE TRIGGER trg_idempotency_record_lifecycle")
            try {
                if (tamperBody) {
                    admin.update(
                        "UPDATE audit.idempotency_record SET response_body = '{\"tampered\":true}'::jsonb WHERE principal_id = ? AND idempotency_key = ?",
                        PRINCIPAL_ID, key,
                    )
                } else {
                    admin.update(
                        "UPDATE audit.idempotency_record SET response_digest = repeat('f', 64) WHERE principal_id = ? AND idempotency_key = ?",
                        PRINCIPAL_ID, key,
                    )
                }
            } finally {
                admin.execute("ALTER TABLE audit.idempotency_record ENABLE TRIGGER trg_idempotency_record_lifecycle")
            }
            val countBeforeReplay = executions.get()
            assertThatThrownBy { executor.execute(metadata(key), "{}".toByteArray(), command()) }
                .isInstanceOf(CommandIntegrityException::class.java)
            assertThat(executions).hasValue(countBeforeReplay)
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

    private fun successMutation(body: CanonicalJsonObject = json("""{"result":"after"}""")) = CommandMutation(
        200, body, RESOURCE_ID, AGGREGATE_ID, "kernel-test", 3, 4, "test",
        json("""{"changed":"value"}"""),
        listOf(PendingEventSpec("kernel-test.updated", 1, json("""{"value":"after"}"""), 4)),
    )

    private fun json(value: String): CanonicalJsonObject = CanonicalJsonObject.from(JSON.readTree(value))

    private fun executorAt(clock: Clock): CommandExecutor {
        return CommandExecutor(
            DataSourceTransactionManager(jdbc.dataSource!!), authorization,
            AuthorizationRevisionLockRepository(jdbc),
            IdempotencyRepository.forTesting(jdbc, clock), AuditRepository(jdbc),
            OutboxRepository(jdbc), lockRegistry(), jdbc,
        )
    }

    private fun lockRegistry() = AggregateLockRegistry(listOf(
        AggregateLockResolver("kernel-secondary", 10) { operations, id ->
            lockOrder += AggregateReference("kernel-secondary", id)
            operations.queryForObject(
                "SELECT row_version FROM occ.command_kernel_test WHERE id = ? FOR UPDATE",
                Long::class.java,
                id,
            )
        },
        AggregateLockResolver("kernel-test", 20) { operations, id ->
            lockOrder += AggregateReference("kernel-test", id)
            operations.query(
                "SELECT row_version FROM occ.command_kernel_test WHERE id = ? FOR UPDATE",
                { result, _ -> result.getLong(1) },
                id,
            ).singleOrNull()
        },
        AggregateLockResolver("kernel-created", 30) { _, _ -> error("created aggregates are not locked") },
        AggregateLockResolver("kernel-invalid-0", 40) { _, _ -> -1 },
        AggregateLockResolver("kernel-invalid-1", 40) { _, _ -> CommandExecutor.MAX_SAFE_INTEGER + 1 },
    ))

    private fun command() = object : AuthorizedCommand {
        override val action = "test.update"
        override val entityId = ENTITY_ID
        override val resourceId = RESOURCE_ID
        override val aggregateType = "kernel-test"
        override val aggregateId = AGGREGATE_ID
        override val expectedVersionRequired = true
        override val changesAuthorizationFacts = false
        override val lockPlan = AggregateLockPlan(existing = listOf(AggregateReference(aggregateType, aggregateId)))

        override fun execute(context: CommandContext): CommandMutation {
            executions.incrementAndGet()
            context.jdbc.update(
                "UPDATE occ.command_kernel_test SET value = 'after', row_version = row_version + 1 WHERE id = ?",
                AGGREGATE_ID,
            )
            return CommandMutation(
                status = 200,
                body = json("""{"result":"after"}"""),
                resourceId = RESOURCE_ID,
                aggregateId = AGGREGATE_ID,
                aggregateType = "kernel-test",
                beforeVersion = 3,
                afterVersion = 4,
                auditReason = "test",
                auditDetail = json("""{"changed":"value"}"""),
                events = listOf(PendingEventSpec("kernel-test.updated", 1, json("""{"value":"after"}"""), 4)),
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
        private val SECOND_AGGREGATE_ID = UUID.fromString("81000000-0000-7000-8000-000000000007")
        private val CREATED_AGGREGATE_ID = UUID.fromString("81000000-0000-7000-8000-000000000008")
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
