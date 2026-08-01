package com.innorder.occ

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.api.CorrelationIdFilter
import com.innorder.occ.auth.AccessTokenPrincipal
import com.innorder.occ.authz.AuthorizationRevisionLockRepository
import com.innorder.occ.command.AuthorizedCommand
import com.innorder.occ.command.AggregateLockPlan
import com.innorder.occ.command.AggregateLockResolver
import com.innorder.occ.command.AggregateReference
import com.innorder.occ.command.AggregateChange
import com.innorder.occ.command.CanonicalJsonObject
import com.innorder.occ.command.CommandContext
import com.innorder.occ.command.CommandExecutor
import com.innorder.occ.command.CommandMetadata
import com.innorder.occ.command.CommandMutation
import com.innorder.occ.command.PendingEventSpec
import com.innorder.occ.iam.BootstrapIds
import com.innorder.occ.iam.BootstrapSecretMaterial
import com.innorder.occ.iam.BootstrapSecretReader
import com.innorder.occ.iam.SecretCharacters
import com.innorder.occ.iam.SecretFileKind
import com.innorder.occ.iam.SecretFileMetadata
import com.innorder.occ.iam.SecureSecretChannel
import com.innorder.occ.iam.SecureSecretDirectory
import jakarta.servlet.http.HttpServletRequest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.boot.test.system.CapturedOutput
import org.springframework.boot.test.system.OutputCaptureExtension
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Import
import org.springframework.context.annotation.Primary
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.security.core.Authentication
import org.springframework.test.annotation.DirtiesContext
import org.springframework.test.context.ActiveProfiles
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.post
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RestController
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermission
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit

@SpringBootTest
@AutoConfigureMockMvc
@Testcontainers
@ActiveProfiles("test")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Import(PlatformSecurityKernelIntegrationTest.KernelTestConfiguration::class)
@ExtendWith(OutputCaptureExtension::class)
class PlatformSecurityKernelIntegrationTest(
    @param:Autowired private val mockMvc: MockMvc,
    @param:Autowired private val mapper: ObjectMapper,
    @param:Autowired private val jdbc: JdbcTemplate,
    @param:Autowired private val facts: AuthorizationFactFixture,
) {
    private lateinit var administratorId: UUID

    @BeforeEach
    fun prepareAggregate() {
        administratorId = jdbc.queryForObject(
            "SELECT principal_id FROM iam.user_account WHERE username = 'admin'",
            UUID::class.java,
        )!!
        val flyway = JdbcTemplate(DriverManagerDataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only"))
        flyway.execute("CREATE TABLE IF NOT EXISTS occ.platform_kernel_test(id uuid PRIMARY KEY, value text NOT NULL, row_version bigint NOT NULL)")
        flyway.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON occ.platform_kernel_test TO innorder_runtime")
        jdbc.update("DELETE FROM audit.outbox_event WHERE aggregate_id = ?", administratorId)
        jdbc.update("DELETE FROM audit.idempotency_record WHERE principal_id = ?", administratorId)
        jdbc.update("DELETE FROM occ.platform_kernel_test WHERE id = ?", administratorId)
        jdbc.update("INSERT INTO occ.platform_kernel_test(id, value, row_version) VALUES (?, 'before', 3)", administratorId)
    }

    @AfterEach
    fun restoreAdministratorRole() {
        facts.restore(administratorId)
    }

    @Test
    fun `production security kernel completes correlated allow replay failure recovery and deny journey`(output: CapturedOutput) {
        val bootstrapLogin = login()
        val firstRefresh = bootstrapLogin.path("refreshToken").textValue()
        val rotated = postJson("/api/v1/auth/refresh", """{"refreshToken":"$firstRefresh"}""", 200)
        assertProblem(postJson("/api/v1/auth/refresh", """{"refreshToken":"$firstRefresh"}""", 401), "OCC-AUTH-INVALID-CREDENTIALS")
        assertProblem(postJson("/api/v1/auth/refresh", """{"refreshToken":"${rotated.path("refreshToken").textValue()}"}""", 401), "OCC-AUTH-INVALID-CREDENTIALS")

        val login = login()
        val accessToken = login.path("accessToken").textValue()
        val refreshToken = login.path("refreshToken").textValue()
        val me = correlatedGet("/api/v1/me", accessToken, 200).body
        assertThat(me.path("capabilities").map(JsonNode::textValue))
            .containsExactly("occ.admin", "occ.execute", "occ.read")

        assertProblem(correlatedGet("/api/v1/me", "not-a-jwt", 401).body, "OCC-API-AUTHENTICATION")

        val first = command(accessToken, administratorId, "kernel-first", 3, """{"secret":"journey-request-only","value":"first"}""", 200)
        assertThat(first.body).isEqualTo(mapper.readTree("""{"result":"first","version":4}"""))
        assertThat(first.replayed).isFalse()
        assertCommandState(version = 4, allows = 1, audit = 1, outbox = 1, idempotency = 1)

        val replay = command(accessToken, administratorId, "kernel-first", 3, """{"value":"first","secret":"journey-request-only"}""", 200)
        assertThat(replay.body).isEqualTo(first.body)
        assertThat(replay.replayed).isTrue()
        assertCommandState(version = 4, allows = 2, audit = 1, outbox = 1, idempotency = 1)

        command(accessToken, administratorId, "kernel-first", 3, """{"value":"different"}""", 409)
        command(accessToken, UUID.randomUUID(), "kernel-first", 3, """{"value":"first","secret":"journey-request-only"}""", 409)
        command(accessToken, administratorId, "kernel-first", 4, """{"value":"first","secret":"journey-request-only"}""", 409)
        command(accessToken, administratorId, "kernel-stale", 3, """{"value":"stale"}""", 409)
        val second = command(accessToken, administratorId, "kernel-second", 4, """{"value":"second"}""", 200)
        assertThat(second.body.path("version").longValue()).isEqualTo(5)

        val beforeUnavailable = kernelCounts()
        opa.stop()
        val unavailable = command(accessToken, administratorId, "kernel-opa-down", 5, """{"value":"unsafe"}""", 503)
        assertProblem(unavailable.body, "OCC-AUTHZ-UNAVAILABLE")
        assertThat(decisions("ERROR")).isEqualTo(1)
        assertThat(version()).isEqualTo(5)
        assertThat(commandRecordCount("kernel-opa-down")).isZero()
        assertThat(kernelCounts()).isEqualTo(beforeUnavailable)
        opa.start()
        command(accessToken, administratorId, "kernel-recovered", 5, """{"value":"recovered"}""", 200)
        assertThat(version()).isEqualTo(6)

        val revisionBefore = revision()
        facts.revoke(administratorId)
        assertThat(revision()).isEqualTo(revisionBefore + 1)
        assertThat(correlatedGet("/api/v1/me", accessToken, 200).body.path("capabilities")).isEmpty()
        val beforeDenied = kernelCounts()
        val denied = command(accessToken, administratorId, "kernel-denied", 6, """{"value":"denied"}""", 403)
        assertProblem(denied.body, "OCC-API-FORBIDDEN")
        assertThat(version()).isEqualTo(6)
        assertThat(commandRecordCount("kernel-denied")).isZero()
        assertThat(decisions("DENY")).isEqualTo(1)
        assertThat(kernelCounts()).isEqualTo(beforeDenied)

        val persisted = jdbc.queryForObject(
            """SELECT concat_ws(' ',
                   coalesce((SELECT string_agg(to_jsonb(d)::text, ' ') FROM authz.decision_log d), ''),
                   coalesce((SELECT string_agg(to_jsonb(a)::text, ' ') FROM audit.audit_record a WHERE actor_entity_id = ?), ''),
                   coalesce((SELECT string_agg(to_jsonb(o)::text, ' ') FROM audit.outbox_event o WHERE actor_entity_id = ?), ''),
                   coalesce((SELECT string_agg(to_jsonb(i)::text, ' ') FROM audit.idempotency_record i WHERE principal_id = ?), ''))""",
            String::class.java, administratorId, administratorId, administratorId,
        )!!
        assertThat(persisted).doesNotContain(PASSWORD, accessToken, refreshToken, firstRefresh, "journey-request-only")
        assertThat(persisted).doesNotContain("password_hash", "refreshToken", "accessToken")
        assertThat(output.all).doesNotContain(PASSWORD, accessToken, refreshToken, firstRefresh, "journey-request-only")
    }

    private fun login(): JsonNode = postJson(
        "/api/v1/auth/login", """{"username":"admin","password":"$PASSWORD"}""", 200,
    )

    private fun postJson(path: String, body: String, status: Int): JsonNode {
        val correlation = UUID.randomUUID().toString()
        val result = mockMvc.post(path) {
            header(CorrelationIdFilter.HEADER_NAME, correlation)
            contentType = MediaType.APPLICATION_JSON
            content = body
        }.andExpect { status { isEqualTo(status) } }.andReturn()
        assertThat(result.response.getHeader(CorrelationIdFilter.HEADER_NAME)).isEqualTo(correlation)
        return mapper.readTree(result.response.contentAsString)
    }

    private fun correlatedGet(path: String, token: String, status: Int): HttpResult {
        val correlation = UUID.randomUUID().toString()
        val result = mockMvc.get(path) {
            header(CorrelationIdFilter.HEADER_NAME, correlation)
            header("Authorization", "Bearer $token")
        }.andExpect { status { isEqualTo(status) } }.andReturn()
        assertThat(result.response.getHeader(CorrelationIdFilter.HEADER_NAME)).isEqualTo(correlation)
        return HttpResult(mapper.readTree(result.response.contentAsString), false)
    }

    private fun command(token: String, target: UUID, key: String, version: Long, body: String, status: Int): HttpResult {
        val correlation = UUID.randomUUID().toString()
        val result = mockMvc.post("/api/v1/test/kernel/$target") {
            header(CorrelationIdFilter.HEADER_NAME, correlation)
            header("Authorization", "Bearer $token")
            header("Idempotency-Key", key)
            header("Expected-Version", version)
            contentType = MediaType.APPLICATION_JSON
            content = body
        }.andExpect { status { isEqualTo(status) } }.andReturn()
        assertThat(result.response.getHeader(CorrelationIdFilter.HEADER_NAME)).isEqualTo(correlation)
        return HttpResult(
            mapper.readTree(result.response.contentAsString),
            result.response.getHeader("X-Idempotent-Replay") == "true",
        )
    }

    private fun assertProblem(problem: JsonNode, code: String) {
        assertThat(problem.path("code").textValue()).isEqualTo(code)
        assertThat(problem.path("correlationId").textValue()).isNotBlank()
    }

    private fun assertCommandState(version: Long, allows: Long, audit: Long, outbox: Long, idempotency: Long) {
        assertThat(version()).isEqualTo(version)
        assertThat(decisions("ALLOW")).isEqualTo(allows)
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.audit_record WHERE actor_entity_id = ?", Long::class.java, administratorId)).isEqualTo(audit)
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.outbox_event WHERE actor_entity_id = ?", Long::class.java, administratorId)).isEqualTo(outbox)
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.idempotency_record WHERE principal_id = ? AND state = 'COMPLETED'", Long::class.java, administratorId)).isEqualTo(idempotency)
    }

    private fun version() = jdbc.queryForObject("SELECT row_version FROM occ.platform_kernel_test WHERE id = ?", Long::class.java, administratorId)!!
    private fun revision() = jdbc.queryForObject("SELECT current_revision FROM authz.authorization_state WHERE singleton", Long::class.java)!!
    private fun decisions(value: String) = jdbc.queryForObject("SELECT count(*) FROM authz.decision_log WHERE principal_entity_id = ? AND action_key = 'occ.execute' AND decision = ?", Long::class.java, administratorId, value)!!
    private fun commandRecordCount(key: String) = jdbc.queryForObject("SELECT count(*) FROM audit.idempotency_record WHERE principal_id = ? AND idempotency_key = ?", Long::class.java, administratorId, key)!!
    private fun kernelCounts() = KernelCounts(
        version(),
        decisions("ALLOW"),
        jdbc.queryForObject("SELECT count(*) FROM audit.audit_record WHERE actor_entity_id = ?", Long::class.java, administratorId)!!,
        jdbc.queryForObject("SELECT count(*) FROM audit.outbox_event WHERE actor_entity_id = ?", Long::class.java, administratorId)!!,
        jdbc.queryForObject("SELECT count(*) FROM audit.idempotency_record WHERE principal_id = ?", Long::class.java, administratorId)!!,
    )

    data class HttpResult(val body: JsonNode, val replayed: Boolean)
    data class KernelCounts(val version: Long, val allows: Long, val audit: Long, val outbox: Long, val idempotency: Long)

    @TestConfiguration(proxyBeanMethods = false)
    class KernelTestConfiguration {
        @Bean
        @Primary
        internal fun kernelBootstrapSecretReader(): BootstrapSecretReader = InjectedSecretReader()

        @Bean
        fun kernelTestController(executor: CommandExecutor, mapper: ObjectMapper) = KernelTestController(executor, mapper)

        @Bean
        fun kernelAggregateLockResolver() = AggregateLockResolver("platform-kernel-test", 100) { jdbc, id ->
            jdbc.query(
                "SELECT row_version FROM occ.platform_kernel_test WHERE id = ? FOR UPDATE",
                { result, _ -> result.getLong(1) },
                id,
            ).singleOrNull()
        }

        @Bean
        fun authorizationFactFixture(
            jdbc: JdbcTemplate,
            transactions: TransactionTemplate,
            locks: AuthorizationRevisionLockRepository,
        ) = AuthorizationFactFixture(jdbc, transactions, locks)
    }

    @RestController
    class KernelTestController(private val executor: CommandExecutor, private val mapper: ObjectMapper) {
        @PostMapping("/api/v1/test/kernel/{target}", consumes = [MediaType.APPLICATION_JSON_VALUE], produces = [MediaType.APPLICATION_JSON_VALUE])
        fun execute(
            authentication: Authentication,
            request: HttpServletRequest,
            @PathVariable target: UUID,
            @RequestHeader("Idempotency-Key") key: String,
            @RequestHeader("Expected-Version") expectedVersion: Long,
            @RequestBody bytes: ByteArray,
        ): ResponseEntity<String> {
            val principal = authentication.principal as AccessTokenPrincipal
            val value = mapper.readTree(bytes).path("value").textValue() ?: "updated"
            val correlationId = UUID.fromString(request.getAttribute(CorrelationIdFilter.REQUEST_ATTRIBUTE) as String)
            val result = executor.execute(
                CommandMetadata(principal.principalId, "platform.kernel.update", key, expectedVersion, correlationId),
                bytes,
                KernelCommand(target, value, mapper),
            )
            return ResponseEntity.status(result.status)
                .header("X-Idempotent-Replay", result.replayed.toString())
                .contentType(MediaType.APPLICATION_JSON)
                .body(result.body.canonicalText())
        }
    }

    class KernelCommand(
        override val aggregateId: UUID,
        private val value: String,
        private val mapper: ObjectMapper,
    ) : AuthorizedCommand {
        override val action = "occ.execute"
        override val entityId: UUID get() = aggregateId
        override val resourceId: UUID get() = aggregateId
        override val aggregateType = "platform-kernel-test"
        override val expectedVersionRequired = true
        override val changesAuthorizationFacts = false
        override val lockPlan get() = AggregateLockPlan(existing = listOf(AggregateReference(aggregateType, aggregateId)))

        override fun execute(context: CommandContext): CommandMutation {
            val before = requireNotNull(context.descriptor.expectedVersion)
            val after = before + 1
            context.jdbc.update("UPDATE occ.platform_kernel_test SET value = ?, row_version = ? WHERE id = ?", value, after, aggregateId)
            fun json(text: String) = CanonicalJsonObject.from(mapper.readTree(text))
            return CommandMutation(
                200, json("""{"result":"$value","version":$after}"""), aggregateId,
                listOf(AggregateChange(AggregateReference(aggregateType, aggregateId), before, after)),
                "platform kernel acceptance", json("""{"value":"$value"}"""),
                listOf(PendingEventSpec(
                    "platform-kernel.updated", 1, json("""{"value":"$value","version":$after}"""),
                    AggregateReference(aggregateType, aggregateId), after,
                )),
            )
        }
    }

    class AuthorizationFactFixture(
        private val jdbc: JdbcTemplate,
        private val transactions: TransactionTemplate,
        private val locks: AuthorizationRevisionLockRepository,
    ) {
        fun revoke(principalId: UUID) {
            transactions.executeWithoutResult {
                locks.acquireForChange()
                check(jdbc.update(
                    """UPDATE authz.relationship SET revoked_at = greatest(transaction_timestamp(), valid_from)
                       WHERE relation_definition_id = ? AND subject_entity_id = ? AND object_entity_id = ? AND revoked_at IS NULL""",
                    BootstrapIds.ROLE_ASSIGNMENT_RELATION, principalId, BootstrapIds.ADMINISTRATOR_ROLE,
                ) == 1)
            }
        }

        fun restore(principalId: UUID) {
            if (jdbc.queryForObject(
                    """SELECT count(*) FROM authz.relationship WHERE relation_definition_id = ?
                       AND subject_entity_id = ? AND object_entity_id = ? AND revoked_at IS NULL""",
                    Long::class.java, BootstrapIds.ROLE_ASSIGNMENT_RELATION, principalId, BootstrapIds.ADMINISTRATOR_ROLE,
                )!! > 0) return
            transactions.executeWithoutResult {
                locks.acquireForChange()
                jdbc.update(
                    """INSERT INTO authz.relationship
                       (id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref)
                       VALUES (?, ?, ?, ?, 'SYSTEM', 'platform-kernel-test-cleanup')""",
                    UUID.randomUUID(), BootstrapIds.ROLE_ASSIGNMENT_RELATION, principalId, BootstrapIds.ADMINISTRATOR_ROLE,
                )
            }
        }
    }

    private class InjectedSecretReader : BootstrapSecretReader() {
        override fun open(path: Path, expectedOwner: String): BootstrapSecretMaterial {
            val metadata = SecretFileMetadata(
                SecretFileKind.REGULAR, PASSWORD.length.toLong(), "injected-kernel-secret", Instant.EPOCH,
                Instant.EPOCH, setOf(PosixFilePermission.OWNER_READ), expectedOwner,
            )
            return BootstrapSecretMaterial(NoopSecretDirectory(metadata), path.fileName, metadata, expectedOwner, SecretCharacters(PASSWORD.toCharArray()))
        }
    }

    private class NoopSecretDirectory(private val metadata: SecretFileMetadata) : SecureSecretDirectory {
        override fun inspectParent() = metadata.copy(kind = SecretFileKind.DIRECTORY)
        override fun inspect(relativeName: Path) = metadata
        override fun openChannel(relativeName: Path, maximumBytes: Int) = object : SecureSecretChannel {
            override fun read() = PASSWORD.toByteArray()
            override fun close() = Unit
        }
        override fun move(source: Path, target: Path) = Unit
        override fun delete(relativeName: Path) = Unit
        override fun close() = Unit
    }

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        private const val PASSWORD = "platform-kernel-bootstrap-test-only"
        private val opa = OpaProcess()

        @Container
        @JvmStatic
        val postgres: PostgreSQLContainer<*> = PostgreSQLContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("innorder_occ")
            .withUsername("innorder_admin")
            .withPassword("admin-test-only")
            .withCopyFileToContainer(MountableFile.forClasspathResource("postgres-test-init.sql"), "/docker-entrypoint-initdb.d/010-test-roles.sql")

        @DynamicPropertySource
        @JvmStatic
        fun properties(registry: DynamicPropertyRegistry) {
            opa.start()
            registry.add("spring.datasource.url", postgres::getJdbcUrl)
            registry.add("spring.datasource.username") { "innorder_runtime" }
            registry.add("spring.datasource.password") { "runtime-test-only" }
            registry.add("spring.flyway.url", postgres::getJdbcUrl)
            registry.add("spring.flyway.user") { "innorder_flyway" }
            registry.add("spring.flyway.password") { "flyway-test-only" }
            registry.add("flowable.database-schema") { "flowable" }
            registry.add("flowable.database-schema-update") { "true" }
            registry.add("occ.bootstrap-administrator.password-file") { "injected-test-secret" }
            registry.add("occ.bootstrap-administrator.secret-owner") { "occ-test" }
            registry.add("occ.opa.base-url", opa::baseUrl)
            registry.add("occ.status-probes.external-enabled") { "false" }
        }

        @AfterAll
        @JvmStatic
        fun stopOpa() = opa.stop()
    }

    private class OpaProcess {
        private val executable = System.getenv("OPA_PATH")?.takeIf(String::isNotBlank)
            ?: throw IllegalStateException("PlatformSecurityKernelIntegrationTest requires OPA_PATH for OPA 1.5.1")
        private val policyDirectory = sequenceOf(Path.of("policies", "opa"), Path.of("..", "..", "policies", "opa"))
            .map(Path::toAbsolutePath).firstOrNull(Files::isDirectory)
            ?: throw IllegalStateException("Repository OPA policy directory is unavailable")
        private val port = ServerSocket(0).use { it.localPort }
        private var process: Process? = null

        init {
            val version = ProcessBuilder(executable, "version").redirectErrorStream(true).start().run {
                val output = inputStream.bufferedReader().readText()
                check(waitFor(10, TimeUnit.SECONDS) && exitValue() == 0) { "OPA version check failed" }
                output
            }
            check(Regex("(?m)^Version:\\s+1\\.5\\.1\\s*$").containsMatchIn(version)) { "OPA_PATH must reference OPA 1.5.1" }
        }

        @Synchronized
        fun start() {
            if (process?.isAlive == true) return
            process = ProcessBuilder(executable, "run", "--server", "--addr=127.0.0.1:$port", policyDirectory.toString())
                .redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD).start()
            repeat(100) {
                if (process?.isAlive != true) throw IllegalStateException("OPA exited before readiness")
                if (runCatching {
                        (URI("http://127.0.0.1:$port/health").toURL().openConnection() as HttpURLConnection).run {
                            connectTimeout = 100; readTimeout = 100; responseCode == 200
                        }
                    }.getOrDefault(false)) return
                Thread.sleep(50)
            }
            throw IllegalStateException("OPA readiness timed out")
        }

        @Synchronized
        fun stop() {
            process?.destroy()
            if (process?.waitFor(5, TimeUnit.SECONDS) == false) process?.destroyForcibly()
            process = null
        }

        fun baseUrl() = "http://127.0.0.1:$port"
    }
}
