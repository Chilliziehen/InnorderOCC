package com.innorder.occ.resource

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.command.CommandMetadata
import com.innorder.occ.iam.BootstrapSecretMaterial
import com.innorder.occ.iam.BootstrapSecretReader
import com.innorder.occ.iam.SecretCharacters
import com.innorder.occ.iam.SecretFileKind
import com.innorder.occ.iam.SecretFileMetadata
import com.innorder.occ.iam.SecureSecretChannel
import com.innorder.occ.iam.SecureSecretDirectory
import org.junit.jupiter.api.AfterAll
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Import
import org.springframework.context.annotation.Primary
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.annotation.DirtiesContext
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
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
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.TimeUnit

@SpringBootTest
@AutoConfigureMockMvc
@Testcontainers
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Import(ResourceIntegrationSupport.Configuration::class)
abstract class ResourceIntegrationSupport {
    @Autowired protected lateinit var resources: ResourceService
    @Autowired protected lateinit var jdbc: JdbcTemplate
    @Autowired protected lateinit var mapper: ObjectMapper
    @Autowired protected lateinit var mockMvc: MockMvc

    protected val administratorId: UUID
        get() = jdbc.queryForObject(
            "SELECT principal_id FROM iam.user_account WHERE username = 'admin'",
            UUID::class.java,
        )!!

    protected fun entity(label: String): UUID = entity(UUID.randomUUID(), label)

    protected fun entity(id: UUID, label: String): UUID = id.also {
        jdbc.update(
            """INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state)
               SELECT ?, entity_type_id, entity_type_version_id, ?, 'ACTIVE'
               FROM authz.entity WHERE id = ?""",
            id, "$label-$id", administratorId,
        )
    }

    protected fun metadata(key: String = UUID.randomUUID().toString(), expectedVersion: Long? = null) = CommandMetadata(
        administratorId,
        "resource.command",
        key,
        expectedVersion,
        UUID.randomUUID(),
    )

    protected fun instant(hour: Int, minute: Int = 0): OffsetDateTime =
        OffsetDateTime.of(2035, 1, 1, hour, minute, 0, 0, ZoneOffset.UTC)

    protected fun createResource(capacity: Int = 10, state: ResourceState = ResourceState.AVAILABLE): ManagedResource {
        val id = entity("resource")
        val request = CreateResourceRequest(id, "ROOM", capacity.toBigDecimal(), state, mapOf("label" to "Room"))
        return resources.create(metadata(), mapper.writeValueAsBytes(request), request).body
    }

    protected fun reserve(
        resourceId: UUID,
        requesterId: UUID,
        start: OffsetDateTime,
        end: OffsetDateTime,
        capacity: Int,
        exclusive: Boolean = false,
        key: String = UUID.randomUUID().toString(),
    ): Reservation {
        val request = ReserveResourceRequest(
            UUID.randomUUID(), requesterId, null, null, start, end, capacity.toBigDecimal(), exclusive,
        )
        return resources.reserve(resourceId, metadata(key), mapper.writeValueAsBytes(request), request).body
    }

    @TestConfiguration(proxyBeanMethods = false)
    class Configuration {
        @Bean
        @Primary
        internal fun resourceBootstrapSecretReader(): BootstrapSecretReader = InjectedSecretReader()
    }

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        private const val PASSWORD = "resource-bootstrap-test-only"
        private val opa = OpaProcess()

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
            registry.add("occ.bootstrap-administrator.password-file") { "injected-test-secret" }
            registry.add("occ.bootstrap-administrator.secret-owner") { "occ-test" }
            registry.add("occ.opa.base-url", opa::baseUrl)
            registry.add("occ.status-probes.external-enabled") { "false" }
        }

        @AfterAll
        @JvmStatic
        fun stopOpa() = opa.stop()
    }

    private class InjectedSecretReader : BootstrapSecretReader() {
        override fun open(path: Path, expectedOwner: String): BootstrapSecretMaterial {
            val metadata = SecretFileMetadata(
                SecretFileKind.REGULAR, PASSWORD.length.toLong(), "resource-secret", Instant.EPOCH,
                Instant.EPOCH, setOf(PosixFilePermission.OWNER_READ), expectedOwner,
            )
            return BootstrapSecretMaterial(
                NoopSecretDirectory(metadata), path.fileName, metadata, expectedOwner,
                SecretCharacters(PASSWORD.toCharArray()),
            )
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

    private class OpaProcess {
        private val executable = System.getenv("OPA_PATH")?.takeIf(String::isNotBlank)
            ?: throw IllegalStateException("Resource integration tests require OPA_PATH for OPA 1.5.1")
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
            check(Regex("(?m)^Version:\\s+1\\.5\\.1\\s*$").containsMatchIn(version)) {
                "OPA_PATH must reference OPA 1.5.1"
            }
        }

        @Synchronized
        fun start() {
            if (process?.isAlive == true) return
            process = ProcessBuilder(executable, "run", "--server", "--addr=127.0.0.1:$port", policyDirectory.toString())
                .redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD).start()
            repeat(400) {
                if (process?.isAlive != true) error("OPA exited before readiness")
                if (runCatching {
                        (URI("http://127.0.0.1:$port/health").toURL().openConnection() as HttpURLConnection).run {
                            connectTimeout = 100
                            readTimeout = 100
                            responseCode == 200
                        }
                    }.getOrDefault(false)) return
                Thread.sleep(50)
            }
            error("OPA readiness timed out")
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
