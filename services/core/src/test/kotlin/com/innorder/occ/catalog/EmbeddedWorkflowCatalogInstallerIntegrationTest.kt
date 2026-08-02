package com.innorder.occ.catalog

import com.innorder.occ.authz.WorkflowAuthorizationRelationDefinitions
import com.innorder.occ.iam.BootstrapIds
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.postgresql.ds.PGSimpleDataSource
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile

class EmbeddedWorkflowCatalogInstallerIntegrationTest {
    @Test
    fun `workflow catalog owns stable UUIDv5 identifiers while canonical relation literals remain upstream exceptions`() {
        assertThat(EmbeddedWorkflowCatalogIds.NAMESPACE)
            .isEqualTo(java.util.UUID.fromString("9f973715-bf36-57c5-9339-d0013c9c99d7"))
        assertThat(
            listOf(
                EmbeddedWorkflowCatalogIds.PACKAGE,
                EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
                EmbeddedWorkflowCatalogIds.COHORT_TYPE,
                EmbeddedWorkflowCatalogIds.COHORT_TYPE_VERSION,
                EmbeddedWorkflowCatalogIds.PROCESS_TYPE,
                EmbeddedWorkflowCatalogIds.PROCESS_TYPE_VERSION,
                EmbeddedWorkflowCatalogIds.TASK_TYPE,
                EmbeddedWorkflowCatalogIds.TASK_TYPE_VERSION,
            ),
        ).containsExactly(
            java.util.UUID.fromString("37779a89-8140-5bd6-aa71-51f7aa4e26a0"),
            java.util.UUID.fromString("5e2b6072-9b03-5ede-8bf0-540b2447655a"),
            java.util.UUID.fromString("cf3f4f08-947c-5d79-9bc6-700de641f2c7"),
            java.util.UUID.fromString("b36593b3-9df3-55b7-861a-6466853f41f4"),
            java.util.UUID.fromString("4f3d5746-f425-58e2-9aa1-147faa4f33a5"),
            java.util.UUID.fromString("15fa468c-1400-58fe-b7e9-9398f24802cd"),
            java.util.UUID.fromString("88bb8859-b452-5330-8221-29700dc6a89f"),
            java.util.UUID.fromString("7020a106-ff69-52db-aa0d-de281b1d8bad"),
        ).allSatisfy { assertThat(it.version()).isEqualTo(5) }
        assertThat(WorkflowAuthorizationRelationDefinitions.all.map { it.id.toString() }).containsExactly(
            "00000000-0000-7000-8000-000000000101",
            "00000000-0000-7000-8000-000000000102",
            "00000000-0000-7000-8000-000000000103",
            "00000000-0000-7000-8000-000000000104",
            "00000000-0000-7000-8000-000000000105",
        )
    }

    @Test
    fun `installer publishes stable workflow prerequisites idempotently and rejects drift`() {
        PostgreSQLContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres")).use { postgres ->
            postgres.withDatabaseName("innorder_occ")
                .withUsername("innorder_admin")
                .withPassword("admin-test-only")
                .withCopyFileToContainer(
                    MountableFile.forClasspathResource("postgres-test-init.sql"),
                    "/docker-entrypoint-initdb.d/010-test-roles.sql",
                )
                .start()
            Flyway.configure().dataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only")
                .locations("classpath:db/migration").load().migrate()
            val dataSource = PGSimpleDataSource().apply {
                setURL(postgres.jdbcUrl)
                user = "innorder_flyway"
                password = "flyway-test-only"
            }
            val jdbc = JdbcTemplate(dataSource)
            seedPlatformUserType(jdbc)
            val installer = EmbeddedWorkflowCatalogInstaller(
                jdbc,
                TransactionTemplate(DataSourceTransactionManager(dataSource)),
            )

            installer.installPackage()
            assertThat(jdbc.queryForObject(
                "SELECT id FROM authz.entity WHERE entity_key = 'customer:default'",
                java.util.UUID::class.java,
            )).isEqualTo(jdbc.queryForObject(
                "SELECT id FROM platform.customer_instance WHERE singleton",
                java.util.UUID::class.java,
            ))
            val firstTypes = jdbc.queryForList(
                "SELECT id::text, type_key FROM catalog.entity_type WHERE package_id = ? ORDER BY type_key",
                EmbeddedWorkflowCatalogIds.PACKAGE,
            )
            val firstVersions = jdbc.queryForList(
                "SELECT id::text, entity_type_id::text, schema_version FROM catalog.entity_type_version WHERE package_version_id = ? ORDER BY entity_type_id",
                EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
            )
            installer.installPackage()

            assertThat(firstTypes).hasSize(3).isEqualTo(jdbc.queryForList(
                "SELECT id::text, type_key FROM catalog.entity_type WHERE package_id = ? ORDER BY type_key",
                EmbeddedWorkflowCatalogIds.PACKAGE,
            ))
            assertThat(firstVersions).hasSize(3).allSatisfy { assertThat(it["schema_version"]).isEqualTo(1) }
                .isEqualTo(jdbc.queryForList(
                    "SELECT id::text, entity_type_id::text, schema_version FROM catalog.entity_type_version WHERE package_version_id = ? ORDER BY entity_type_id",
                    EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
                ))
            assertThat(jdbc.queryForObject(
                "SELECT status FROM catalog.package_version WHERE id = ?",
                String::class.java,
                EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
            )).isEqualTo("PUBLISHED")
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM catalog.workflow_definition WHERE package_version_id = ?",
                Long::class.java,
                EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
            )).isZero()
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM catalog.form_definition WHERE package_version_id = ?",
                Long::class.java,
                EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
            )).isZero()
            assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.principal", Long::class.java)).isZero()
            jdbc.update(
                "DELETE FROM authz.entity WHERE id = (SELECT id FROM platform.customer_instance WHERE singleton)",
            )
            installer.installPackage()
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM authz.entity WHERE id = (SELECT id FROM platform.customer_instance WHERE singleton) AND entity_key = 'customer:default' AND state = 'ACTIVE'",
                Long::class.java,
            )).isEqualTo(1)

            val relations = jdbc.queryForList(
                """SELECT id::text, relation_key, subject_type_id::text, object_type_id::text,
                          cardinality, auth_relevant
                   FROM catalog.relation_definition WHERE package_version_id = ? ORDER BY relation_key""",
                EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
            )
            assertThat(relations.map { it["id"] }).containsExactlyInAnyOrderElementsOf(
                WorkflowAuthorizationRelationDefinitions.all.map { it.id.toString() },
            )
            assertThat(relations).allSatisfy {
                assertThat(it["subject_type_id"]).isEqualTo(BootstrapIds.USER_TYPE.toString())
                assertThat(it["auth_relevant"]).isEqualTo(true)
            }
            assertThat(relations.associate { it["relation_key"] to it["cardinality"] })
                .containsEntry("cohort_owner", "ONE_TO_MANY")
                .containsEntry("cohort_teacher", "MANY_TO_MANY")
                .containsEntry("cohort_participant", "MANY_TO_MANY")
                .containsEntry("task_candidate", "MANY_TO_MANY")
                .containsEntry("task_assignee", "ONE_TO_MANY")

            jdbc.update(
                "UPDATE catalog.entity_type SET name = 'Drifted' WHERE id = ?",
                EmbeddedWorkflowCatalogIds.COHORT_TYPE,
            )
            assertThatThrownBy { installer.installPackage() }
                .isInstanceOf(WorkflowCatalogInstallationException::class.java)
        }
    }

    private fun seedPlatformUserType(jdbc: JdbcTemplate) {
        jdbc.update(
            "INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, 'platform-iam', 'Platform IAM', 'ACTIVE')",
            BootstrapIds.PACKAGE,
        )
        jdbc.update(
            "INSERT INTO catalog.package_version(id, package_id, semver, status) VALUES (?, ?, '1.0.0', 'DRAFT')",
            BootstrapIds.PACKAGE_VERSION,
            BootstrapIds.PACKAGE,
        )
        jdbc.update(
            """INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind, authorizable)
               VALUES (?, ?, 'platform.user', 'User', 'PRINCIPAL', true)""",
            BootstrapIds.USER_TYPE,
            BootstrapIds.PACKAGE,
        )
        jdbc.update(
            """INSERT INTO catalog.entity_type_version(id, entity_type_id, package_version_id, schema_version, json_schema)
               VALUES (?, ?, ?, 1, '{}'::jsonb)""",
            BootstrapIds.USER_TYPE_VERSION,
            BootstrapIds.USER_TYPE,
            BootstrapIds.PACKAGE_VERSION,
        )
        jdbc.update(
            """UPDATE catalog.package_version SET status = 'PUBLISHED', content_hash = repeat('a', 64),
                   published_at = transaction_timestamp() WHERE id = ?""",
            BootstrapIds.PACKAGE_VERSION,
        )
    }

    companion object {
        private const val IMAGE = "pgvector/pgvector:pg16"
    }
}
