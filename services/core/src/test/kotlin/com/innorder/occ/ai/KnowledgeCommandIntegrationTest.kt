package com.innorder.occ.ai

import com.innorder.occ.authz.AuthorizationAvailabilityException
import com.innorder.occ.authz.AuthorizationDecision
import com.innorder.occ.authz.AuthorizationDecisionReference
import com.innorder.occ.authz.AuthorizationDecisionValue
import com.innorder.occ.authz.AuthorizationDeniedException
import com.innorder.occ.authz.AuthorizationEntity
import com.innorder.occ.authz.AuthorizationPrincipal
import com.innorder.occ.authz.AuthorizationRequest
import com.innorder.occ.authz.AuthorizationResource
import com.innorder.occ.authz.AuthorizationRevisionLockRepository
import com.innorder.occ.authz.AuthorizationService
import com.innorder.occ.authz.AuthorizationSnapshot
import com.innorder.occ.authz.AuthorizationSnapshotSource
import com.innorder.occ.authz.DecisionAuditLog
import com.innorder.occ.authz.DecisionLogEntry
import com.innorder.occ.authz.PolicyLayer
import com.innorder.occ.command.AuditRepository
import com.innorder.occ.command.CommandExecutor
import com.innorder.occ.command.CommandMetadata
import com.innorder.occ.command.IdempotencyRepository
import com.innorder.occ.command.OptimisticConflictException
import com.innorder.occ.events.OutboxRepository
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.postgresql.ds.PGSimpleDataSource
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import java.util.UUID
import java.util.concurrent.Executors

@Testcontainers(disabledWithoutDocker = true)
class KnowledgeCommandIntegrationTest {
    private lateinit var jdbc: JdbcTemplate
    private lateinit var decisions: Decisions
    private lateinit var service: KnowledgeCommandService

    @BeforeEach
    fun reset() {
        jdbc = JdbcTemplate(runtimeDataSource())
        JdbcTemplate(adminDataSource()).execute("TRUNCATE audit.audit_record")
        jdbc.update("DELETE FROM audit.outbox_event WHERE aggregate_id = ?", DOCUMENT_ID)
        jdbc.update("DELETE FROM audit.idempotency_record WHERE principal_id = ?", PRINCIPAL_ID)
        val admin = JdbcTemplate(adminDataSource())
        admin.execute("ALTER TABLE ai.knowledge_document DISABLE TRIGGER trg_knowledge_document_touch")
        try {
            admin.update("UPDATE ai.knowledge_document SET current_version = 1, state = 'READY', row_version = 7 WHERE id IN (?, ?)", DOCUMENT_ID, SECOND_DOCUMENT_ID)
        } finally {
            admin.execute("ALTER TABLE ai.knowledge_document ENABLE TRIGGER trg_knowledge_document_touch")
        }
        jdbc.update("UPDATE ai.embedding_space SET status = 'BUILDING', activated_at = NULL WHERE id = ?", CANDIDATE_SPACE_ID)
        jdbc.update("UPDATE ai.embedding_space SET status = 'ACTIVE' WHERE id = ?", ACTIVE_SPACE_ID)
        decisions = Decisions()
        val authorization = AuthorizationService(
            decisions,
            { snapshot ->
                if (decisions.error) throw IllegalStateException("OPA unavailable with internal detail")
                val outcome = decisions.outcome
                AuthorizationDecision(
                    1, "knowledge-v1", snapshot.requestId, 1, snapshot.releases, outcome,
                    outcome == AuthorizationDecisionValue.ALLOW,
                    listOf(if (outcome == AuthorizationDecisionValue.ALLOW) "ALLOW_KNOWLEDGE" else "DENY_KNOWLEDGE"),
                    listOf(POLICY_REFERENCE), if (outcome == AuthorizationDecisionValue.ALLOW) listOf(POLICY_REFERENCE) else emptyList(),
                )
            },
            object : DecisionAuditLog {
                override fun persistInCallerTransaction(entry: DecisionLogEntry) = Unit
                override fun persistIndependently(entry: DecisionLogEntry) = Unit
            },
        )
        val executor = CommandExecutor(
            DataSourceTransactionManager(jdbc.dataSource!!), authorization,
            AuthorizationRevisionLockRepository(jdbc), IdempotencyRepository(jdbc), AuditRepository(jdbc),
            OutboxRepository(jdbc), jdbc,
        )
        service = KnowledgeCommandService(executor)
    }

    @Test
    fun `activation and rollback are authorized idempotent audited commands with immutable trace`() {
        val activation = KnowledgeActivationRequest(DOCUMENT_ID, 2, CANDIDATE_SPACE_ID, GATE_ID, ACTIVE_SPACE_ID)
        val metadata = metadata("activate", 7)

        val first = service.activate(metadata, activation)
        val replay = service.activate(metadata, activation)

        assertThat(first.status).isEqualTo(200)
        assertThat(replay.replayed).isTrue()
        assertThat(decisions.calls).isEqualTo(1)
        assertState(2, 8, CANDIDATE_SPACE_ID, "ACTIVE", ACTIVE_SPACE_ID, "RETIRED")
        assertThat(jdbc.queryForObject("SELECT current_version FROM ai.knowledge_document WHERE id = ?", Int::class.java, SECOND_DOCUMENT_ID)).isEqualTo(2)
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.audit_record WHERE target_entity_id = ?", Long::class.java, DOCUMENT_ID)).isEqualTo(1)
        assertThat(jdbc.queryForObject("SELECT payload::text FROM audit.outbox_event WHERE aggregate_id = ?", String::class.java, DOCUMENT_ID))
            .contains("previousVersion", "candidateVersion", ACTIVE_SPACE_ID.toString(), CANDIDATE_SPACE_ID.toString())

        val rollback = service.rollback(metadata("rollback", 8), KnowledgeRollbackRequest(DOCUMENT_ID, GATE_ID))

        assertThat(rollback.status).isEqualTo(200)
        assertState(1, 9, ACTIVE_SPACE_ID, "ACTIVE", CANDIDATE_SPACE_ID, "RETIRED")
        assertThat(jdbc.queryForObject("SELECT current_version FROM ai.knowledge_document WHERE id = ?", Int::class.java, SECOND_DOCUMENT_ID)).isEqualTo(1)
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.audit_record WHERE target_entity_id = ?", Long::class.java, DOCUMENT_ID)).isEqualTo(2)
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.outbox_event WHERE aggregate_id = ?", Long::class.java, DOCUMENT_ID)).isEqualTo(2)
        assertThat(jdbc.queryForObject("SELECT count(*) FROM ai.knowledge_document_version WHERE document_id = ?", Long::class.java, DOCUMENT_ID)).isEqualTo(2)
    }

    @Test
    fun `OPA deny and error fail before locks or state changes`() {
        decisions.outcome = AuthorizationDecisionValue.DENY
        assertThatThrownBy { service.activate(metadata("deny", 7), KnowledgeActivationRequest(DOCUMENT_ID, 2, CANDIDATE_SPACE_ID, GATE_ID, ACTIVE_SPACE_ID)) }
            .isInstanceOf(AuthorizationDeniedException::class.java)
        decisions.outcome = AuthorizationDecisionValue.ALLOW
        decisions.error = true
        assertThatThrownBy { service.activate(metadata("error", 7), KnowledgeActivationRequest(DOCUMENT_ID, 2, CANDIDATE_SPACE_ID, GATE_ID, ACTIVE_SPACE_ID)) }
            .isInstanceOf(AuthorizationAvailabilityException::class.java)
        assertState(1, 7, ACTIVE_SPACE_ID, "ACTIVE", CANDIDATE_SPACE_ID, "BUILDING")
    }

    @Test
    fun `expected version and concurrent activation permit exactly one mutation`() {
        assertThatThrownBy { service.activate(metadata("stale", 6), KnowledgeActivationRequest(DOCUMENT_ID, 2, CANDIDATE_SPACE_ID, GATE_ID, ACTIVE_SPACE_ID)) }
            .isInstanceOf(OptimisticConflictException::class.java)

        val pool = Executors.newFixedThreadPool(2)
        val results = try {
            listOf("race-a", "race-b").map { key -> pool.submit(runCatchingTask {
                service.activate(metadata(key, 7), KnowledgeActivationRequest(DOCUMENT_ID, 2, CANDIDATE_SPACE_ID, GATE_ID, ACTIVE_SPACE_ID))
            }) }.map { it.get() }
        } finally { pool.shutdownNow() }
        assertThat(results.count { it.isSuccess }).isEqualTo(1)
        assertThat(results.count { it.isFailure }).isEqualTo(1)
        assertThat(jdbc.queryForObject("SELECT count(*) FROM audit.outbox_event WHERE aggregate_id = ?", Long::class.java, DOCUMENT_ID)).isEqualTo(1)
    }

    @Test
    fun `missing member changed head chunk drift and stale active space fail atomically`() {
        val admin = JdbcTemplate(adminDataSource())
        fun rejected() {
            assertThatThrownBy { service.activate(metadata("race-${UUID.randomUUID()}", 7), KnowledgeActivationRequest(DOCUMENT_ID, 2, CANDIDATE_SPACE_ID, GATE_ID, ACTIVE_SPACE_ID)) }
                .isInstanceOf(KnowledgeGateException::class.java)
            assertState(1, 7, ACTIVE_SPACE_ID, "ACTIVE", CANDIDATE_SPACE_ID, "BUILDING")
            assertThat(jdbc.queryForObject("SELECT current_version FROM ai.knowledge_document WHERE id = ?", Int::class.java, SECOND_DOCUMENT_ID)).isEqualTo(1)
        }

        admin.execute("ALTER TABLE ai.ingestion_job DISABLE TRIGGER trg_ingestion_job_lifecycle")
        try {
            admin.update("UPDATE ai.ingestion_job SET status = 'FAILED', sanitized_error = 'corrupt fixture' WHERE id = ?", SECOND_JOB_ID)
            rejected()
            admin.update("UPDATE ai.ingestion_job SET status = 'COMPLETED', sanitized_error = NULL WHERE id = ?", SECOND_JOB_ID)
        } finally {
            admin.update("UPDATE ai.ingestion_job SET status = 'COMPLETED', sanitized_error = NULL WHERE id = ?", SECOND_JOB_ID)
            admin.execute("ALTER TABLE ai.ingestion_job ENABLE TRIGGER trg_ingestion_job_lifecycle")
        }

        admin.update("UPDATE ai.knowledge_document SET current_version = 2 WHERE id = ?", SECOND_DOCUMENT_ID)
        try {
            assertThatThrownBy { service.activate(metadata("head-race", 7), KnowledgeActivationRequest(DOCUMENT_ID, 2, CANDIDATE_SPACE_ID, GATE_ID, ACTIVE_SPACE_ID)) }
                .isInstanceOf(KnowledgeGateException::class.java)
            assertState(1, 7, ACTIVE_SPACE_ID, "ACTIVE", CANDIDATE_SPACE_ID, "BUILDING")
            assertThat(jdbc.queryForObject("SELECT current_version FROM ai.knowledge_document WHERE id = ?", Int::class.java, SECOND_DOCUMENT_ID)).isEqualTo(2)
        } finally {
            admin.execute("ALTER TABLE ai.knowledge_document DISABLE TRIGGER trg_knowledge_document_touch")
            try { admin.update("UPDATE ai.knowledge_document SET current_version = 1, row_version = 7 WHERE id = ?", SECOND_DOCUMENT_ID) }
            finally { admin.execute("ALTER TABLE ai.knowledge_document ENABLE TRIGGER trg_knowledge_document_touch") }
        }

        admin.update("UPDATE ai.knowledge_chunk SET content_hash = ? WHERE id = ?", "e".repeat(64), FIRST_CHUNK_ID)
        try { rejected() } finally { admin.update("UPDATE ai.knowledge_chunk SET content_hash = ? WHERE id = ?", "8".repeat(64), FIRST_CHUNK_ID) }

        admin.update("UPDATE ai.embedding_space SET status = 'RETIRED' WHERE id = ?", ACTIVE_SPACE_ID)
        try {
            assertThatThrownBy { service.activate(metadata("stale-active", 7), KnowledgeActivationRequest(DOCUMENT_ID, 2, CANDIDATE_SPACE_ID, GATE_ID, ACTIVE_SPACE_ID)) }
                .isInstanceOf(KnowledgeGateException::class.java)
            assertThat(jdbc.queryForObject("SELECT current_version FROM ai.knowledge_document WHERE id = ?", Int::class.java, DOCUMENT_ID)).isEqualTo(1)
        } finally { admin.update("UPDATE ai.embedding_space SET status = 'ACTIVE' WHERE id = ?", ACTIVE_SPACE_ID) }
    }

    @Test
    fun `rollback rejects previous corpus drift without partial transition`() {
        val admin = JdbcTemplate(adminDataSource())
        service.activate(metadata("activate-drift", 7), KnowledgeActivationRequest(DOCUMENT_ID, 2, CANDIDATE_SPACE_ID, GATE_ID, ACTIVE_SPACE_ID))
        admin.update("UPDATE ai.knowledge_chunk SET content_hash = ? WHERE id = ?", "f".repeat(64), FIRST_OLD_CHUNK_ID)
        try {
            assertThatThrownBy { service.rollback(metadata("rollback-drift", 8), KnowledgeRollbackRequest(DOCUMENT_ID, GATE_ID)) }
                .isInstanceOf(KnowledgeGateException::class.java)
            assertState(2, 8, CANDIDATE_SPACE_ID, "ACTIVE", ACTIVE_SPACE_ID, "RETIRED")
            assertThat(jdbc.queryForObject("SELECT current_version FROM ai.knowledge_document WHERE id = ?", Int::class.java, SECOND_DOCUMENT_ID)).isEqualTo(2)
        } finally { admin.update("UPDATE ai.knowledge_chunk SET content_hash = ? WHERE id = ?", "0".repeat(64), FIRST_OLD_CHUNK_ID) }
    }

    private fun <T> runCatchingTask(action: () -> T) = java.util.concurrent.Callable { runCatching(action) }

    private fun assertState(documentVersion: Int, rowVersion: Long, activeId: UUID, activeStatus: String, otherId: UUID, otherStatus: String) {
        assertThat(jdbc.queryForObject("SELECT current_version FROM ai.knowledge_document WHERE id = ?", Int::class.java, DOCUMENT_ID)).isEqualTo(documentVersion)
        assertThat(jdbc.queryForObject("SELECT row_version FROM ai.knowledge_document WHERE id = ?", Long::class.java, DOCUMENT_ID)).isEqualTo(rowVersion)
        assertThat(jdbc.queryForObject("SELECT status FROM ai.embedding_space WHERE id = ?", String::class.java, activeId)).isEqualTo(activeStatus)
        assertThat(jdbc.queryForObject("SELECT status FROM ai.embedding_space WHERE id = ?", String::class.java, otherId)).isEqualTo(otherStatus)
    }

    private fun metadata(key: String, version: Long) = CommandMetadata(PRINCIPAL_ID, "knowledge.$key", key, version, UUID.randomUUID())

    private class Decisions : AuthorizationSnapshotSource {
        var outcome = AuthorizationDecisionValue.ALLOW
        var error = false
        var calls = 0
        override fun load(request: AuthorizationRequest): AuthorizationSnapshot {
            calls += 1
            return AuthorizationSnapshot(
                1, request.requestId, 1, mapOf(PolicyLayer.PLATFORM to RELEASE_ID),
                AuthorizationPrincipal(request.principalId, true), AuthorizationEntity(request.entityId), request.action,
                AuthorizationResource(request.resourceId, true), request.context, emptyList(), emptyList(), RELEASE_ID,
                "knowledge-v1", mapOf(request.entityId to 7), "a".repeat(64),
            )
        }
    }

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        private const val POLICY_REFERENCE = "policy:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        private val PRINCIPAL_ID = UUID.fromString("82000000-0000-7000-8000-000000000001")
        private val DOCUMENT_ID = UUID.fromString("82000000-0000-7000-8000-000000000002")
        private val SECOND_DOCUMENT_ID = UUID.fromString("82000000-0000-7000-8000-000000000014")
        private val SOURCE_ID = UUID.fromString("82000000-0000-7000-8000-000000000003")
        private val PROVIDER_ID = UUID.fromString("82000000-0000-7000-8000-000000000004")
        private val PROFILE_ID = UUID.fromString("82000000-0000-7000-8000-000000000005")
        private val ACTIVE_SPACE_ID = UUID.fromString("82000000-0000-7000-8000-000000000006")
        private val CANDIDATE_SPACE_ID = UUID.fromString("82000000-0000-7000-8000-000000000007")
        private val DATASET_ID = UUID.fromString("82000000-0000-7000-8000-000000000008")
        private val DATASET_VERSION_ID = UUID.fromString("82000000-0000-7000-8000-000000000009")
        private val GATE_ID = UUID.fromString("82000000-0000-7000-8000-000000000010")
        private val OLD_VERSION_ID = UUID.fromString("82000000-0000-7000-8000-000000000011")
        private val NEW_VERSION_ID = UUID.fromString("82000000-0000-7000-8000-000000000012")
        private val RELEASE_ID = UUID.fromString("82000000-0000-7000-8000-000000000013")
        private val SECOND_OLD_VERSION_ID = UUID.fromString("82000000-0000-7000-8000-000000000015")
        private val SECOND_NEW_VERSION_ID = UUID.fromString("82000000-0000-7000-8000-000000000016")
        private val FIRST_CHUNK_ID = UUID.fromString("82000000-0000-7000-8000-000000000017")
        private val SECOND_CHUNK_ID = UUID.fromString("82000000-0000-7000-8000-000000000018")
        private val FIRST_OLD_CHUNK_ID = UUID.fromString("82000000-0000-7000-8000-000000000021")
        private val SECOND_OLD_CHUNK_ID = UUID.fromString("82000000-0000-7000-8000-000000000022")
        private val FIRST_JOB_ID = UUID.fromString("82000000-0000-7000-8000-000000000019")
        private val SECOND_JOB_ID = UUID.fromString("82000000-0000-7000-8000-000000000020")
        private val OLD_HASH = "1".repeat(64)
        private val NEW_HASH = "2".repeat(64)
        private val MANIFEST = "3".repeat(64)

        @Container @JvmStatic
        val postgres: PostgreSQLContainer<*> = PostgreSQLContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("innorder_occ").withUsername("innorder_admin").withPassword("admin-test-only")
            .withCopyFileToContainer(MountableFile.forClasspathResource("postgres-test-init.sql"), "/docker-entrypoint-initdb.d/010-test-roles.sql")

        @BeforeAll @JvmStatic
        fun initializeDatabase() {
            Flyway.configure().dataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only").locations("classpath:db/migration").load().migrate()
            val db = JdbcTemplate(adminDataSource())
            val packageId = UUID.randomUUID(); val packageVersionId = UUID.randomUUID(); val typeId = UUID.randomUUID(); val typeVersionId = UUID.randomUUID()
            db.update("INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, ?, 'Knowledge test', 'ACTIVE')", packageId, "knowledge-${UUID.randomUUID()}")
            db.update("INSERT INTO catalog.package_version(id, package_id, semver, status) VALUES (?, ?, '1.0.0', 'DRAFT')", packageVersionId, packageId)
            db.update("INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind, authorizable) VALUES (?, ?, 'knowledge.test', 'Knowledge Test', 'PRINCIPAL', true)", typeId, packageId)
            db.update("INSERT INTO catalog.entity_type_version(id, entity_type_id, package_version_id, schema_version, json_schema) VALUES (?, ?, ?, 1, '{}'::jsonb)", typeVersionId, typeId, packageVersionId)
            listOf(PRINCIPAL_ID, DOCUMENT_ID, SOURCE_ID, PROVIDER_ID, SECOND_DOCUMENT_ID).forEachIndexed { index, id -> db.update("INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state) VALUES (?, ?, ?, ?, 'ACTIVE')", id, typeId, typeVersionId, "knowledge:$index") }
            db.update("INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, 'USER', 'Knowledge User', 'ACTIVE')", PRINCIPAL_ID)
            db.update("INSERT INTO ai.knowledge_source(id, source_type, state) VALUES (?, 'UPLOAD', 'ACTIVE')", SOURCE_ID)
            db.update("INSERT INTO ai.knowledge_document(id, source_id, document_key, state, row_version) VALUES (?, ?, 'document', 'READY', 7), (?, ?, 'document-2', 'READY', 7)", DOCUMENT_ID, SOURCE_ID, SECOND_DOCUMENT_ID, SOURCE_ID)
            db.update("""INSERT INTO ai.knowledge_document_version(id, document_id, version, object_key, content_hash, mime_type, parser_version, data_classification)
                VALUES (?, ?, 1, 'q/old', ?, 'text/plain', 'v1', 'INTERNAL'), (?, ?, 2, 'q/new', ?, 'text/plain', 'v1', 'INTERNAL'),
                       (?, ?, 1, 'q/old-2', ?, 'text/plain', 'v1', 'INTERNAL'), (?, ?, 2, 'q/new-2', ?, 'text/plain', 'v1', 'INTERNAL')""",
                OLD_VERSION_ID, DOCUMENT_ID, OLD_HASH, NEW_VERSION_ID, DOCUMENT_ID, NEW_HASH,
                SECOND_OLD_VERSION_ID, SECOND_DOCUMENT_ID, "6".repeat(64), SECOND_NEW_VERSION_ID, SECOND_DOCUMENT_ID, "7".repeat(64))
            db.update("UPDATE ai.knowledge_document SET current_version = 1 WHERE id IN (?, ?)", DOCUMENT_ID, SECOND_DOCUMENT_ID)
            db.update("""INSERT INTO ai.knowledge_chunk(id, document_version_id, ordinal, content, content_hash, token_count, metadata)
                VALUES (?, ?, 0, 'first candidate', ?, 2, '{}'::jsonb), (?, ?, 0, 'second candidate', ?, 2, '{}'::jsonb),
                       (?, ?, 0, 'first previous', ?, 2, '{}'::jsonb), (?, ?, 0, 'second previous', ?, 2, '{}'::jsonb)""",
                FIRST_CHUNK_ID, NEW_VERSION_ID, "8".repeat(64), SECOND_CHUNK_ID, SECOND_NEW_VERSION_ID, "9".repeat(64),
                FIRST_OLD_CHUNK_ID, OLD_VERSION_ID, "0".repeat(64), SECOND_OLD_CHUNK_ID, SECOND_OLD_VERSION_ID, "1".repeat(64))
            db.update("INSERT INTO ai.model_provider(id, provider_type, base_url, secret_ref, state) VALUES (?, 'OPENAI', 'https://provider.invalid', 'secret', 'ACTIVE')", PROVIDER_ID)
            db.update("INSERT INTO ai.model_profile(id, provider_id, model_key, purpose, timeout_ms, state) VALUES (?, ?, 'embed', 'EMBEDDING', 1000, 'ACTIVE')", PROFILE_ID, PROVIDER_ID)
            db.update("INSERT INTO ai.embedding_space(id, model_profile_id, dimensions, distance_metric, corpus_version, status, coverage, activated_at) VALUES (?, ?, 2, 'COSINE', 'old', 'ACTIVE', 1, now()), (?, ?, 2, 'COSINE', ?, 'BUILDING', 1, NULL)", ACTIVE_SPACE_ID, PROFILE_ID, CANDIDATE_SPACE_ID, PROFILE_ID, MANIFEST)
            db.queryForList("SELECT ai.create_embedding_partition(?, 2, 'COSINE')", CANDIDATE_SPACE_ID)
            db.update("INSERT INTO ai.chunk_embedding(embedding_space_id, chunk_id, embedding) VALUES (?, ?, '[1,0]'::public.vector), (?, ?, '[0,1]'::public.vector)", CANDIDATE_SPACE_ID, FIRST_CHUNK_ID, CANDIDATE_SPACE_ID, SECOND_CHUNK_ID)
            db.update("""INSERT INTO ai.ingestion_job(id, source_id, document_id, produced_document_version_id, source_version, source_object_hash, normalized_content_hash, parser_version, chunker_version, candidate_embedding_space_id, corpus_manifest_digest, checkpoint, stage, status, attempts, completed_at)
                VALUES (?, ?, ?, ?, 'v2-a', ?, ?, 'v1', 'v2', ?, ?, '{}'::jsonb, 'COMPLETE', 'COMPLETED', 1, now()),
                       (?, ?, ?, ?, 'v2-b', ?, ?, 'v1', 'v2', ?, ?, '{}'::jsonb, 'COMPLETE', 'COMPLETED', 1, now())""",
                FIRST_JOB_ID, SOURCE_ID, DOCUMENT_ID, NEW_VERSION_ID, "a".repeat(64), NEW_HASH, CANDIDATE_SPACE_ID, MANIFEST,
                SECOND_JOB_ID, SOURCE_ID, SECOND_DOCUMENT_ID, SECOND_NEW_VERSION_ID, "b".repeat(64), "7".repeat(64), CANDIDATE_SPACE_ID, MANIFEST)
            db.update("INSERT INTO ai.evaluation_dataset(id, dataset_key, name) VALUES (?, 'knowledge-gate', 'Knowledge gate')", DATASET_ID)
            db.update("INSERT INTO ai.evaluation_dataset_version(id, dataset_id, version, content_hash, status) VALUES (?, ?, 1, ?, 'DRAFT')", DATASET_VERSION_ID, DATASET_ID, "4d".repeat(32))
            repeat(20) { index -> db.update("INSERT INTO ai.evaluation_case(id, dataset_version_id, case_key, input, expected_properties) VALUES (?, ?, ?, '{\"query\":true}'::jsonb, '{\"outcome\":\"ANSWER\"}'::jsonb)", UUID.fromString("82000000-0000-7000-8001-${(index + 1).toString().padStart(12, '0')}"), DATASET_VERSION_ID, "case-$index") }
            db.update("UPDATE ai.evaluation_dataset_version SET status = 'PUBLISHED' WHERE id = ?", DATASET_VERSION_ID)
            db.queryForObject("SELECT ai.begin_embedding_space_gate(?, ?, ?, ?, ?, ?)", UUID::class.java, GATE_ID, DATASET_VERSION_ID, CANDIDATE_SPACE_ID, MANIFEST, ACTIVE_SPACE_ID, "5e".repeat(32))
            repeat(20) { index -> db.queryForObject("SELECT ai.record_embedding_gate_case(?, ?, 1, 1, 1, 1, 0, ?, ?, 'MATCH', ?)", UUID::class.java, GATE_ID, UUID.fromString("82000000-0000-7000-8001-${(index + 1).toString().padStart(12, '0')}"), "c".repeat(64), "c".repeat(64), "d".repeat(64)) }
            check(db.queryForObject("SELECT ai.finalize_embedding_space_gate(?)", String::class.java, GATE_ID) == "PASS")
        }

        private fun runtimeDataSource() = PGSimpleDataSource().apply { setURL(postgres.jdbcUrl); user = "innorder_runtime"; password = "runtime-test-only" }
        private fun adminDataSource() = PGSimpleDataSource().apply { setURL(postgres.jdbcUrl); user = postgres.username; password = postgres.password }
    }
}
