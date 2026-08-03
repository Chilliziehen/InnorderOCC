package com.innorder.occ.iam

import com.innorder.occ.OccCoreApplication
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import com.innorder.occ.authz.PolicyLayer
import com.innorder.occ.authz.PolicyReleaseIntegrity
import com.innorder.occ.authz.PolicyReleaseItemIntegrity
import com.innorder.occ.catalog.WorkflowCatalogInstallationException
import org.flywaydb.core.Flyway
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
import java.time.OffsetDateTime
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

class BootstrapAdministratorStartupIntegrationTest {
    @Test
    fun `empty database without administrator password seeds baseline and risk identities without admin`() {
        database { postgres, jdbc ->
            val ready = AtomicBoolean()
            val startupArguments = arguments(postgres).filterNot {
                it.startsWith("--occ.bootstrap-administrator.")
            }.toTypedArray()

            SpringApplicationBuilder(OccCoreApplication::class.java)
                .listeners(ApplicationListener<ApplicationReadyEvent> { ready.set(true) })
                .run(*startupArguments).use {
                    assertThat(ready).isTrue()
                    assertThat(jdbc.queryForObject(
                        "SELECT count(*) FROM catalog.package_version WHERE id = ? AND status = 'PUBLISHED'",
                        Long::class.java,
                        BootstrapIds.PACKAGE_VERSION,
                    )).isEqualTo(1)
                    assertThat(jdbc.queryForObject(
                        "SELECT count(*) FROM authz.policy_release WHERE id = ? AND status = 'ACTIVE'",
                        Long::class.java,
                        BootstrapIds.POLICY_RELEASE,
                    )).isEqualTo(1)
                    assertThat(jdbc.queryForObject(
                        "SELECT count(*) FROM iam.principal WHERE id = ? AND principal_kind = 'SERVICE'",
                        Long::class.java,
                        RISK_SYSTEM_ID,
                    )).isEqualTo(1)
                    assertThat(jdbc.queryForObject(
                        "SELECT count(*) FROM authz.entity WHERE id = ? AND entity_key = 'system:risk-report'",
                        Long::class.java,
                        RISK_REPORT_ID,
                    )).isEqualTo(1)
                    assertThat(jdbc.queryForObject(
                        "SELECT count(*) FROM iam.principal WHERE principal_kind = 'USER'",
                        Long::class.java,
                    )).isZero()
                    assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java)).isZero()
                    assertThat(jdbc.queryForObject(
                        "SELECT count(*) FROM authz.relationship WHERE source_ref = 'initial-administrator'",
                        Long::class.java,
                    )).isZero()
                }
            val firstState = securityState(jdbc)

            ready.set(false)
            SpringApplicationBuilder(OccCoreApplication::class.java)
                .listeners(ApplicationListener<ApplicationReadyEvent> { ready.set(true) })
                .run(*startupArguments).use { assertThat(ready).isTrue() }
            assertThat(securityState(jdbc)).isEqualTo(firstState)
        }
    }

    @Test
    fun `platform baseline collision rolls back and prevents downstream startup runners`() {
        database { postgres, jdbc ->
            migrate(postgres)
            jdbc.update(
                """INSERT INTO catalog.domain_package(id, package_key, name, description, status)
                   VALUES (?, 'platform-iam', 'Collision', 'collision', 'ACTIVE')""",
                UUID.randomUUID(),
            )
            val ready = AtomicBoolean()

            assertThatThrownBy {
                SpringApplicationBuilder(OccCoreApplication::class.java)
                    .listeners(ApplicationListener<ApplicationReadyEvent> { ready.set(true) })
                    .run(*arguments(postgres).filterNot {
                        it.startsWith("--occ.bootstrap-administrator.")
                    }.toTypedArray())
            }.isInstanceOf(BootstrapBaselineException::class.java)

            assertThat(ready).isFalse()
            assertThat(jdbc.queryForObject("SELECT count(*) FROM catalog.domain_package", Long::class.java)).isEqualTo(1)
            assertThat(jdbc.queryForObject("SELECT count(*) FROM catalog.package_version", Long::class.java)).isZero()
            assertThat(jdbc.queryForObject("SELECT count(*) FROM authz.policy_release", Long::class.java)).isZero()
            assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.principal", Long::class.java)).isZero()
            assertThat(jdbc.queryForObject("SELECT count(*) FROM authz.entity", Long::class.java)).isZero()
        }
    }

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
                        .isEqualTo(15)
                    assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java))
                        .isEqualTo(1)
                    assertThat(jdbc.queryForObject(
                        "SELECT count(*) FROM iam.principal WHERE id = ? AND principal_kind = 'SERVICE' AND status = 'ACTIVE'",
                        Long::class.java,
                        RISK_SYSTEM_ID,
                    )).isEqualTo(1)
                    assertThat(jdbc.queryForObject(
                        "SELECT count(*) FROM authz.entity WHERE id = ? AND entity_key = 'system:risk-report' AND state = 'ACTIVE'",
                        Long::class.java,
                        RISK_REPORT_ID,
                    )).isEqualTo(1)
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
                .isEqualTo(15)
            assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java)).isZero()
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM catalog.package_version WHERE id = ? AND status = 'PUBLISHED'",
                Long::class.java,
                BootstrapIds.PACKAGE_VERSION,
            )).isEqualTo(1)
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM authz.policy_release WHERE id = ? AND status = 'ACTIVE'",
                Long::class.java,
                BootstrapIds.POLICY_RELEASE,
            )).isEqualTo(1)
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM iam.principal WHERE principal_kind = 'USER'",
                Long::class.java,
            )).isZero()
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM iam.principal WHERE id = ?",
                Long::class.java,
                RISK_SYSTEM_ID,
            )).isZero()
        }
    }

    @Test
    fun `fresh migrated startup without bootstrap fails safely before readiness`() {
        database { postgres, jdbc ->
            val disabledArguments = arguments(postgres).filterNot {
                it.startsWith("--occ.bootstrap-administrator.")
            }.toTypedArray()
            val ready = AtomicBoolean()

            assertThatThrownBy {
                SpringApplicationBuilder(OccCoreApplication::class.java)
                    .listeners(ApplicationListener<ApplicationReadyEvent> { ready.set(true) })
                    .run(*disabledArguments)
            }.isInstanceOf(WorkflowCatalogInstallationException::class.java)
                .hasMessage("Embedded workflow catalog installation conflicts with existing data")
                .hasMessageNotContaining("SELECT")
                .hasMessageNotContaining("catalog.entity_type")
                .hasMessageNotContaining("platform.user")
            assertThat(ready).isFalse()
            assertThat(jdbc.queryForObject("SELECT count(*) FROM authz.policy_release", Long::class.java)).isZero()
            assertThat(jdbc.queryForObject("SELECT count(*) FROM authz.policy_bundle_version", Long::class.java)).isZero()
        }
    }

    @Test
    fun `disabled bootstrap upgrades an existing active v1 policy during startup`() {
        database { postgres, jdbc ->
            Flyway.configure().dataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only")
                .locations("classpath:db/migration").load().migrate()
            seedRoleCatalog(jdbc)
            seedV1Policy(jdbc)
            val disabledArguments = arguments(postgres).filterNot {
                it.startsWith("--occ.bootstrap-administrator.")
            }.toTypedArray()

            SpringApplicationBuilder(OccCoreApplication::class.java)
                .run(*disabledArguments).use {
                    assertThat(jdbc.queryForObject(
                        "SELECT status FROM authz.policy_release WHERE id = ?",
                        String::class.java,
                        BootstrapIds.POLICY_RELEASE_V1,
                    )).isEqualTo("RETIRED")
                    assertThat(jdbc.queryForObject(
                        """SELECT count(*) FROM authz.policy_release pr
                           JOIN authz.policy_release_item pri ON pri.release_id = pr.id
                           WHERE pr.id = ? AND pr.release_number = 2 AND pr.status = 'ACTIVE'
                             AND pr.opa_revision = ? AND pri.bundle_version_id = ?""",
                        Long::class.java,
                        BootstrapIds.POLICY_RELEASE_V2,
                        BootstrapPolicyBaseline.OPA_REVISION,
                        BootstrapIds.POLICY_BUNDLE_VERSION_V2,
                    )).isEqualTo(1)
                }
        }
    }

    private fun seedRoleCatalog(jdbc: JdbcTemplate) {
        jdbc.update(
            "INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, 'platform-iam', 'Platform IAM', 'ACTIVE')",
            BootstrapIds.PACKAGE,
        )
        jdbc.update(
            "INSERT INTO catalog.package_version(id, package_id, semver, status) VALUES (?, ?, '1.0.0', 'DRAFT')",
            BootstrapIds.PACKAGE_VERSION, BootstrapIds.PACKAGE,
        )
        jdbc.update(
            """INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind, authorizable)
               VALUES (?, ?, 'platform.user', 'User', 'PRINCIPAL', true)""",
            BootstrapIds.USER_TYPE, BootstrapIds.PACKAGE,
        )
        jdbc.update(
            """INSERT INTO catalog.entity_type_version
               (id, entity_type_id, package_version_id, schema_version, json_schema)
               VALUES (?, ?, ?, 1, '{}'::jsonb)""",
            BootstrapIds.USER_TYPE_VERSION, BootstrapIds.USER_TYPE, BootstrapIds.PACKAGE_VERSION,
        )
        jdbc.update(
            """INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind, authorizable)
               VALUES (?, ?, 'platform.role', 'Role', 'PRINCIPAL', true)""",
            BootstrapIds.ROLE_TYPE, BootstrapIds.PACKAGE,
        )
        jdbc.update(
            """INSERT INTO catalog.entity_type_version
               (id, entity_type_id, package_version_id, schema_version, json_schema)
               VALUES (?, ?, ?, 1, '{}'::jsonb)""",
            BootstrapIds.ROLE_TYPE_VERSION, BootstrapIds.ROLE_TYPE, BootstrapIds.PACKAGE_VERSION,
        )
        jdbc.update(
            """UPDATE catalog.package_version SET status = 'PUBLISHED', content_hash = repeat('a', 64),
                   published_at = transaction_timestamp() WHERE id = ?""",
            BootstrapIds.PACKAGE_VERSION,
        )
    }

    private fun seedV1Policy(jdbc: JdbcTemplate) {
        val now = OffsetDateTime.now()
        val releaseHash = PolicyReleaseIntegrity.contentHash(
            BootstrapPolicyV1Baseline.OPA_REVISION,
            listOf(PolicyReleaseItemIntegrity(
                PolicyLayer.PLATFORM,
                BootstrapIds.POLICY_BUNDLE,
                BootstrapIds.POLICY_BUNDLE_VERSION_V1,
                BootstrapPolicyV1Baseline.contentHash,
            )),
        )
        jdbc.update(
            """INSERT INTO authz.policy_bundle(id, bundle_key, layer, status, created_at)
               VALUES (?, 'platform-core-authorization', 'PLATFORM', 'ACTIVE', ?)""",
            BootstrapIds.POLICY_BUNDLE, now,
        )
        jdbc.update(
            """INSERT INTO authz.policy_bundle_version
               (id, bundle_id, version, status, manifest, content_hash, created_at, published_at)
               VALUES (?, ?, 1, 'PUBLISHED', ?::jsonb, ?, ?, ?)""",
            BootstrapIds.POLICY_BUNDLE_VERSION_V1, BootstrapIds.POLICY_BUNDLE,
            BootstrapPolicyV1Baseline.manifest, BootstrapPolicyV1Baseline.contentHash, now, now,
        )
        jdbc.update(
            """INSERT INTO authz.policy_release(id, release_number, status, content_hash, created_at)
               VALUES (?, 1, 'STAGED', ?, ?)""",
            BootstrapIds.POLICY_RELEASE_V1, releaseHash, now,
        )
        jdbc.update(
            "INSERT INTO authz.policy_release_item(release_id, bundle_id, bundle_version_id) VALUES (?, ?, ?)",
            BootstrapIds.POLICY_RELEASE_V1, BootstrapIds.POLICY_BUNDLE, BootstrapIds.POLICY_BUNDLE_VERSION_V1,
        )
        jdbc.update(
            """UPDATE authz.policy_release SET status = 'ACTIVE', opa_revision = ?, published_at = ? WHERE id = ?""",
            BootstrapPolicyV1Baseline.OPA_REVISION, now, BootstrapIds.POLICY_RELEASE_V1,
        )
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
        "--occ.risk-due.enabled=true",
        "--occ.risk-due.system-principal-id=$RISK_SYSTEM_ID",
        "--occ.risk-metrics.enabled=true",
        "--occ.risk-metrics.report-resource-id=$RISK_REPORT_ID",
    )

    private fun migrate(postgres: PostgreSQLContainer<*>) {
        Flyway.configure()
            .dataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only")
            .locations("filesystem:../../database/migrations")
            .load()
            .migrate()
    }

    private fun securityState(jdbc: JdbcTemplate): Map<String, Any> = jdbc.queryForMap(
        """SELECT
             (SELECT current_revision FROM authz.authorization_state WHERE singleton) AS revision,
             (SELECT count(*) FROM catalog.domain_package) AS packages,
             (SELECT count(*) FROM catalog.package_version) AS package_versions,
             (SELECT count(*) FROM catalog.entity_type) AS entity_types,
             (SELECT count(*) FROM authz.policy_release) AS policy_releases,
             (SELECT count(*) FROM authz.entity) AS entities,
             (SELECT count(*) FROM iam.principal) AS principals,
             (SELECT count(*) FROM iam.user_account) AS accounts,
             (SELECT count(*) FROM authz.relationship) AS relationships,
             (SELECT updated_at FROM catalog.domain_package WHERE id = '${BootstrapIds.PACKAGE}') AS package_updated_at,
             (SELECT published_at FROM catalog.package_version WHERE id = '${BootstrapIds.PACKAGE_VERSION}') AS package_published_at,
             (SELECT published_at FROM authz.policy_release WHERE id = '${BootstrapIds.POLICY_RELEASE}') AS policy_published_at,
             (SELECT max(updated_at) FROM authz.entity) AS entity_updated_at,
             (SELECT max(updated_at) FROM iam.principal) AS principal_updated_at,
             (SELECT max(updated_at) FROM authz.relationship) AS relationship_updated_at""",
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
        private val RISK_SYSTEM_ID = UUID.fromString("00000000-0000-7000-8000-000000000040")
        private val RISK_REPORT_ID = UUID.fromString("00000000-0000-7000-8000-000000000041")
    }
}
