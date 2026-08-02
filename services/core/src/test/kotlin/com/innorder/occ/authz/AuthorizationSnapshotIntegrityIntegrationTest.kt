package com.innorder.occ.authz

import com.fasterxml.jackson.databind.MapperFeature
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.postgresql.ds.PGSimpleDataSource
import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import java.security.MessageDigest
import java.util.UUID

@Testcontainers(disabledWithoutDocker = true)
open class AuthorizationSnapshotIntegrityIntegrationTest {
    @Test
    fun `loads exact platform domain customer allow and deny layers`() = scenario { jdbc ->
        val manifests = mapOf(
            PolicyLayer.PLATFORM to manifest("platform-allow", "ALLOW", "occ.read"),
            PolicyLayer.DOMAIN to manifest("domain-deny", "DENY", "occ.execute"),
            PolicyLayer.CUSTOMER to manifest("customer-allow", "ALLOW", "occ.admin"),
        )
        seedActiveRelease(jdbc, manifests)

        val snapshot = repository(jdbc).load(request())

        assertThat(snapshot.releases.keys).containsExactlyInAnyOrder(
            PolicyLayer.PLATFORM, PolicyLayer.DOMAIN, PolicyLayer.CUSTOMER,
        )
        assertThat(snapshot.grants.map { it.id }).containsExactlyInAnyOrder(
            "platform-allow", "domain-deny", "customer-allow",
        )
        assertThat(snapshot.grants.map { it.effect }).contains(GrantEffect.ALLOW, GrantEffect.DENY)
    }

    @Test
    fun `rejects missing platform duplicate layer and multiple active releases`() {
        scenario { jdbc ->
            assertThatThrownBy {
                seedActiveRelease(jdbc, mapOf(PolicyLayer.DOMAIN to manifest("domain", "ALLOW", "occ.read")))
            }.isInstanceOf(DataAccessException::class.java)
        }
        scenario { jdbc ->
            val first = bundle(jdbc, PolicyLayer.PLATFORM, manifest("platform-one", "ALLOW", "occ.read"))
            val second = bundle(jdbc, PolicyLayer.PLATFORM, manifest("platform-two", "DENY", "occ.read"))
            activate(jdbc, listOf(first, second), "a".repeat(64))
            assertThatThrownBy { repository(jdbc).load(request()) }
                .isInstanceOf(AuthorizationSnapshotException::class.java)
        }
        scenario { jdbc ->
            seedActiveRelease(jdbc, mapOf(PolicyLayer.PLATFORM to manifest("first", "ALLOW", "occ.read")))
            val second = bundle(jdbc, PolicyLayer.PLATFORM, manifest("second", "ALLOW", "occ.read"))
            assertThatThrownBy { activate(jdbc, listOf(second)) }
                .isInstanceOf(DataAccessException::class.java)
        }
    }

    @Test
    fun `accepts a deprecated parent pinned by an active release and rejects unpublished bundle version`() {
        scenario { jdbc ->
            val item = bundle(
                jdbc, PolicyLayer.PLATFORM, manifest("inactive", "ALLOW", "occ.read"), bundleStatus = "DEPRECATED",
            )
            activate(jdbc, listOf(item))
            assertThat(repository(jdbc).load(request()).grants.map { it.id }).containsExactly("inactive")
        }
        scenario { jdbc ->
            val item = bundle(
                jdbc, PolicyLayer.PLATFORM, manifest("draft", "ALLOW", "occ.read"), versionStatus = "DRAFT",
            )
            assertThatThrownBy { activate(jdbc, listOf(item)) }
                .isInstanceOf(DataAccessException::class.java)
        }
    }

    @Test
    fun `rejects malformed oversized unknown and hash-mismatched manifests`() {
        val invalid = listOf(
            """{"version":1,"roleGrants":[{"id":"bad-pattern","effect":"ALLOW","action":"occ.*","entityId":"*","resourceId":"*","subjectRoleEntityKey":"role:administrator"}],"forbiddenActions":[]}""" to null,
            """{"version":1,"roleGrants":[],"forbiddenActions":[],"padding":"${"x".repeat(70_000)}"}""" to null,
            """{"version":1,"roleGrants":[],"forbiddenActions":[],"unknown":true}""" to null,
            manifest("bad-hash", "ALLOW", "occ.read") to "f".repeat(64),
        )
        invalid.forEach { (manifest, forcedHash) ->
            scenario { jdbc ->
                val item = bundle(jdbc, PolicyLayer.PLATFORM, manifest, forcedHash = forcedHash)
                activate(jdbc, listOf(item))
                assertThatThrownBy { repository(jdbc).load(request()) }
                    .isInstanceOf(AuthorizationSnapshotException::class.java)
            }
        }
    }

    @Test
    fun `rejects bad composed hash and immutable release item change`() {
        scenario { jdbc ->
            val item = bundle(jdbc, PolicyLayer.PLATFORM, manifest("bad-composed", "ALLOW", "occ.read"))
            activate(jdbc, listOf(item), "e".repeat(64))
            assertThatThrownBy { repository(jdbc).load(request()) }
                .isInstanceOf(AuthorizationSnapshotException::class.java)
        }
        scenario { jdbc ->
            val platform = bundle(jdbc, PolicyLayer.PLATFORM, manifest("platform", "ALLOW", "occ.read"))
            val releaseId = activate(jdbc, listOf(platform))
            val customer = bundle(jdbc, PolicyLayer.CUSTOMER, manifest("customer", "ALLOW", "occ.read"))
            assertThatThrownBy {
                jdbc.update(
                    "INSERT INTO authz.policy_release_item(release_id, bundle_id, bundle_version_id) VALUES (?, ?, ?)",
                    releaseId, customer.bundleId, customer.bundleVersionId,
                )
            }.isInstanceOf(DataAccessException::class.java)
        }
    }

    protected fun scenario(block: (JdbcTemplate) -> Unit) {
        val jdbc = JdbcTemplate(dataSource())
        TransactionTemplate(DataSourceTransactionManager(jdbc.dataSource!!)).execute { status ->
            try {
                block(jdbc)
            } finally {
                status.setRollbackOnly()
            }
        }
    }

    protected fun seedActiveRelease(jdbc: JdbcTemplate, manifests: Map<PolicyLayer, String>): UUID {
        val items = manifests.map { (layer, manifest) -> bundle(jdbc, layer, manifest) }
        return activate(jdbc, items)
    }

    private fun bundle(
        jdbc: JdbcTemplate,
        layer: PolicyLayer,
        manifest: String,
        bundleStatus: String = "ACTIVE",
        versionStatus: String = "PUBLISHED",
        forcedHash: String? = null,
    ): Item {
        val bundleId = UUID.randomUUID()
        val versionId = UUID.randomUUID()
        val hash = forcedHash ?: canonicalHash(manifest)
        jdbc.update(
            """INSERT INTO authz.policy_bundle(id, bundle_key, layer, package_id, status)
               VALUES (?, ?, ?, ?, ?)""",
            bundleId, "matrix:$bundleId", layer.name, if (layer == PolicyLayer.DOMAIN) PACKAGE_ID else null, bundleStatus,
        )
        if (versionStatus == "PUBLISHED") {
            jdbc.update(
                """INSERT INTO authz.policy_bundle_version
                   (id, bundle_id, version, status, manifest, content_hash, published_at)
                   VALUES (?, ?, 1, 'PUBLISHED', ?::jsonb, ?, transaction_timestamp())""",
                versionId, bundleId, manifest, hash,
            )
        } else {
            jdbc.update(
                """INSERT INTO authz.policy_bundle_version(id, bundle_id, version, status, manifest)
                   VALUES (?, ?, 1, ?, ?::jsonb)""",
                versionId, bundleId, versionStatus, manifest,
            )
        }
        return Item(layer, bundleId, versionId, hash)
    }

    private fun activate(jdbc: JdbcTemplate, items: List<Item>, forcedHash: String? = null): UUID {
        val releaseId = UUID.randomUUID()
        val releaseNumber = jdbc.queryForObject(
            "SELECT coalesce(max(release_number), 0) + 1 FROM authz.policy_release",
            Long::class.java,
        )!!
        val integrityItems = items.map {
            PolicyReleaseItemIntegrity(it.layer, it.bundleId, it.bundleVersionId, it.contentHash)
        }
        val hash = forcedHash ?: PolicyReleaseIntegrity.contentHash(OPA_REVISION, integrityItems)
        jdbc.update(
            "INSERT INTO authz.policy_release(id, release_number, status, content_hash) VALUES (?, ?, 'STAGED', ?)",
            releaseId, releaseNumber, hash,
        )
        items.forEach { item ->
            jdbc.update(
                "INSERT INTO authz.policy_release_item(release_id, bundle_id, bundle_version_id) VALUES (?, ?, ?)",
                releaseId, item.bundleId, item.bundleVersionId,
            )
        }
        jdbc.update(
            """UPDATE authz.policy_release SET status = 'ACTIVE', opa_revision = ?, published_at = transaction_timestamp()
               WHERE id = ?""",
            OPA_REVISION, releaseId,
        )
        return releaseId
    }

    protected fun repository(jdbc: JdbcTemplate) = AuthorizationSnapshotRepository(jdbc, ObjectMapper().findAndRegisterModules())

    protected fun request() = AuthorizationRequest(
        REQUEST_ID, PRINCIPAL_ID, "occ.read", ENTITY_ID, RESOURCE_ID,
        mapOf("correlationId" to REQUEST_ID.toString()),
    )

    private fun manifest(id: String, effect: String, action: String) =
        """{"version":1,"roleGrants":[{"id":"$id","effect":"$effect","action":"$action","entityId":"*","resourceId":"*","subjectRoleEntityKey":"role:administrator"}],"forbiddenActions":[]}"""

    private fun canonicalHash(json: String): String {
        val mapper = ObjectMapper().findAndRegisterModules().apply {
            setConfig(serializationConfig.with(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY))
        }.enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
        val normalized = mapper.convertValue(mapper.readTree(json), Any::class.java)
        return MessageDigest.getInstance("SHA-256").digest(mapper.writeValueAsBytes(normalized))
            .joinToString("") { "%02x".format(it) }
    }

    private data class Item(
        val layer: PolicyLayer,
        val bundleId: UUID,
        val bundleVersionId: UUID,
        val contentHash: String,
    )

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        private const val OPA_REVISION = "platform-authz-v2"
        private val PACKAGE_ID = UUID.fromString("73000000-0000-7000-8000-000000000001")
        private val PACKAGE_VERSION_ID = UUID.fromString("73000000-0000-7000-8000-000000000002")
        private val TYPE_ID = UUID.fromString("73000000-0000-7000-8000-000000000003")
        private val TYPE_VERSION_ID = UUID.fromString("73000000-0000-7000-8000-000000000004")
        private val ROLE_TYPE_ID = UUID.fromString("73000000-0000-7000-8000-000000000005")
        private val ROLE_TYPE_VERSION_ID = UUID.fromString("73000000-0000-7000-8000-000000000006")
        private val RELATION_ID = UUID.fromString("00000000-0000-7000-8000-000000000002")
        private val PRINCIPAL_ID = UUID.fromString("73000000-0000-7000-8000-000000000007")
        private val ENTITY_ID = UUID.fromString("73000000-0000-7000-8000-000000000008")
        private val RESOURCE_ID = UUID.fromString("73000000-0000-7000-8000-000000000009")
        private val ROLE_ID = UUID.fromString("73000000-0000-7000-8000-000000000010")
        private val REQUEST_ID = UUID.fromString("73000000-0000-4000-8000-000000000011")

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
            Flyway.configure().dataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only")
                .locations("classpath:db/migration").load().migrate()
            val jdbc = JdbcTemplate(dataSource())
            jdbc.update("INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, 'matrix', 'Matrix', 'ACTIVE')", PACKAGE_ID)
            jdbc.update("INSERT INTO catalog.package_version(id, package_id, semver, status) VALUES (?, ?, '1.0.0', 'DRAFT')", PACKAGE_VERSION_ID, PACKAGE_ID)
            jdbc.update("INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind, authorizable) VALUES (?, ?, 'matrix.subject', 'Subject', 'PRINCIPAL', true), (?, ?, 'matrix.role', 'Role', 'PRINCIPAL', true)", TYPE_ID, PACKAGE_ID, ROLE_TYPE_ID, PACKAGE_ID)
            jdbc.update("INSERT INTO catalog.entity_type_version(id, entity_type_id, package_version_id, schema_version, json_schema) VALUES (?, ?, ?, 1, '{}'::jsonb), (?, ?, ?, 1, '{}'::jsonb)", TYPE_VERSION_ID, TYPE_ID, PACKAGE_VERSION_ID, ROLE_TYPE_VERSION_ID, ROLE_TYPE_ID, PACKAGE_VERSION_ID)
            jdbc.update("INSERT INTO catalog.relation_definition(id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality, auth_relevant) VALUES (?, ?, 'platform.role-assignment', ?, ?, 'MANY_TO_MANY', true)", RELATION_ID, PACKAGE_VERSION_ID, TYPE_ID, ROLE_TYPE_ID)
            listOf(
                "74000000-0000-7000-8000-000000000001" to "cohort_owner",
                "74000000-0000-7000-8000-000000000002" to "cohort_teacher",
                "74000000-0000-7000-8000-000000000003" to "cohort_participant",
                "74000000-0000-7000-8000-000000000004" to "task_candidate",
                "74000000-0000-7000-8000-000000000005" to "task_assignee",
                "74000000-0000-7000-8000-000000000006" to "unrelated_authority",
            ).forEach { (id, key) ->
                jdbc.update(
                    """INSERT INTO catalog.relation_definition
                       (id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality, auth_relevant)
                       VALUES (?::uuid, ?, ?, ?, ?, 'MANY_TO_MANY', true)""",
                    id, PACKAGE_VERSION_ID, key, TYPE_ID, TYPE_ID,
                )
            }
            listOf(
                arrayOf(PRINCIPAL_ID, TYPE_ID, TYPE_VERSION_ID, "matrix:user"),
                arrayOf(ENTITY_ID, TYPE_ID, TYPE_VERSION_ID, "matrix:entity"),
                arrayOf(RESOURCE_ID, TYPE_ID, TYPE_VERSION_ID, "matrix:resource"),
                arrayOf(ROLE_ID, ROLE_TYPE_ID, ROLE_TYPE_VERSION_ID, "role:administrator"),
            ).forEach { row -> jdbc.update("INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state) VALUES (?, ?, ?, ?, 'ACTIVE')", *row) }
            jdbc.update("INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, 'USER', 'Matrix User', 'ACTIVE'), (?, 'ROLE', 'Administrator', 'ACTIVE')", PRINCIPAL_ID, ROLE_ID)
            jdbc.update("UPDATE catalog.package_version SET status = 'PUBLISHED', content_hash = repeat('a', 64), published_at = transaction_timestamp() WHERE id = ?", PACKAGE_VERSION_ID)
            jdbc.update("INSERT INTO authz.relationship(id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref) VALUES (?, ?, ?, ?, 'SYSTEM', 'matrix')", UUID.randomUUID(), RELATION_ID, PRINCIPAL_ID, ROLE_ID)
        }

        private fun dataSource() = PGSimpleDataSource().apply {
            setURL(postgres.jdbcUrl)
            user = "innorder_runtime"
            password = "runtime-test-only"
        }
    }
}
