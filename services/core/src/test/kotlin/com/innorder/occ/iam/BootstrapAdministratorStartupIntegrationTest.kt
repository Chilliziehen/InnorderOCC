package com.innorder.occ.iam

import com.innorder.occ.OccCoreApplication
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.postgresql.ds.PGSimpleDataSource
import org.springframework.boot.builder.SpringApplicationBuilder
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.ApplicationListener
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Primary
import org.springframework.jdbc.core.JdbcTemplate
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermission
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean

class BootstrapAdministratorStartupIntegrationTest {
    @Test
    fun `configured runner executes after Flyway and reaches application readiness`() {
        database { postgres, jdbc ->
            StartupReaderConfiguration.reader = successfulReader()
            val ready = AtomicBoolean()
            SpringApplicationBuilder(OccCoreApplication::class.java, StartupReaderConfiguration::class.java)
                .listeners(ApplicationListener<ApplicationReadyEvent> { ready.set(true) })
                .run(*arguments(postgres)).use {
                    assertThat(ready).isTrue()
                    assertThat(jdbc.queryForObject("SELECT count(*) FROM flyway_schema_history", Long::class.java))
                        .isEqualTo(12)
                    assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java))
                        .isEqualTo(1)
                }
        }
    }

    @Test
    fun `bootstrap failure aborts context before readiness after Flyway initialization`() {
        database { postgres, jdbc ->
            StartupReaderConfiguration.reader = object : BootstrapSecretReader() {
                override fun open(path: Path, expectedOwner: String): BootstrapSecretMaterial =
                    throw BootstrapConfigurationException()
            }
            val ready = AtomicBoolean()
            assertThatThrownBy {
                SpringApplicationBuilder(OccCoreApplication::class.java, StartupReaderConfiguration::class.java)
                    .listeners(ApplicationListener<ApplicationReadyEvent> { ready.set(true) })
                    .run(*arguments(postgres))
            }.isInstanceOf(BootstrapConfigurationException::class.java)

            assertThat(ready).isFalse()
            assertThat(jdbc.queryForObject("SELECT count(*) FROM flyway_schema_history", Long::class.java))
                .isEqualTo(12)
            assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java)).isZero()
        }
    }

    private fun successfulReader(): BootstrapSecretReader = BootstrapSecretReader(
        SecureSecretDirectoryFactory {
            val stable = SecretFileMetadata(
                SecretFileKind.REGULAR,
                PASSWORD.length.toLong(),
                "startup-stable-key",
                Instant.EPOCH,
                Instant.EPOCH,
                setOf(PosixFilePermission.OWNER_READ),
                OWNER,
            )
            object : SecureSecretDirectory {
                override fun inspectParent(): SecretFileMetadata = SecretFileMetadata(
                    SecretFileKind.DIRECTORY,
                    0,
                    "startup-parent-key",
                    Instant.EPOCH,
                    Instant.EPOCH,
                    setOf(
                        PosixFilePermission.OWNER_READ,
                        PosixFilePermission.OWNER_WRITE,
                        PosixFilePermission.OWNER_EXECUTE,
                    ),
                    OWNER,
                )
                override fun inspect(relativeName: Path): SecretFileMetadata = stable
                override fun openChannel(relativeName: Path, maximumBytes: Int): SecureSecretChannel =
                    object : SecureSecretChannel {
                        override fun read(): ByteArray = PASSWORD.toByteArray()
                        override fun close() = Unit
                    }
                override fun move(source: Path, target: Path) = Unit
                override fun delete(relativeName: Path) = Unit
                override fun close() = Unit
            }
        },
    )

    private fun arguments(postgres: PostgreSQLContainer<*>): Array<String> = arrayOf(
        "--server.port=0",
        "--spring.datasource.url=${postgres.jdbcUrl}",
        "--spring.datasource.username=innorder_runtime",
        "--spring.datasource.password=runtime-test-only",
        "--spring.flyway.url=${postgres.jdbcUrl}",
        "--spring.flyway.user=innorder_flyway",
        "--spring.flyway.password=flyway-test-only",
        "--flowable.database-schema=flowable",
        "--occ.status-probes.external-enabled=false",
        "--occ.bootstrap-administrator.password-file=deterministic-startup-secret",
        "--occ.bootstrap-administrator.secret-owner=$OWNER",
    )

    private fun database(block: (PostgreSQLContainer<*>, JdbcTemplate) -> Unit) {
        PostgreSQLContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres")).use { postgres ->
            postgres.withDatabaseName("innorder_occ")
                .withUsername("innorder_admin")
                .withPassword("admin-test-only")
                .withCopyFileToContainer(
                    MountableFile.forClasspathResource("postgres-test-init.sql"),
                    "/docker-entrypoint-initdb.d/010-test-roles.sql",
                )
                .start()
            val dataSource = PGSimpleDataSource().apply {
                setURL(postgres.jdbcUrl)
                user = "innorder_flyway"
                password = "flyway-test-only"
            }
            block(postgres, JdbcTemplate(dataSource))
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    class StartupReaderConfiguration {
        @Bean
        @Primary
        internal fun startupBootstrapSecretReader(): BootstrapSecretReader = reader

        companion object {
            internal lateinit var reader: BootstrapSecretReader
        }
    }

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        private const val OWNER = "occ-service"
        private const val PASSWORD = "startup-bootstrap-test-only"
    }
}
