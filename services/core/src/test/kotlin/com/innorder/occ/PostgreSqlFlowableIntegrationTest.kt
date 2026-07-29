package com.innorder.occ

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.flowable.engine.RepositoryService
import org.flowable.engine.RuntimeService
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import java.util.UUID

@SpringBootTest
@Testcontainers(disabledWithoutDocker = true)
class PostgreSqlFlowableIntegrationTest(
    @param:Autowired private val jdbcTemplate: JdbcTemplate,
    @param:Autowired private val repositoryService: RepositoryService,
    @param:Autowired private val runtimeService: RuntimeService,
) {
    @Test
    fun `migrations runtime privileges Flowable and pgvector match production boundaries`() {
        val flywayJdbc = JdbcTemplate(DriverManagerDataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only"))
        assertThat(jdbcTemplate.queryForObject("SELECT current_user", String::class.java)).isEqualTo("innorder_runtime")
        assertThat(flywayJdbc.queryForList("SELECT DISTINCT installed_by FROM flyway_schema_history", String::class.java))
            .containsExactly("innorder_flyway")
        assertThat(flywayJdbc.queryForList("SELECT version::integer FROM flyway_schema_history WHERE success ORDER BY installed_rank", Int::class.java))
            .containsExactly(1, 2, 3, 4, 5, 6, 7, 8, 9)

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
        )).isEqualTo("vector(7)")
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
        }
    }
}
