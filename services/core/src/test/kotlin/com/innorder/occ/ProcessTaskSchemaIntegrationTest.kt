package com.innorder.occ

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.catchThrowable
import org.flywaydb.core.Flyway
import org.flywaydb.core.api.MigrationVersion
import org.junit.jupiter.api.Test
import org.postgresql.util.PSQLException
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.utility.DockerImageName

class ProcessTaskSchemaIntegrationTest {
    @Test
    fun appliesV013WithRuntimePrivileges() = withPostgres { postgres, jdbc ->
        migrate(postgres).migrate()

        assertThat(jdbc.queryForObject("SELECT to_regclass('occ.cohort')::text", String::class.java))
            .isEqualTo("occ.cohort")
        assertThat(jdbc.queryForObject(
            "SELECT has_table_privilege('innorder_runtime', 'occ.notification', 'SELECT,INSERT,UPDATE,DELETE')",
            Boolean::class.java,
        )).isTrue()
        assertThat(jdbc.queryForObject(
            """SELECT has_table_privilege('innorder_runtime', 'audit.dependency_failure_attempt', 'SELECT,INSERT')
               AND NOT has_table_privilege('innorder_runtime', 'audit.dependency_failure_attempt', 'UPDATE,DELETE')""",
            Boolean::class.java,
        )).isTrue()
    }

    @Test
    fun rejectsUntruthfulLegacyBackfill() = withPostgres { postgres, jdbc ->
        migrate(postgres, "12").migrate()
        jdbc.execute(
            """
            INSERT INTO catalog.domain_package (id, package_key, name, status)
            VALUES ('71000000-0000-7000-8000-000000000001', 'upgrade.guard', 'Upgrade guard', 'ACTIVE');
            INSERT INTO catalog.package_version (id, package_id, semver, status, manifest)
            VALUES ('72000000-0000-7000-8000-000000000001', '71000000-0000-7000-8000-000000000001', '1.0.0', 'DRAFT', '{}');
            INSERT INTO catalog.entity_type (id, package_id, type_key, name, entity_kind)
            VALUES ('73000000-0000-7000-8000-000000000001', '71000000-0000-7000-8000-000000000001', 'process', 'Process', 'RESOURCE');
            INSERT INTO catalog.entity_type_version (id, entity_type_id, package_version_id, schema_version, json_schema)
            VALUES ('74000000-0000-7000-8000-000000000001', '73000000-0000-7000-8000-000000000001', '72000000-0000-7000-8000-000000000001', 1, '{}');
            INSERT INTO catalog.workflow_definition (id, package_version_id, workflow_key, bpmn_object_key, content_hash)
            VALUES ('75000000-0000-7000-8000-000000000001', '72000000-0000-7000-8000-000000000001', 'route', 'route.bpmn', repeat('a', 64));
            INSERT INTO authz.entity (id, entity_type_id, entity_type_version_id, entity_key, state)
            VALUES ('76000000-0000-7000-8000-000000000001', '73000000-0000-7000-8000-000000000001', '74000000-0000-7000-8000-000000000001', 'process:legacy', 'ACTIVE');
            INSERT INTO occ.process_definition_binding
              (id, workflow_definition_id, package_version_id, bpmn_key, flowable_deployment_id, flowable_definition_id, content_hash)
            VALUES ('77000000-0000-7000-8000-000000000001', '75000000-0000-7000-8000-000000000001',
              '72000000-0000-7000-8000-000000000001', 'route', 'legacy-deployment', 'legacy-definition', repeat('b', 64));
            INSERT INTO occ.process_instance
              (id, definition_binding_id, package_version_id, flowable_instance_id, business_key, state)
            VALUES ('76000000-0000-7000-8000-000000000001', '77000000-0000-7000-8000-000000000001',
              '72000000-0000-7000-8000-000000000001', 'legacy-instance', 'legacy-business', 'RUNNING');
            """.trimIndent(),
        )

        val failure = catchThrowable { migrate(postgres).migrate() }
        assertThat(failure).hasRootCauseInstanceOf(PSQLException::class.java)
        val rootCause = generateSequence(failure) { it.cause }.last()
        assertThat((rootCause as PSQLException).sqlState).isEqualTo("55000")
    }

    @Test
    fun enforcesProcessTaskConstraints() = withPostgres { postgres, jdbc ->
        migrate(postgres).migrate()

        assertThat(jdbc.queryForObject(
            """SELECT count(*) FROM pg_constraint WHERE conname IN (
                 'fk_process_binding_workflow_package', 'fk_process_definition_package',
                 'fk_process_cohort_package', 'ex_relationship_effective_window',
                 'uq_process_cohort_started_participant')""",
            Long::class.java,
        )).isEqualTo(5)
        assertThat(jdbc.queryForObject(
            """SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
                 'trg_cohort_owner_projection', 'trg_cohort_lifecycle',
                 'trg_process_instance_lifecycle', 'trg_task_projection_lifecycle',
                 'trg_task_timeline_immutable', 'trg_task_review_projection_immutable',
                 'trg_notification_lifecycle')""",
            Long::class.java,
        )).isEqualTo(7)
    }

    private fun migrate(postgres: PostgreSQLContainer<*>, target: String? = null): Flyway {
        val configuration = Flyway.configure()
            .dataSource(postgres.jdbcUrl, postgres.username, postgres.password)
            .locations("classpath:db/migration")
        if (target != null) configuration.target(MigrationVersion.fromVersion(target))
        return configuration.load()
    }

    private fun withPostgres(block: (PostgreSQLContainer<*>, JdbcTemplate) -> Unit) {
        val postgres = PostgreSQLContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("innorder_occ")
            .withUsername("postgres")
            .withPassword("postgres-test-only")
        postgres.start()
        try {
            val jdbc = JdbcTemplate(DriverManagerDataSource(postgres.jdbcUrl, postgres.username, postgres.password))
            jdbc.execute(
                """DO ${'$'}${'$'} BEGIN
                     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'innorder_runtime') THEN
                       CREATE ROLE innorder_runtime NOLOGIN;
                     END IF;
                   END ${'$'}${'$'}""",
            )
            block(postgres, jdbc)
        } finally {
            postgres.stop()
        }
    }

    private companion object {
        const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
    }
}
