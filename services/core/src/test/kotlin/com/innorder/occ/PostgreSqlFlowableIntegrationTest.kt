package com.innorder.occ

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.flowable.engine.RepositoryService
import org.flowable.engine.RuntimeService
import org.flowable.engine.HistoryService
import org.flowable.engine.ProcessEngine
import org.flowable.spring.SpringProcessEngineConfiguration
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Import
import org.springframework.context.annotation.AnnotationConfigApplicationContext
import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.annotation.DirtiesContext
import org.springframework.test.context.ActiveProfiles
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.annotation.Transactional
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import java.util.UUID
import java.nio.file.Files
import java.nio.file.Path
import java.util.function.Supplier
import javax.sql.DataSource
import com.innorder.occ.config.FlowableTransactionBoundaryVerifier

@SpringBootTest
@Testcontainers(disabledWithoutDocker = true)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@ActiveProfiles("test")
@Import(
    PostgreSqlFlowableIntegrationTest.AtomicityConfiguration::class,
    PlatformCatalogPrerequisiteTestConfiguration::class,
)
class PostgreSqlFlowableIntegrationTest(
    @param:Autowired private val jdbcTemplate: JdbcTemplate,
    @param:Autowired private val repositoryService: RepositoryService,
    @param:Autowired private val runtimeService: RuntimeService,
    @param:Autowired private val historyService: HistoryService,
    @param:Autowired private val processEngine: ProcessEngine,
    @param:Autowired private val processConfiguration: SpringProcessEngineConfiguration,
    @param:Autowired private val dataSource: DataSource,
    @param:Autowired private val transactionManager: PlatformTransactionManager,
    @param:Autowired private val atomicity: FlowableAtomicityFixture,
) {
    @Test
    fun `Flowable is bound to the application datasource and Spring transaction manager`() {
        assertThat(processEngine.processEngineConfiguration).isSameAs(processConfiguration)
        assertThat(processConfiguration.transactionManager).isSameAs(transactionManager)
        assertThat(processConfiguration.dataSource.connection.use { it.metaData.url })
            .isEqualTo(dataSource.connection.use { it.metaData.url })
    }

    @Test
    fun `Flowable and OCC writes commit and roll back on one real PostgreSQL transaction`() {
        JdbcTemplate(DriverManagerDataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only")).run {
            execute("CREATE TABLE IF NOT EXISTS occ.flowable_atomicity_test(id uuid PRIMARY KEY, value text NOT NULL)")
            execute("GRANT SELECT, INSERT, UPDATE, DELETE ON occ.flowable_atomicity_test TO innorder_runtime")
        }
        val deployment = repositoryService.createDeployment().addString("atomicity.bpmn20.xml", ATOMICITY_PROCESS).deploy()
        val rolledBack = UUID.randomUUID()
        val committed = UUID.randomUUID()
        try {
            assertThatThrownBy { atomicity.write(rolledBack, fail = true) }
                .isInstanceOf(IllegalStateException::class.java)
            assertAtomicityCounts(rolledBack, 0)
            atomicity.write(committed, fail = false)
            assertAtomicityCounts(committed, 1)
        } finally {
            runtimeService.createProcessInstanceQuery().processDefinitionKey("atomicityProcess").list()
                .forEach { runtimeService.deleteProcessInstance(it.id, "test cleanup") }
            repositoryService.deleteDeployment(deployment.id, true)
            jdbcTemplate.update("DELETE FROM audit.outbox_event WHERE aggregate_id IN (?, ?)", rolledBack, committed)
            JdbcTemplate(DriverManagerDataSource(postgres.jdbcUrl, "innorder_admin", "admin-test-only")).run {
                execute("ALTER TABLE audit.audit_record DISABLE TRIGGER trg_audit_record_immutable")
                update("DELETE FROM audit.audit_record WHERE correlation_id IN (?, ?)", rolledBack, committed)
                execute("ALTER TABLE audit.audit_record ENABLE TRIGGER trg_audit_record_immutable")
            }
            jdbcTemplate.update("DELETE FROM occ.flowable_atomicity_test WHERE id IN (?, ?)", rolledBack, committed)
        }
    }

    @Test
    fun `Flowable boundary verifier rejects a separate datasource with a generic message`() {
        val separate = DriverManagerDataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only")
        val invalid = SpringProcessEngineConfiguration().apply {
            setDataSource(separate)
            transactionManager = DataSourceTransactionManager(separate)
            databaseSchemaUpdate = "false"
        }
        assertThatThrownBy {
            AnnotationConfigApplicationContext().use { context ->
                context.registerBean(SpringProcessEngineConfiguration::class.java, Supplier { invalid })
                context.registerBean(FlowableTransactionBoundaryVerifier::class.java, Supplier {
                    FlowableTransactionBoundaryVerifier(dataSource, transactionManager, context.environment)
                })
                context.refresh()
            }
        }.hasRootCauseInstanceOf(IllegalStateException::class.java)
            .hasRootCauseMessage("Flowable transaction boundary is invalid")
    }

    private fun assertAtomicityCounts(id: UUID, expected: Long) {
        assertThat(runtimeService.createProcessInstanceQuery().processInstanceBusinessKey(id.toString()).count()).isEqualTo(expected)
        assertThat(historyService.createHistoricProcessInstanceQuery().processInstanceBusinessKey(id.toString()).count()).isEqualTo(expected)
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM occ.flowable_atomicity_test WHERE id = ?", Long::class.java, id)).isEqualTo(expected)
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM audit.audit_record WHERE correlation_id = ?", Long::class.java, id)).isEqualTo(expected)
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM audit.outbox_event WHERE aggregate_id = ?", Long::class.java, id)).isEqualTo(expected)
    }
    @Test
    fun `real PostgreSQL executes all schema contract SQL`() {
        val testDirectory = databaseTestDirectory()
        listOf(
            "000_assert.sql",
            "001_schema_contract.sql",
            "002_constraints.sql",
            "003_process_task_workflow.sql",
            "run_all.sql",
        ).forEach { name ->
            postgres.copyFileToContainer(MountableFile.forHostPath(testDirectory.resolve(name)), "/tmp/database-tests/$name")
        }

        val result = postgres.execInContainer(
            "sh",
            "-c",
            "PGPASSWORD=flyway-test-only psql -h 127.0.0.1 -U innorder_flyway -d innorder_occ -f /tmp/database-tests/run_all.sql",
        )

        assertThat(result.exitCode).withFailMessage(result.stderr + result.stdout).isZero()
        assertThat(result.stdout).contains("all single-session schema tests passed")
    }

    @Test
    fun `psql full schema entrypoint applies to a fresh PostgreSQL database`() {
        val databaseDirectory = databaseDirectory()
        postgres.copyFileToContainer(MountableFile.forHostPath(databaseDirectory), "/tmp/full-schema")
        val adminJdbc = JdbcTemplate(DriverManagerDataSource(postgres.jdbcUrl, "innorder_admin", "admin-test-only"))
        adminJdbc.execute("DROP DATABASE IF EXISTS innorder_full_schema_test WITH (FORCE)")
        adminJdbc.execute("CREATE DATABASE innorder_full_schema_test")
        try {
            val result = postgres.execInContainer(
                "sh",
                "-c",
                "PGPASSWORD=admin-test-only psql -h 127.0.0.1 -U innorder_admin -d innorder_full_schema_test -f /tmp/full-schema/innorder_occ_full_schema.sql",
            )
            assertThat(result.exitCode).withFailMessage(result.stderr + result.stdout).isZero()
            assertThat(result.stdout).contains("COMMIT")
        } finally {
            adminJdbc.execute("DROP DATABASE IF EXISTS innorder_full_schema_test WITH (FORCE)")
        }
    }

    @Test
    fun `migrations runtime privileges Flowable and pgvector match production boundaries`() {
        val flywayJdbc = JdbcTemplate(DriverManagerDataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only"))
        assertThat(jdbcTemplate.queryForObject("SELECT current_user", String::class.java)).isEqualTo("innorder_runtime")
        assertThat(flywayJdbc.queryForList("SELECT DISTINCT installed_by FROM flyway_schema_history", String::class.java))
            .containsExactly("innorder_flyway")
        // Agent 06 must reconcile this exact list to V001-V015 after merging reserved V013 and V015.
        assertThat(flywayJdbc.queryForList("SELECT version::integer FROM flyway_schema_history WHERE success ORDER BY installed_rank", Int::class.java))
            .containsExactlyElementsOf((1..16).toList())
        assertThat(flywayJdbc.queryForList(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'iam' AND table_name = 'user_account' ORDER BY ordinal_position",
            String::class.java,
        )).containsExactly(
            "principal_id",
            "username",
            "password_hash",
            "password_version",
            "failed_attempts",
            "locked_until",
            "last_login_at",
            "failed_window_started_at",
        )
        assertThat(flywayJdbc.queryForObject(
            "SELECT has_column_privilege('innorder_runtime', 'iam.user_account', 'failed_window_started_at', 'SELECT,UPDATE')",
            Boolean::class.java,
        )).isTrue()
        assertThat(jdbcTemplate.queryForObject(
            "SELECT id::text || ':' || instance_key FROM platform.customer_instance WHERE singleton",
            String::class.java,
        )).isEqualTo("00000000-0000-7000-8000-000000000001:default")
        assertThat(flywayJdbc.queryForList(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'iam' AND table_name = 'auth_session' ORDER BY ordinal_position",
            String::class.java,
        )).containsExactly(
            "id",
            "principal_id",
            "token_version",
            "refresh_token_hash",
            "created_at",
            "last_used_at",
            "expires_at",
            "revoked_at",
            "replaced_by_session_id",
            "client_fingerprint",
        )
        assertThat(flywayJdbc.queryForList(
            "SELECT tgname FROM pg_trigger WHERE tgrelid = 'iam.auth_session'::regclass AND NOT tgisinternal",
            String::class.java,
        )).containsExactly("trg_auth_session_rotation_integrity")
        assertThat(flywayJdbc.queryForObject(
            "SELECT indexdef FROM pg_indexes WHERE schemaname = 'iam' AND indexname = 'ix_auth_session_active_principal_expiry'",
            String::class.java,
        )).contains("WHERE (revoked_at IS NULL)")

        assertThatThrownBy { jdbcTemplate.execute("CREATE TABLE occ.runtime_must_not_create(id integer)") }
            .isInstanceOf(DataAccessException::class.java)

        val actSchemas = jdbcTemplate.queryForList(
            "SELECT DISTINCT schemaname FROM pg_tables WHERE upper(tablename) LIKE 'ACT\\_%' ESCAPE '\\'",
            String::class.java,
        )
        assertThat(actSchemas).containsExactly("flowable")
        assertThat(jdbcTemplate.queryForObject("SELECT schema_owner FROM information_schema.schemata WHERE schema_name = 'flowable'", String::class.java))
            .isEqualTo("innorder_flyway")
        assertThat(jdbcTemplate.queryForList("SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'flowable'", String::class.java))
            .containsExactly("innorder_runtime")

        val deployment = repositoryService.createDeployment()
            .addString(
                "integration.bpmn20.xml",
                """<?xml version="1.0" encoding="UTF-8"?>
                <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="occ-test">
                  <process id="integrationProcess" isExecutable="true"><startEvent id="start"/><sequenceFlow id="toEnd" sourceRef="start" targetRef="end"/><endEvent id="end"/></process>
                </definitions>""".trimIndent(),
            ).deploy()
        assertThat(repositoryService.createDeploymentQuery().deploymentId(deployment.id).singleResult()).isNotNull
        assertThat(runtimeService.startProcessInstanceByKey("integrationProcess").isEnded).isTrue()

        assertThat(jdbcTemplate.queryForList("SELECT extname FROM pg_extension WHERE extname IN ('vector', 'btree_gist') ORDER BY extname", String::class.java))
            .containsExactly("btree_gist", "vector")
        assertThat(jdbcTemplate.queryForObject("SELECT to_regprocedure('ai.create_embedding_partition(uuid,integer,text)') IS NOT NULL", Boolean::class.java))
            .isTrue()
    }

    @Test
    fun `runtime creates only a validated embedding partition through the hardened function`() {
        val flywayJdbc = JdbcTemplate(DriverManagerDataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only"))
        val spaceId = UUID.fromString("10000000-0000-0000-0000-000000000007")
        val partitionName = "chunk_embedding_10000000_0000_0000_0000_000000000007"
        val indexName = "hnsw_10000000_0000_0000_0000_000000000007"
        seedEmbeddingSpace(flywayJdbc, spaceId, 7, "COSINE")

        jdbcTemplate.queryForList(
            "SELECT ai.create_embedding_partition(?::uuid, ?, ?)",
            spaceId,
            7,
            "COSINE",
        )

        assertThat(jdbcTemplate.queryForObject(
            "SELECT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ai' AND c.relname = ? AND c.relkind = 'r')",
            Boolean::class.java,
            partitionName,
        )).isTrue()
        assertThat(jdbcTemplate.queryForObject(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = ('ai.' || ?)::regclass AND contype = 'c'",
            String::class.java,
            partitionName,
        )).contains("vector_dims(embedding) = 7")
        assertThat(jdbcTemplate.queryForObject(
            "SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = ('ai.' || ?)::regclass AND a.attnum = 1",
            String::class.java,
            indexName,
        )).endsWith("vector(7)")
        assertThat(jdbcTemplate.queryForObject(
            "SELECT am.amname FROM pg_class c JOIN pg_am am ON am.oid = c.relam WHERE c.oid = ('ai.' || ?)::regclass",
            String::class.java,
            indexName,
        )).isEqualTo("hnsw")
        assertThat(jdbcTemplate.queryForObject(
            "SELECT opc.opcname FROM pg_index i JOIN pg_opclass opc ON opc.oid = i.indclass[0] WHERE i.indexrelid = ('ai.' || ?)::regclass",
            String::class.java,
            indexName,
        )).isEqualTo("vector_cosine_ops")

        assertThatThrownBy { jdbcTemplate.execute("CREATE TABLE ai.runtime_must_not_create(id integer)") }
            .isInstanceOf(DataAccessException::class.java)
        assertThatThrownBy { jdbcTemplate.execute("CREATE TABLE occ.runtime_must_not_create_again(id integer)") }
            .isInstanceOf(DataAccessException::class.java)
        assertThat(jdbcTemplate.queryForObject("SELECT current_user", String::class.java)).isEqualTo("innorder_runtime")
    }

    @Test
    fun `runtime performs application DML and can use every application sequence`() {
        val packageId = UUID.fromString("20000000-0000-0000-0000-000000000001")

        assertThat(jdbcTemplate.update(
            "INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, ?, ?, ?)",
            packageId,
            "integration-runtime-dml",
            "Runtime DML",
            "ACTIVE",
        )).isEqualTo(1)
        assertThat(jdbcTemplate.queryForObject(
            "SELECT name FROM catalog.domain_package WHERE id = ?",
            String::class.java,
            packageId,
        )).isEqualTo("Runtime DML")
        assertThat(jdbcTemplate.update(
            "UPDATE catalog.domain_package SET name = ? WHERE id = ?",
            "Runtime DML Updated",
            packageId,
        )).isEqualTo(1)
        assertThat(jdbcTemplate.queryForObject(
            "SELECT row_version FROM catalog.domain_package WHERE id = ?",
            Long::class.java,
            packageId,
        )).isEqualTo(1L)

        val sequences = jdbcTemplate.queryForList(
            "SELECT format('%I.%I', schemaname, sequencename) FROM pg_sequences WHERE schemaname IN ('platform', 'catalog', 'iam', 'authz', 'occ', 'audit', 'ai') ORDER BY 1",
            String::class.java,
        )
        for (sequence in sequences) {
            assertThat(jdbcTemplate.queryForObject("SELECT nextval(?::regclass)", Long::class.java, sequence)).isPositive()
        }

        assertThat(jdbcTemplate.update("DELETE FROM catalog.domain_package WHERE id = ?", packageId)).isEqualTo(1)
        assertThat(jdbcTemplate.queryForObject("SELECT current_user", String::class.java)).isEqualTo("innorder_runtime")
    }

    private fun seedEmbeddingSpace(
        flywayJdbc: JdbcTemplate,
        spaceId: UUID,
        dimensions: Int,
        metric: String,
    ) {
        flywayJdbc.update("INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES ('10000000-0000-0000-0000-000000000001', 'integration-ai', 'Integration AI', 'ACTIVE')")
        flywayJdbc.update("INSERT INTO catalog.package_version(id, package_id, semver, status) VALUES ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '1.0.0', 'DRAFT')")
        flywayJdbc.update("INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind) VALUES ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'model-provider', 'Model Provider', 'SYSTEM')")
        flywayJdbc.update("INSERT INTO catalog.entity_type_version(id, entity_type_id, package_version_id, schema_version, json_schema) VALUES ('10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 1, '{}')")
        flywayJdbc.update("INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state) VALUES ('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000004', 'integration-provider', 'ACTIVE')")
        flywayJdbc.update("INSERT INTO ai.model_provider(id, provider_type, base_url, secret_ref, state) VALUES ('10000000-0000-0000-0000-000000000005', 'LOCAL', 'http://127.0.0.1', 'test-only', 'ACTIVE')")
        flywayJdbc.update("INSERT INTO ai.model_profile(id, provider_id, model_key, purpose, timeout_ms, state) VALUES ('10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000005', 'integration-embedding', 'EMBEDDING', 1000, 'ACTIVE')")
        flywayJdbc.update(
            "INSERT INTO ai.embedding_space(id, model_profile_id, dimensions, distance_metric, corpus_version, status) VALUES (?, '10000000-0000-0000-0000-000000000006', ?, ?, 'integration-v1', 'BUILDING')",
            spaceId,
            dimensions,
            metric,
        )
    }

    @TestConfiguration(proxyBeanMethods = false)
    class AtomicityConfiguration {
        @Bean
        fun flowableAtomicityFixture(runtimeService: RuntimeService, jdbcTemplate: JdbcTemplate) =
            FlowableAtomicityFixture(runtimeService, jdbcTemplate)
    }

    open class FlowableAtomicityFixture(
        private val runtimeService: RuntimeService,
        private val jdbc: JdbcTemplate,
    ) {
        @Transactional
        open fun write(id: UUID, fail: Boolean) {
            runtimeService.startProcessInstanceByKey("atomicityProcess", id.toString())
            jdbc.update("INSERT INTO occ.flowable_atomicity_test(id, value) VALUES (?, 'committed')", id)
            jdbc.update(
                "INSERT INTO audit.audit_record(id, transaction_id, action_key, detail, correlation_id) VALUES (?, ?, 'flowable.atomicity', '{}'::jsonb, ?)",
                UUID.randomUUID(), UUID.randomUUID(), id,
            )
            jdbc.update(
                """INSERT INTO audit.outbox_event
                   (id, aggregate_type, aggregate_id, aggregate_version, event_type, schema_version, payload,
                    correlation_id, available_at, next_attempt_at)
                   VALUES (?, 'flowable-test', ?, 1, 'flowable.atomicity', 1, '{}'::jsonb, ?,
                           statement_timestamp(), statement_timestamp())""",
                UUID.randomUUID(), id, id,
            )
            if (fail) throw IllegalStateException("forced rollback")
        }
    }

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"

        @Container
        @JvmStatic
        val postgres: PostgreSQLContainer<*> = PostgreSQLContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("innorder_occ")
            .withUsername("innorder_admin")
            .withPassword("admin-test-only")
            .withCopyFileToContainer(MountableFile.forClasspathResource("postgres-test-init.sql"), "/docker-entrypoint-initdb.d/010-test-roles.sql")

        @DynamicPropertySource
        @JvmStatic
        fun databaseProperties(registry: DynamicPropertyRegistry) {
            registry.add("spring.datasource.url", postgres::getJdbcUrl)
            registry.add("spring.datasource.username") { "innorder_runtime" }
            registry.add("spring.datasource.password") { "runtime-test-only" }
            registry.add("spring.flyway.url", postgres::getJdbcUrl)
            registry.add("spring.flyway.user") { "innorder_flyway" }
            registry.add("spring.flyway.password") { "flyway-test-only" }
            registry.add("flowable.database-schema") { "flowable" }
            registry.add("flowable.database-schema-update") { "true" }
            registry.add("occ.status-probes.external-enabled") { "false" }
        }

        private const val ATOMICITY_PROCESS = """<?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="occ-test">
              <process id="atomicityProcess" isExecutable="true">
                <startEvent id="start"/><sequenceFlow id="toWait" sourceRef="start" targetRef="wait"/>
                <userTask id="wait"/><sequenceFlow id="toEnd" sourceRef="wait" targetRef="end"/><endEvent id="end"/>
              </process>
            </definitions>"""

        private fun databaseTestDirectory(): Path = listOf(
            Path.of("database", "tests"),
            Path.of("..", "..", "database", "tests"),
        ).firstOrNull(Files::isDirectory)
            ?: error("database/tests directory is unavailable")

        private fun databaseDirectory(): Path = listOf(
            Path.of("database"),
            Path.of("..", "..", "database"),
        ).firstOrNull(Files::isDirectory)
            ?: error("database directory is unavailable")
    }
}
