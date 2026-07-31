package com.innorder.occ.authz

import com.fasterxml.jackson.databind.ObjectMapper
import com.sun.net.httpserver.HttpServer
import com.sun.net.httpserver.HttpExchange
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import org.flywaydb.core.Flyway
import org.postgresql.ds.PGSimpleDataSource
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Duration
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@Testcontainers(disabledWithoutDocker = true)
class AuthorizationServiceIntegrationTest {
    private var server: HttpServer? = null

    @AfterEach
    fun cleanup() {
        server?.stop(0)
        TransactionSynchronizationManager.clear()
    }

    @Test
    fun `OPA client sends the exact v1 wrapper and strictly parses an allow decision`() {
        val requestBody = arrayOfNulls<String>(1)
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/v1/data/innorder/platform/authz/decision") { exchange ->
                requestBody[0] = exchange.requestBody.bufferedReader(Charsets.UTF_8).use { it.readText() }
                val response = """{"result":{"contractVersion":1,"requestId":"$REQUEST_ID","authorizationRevision":17,"releases":{"PLATFORM":"$PLATFORM_VERSION_ID"},"decision":"ALLOW","allow":true,"reasonCodes":["ALLOW_GRANT_MATCH"],"reasonIds":["$GRANT_REFERENCE"],"matchedPolicyIds":["$GRANT_REFERENCE"]}}"""
                exchange.responseHeaders.add("Content-Type", "application/json")
                exchange.sendResponseHeaders(200, response.toByteArray().size.toLong())
                exchange.responseBody.use { it.write(response.toByteArray()) }
            }
            start()
        }
        val snapshot = snapshot()

        val decision = OpaClient(
            ObjectMapper().findAndRegisterModules(),
            OpaProperties("http://127.0.0.1:${server!!.address.port}", Duration.ofMillis(500), Duration.ofSeconds(1)),
        ).decide(snapshot)

        assertThat(decision.decision).isEqualTo(AuthorizationDecisionValue.ALLOW)
        assertThat(decision.allow).isTrue()
        val input = ObjectMapper().readTree(requestBody[0]).path("input")
        val expected = ObjectMapper().readTree(
            """{"contractVersion":1,"requestId":"$REQUEST_ID","authorizationRevision":17,"releases":{"PLATFORM":"$PLATFORM_VERSION_ID"},"principal":{"id":"$PRINCIPAL_ID","enabled":true},"entity":{"id":"$ENTITY_ID"},"action":"occ.read","resource":{"id":"$RESOURCE_ID","active":true},"context":{"correlationId":"$REQUEST_ID"},"forbiddenActions":[],"grants":[{"id":"platform-administrator-read","layer":"PLATFORM","releaseId":"$PLATFORM_VERSION_ID","effect":"ALLOW","action":"occ.read","principalId":"$PRINCIPAL_ID","entityId":"*","resourceId":"*"}]}""",
        )
        assertThat(input).isEqualTo(expected)
    }

    @Test
    fun `OPA client fails closed on status malformed oversized and timeout responses`() {
        assertOpaFailure { exchange ->
            exchange.sendResponseHeaders(503, 0)
            exchange.responseBody.close()
        }
        assertOpaFailure { exchange ->
            val bytes = "{\"result\":".toByteArray()
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        assertOpaFailure { exchange ->
            val bytes = ByteArray(256 * 1024 + 1) { 'x'.code.toByte() }
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        assertOpaFailure { exchange ->
            Thread.sleep(1_250)
            exchange.sendResponseHeaders(200, 0)
            exchange.responseBody.close()
        }
    }

    @Test
    fun `OPA client preserves the interrupt flag`() {
        val entered = CountDownLatch(1)
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/v1/data/innorder/platform/authz/decision") { exchange ->
                exchange.requestBody.use { it.readAllBytes() }
                entered.countDown()
                Thread.sleep(2_000)
                exchange.sendResponseHeaders(200, 0)
                exchange.responseBody.close()
            }
            start()
        }
        val preserved = AtomicBoolean()
        val caller = Thread {
            try {
                OpaClient(
                    ObjectMapper().findAndRegisterModules(),
                    OpaProperties("http://127.0.0.1:${server!!.address.port}"),
                ).decide(snapshot())
            } catch (_: OpaClientException) {
                preserved.set(Thread.currentThread().isInterrupted)
            }
        }
        caller.start()
        assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue()
        caller.interrupt()
        caller.join(5_000)
        assertThat(caller.isAlive).isFalse()
        assertThat(preserved).isTrue()
    }

    @Test
    fun `OPA client rejects non opaque policy references`() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/v1/data/innorder/platform/authz/decision") { exchange ->
                exchange.requestBody.use { it.readAllBytes() }
                val response = """{"result":{"contractVersion":1,"requestId":"$REQUEST_ID","authorizationRevision":17,"releases":{"PLATFORM":"$PLATFORM_VERSION_ID"},"decision":"ALLOW","allow":true,"reasonCodes":["ALLOW_GRANT_MATCH"],"reasonIds":["grant:raw-id"],"matchedPolicyIds":["grant:raw-id"]}}"""
                exchange.sendResponseHeaders(200, response.toByteArray().size.toLong())
                exchange.responseBody.use { it.write(response.toByteArray()) }
            }
            start()
        }

        assertThatThrownBy {
            OpaClient(
                ObjectMapper().findAndRegisterModules(),
                OpaProperties("http://127.0.0.1:${server!!.address.port}"),
            ).decide(snapshot())
        }.isInstanceOf(OpaClientException::class.java)
            .hasMessage("Policy decision service is unavailable")
    }

    @Test
    fun `OPA client rejects non RFC textual UUID representations before DTO conversion`() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/v1/data/innorder/platform/authz/decision") { exchange ->
                exchange.requestBody.use { it.readAllBytes() }
                val response = """{"result":{"contractVersion":1,"requestId":"3d3d3d3dTd2N3d3d3d3d3Q==","authorizationRevision":17,"releases":{"PLATFORM":"$PLATFORM_VERSION_ID"},"decision":"ALLOW","allow":true,"reasonCodes":["ALLOW_GRANT_MATCH"],"reasonIds":["$GRANT_REFERENCE"],"matchedPolicyIds":["$GRANT_REFERENCE"]}}"""
                exchange.sendResponseHeaders(200, response.toByteArray().size.toLong())
                exchange.responseBody.use { it.write(response.toByteArray()) }
            }
            start()
        }

        assertThatThrownBy {
            OpaClient(
                ObjectMapper().findAndRegisterModules(),
                OpaProperties("http://127.0.0.1:${server!!.address.port}"),
            ).decide(snapshot())
        }.isInstanceOf(OpaClientException::class.java)
    }

    @Test
    fun `real OPA serves the exact v1 decision endpoint wrapper`() {
        val strict = System.getenv("INNORDER_STRICT_AUTHZ_TESTS") == "1"
        val opa = System.getenv("OPA_PATH")
        if (strict) assertThat(opa).describedAs("strict authorization tests require OPA_PATH").isNotBlank()
        assumeTrue(!opa.isNullOrBlank(), "OPA_PATH is not configured")
        val policyDirectory = sequenceOf(
            Path.of("policies", "opa"),
            Path.of("..", "..", "policies", "opa"),
        ).map(Path::toAbsolutePath).firstOrNull(Files::isDirectory)
        if (strict) assertThat(policyDirectory).describedAs("OPA policy directory").isNotNull()
        assumeTrue(policyDirectory != null, "OPA policy directory is unavailable")
        val port = ServerSocket(0).use { it.localPort }
        val process = ProcessBuilder(
            opa,
            "run",
            "--server",
            "--addr=127.0.0.1:$port",
            policyDirectory.toString(),
        ).redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .redirectError(ProcessBuilder.Redirect.DISCARD)
            .start()
        try {
            awaitOpa(port, process)
            val jdbc = JdbcTemplate(dataSource())
            resetAuthorizationFacts(jdbc)
            val builtSnapshot = TransactionTemplate(DataSourceTransactionManager(jdbc.dataSource!!)).execute {
                AuthorizationSnapshotRepository(jdbc, ObjectMapper().findAndRegisterModules()).load(request())
            }!!
            val result = OpaClient(
                ObjectMapper().findAndRegisterModules(),
                OpaProperties("http://127.0.0.1:$port"),
            ).decide(builtSnapshot)
            assertThat(result.decision).isEqualTo(AuthorizationDecisionValue.DENY)
            assertThat(result.requestId).isEqualTo(REQUEST_ID)
            assertThat(result.authorizationRevision).isEqualTo(builtSnapshot.authorizationRevision)
            assertThat(result.releases).containsExactlyEntriesOf(builtSnapshot.releases)
            assertThat(result.reasonCodes).contains("EXPLICIT_DENY")

            jdbc.update(
                "UPDATE authz.relationship SET revoked_at = transaction_timestamp() WHERE subject_entity_id = ? AND revoked_at IS NULL",
                PRINCIPAL_ID,
            )
            val noRoleSnapshot = TransactionTemplate(DataSourceTransactionManager(jdbc.dataSource!!)).execute {
                AuthorizationSnapshotRepository(jdbc, ObjectMapper().findAndRegisterModules()).load(request())
            }!!
            assertThat(noRoleSnapshot.grants).isEmpty()
            val noRoleResult = OpaClient(
                ObjectMapper().findAndRegisterModules(),
                OpaProperties("http://127.0.0.1:$port"),
            ).decide(noRoleSnapshot)
            assertThat(noRoleResult.decision).isEqualTo(AuthorizationDecisionValue.DENY)
            assertThat(noRoleResult.reasonCodes).containsExactly("NO_MATCHING_ALLOW")
        } finally {
            process.destroy()
            if (!process.waitFor(5, TimeUnit.SECONDS)) process.destroyForcibly()
        }
    }

    @Test
    fun `service rejects authorization outside an active transaction without taking a snapshot`() {
        val snapshots = RecordingSnapshotSource(snapshot())
        val service = AuthorizationService(snapshots, FixedDecisionClient(decision()), RecordingDecisionLog())

        assertThatThrownBy { service.authorize(request()) }
            .isInstanceOf(AuthorizationAvailabilityException::class.java)
            .hasMessage("Authorization is unavailable")
        assertThat(snapshots.calls).isZero()
    }

    @Test
    fun `service fails closed when OPA echoes a stale authorization revision`() {
        TransactionSynchronizationManager.setActualTransactionActive(true)
        val logs = RecordingDecisionLog()
        val stale = decision().copy(authorizationRevision = 16)
        val service = AuthorizationService(RecordingSnapshotSource(snapshot()), FixedDecisionClient(stale), logs)

        assertThatThrownBy { service.authorize(request()) }
            .isInstanceOf(AuthorizationAvailabilityException::class.java)
            .hasMessage("Authorization is unavailable")
        assertThat(logs.independent.single().decision).isEqualTo(AuthorizationDecisionValue.ERROR)
        assertThat(logs.independent.single().reasonCodes).containsExactly("AUTHORIZATION_INTEGRITY_ERROR")
    }

    @Test
    fun `snapshot expands a published role grant only for the fixed direct active relationship`() {
        val jdbc = JdbcTemplate(dataSource())
        resetAuthorizationFacts(jdbc)
        val repository = AuthorizationSnapshotRepository(jdbc, ObjectMapper().findAndRegisterModules())
        val transactions = TransactionTemplate(DataSourceTransactionManager(jdbc.dataSource!!))

        val snapshot = transactions.execute { repository.load(request()) }!!

        assertThat(snapshot.releases).containsExactlyEntriesOf(mapOf(
            PolicyLayer.DOMAIN to DOMAIN_VERSION_ID,
            PolicyLayer.PLATFORM to PLATFORM_VERSION_ID,
        ))
        assertThat(snapshot.composedReleaseId).isEqualTo(COMPOSED_RELEASE_ID)
        assertThat(snapshot.opaRevision).isEqualTo("platform-authz-v1")
        assertThat(snapshot.principal.enabled).isTrue()
        assertThat(snapshot.resource.active).isTrue()
        assertThat(snapshot.grants).containsExactly(
            AuthorizationGrant(
                "domain-administrator-read-deny", PolicyLayer.DOMAIN, DOMAIN_VERSION_ID,
                GrantEffect.DENY, "occ.read", PRINCIPAL_ID.toString(), "*", "*",
            ),
            AuthorizationGrant(
                "platform-administrator-read", PolicyLayer.PLATFORM, PLATFORM_VERSION_ID,
                GrantEffect.ALLOW, "occ.read", PRINCIPAL_ID.toString(), "*", "*",
            ),
        )
        assertThat(snapshot.contextDigest).matches("^[0-9a-f]{64}${'$'}")
        assertThat(snapshot.snapshotAt).isNotNull()
        assertThatThrownBy { (snapshot.context as MutableMap<String, Any?>)["new"] = "value" }
            .isInstanceOf(UnsupportedOperationException::class.java)
        assertThatThrownBy { (snapshot.grants as MutableList<AuthorizationGrant>).clear() }
            .isInstanceOf(UnsupportedOperationException::class.java)

        jdbc.update(
            "UPDATE authz.relationship SET revoked_at = transaction_timestamp() WHERE subject_entity_id = ? AND revoked_at IS NULL",
            PRINCIPAL_ID,
        )
        val withoutRole = transactions.execute { repository.load(request()) }!!
        assertThat(withoutRole.grants).isEmpty()
    }

    @Test
    fun `snapshot rejects authorization revision above the safe integer ceiling`() {
        val jdbc = JdbcTemplate(dataSource())
        resetAuthorizationFacts(jdbc)
        val previous = jdbc.queryForObject(
            "SELECT current_revision FROM authz.authorization_state WHERE singleton",
            Long::class.java,
        )!!
        try {
            jdbc.update(
                "UPDATE authz.authorization_state SET current_revision = ? WHERE singleton",
                AuthorizationDecisionValidator.MAX_SAFE_INTEGER + 1,
            )
            val repository = AuthorizationSnapshotRepository(jdbc, ObjectMapper().findAndRegisterModules())
            val transactions = TransactionTemplate(DataSourceTransactionManager(jdbc.dataSource!!))

            assertThatThrownBy { transactions.execute { repository.load(request()) } }
                .isInstanceOf(AuthorizationSnapshotException::class.java)
        } finally {
            jdbc.update("UPDATE authz.authorization_state SET current_revision = ? WHERE singleton", previous)
        }
    }

    @Test
    fun `expired future and wrong relation assignments never expand grants`() {
        val jdbc = JdbcTemplate(dataSource())
        resetAuthorizationFacts(jdbc)
        val manager = DataSourceTransactionManager(jdbc.dataSource!!)
        val repository = AuthorizationSnapshotRepository(jdbc, ObjectMapper().findAndRegisterModules())
        fun snapshotGrants() = TransactionTemplate(manager).execute { repository.load(request()).grants }!!
        fun revokeCurrent() = jdbc.update(
            "UPDATE authz.relationship SET revoked_at = greatest(transaction_timestamp(), valid_from) WHERE subject_entity_id = ? AND revoked_at IS NULL",
            PRINCIPAL_ID,
        )

        revokeCurrent()
        jdbc.update(
            """INSERT INTO authz.relationship
               (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until, source_kind, source_ref)
               VALUES (?, ?, ?, ?, transaction_timestamp() - interval '2 hours', transaction_timestamp() - interval '1 hour', 'SYSTEM', 'expired')""",
            UUID.randomUUID(), RELATION_ID, PRINCIPAL_ID, ROLE_ID,
        )
        assertThat(snapshotGrants()).isEmpty()

        revokeCurrent()
        jdbc.update(
            """INSERT INTO authz.relationship
               (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, source_kind, source_ref)
               VALUES (?, ?, ?, ?, transaction_timestamp() + interval '1 hour', 'SYSTEM', 'future')""",
            UUID.randomUUID(), RELATION_ID, PRINCIPAL_ID, ROLE_ID,
        )
        assertThat(snapshotGrants()).isEmpty()

        revokeCurrent()
        jdbc.update(
            """INSERT INTO authz.relationship
               (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, source_kind, source_ref)
               VALUES (?, ?, ?, ?, transaction_timestamp(), 'SYSTEM', 'wrong-relation')""",
            UUID.randomUUID(), WRONG_RELATION_ID, PRINCIPAL_ID, ROLE_ID,
        )
        assertThat(snapshotGrants()).isEmpty()
    }

    @Test
    fun `snapshot holds the shared authorization lock and one transaction timestamp until caller completion`() {
        val jdbc = JdbcTemplate(dataSource())
        resetAuthorizationFacts(jdbc)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val snapshotFuture = pool.submit<AuthorizationSnapshot> {
                val local = JdbcTemplate(dataSource())
                TransactionTemplate(DataSourceTransactionManager(local.dataSource!!)).execute {
                    val snapshot = AuthorizationSnapshotRepository(local, ObjectMapper().findAndRegisterModules()).load(request())
                    Thread.sleep(25)
                    assertThat(local.queryForObject("SELECT transaction_timestamp()", java.time.OffsetDateTime::class.java))
                        .isEqualTo(snapshot.snapshotAt)
                    entered.countDown()
                    assertThat(release.await(10, TimeUnit.SECONDS)).isTrue()
                    snapshot
                }!!
            }
            assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue()
            val changeFuture = pool.submit<Int> {
                JdbcTemplate(dataSource()).update(
                    "UPDATE authz.relationship SET revoked_at = greatest(transaction_timestamp(), valid_from) WHERE subject_entity_id = ? AND revoked_at IS NULL",
                    PRINCIPAL_ID,
                )
            }
            Thread.sleep(250)
            assertThat(changeFuture.isDone).isFalse()
            release.countDown()
            assertThat(snapshotFuture.get(10, TimeUnit.SECONDS)).isNotNull()
            assertThat(changeFuture.get(10, TimeUnit.SECONDS)).isEqualTo(1)
        } finally {
            release.countDown()
            pool.shutdownNow()
            assertThat(pool.awaitTermination(10, TimeUnit.SECONDS)).isTrue()
        }
    }

    @Test
    fun `allow log rolls back with its caller transaction`() {
        val jdbc = JdbcTemplate(dataSource())
        resetAuthorizationFacts(jdbc)
        val manager = DataSourceTransactionManager(jdbc.dataSource!!)
        val service = databaseService(jdbc, manager, AuthorizationDecisionValue.ALLOW)
        val request = request().copy(
            requestId = UUID.randomUUID(),
            context = mapOf("secret" to "context-secret-value"),
        )

        TransactionTemplate(manager).execute { status ->
            service.authorize(request)
            status.setRollbackOnly()
        }

        assertThat(decisionCount(jdbc, request.requestId)).isZero()
    }

    @Test
    fun `allow returns an immutable reference and commits its log with caller`() {
        val jdbc = JdbcTemplate(dataSource())
        resetAuthorizationFacts(jdbc)
        val manager = DataSourceTransactionManager(jdbc.dataSource!!)
        val service = databaseService(jdbc, manager, AuthorizationDecisionValue.ALLOW)
        val request = request().copy(requestId = UUID.randomUUID())

        val reference = TransactionTemplate(manager).execute { service.authorize(request) }!!

        assertThat(decisionCount(jdbc, request.requestId)).isEqualTo(1)
        assertThat(jdbc.queryForObject(
            "SELECT decision FROM authz.decision_log WHERE request_id = ?",
            String::class.java,
            request.requestId,
        )).isEqualTo("ALLOW")
        assertThatThrownBy {
            (reference.releases as MutableMap<PolicyLayer, UUID>)[PolicyLayer.CUSTOMER] = UUID.randomUUID()
        }.isInstanceOf(UnsupportedOperationException::class.java)
        assertThatThrownBy { (reference.matchedPolicyIds as MutableList<String>).clear() }
            .isInstanceOf(UnsupportedOperationException::class.java)
    }

    @Test
    fun `allow log stores independently calculated exact context and result digests`() {
        val jdbc = JdbcTemplate(dataSource())
        resetAuthorizationFacts(jdbc)
        val manager = DataSourceTransactionManager(jdbc.dataSource!!)
        val mapper = ObjectMapper().findAndRegisterModules()
        val fixedSnapshot = snapshot().copy(
            contextDigest = "f0f1045f6f1922e3bc4fcc9ec9eec908ec2b38dc70d0586f97edb522633cd567",
        )
        val service = AuthorizationService(
            AuthorizationSnapshotSource { fixedSnapshot },
            PolicyDecisionClient { decision() },
            DecisionLogRepository(jdbc, manager, mapper),
        )

        TransactionTemplate(manager).execute { service.authorize(request()) }

        val row = jdbc.queryForMap(
            """SELECT context_digest, result_digest, principal_entity_id, action_key, resource_entity_id,
                      policy_release_id, authorization_revision
               FROM authz.decision_log WHERE request_id = ? ORDER BY created_at DESC LIMIT 1""",
            REQUEST_ID,
        )
        assertThat(row["context_digest"])
            .isEqualTo("f0f1045f6f1922e3bc4fcc9ec9eec908ec2b38dc70d0586f97edb522633cd567")
        assertThat(row["result_digest"])
            .isEqualTo("5b30953c997b180c5191dd50f272e6ccbdbd5c9b07518e58643bc81a2cbaad47")
        assertThat(row["principal_entity_id"]).isEqualTo(PRINCIPAL_ID)
        assertThat(row["action_key"]).isEqualTo("occ.read")
        assertThat(row["resource_entity_id"]).isEqualTo(RESOURCE_ID)
        assertThat(row["policy_release_id"]).isEqualTo(COMPOSED_RELEASE_ID)
        assertThat(row["authorization_revision"]).isEqualTo(17L)
    }

    @Test
    fun `deny log commits independently and survives the caller rollback`() {
        val jdbc = JdbcTemplate(dataSource())
        resetAuthorizationFacts(jdbc)
        val manager = DataSourceTransactionManager(jdbc.dataSource!!)
        val service = databaseService(jdbc, manager, AuthorizationDecisionValue.DENY)
        val request = request().copy(
            requestId = UUID.randomUUID(),
            context = mapOf("secret" to "context-secret-value"),
        )

        assertThatThrownBy { TransactionTemplate(manager).execute { service.authorize(request) } }
            .isInstanceOf(AuthorizationDeniedException::class.java)

        assertThat(decisionCount(jdbc, request.requestId)).isEqualTo(1)
        val row = jdbc.queryForMap(
            """SELECT decision, reason_codes, matched_policies, context_digest,
                      resource_ref, result_digest, latency_ms
               FROM authz.decision_log WHERE request_id = ?""",
            request.requestId,
        )
        assertThat(row["decision"]).isEqualTo("DENY")
        assertThat(row["reason_codes"].toString()).contains("NO_MATCHING_ALLOW")
        assertThat(row["matched_policies"].toString()).isEqualTo("[]")
        assertThat(row["context_digest"].toString()).matches("^[0-9a-f]{64}${'$'}")
        assertThat(row["resource_ref"]).isNull()
        assertThat(row["result_digest"].toString()).matches("^[0-9a-f]{64}${'$'}")
        assertThat(row["latency_ms"] as Int).isNotNegative()
        assertThat(jdbc.queryForObject(
            "SELECT to_jsonb(d)::text FROM authz.decision_log d WHERE request_id = ?",
            String::class.java,
            request.requestId,
        )).doesNotContain("context-secret-value")
    }

    @Test
    fun `transport and stale release errors log independently and survive caller rollback`() {
        val jdbc = JdbcTemplate(dataSource())
        resetAuthorizationFacts(jdbc)
        val manager = DataSourceTransactionManager(jdbc.dataSource!!)
        val mapper = ObjectMapper().findAndRegisterModules()
        val attempts = listOf<PolicyDecisionClient>(
            PolicyDecisionClient { throw OpaClientException() },
            PolicyDecisionClient { snapshot ->
                AuthorizationDecision(
                    1, snapshot.requestId, snapshot.authorizationRevision - 1, snapshot.releases,
                    AuthorizationDecisionValue.ALLOW, true, listOf("ALLOW_GRANT_MATCH"),
                    listOf(GRANT_REFERENCE), listOf(GRANT_REFERENCE),
                )
            },
            PolicyDecisionClient { snapshot ->
                AuthorizationDecision(
                    1, snapshot.requestId, snapshot.authorizationRevision,
                    snapshot.releases + (PolicyLayer.PLATFORM to UUID.randomUUID()),
                    AuthorizationDecisionValue.ALLOW, true, listOf("ALLOW_GRANT_MATCH"),
                    listOf(GRANT_REFERENCE), listOf(GRANT_REFERENCE),
                )
            },
        )
        attempts.forEach { client ->
            val request = request().copy(requestId = UUID.randomUUID())
            val service = AuthorizationService(
                AuthorizationSnapshotRepository(jdbc, mapper),
                client,
                DecisionLogRepository(jdbc, manager, mapper),
            )
            assertThatThrownBy { TransactionTemplate(manager).execute { service.authorize(request) } }
                .isInstanceOf(AuthorizationAvailabilityException::class.java)
            val row = jdbc.queryForMap(
                "SELECT decision, reason_codes, matched_policies FROM authz.decision_log WHERE request_id = ?",
                request.requestId,
            )
            assertThat(row["decision"]).isEqualTo("ERROR")
            assertThat(row["reason_codes"].toString()).contains("AUTHORIZATION_INTEGRITY_ERROR")
            assertThat(row["matched_policies"].toString()).contains("policy:").doesNotContain("OpaClientException")
        }
    }

    @Test
    fun `real OPA client HTTP and integrity failures persist sanitized ERROR logs independently`() {
        val jdbc = JdbcTemplate(dataSource())
        val manager = DataSourceTransactionManager(jdbc.dataSource!!)
        val mapper = ObjectMapper().findAndRegisterModules()
        val cases = listOf(
            HttpFailureCase("http") { exchange, _ ->
                val bytes = "raw-http-response-secret".toByteArray()
                exchange.sendResponseHeaders(503, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            },
            HttpFailureCase("malformed") { exchange, _ ->
                val bytes = "{\"raw-malformed-response-secret\":".toByteArray()
                exchange.sendResponseHeaders(200, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            },
            HttpFailureCase("unknown") { exchange, input ->
                sendJson(exchange, mapper.createObjectNode().apply {
                    set<com.fasterxml.jackson.databind.JsonNode>("result", validAllowDecision(mapper, input))
                    put("rawUnknownResponseSecret", true)
                }, mapper)
            },
            HttpFailureCase("oversized") { exchange, _ ->
                val bytes = ByteArray(256 * 1024 + 1) { 'x'.code.toByte() }
                exchange.sendResponseHeaders(200, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            },
            HttpFailureCase("timeout") { exchange, _ ->
                Thread.sleep(1_250)
                exchange.sendResponseHeaders(200, 0)
                exchange.responseBody.close()
            },
            HttpFailureCase("stale-revision") { exchange, input ->
                val decision = validAllowDecision(mapper, input).apply {
                    put("authorizationRevision", input.path("authorizationRevision").longValue() - 1)
                }
                sendJson(exchange, mapper.createObjectNode().set("result", decision), mapper)
            },
            HttpFailureCase("stale-release") { exchange, input ->
                val decision = validAllowDecision(mapper, input)
                (decision.path("releases") as com.fasterxml.jackson.databind.node.ObjectNode)
                    .put("PLATFORM", UUID.randomUUID().toString())
                sendJson(exchange, mapper.createObjectNode().set("result", decision), mapper)
            },
        )

        cases.forEach { case ->
            resetAuthorizationFacts(jdbc)
            server?.stop(0)
            server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
                createContext("/v1/data/innorder/platform/authz/decision") { exchange ->
                    val input = mapper.readTree(exchange.requestBody).path("input")
                    case.respond(exchange, input)
                }
                start()
            }
            val client = OpaClient(
                mapper,
                OpaProperties("http://127.0.0.1:${server!!.address.port}"),
            )
            val service = AuthorizationService(
                AuthorizationSnapshotRepository(jdbc, mapper),
                client,
                DecisionLogRepository(jdbc, manager, mapper),
            )
            val request = request().copy(
                requestId = UUID.randomUUID(),
                context = mapOf("secret" to "service-secret-context"),
            )

            assertThatThrownBy { TransactionTemplate(manager).execute { service.authorize(request) } }
                .describedAs(case.name)
                .isInstanceOf(AuthorizationAvailabilityException::class.java)

            val row = jdbc.queryForMap(
                """SELECT decision, reason_codes, matched_policies, context_digest, result_digest,
                          to_jsonb(d)::text AS rendered
                   FROM authz.decision_log d WHERE request_id = ?""",
                request.requestId,
            )
            assertThat(row["decision"]).isEqualTo("ERROR")
            assertThat(row["reason_codes"].toString()).isEqualTo("[\"AUTHORIZATION_INTEGRITY_ERROR\"]")
            assertThat(row["matched_policies"].toString())
                .isEqualTo("[\"policy:f588c3bf56f52a87833e48bec0932820d831012c74c2d191f652dd76237c24e2\"]")
            assertThat(row["context_digest"])
                .isEqualTo("e7b85842184ecaa6465bad57cc123d027bd47938f35fa68c6830428cdb7d66a6")
            assertThat(row["result_digest"])
                .isEqualTo("9ef74ed0417b681470606304d1477498f2331e36b66ccd471acf955b01681fe9")
            assertThat(row["rendered"].toString())
                .doesNotContain("service-secret-context", "raw-", "127.0.0.1", "OpaClientException")
        }
    }

    private fun request() = AuthorizationRequest(
        requestId = REQUEST_ID,
        principalId = PRINCIPAL_ID,
        action = "occ.read",
        entityId = ENTITY_ID,
        resourceId = RESOURCE_ID,
        context = mapOf("correlationId" to REQUEST_ID.toString()),
    )

    private fun snapshot() = AuthorizationSnapshot(
        contractVersion = 1,
        requestId = REQUEST_ID,
        authorizationRevision = 17,
        releases = mapOf(PolicyLayer.PLATFORM to PLATFORM_VERSION_ID),
        principal = AuthorizationPrincipal(PRINCIPAL_ID, true),
        entity = AuthorizationEntity(ENTITY_ID),
        action = "occ.read",
        resource = AuthorizationResource(RESOURCE_ID, true),
        context = mapOf("correlationId" to REQUEST_ID.toString()),
        forbiddenActions = emptyList(),
        grants = listOf(
            AuthorizationGrant(
                "platform-administrator-read", PolicyLayer.PLATFORM, PLATFORM_VERSION_ID,
                GrantEffect.ALLOW, "occ.read", PRINCIPAL_ID.toString(), "*", "*",
            ),
        ),
        composedReleaseId = COMPOSED_RELEASE_ID,
        opaRevision = "platform-authz-v1",
        entityVersions = mapOf(PRINCIPAL_ID to 0, ENTITY_ID to 2, RESOURCE_ID to 4),
        contextDigest = "a".repeat(64),
    )

    private fun decision() = AuthorizationDecision(
        contractVersion = 1,
        requestId = REQUEST_ID,
        authorizationRevision = 17,
        releases = mapOf(PolicyLayer.PLATFORM to PLATFORM_VERSION_ID),
        decision = AuthorizationDecisionValue.ALLOW,
        allow = true,
        reasonCodes = listOf("ALLOW_GRANT_MATCH"),
        reasonIds = listOf(GRANT_REFERENCE),
        matchedPolicyIds = listOf(GRANT_REFERENCE),
    )

    private fun databaseService(
        jdbc: JdbcTemplate,
        manager: PlatformTransactionManager,
        outcome: AuthorizationDecisionValue,
    ): AuthorizationService {
        val mapper = ObjectMapper().findAndRegisterModules()
        return AuthorizationService(
            AuthorizationSnapshotRepository(jdbc, mapper),
            PolicyDecisionClient { snapshot ->
                AuthorizationDecision(
                    1,
                    snapshot.requestId,
                    snapshot.authorizationRevision,
                    snapshot.releases,
                    outcome,
                    outcome == AuthorizationDecisionValue.ALLOW,
                    if (outcome == AuthorizationDecisionValue.ALLOW) listOf("ALLOW_GRANT_MATCH") else listOf("NO_MATCHING_ALLOW"),
                    if (outcome == AuthorizationDecisionValue.ALLOW) listOf(GRANT_REFERENCE) else listOf(POLICY_REFERENCE),
                    if (outcome == AuthorizationDecisionValue.ALLOW) listOf(GRANT_REFERENCE) else emptyList(),
                )
            },
            DecisionLogRepository(jdbc, manager, mapper),
        )
    }

    private fun decisionCount(jdbc: JdbcTemplate, requestId: UUID): Long = jdbc.queryForObject(
        "SELECT count(*) FROM authz.decision_log WHERE request_id = ?",
        Long::class.java,
        requestId,
    )!!

    private fun awaitOpa(port: Int, process: Process) {
        val client = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(250)).build()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            check(process.isAlive) { "OPA process exited before becoming ready" }
            try {
                val response = client.send(
                    HttpRequest.newBuilder(URI("http://127.0.0.1:$port/health"))
                        .timeout(Duration.ofMillis(250)).GET().build(),
                    HttpResponse.BodyHandlers.discarding(),
                )
                if (response.statusCode() == 200) return
            } catch (_: Exception) {
                Thread.sleep(25)
            }
        }
        error("OPA did not become ready")
    }

    private fun assertOpaFailure(response: (HttpExchange) -> Unit) {
        server?.stop(0)
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/v1/data/innorder/platform/authz/decision") { exchange ->
                exchange.requestBody.use { it.readAllBytes() }
                response(exchange)
            }
            start()
        }
        assertThatThrownBy {
            OpaClient(
                ObjectMapper().findAndRegisterModules(),
                OpaProperties("http://127.0.0.1:${server!!.address.port}"),
            ).decide(snapshot())
        }.isInstanceOf(OpaClientException::class.java)
            .hasMessage("Policy decision service is unavailable")
    }

    private fun validAllowDecision(
        mapper: ObjectMapper,
        input: com.fasterxml.jackson.databind.JsonNode,
    ): com.fasterxml.jackson.databind.node.ObjectNode = mapper.createObjectNode().apply {
        put("contractVersion", 1)
        put("requestId", input.path("requestId").textValue())
        put("authorizationRevision", input.path("authorizationRevision").longValue())
        set<com.fasterxml.jackson.databind.JsonNode>("releases", input.path("releases").deepCopy())
        put("decision", "ALLOW")
        put("allow", true)
        putArray("reasonCodes").add("ALLOW_GRANT_MATCH")
        putArray("reasonIds").add(GRANT_REFERENCE)
        putArray("matchedPolicyIds").add(GRANT_REFERENCE)
    }

    private fun sendJson(
        exchange: HttpExchange,
        body: com.fasterxml.jackson.databind.JsonNode,
        mapper: ObjectMapper,
    ) {
        val bytes = mapper.writeValueAsBytes(body)
        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.sendResponseHeaders(200, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private data class HttpFailureCase(
        val name: String,
        val respond: (HttpExchange, com.fasterxml.jackson.databind.JsonNode) -> Unit,
    )

    private class RecordingSnapshotSource(private val snapshot: AuthorizationSnapshot) : AuthorizationSnapshotSource {
        var calls = 0
        override fun load(request: AuthorizationRequest): AuthorizationSnapshot {
            calls++
            return snapshot
        }
    }

    private class FixedDecisionClient(private val decision: AuthorizationDecision) : PolicyDecisionClient {
        override fun decide(snapshot: AuthorizationSnapshot): AuthorizationDecision = decision
    }

    private class RecordingDecisionLog : DecisionAuditLog {
        val caller = mutableListOf<DecisionLogEntry>()
        val independent = mutableListOf<DecisionLogEntry>()
        override fun persistInCallerTransaction(entry: DecisionLogEntry) { caller += entry }
        override fun persistIndependently(entry: DecisionLogEntry) { independent += entry }
    }

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        private val PACKAGE_ID = UUID.fromString("72000000-0000-7000-8000-000000000001")
        private val PACKAGE_VERSION_ID = UUID.fromString("72000000-0000-7000-8000-000000000002")
        private val TYPE_ID = UUID.fromString("72000000-0000-7000-8000-000000000003")
        private val TYPE_VERSION_ID = UUID.fromString("72000000-0000-7000-8000-000000000004")
        private val ROLE_TYPE_ID = UUID.fromString("72000000-0000-7000-8000-000000000005")
        private val ROLE_TYPE_VERSION_ID = UUID.fromString("72000000-0000-7000-8000-000000000006")
        private val ROLE_ID = UUID.fromString("00000000-0000-7000-8000-000000000022")
        private val RELATION_ID = UUID.fromString("00000000-0000-7000-8000-000000000002")
        private val WRONG_RELATION_ID = UUID.fromString("72000000-0000-7000-8000-000000000010")
        private val BUNDLE_ID = UUID.fromString("72000000-0000-7000-8000-000000000007")
        private val DOMAIN_BUNDLE_ID = UUID.fromString("72000000-0000-7000-8000-000000000008")
        private val DOMAIN_VERSION_ID = UUID.fromString("72000000-0000-7000-8000-000000000009")
        private val REQUEST_ID = UUID.fromString("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
        private val PRINCIPAL_ID = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        private val ENTITY_ID = UUID.fromString("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
        private val RESOURCE_ID = UUID.fromString("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
        private val PLATFORM_VERSION_ID = UUID.fromString("550e8400-e29b-41d4-a716-446655440000")
        private val COMPOSED_RELEASE_ID = UUID.fromString("123e4567-e89b-42d3-a456-426614174000")
        private const val GRANT_REFERENCE = "grant:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        private const val POLICY_REFERENCE = "policy:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

        @Container
        @JvmStatic
        val postgres: PostgreSQLContainer<*> = PostgreSQLContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("innorder_occ")
            .withUsername("innorder_admin")
            .withPassword("admin-test-only")
            .withCopyFileToContainer(
                MountableFile.forClasspathResource("postgres-test-init.sql"),
                "/docker-entrypoint-initdb.d/010-test-roles.sql",
            )

        @BeforeAll
        @JvmStatic
        fun initializeDatabase() {
            Flyway.configure()
                .dataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only")
                .locations("classpath:db/migration")
                .load()
                .migrate()
            val jdbc = JdbcTemplate(dataSource())
            jdbc.update("INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, 'authz-test', 'Authz Test', 'ACTIVE')", PACKAGE_ID)
            jdbc.update("INSERT INTO catalog.package_version(id, package_id, semver, status) VALUES (?, ?, '1.0.0', 'DRAFT')", PACKAGE_VERSION_ID, PACKAGE_ID)
            jdbc.update("INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind, authorizable) VALUES (?, ?, 'authz.subject', 'Authz Subject', 'PRINCIPAL', true), (?, ?, 'authz.role', 'Authz Role', 'PRINCIPAL', true)", TYPE_ID, PACKAGE_ID, ROLE_TYPE_ID, PACKAGE_ID)
            jdbc.update("INSERT INTO catalog.entity_type_version(id, entity_type_id, package_version_id, schema_version, json_schema) VALUES (?, ?, ?, 1, '{}'::jsonb), (?, ?, ?, 1, '{}'::jsonb)", TYPE_VERSION_ID, TYPE_ID, PACKAGE_VERSION_ID, ROLE_TYPE_VERSION_ID, ROLE_TYPE_ID, PACKAGE_VERSION_ID)
            jdbc.update("INSERT INTO catalog.relation_definition(id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality, auth_relevant) VALUES (?, ?, 'platform.role-assignment', ?, ?, 'MANY_TO_MANY', true)", RELATION_ID, PACKAGE_VERSION_ID, TYPE_ID, ROLE_TYPE_ID)
            jdbc.update("INSERT INTO catalog.relation_definition(id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality, auth_relevant) VALUES (?, ?, 'authz.wrong-relation', ?, ?, 'MANY_TO_MANY', true)", WRONG_RELATION_ID, PACKAGE_VERSION_ID, TYPE_ID, ROLE_TYPE_ID)
            listOf(
                arrayOf(PRINCIPAL_ID, TYPE_ID, TYPE_VERSION_ID, "user:authz"),
                arrayOf(ENTITY_ID, TYPE_ID, TYPE_VERSION_ID, "entity:authz"),
                arrayOf(RESOURCE_ID, TYPE_ID, TYPE_VERSION_ID, "resource:authz"),
                arrayOf(ROLE_ID, ROLE_TYPE_ID, ROLE_TYPE_VERSION_ID, "role:administrator"),
            ).forEach { row ->
                jdbc.update("INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state) VALUES (?, ?, ?, ?, 'ACTIVE')", *row)
            }
            jdbc.update("INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, 'USER', 'Authz User', 'ACTIVE'), (?, 'ROLE', 'Administrator', 'ACTIVE')", PRINCIPAL_ID, ROLE_ID)
            jdbc.update("UPDATE catalog.package_version SET status = 'PUBLISHED', content_hash = repeat('b', 64), published_at = transaction_timestamp() WHERE id = ?", PACKAGE_VERSION_ID)
            val manifest = """{"version":1,"roleGrants":[{"id":"platform-administrator-read","effect":"ALLOW","action":"occ.read","entityId":"*","resourceId":"*","subjectRoleEntityKey":"role:administrator"}],"forbiddenActions":[]}"""
            val hash = sha256(manifest)
            val domainManifest = """{"version":1,"roleGrants":[{"id":"domain-administrator-read-deny","effect":"DENY","action":"occ.read","entityId":"*","resourceId":"*","subjectRoleEntityKey":"role:administrator"}],"forbiddenActions":[]}"""
            val domainHash = sha256(domainManifest)
            val releaseHash = PolicyReleaseIntegrity.contentHash(
                "platform-authz-v1",
                listOf(
                    PolicyReleaseItemIntegrity(PolicyLayer.PLATFORM, BUNDLE_ID, PLATFORM_VERSION_ID, hash),
                    PolicyReleaseItemIntegrity(PolicyLayer.DOMAIN, DOMAIN_BUNDLE_ID, DOMAIN_VERSION_ID, domainHash),
                ),
            )
            jdbc.update("INSERT INTO authz.policy_bundle(id, bundle_key, layer, status) VALUES (?, 'platform-authz-test', 'PLATFORM', 'ACTIVE')", BUNDLE_ID)
            jdbc.update("INSERT INTO authz.policy_bundle_version(id, bundle_id, version, status, manifest, content_hash, published_at) VALUES (?, ?, 1, 'PUBLISHED', ?::jsonb, ?, transaction_timestamp())", PLATFORM_VERSION_ID, BUNDLE_ID, manifest, hash)
            jdbc.update("INSERT INTO authz.policy_bundle(id, bundle_key, layer, package_id, status) VALUES (?, 'domain-authz-test', 'DOMAIN', ?, 'ACTIVE')", DOMAIN_BUNDLE_ID, PACKAGE_ID)
            jdbc.update("INSERT INTO authz.policy_bundle_version(id, bundle_id, version, status, manifest, content_hash, published_at) VALUES (?, ?, 1, 'PUBLISHED', ?::jsonb, ?, transaction_timestamp())", DOMAIN_VERSION_ID, DOMAIN_BUNDLE_ID, domainManifest, domainHash)
            jdbc.update("INSERT INTO authz.policy_release(id, release_number, status, content_hash) VALUES (?, 720001, 'STAGED', ?)", COMPOSED_RELEASE_ID, releaseHash)
            jdbc.update("INSERT INTO authz.policy_release_item(release_id, bundle_id, bundle_version_id) VALUES (?, ?, ?)", COMPOSED_RELEASE_ID, BUNDLE_ID, PLATFORM_VERSION_ID)
            jdbc.update("INSERT INTO authz.policy_release_item(release_id, bundle_id, bundle_version_id) VALUES (?, ?, ?)", COMPOSED_RELEASE_ID, DOMAIN_BUNDLE_ID, DOMAIN_VERSION_ID)
            jdbc.update("UPDATE authz.policy_release SET status = 'ACTIVE', opa_revision = 'platform-authz-v1', published_at = transaction_timestamp() WHERE id = ?", COMPOSED_RELEASE_ID)
        }

        private fun resetAuthorizationFacts(jdbc: JdbcTemplate) {
            jdbc.update("UPDATE authz.relationship SET revoked_at = greatest(transaction_timestamp(), valid_from) WHERE revoked_at IS NULL")
            jdbc.update("UPDATE iam.principal SET status = 'ACTIVE' WHERE id IN (?, ?)", PRINCIPAL_ID, ROLE_ID)
            jdbc.update("UPDATE authz.entity SET state = 'ACTIVE' WHERE id IN (?, ?, ?, ?)", PRINCIPAL_ID, ENTITY_ID, RESOURCE_ID, ROLE_ID)
            jdbc.update("INSERT INTO authz.relationship(id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, source_kind, source_ref) VALUES (?, ?, ?, ?, transaction_timestamp(), 'SYSTEM', 'authz-test')", UUID.randomUUID(), RELATION_ID, PRINCIPAL_ID, ROLE_ID)
        }

        private fun dataSource() = PGSimpleDataSource().apply {
            setURL(postgres.jdbcUrl)
            user = "innorder_runtime"
            password = "runtime-test-only"
        }

        private fun sha256(value: String): String {
            val mapper = ObjectMapper().findAndRegisterModules().apply {
                setConfig(serializationConfig.with(com.fasterxml.jackson.databind.MapperFeature.SORT_PROPERTIES_ALPHABETICALLY))
            }
                .enable(com.fasterxml.jackson.databind.SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
            return MessageDigest.getInstance("SHA-256")
            .digest(mapper.writeValueAsBytes(mapper.convertValue(mapper.readTree(value), Any::class.java)))
            .joinToString("") { "%02x".format(it) }
        }
    }
}
