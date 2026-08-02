package com.innorder.occ.iam

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.springframework.boot.DefaultApplicationArguments
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.postgresql.ds.PGSimpleDataSource
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import java.time.OffsetDateTime

@Testcontainers(disabledWithoutDocker = true)
class PlatformPolicyV2UpgraderIntegrationTest {
    @BeforeEach
    fun resetPolicies() {
        admin.update(
            "TRUNCATE authz.policy_release_item, authz.policy_release, authz.policy_bundle_version, authz.policy_bundle CASCADE",
        )
    }

    @Test
    fun `fresh instance without bootstrap policy is a safe no-op`() {
        assertThat(upgrader().upgrade()).isEqualTo(PlatformPolicyUpgradeResult.NO_ACTION)
        assertThat(runtime.queryForObject("SELECT count(*) FROM authz.policy_release", Long::class.java)).isZero()
        assertThat(runtime.queryForObject("SELECT count(*) FROM authz.policy_bundle_version", Long::class.java)).isZero()
    }

    @Test
    fun `existing active v1 upgrades atomically without rewriting immutable rows and restart is idempotent`() {
        seedV1()
        val oldVersion = runtime.queryForMap(
            "SELECT manifest::text AS manifest, content_hash, published_at FROM authz.policy_bundle_version WHERE id = ?",
            BootstrapIds.POLICY_BUNDLE_VERSION_V1,
        )
        val oldRelease = runtime.queryForMap(
            "SELECT content_hash, opa_revision, published_at, created_at FROM authz.policy_release WHERE id = ?",
            BootstrapIds.POLICY_RELEASE_V1,
        )

        assertThat(upgrader().upgrade()).isEqualTo(PlatformPolicyUpgradeResult.UPGRADED)

        assertThat(runtime.queryForMap(
            "SELECT manifest::text AS manifest, content_hash, published_at FROM authz.policy_bundle_version WHERE id = ?",
            BootstrapIds.POLICY_BUNDLE_VERSION_V1,
        )).isEqualTo(oldVersion)
        assertThat(runtime.queryForMap(
            "SELECT content_hash, opa_revision, published_at, created_at FROM authz.policy_release WHERE id = ?",
            BootstrapIds.POLICY_RELEASE_V1,
        )).isEqualTo(oldRelease)
        assertThat(runtime.queryForObject(
            "SELECT status FROM authz.policy_release WHERE id = ?", String::class.java, BootstrapIds.POLICY_RELEASE_V1,
        )).isEqualTo("RETIRED")
        assertThat(runtime.queryForObject(
            """SELECT count(*) FROM authz.policy_release_item
               WHERE release_id = ? AND bundle_id = ? AND bundle_version_id = ?""",
            Long::class.java,
            BootstrapIds.POLICY_RELEASE_V1, BootstrapIds.POLICY_BUNDLE, BootstrapIds.POLICY_BUNDLE_VERSION_V1,
        )).isEqualTo(1)
        assertV2Active()

        val state = policyState()
        assertThat(upgrader().upgrade()).isEqualTo(PlatformPolicyUpgradeResult.NO_ACTION)
        assertThat(policyState()).isEqualTo(state)
    }

    @Test
    fun `v1 content drift fails startup and leaves the active release untouched`() {
        seedV1(manifest = """{"forbiddenActions":["occ.read"],"roleGrants":[],"version":1}""")

        assertThatThrownBy { upgrader().run(DefaultApplicationArguments()) }
            .isInstanceOf(PlatformPolicyUpgradeException::class.java)
            .hasMessage("Platform authorization policy upgrade failed")
        assertThat(runtime.queryForObject(
            "SELECT status FROM authz.policy_release WHERE id = ?", String::class.java, BootstrapIds.POLICY_RELEASE_V1,
        )).isEqualTo("ACTIVE")
        assertThat(runtime.queryForObject(
            "SELECT count(*) FROM authz.policy_bundle_version WHERE version = 2", Long::class.java,
        )).isZero()
        assertThat(runtime.queryForObject(
            "SELECT count(*) FROM authz.policy_release WHERE release_number = 2", Long::class.java,
        )).isZero()
    }

    private fun seedV1(manifest: String = BootstrapPolicyV1Baseline.manifest) {
        val manifestHash = com.innorder.occ.authz.PolicyReleaseIntegrity.manifestContentHash(manifest)
        val releaseHash = com.innorder.occ.authz.PolicyReleaseIntegrity.contentHash(
            BootstrapPolicyV1Baseline.OPA_REVISION,
            listOf(com.innorder.occ.authz.PolicyReleaseItemIntegrity(
                com.innorder.occ.authz.PolicyLayer.PLATFORM,
                BootstrapIds.POLICY_BUNDLE,
                BootstrapIds.POLICY_BUNDLE_VERSION_V1,
                manifestHash,
            )),
        )
        val now = OffsetDateTime.now()
        runtime.update(
            """INSERT INTO authz.policy_bundle(id, bundle_key, layer, status, created_at)
               VALUES (?, 'platform-core-authorization', 'PLATFORM', 'ACTIVE', ?)""",
            BootstrapIds.POLICY_BUNDLE, now,
        )
        runtime.update(
            """INSERT INTO authz.policy_bundle_version
               (id, bundle_id, version, status, manifest, content_hash, created_at, published_at)
               VALUES (?, ?, 1, 'PUBLISHED', ?::jsonb, ?, ?, ?)""",
            BootstrapIds.POLICY_BUNDLE_VERSION_V1, BootstrapIds.POLICY_BUNDLE,
            manifest, manifestHash, now, now,
        )
        runtime.update(
            """INSERT INTO authz.policy_release(id, release_number, status, content_hash, created_at)
               VALUES (?, 1, 'STAGED', ?, ?)""",
            BootstrapIds.POLICY_RELEASE_V1, releaseHash, now,
        )
        runtime.update(
            "INSERT INTO authz.policy_release_item(release_id, bundle_id, bundle_version_id) VALUES (?, ?, ?)",
            BootstrapIds.POLICY_RELEASE_V1, BootstrapIds.POLICY_BUNDLE, BootstrapIds.POLICY_BUNDLE_VERSION_V1,
        )
        runtime.update(
            """UPDATE authz.policy_release SET status = 'ACTIVE', opa_revision = ?, published_at = ? WHERE id = ?""",
            BootstrapPolicyV1Baseline.OPA_REVISION, now, BootstrapIds.POLICY_RELEASE_V1,
        )
    }

    private fun assertV2Active() {
        assertThat(runtime.queryForMap(
            """SELECT pbv.id AS version_id, pbv.version, pbv.status, pbv.manifest = ?::jsonb AS manifest_matches,
                      pbv.content_hash, pr.id AS release_id, pr.release_number, pr.status AS release_status,
                      pr.opa_revision, pr.content_hash AS release_hash
               FROM authz.policy_release pr
               JOIN authz.policy_release_item pri ON pri.release_id = pr.id
               JOIN authz.policy_bundle_version pbv ON pbv.id = pri.bundle_version_id
               WHERE pr.status = 'ACTIVE'""",
            BootstrapPolicyBaseline.manifest,
        )).containsAllEntriesOf(mapOf(
            "version_id" to BootstrapIds.POLICY_BUNDLE_VERSION_V2,
            "version" to 2,
            "status" to "PUBLISHED",
            "manifest_matches" to true,
            "content_hash" to BootstrapPolicyBaseline.contentHash,
            "release_id" to BootstrapIds.POLICY_RELEASE_V2,
            "release_number" to 2L,
            "release_status" to "ACTIVE",
            "opa_revision" to BootstrapPolicyBaseline.OPA_REVISION,
            "release_hash" to BootstrapPolicyBaseline.releaseHash,
        ))
    }

    private fun policyState() = runtime.queryForList(
        """SELECT 'version' AS kind, id::text, version::bigint AS number, status FROM authz.policy_bundle_version
           UNION ALL SELECT 'release', id::text, release_number, status FROM authz.policy_release
           ORDER BY kind, number""",
    )

    private fun upgrader() = PlatformPolicyV2Upgrader(
        runtime,
        TransactionTemplate(DataSourceTransactionManager(runtime.dataSource!!)),
    )

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"

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

        private lateinit var admin: JdbcTemplate
        private lateinit var runtime: JdbcTemplate

        @BeforeAll
        @JvmStatic
        fun migrate() {
            Flyway.configure().dataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only")
                .locations("classpath:db/migration").load().migrate()
            admin = JdbcTemplate(dataSource("innorder_flyway", "flyway-test-only"))
            runtime = JdbcTemplate(dataSource("innorder_runtime", "runtime-test-only"))
        }

        private fun dataSource(username: String, password: String) = PGSimpleDataSource().apply {
            setURL(postgres.jdbcUrl)
            user = username
            this.password = password
        }
    }
}
