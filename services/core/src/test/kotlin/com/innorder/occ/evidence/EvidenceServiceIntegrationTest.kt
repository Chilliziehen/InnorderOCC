package com.innorder.occ.evidence

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.api.CursorCodec
import com.innorder.occ.authz.*
import com.innorder.occ.command.*
import com.innorder.occ.events.OutboxRepository
import io.minio.BucketExistsArgs
import io.minio.MakeBucketArgs
import io.minio.MinioClient
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.testcontainers.containers.GenericContainer
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.containers.wait.strategy.Wait
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID

@Testcontainers
class EvidenceServiceIntegrationTest {
    private lateinit var fixture: Fixture
    private lateinit var service: EvidenceService
    private lateinit var repository: EvidenceRepository
    private lateinit var transactionManager: DataSourceTransactionManager
    private lateinit var authorization: TestAuthorizationSnapshots

    @BeforeEach
    fun setUp() {
        fixture = seed()
        authorization = TestAuthorizationSnapshots()
        service = newService()
    }

    private fun newService(
        scanner: ScannerSandbox = ScannerSandbox { request -> ScanResult(ScanStatus.CLEAN, "deterministic", "1.0", request.sha256) },
        workflow: EvidenceWorkflowPort = EvidenceWorkflowIntentPort(runtimeJdbc),
        clock: Clock = Clock.fixed(NOW, ZoneOffset.UTC),
    ): EvidenceService {
        val authorizationService = AuthorizationService(
            authorization,
            OpaClient(MAPPER, OpaProperties("http://${opa.host}:${opa.getMappedPort(8181)}")),
            NoOpDecisionLog,
        )
        if (!this::transactionManager.isInitialized) transactionManager = DataSourceTransactionManager(runtimeDataSource)
        if (!this::repository.isInitialized) repository = EvidenceRepository(runtimeJdbc)
        val executor = CommandExecutor(
            transactionManager, authorizationService, AuthorizationRevisionLockRepository(runtimeJdbc),
            IdempotencyRepository(runtimeJdbc), AuditRepository(runtimeJdbc), OutboxRepository(runtimeJdbc), runtimeJdbc,
        )
        return EvidenceService(
            repository, executor, authorizationService,
            CursorCodec(CURSOR_SECRET, clock), objectStore,
            EvidenceContentInspector(
                scanner,
                ParserSandbox { ParserSandboxResult.Accepted("application/pdf") },
                clock,
            ),
            workflow, EvidenceDomainNotificationPort(runtimeJdbc),
            EvidencePreviewService(), transactionManager, clock,
        )
    }

    @Test
    fun `catalog validation schema is the strict source of upload policy`() {
        val policy = EvidenceRequirementPolicy.parse(
            MAPPER.readTree(
                """{
                  "allowedExtensions":["txt","pdf"],
                  "allowedMediaTypes":["text/plain","application/pdf"],
                  "maximumBytes":4096,
                  "archive":{"maximumEntries":8,"maximumExpandedBytes":32768,"maximumCompressionRatio":10.0},
                  "conditionalHardGate":true
                }""".trimIndent(),
            ),
            catalogMaximumBytes = 8192,
        )

        assertThat(policy.content.maximumBytes).isEqualTo(4096)
        assertThat(policy.content.allowedExtensions).containsExactlyInAnyOrder("txt", "pdf")
        assertThat(policy.conditionalHardGate).isTrue()
    }

    @Test
    fun `catalog policy rejects defaults unknown fields and conflicting limits`() {
        assertThatThrownBy {
            EvidenceRequirementPolicy.parse(MAPPER.readTree("{}"), 8192)
        }.isInstanceOf(InvalidEvidenceRequirementException::class.java)
        assertThatThrownBy {
            EvidenceRequirementPolicy.parse(
                MAPPER.readTree(
                    """{
                      "allowedExtensions":["txt"],"allowedMediaTypes":["text/plain"],
                      "maximumBytes":8193,
                      "archive":{"maximumEntries":8,"maximumExpandedBytes":32768,"maximumCompressionRatio":10.0},
                      "conditionalHardGate":false,"unexpected":true
                    }""".trimIndent(),
                ),
                8192,
            )
        }.isInstanceOf(InvalidEvidenceRequirementException::class.java)
    }

    @Test
    fun `participant v1 rejection v2 acceptance and second slot satisfy immutable minimum count gate`() {
        val firstBytes = "first version".toByteArray()
        val firstSession = service.createSession(
            metadata(fixture.participant, "session-v1", null),
            sessionRequest(fixture.target, fixture.requirement, "primary", "first.txt", firstBytes),
        )
        val firstVersion = service.upload(
            metadata(fixture.participant, "upload-v1", 0), firstSession.body.id, ByteArrayInputStream(firstBytes),
        )
        val submittedV1 = service.submit(
            metadata(fixture.participant, "submit-v1", firstVersion.body.evidenceRowVersion), firstVersion.body.evidenceId,
        )
        val rejected = service.review(
            metadata(fixture.reviewer, "review-v1", submittedV1.body.rowVersion),
            firstVersion.body.evidenceId,
            EvidenceReviewRequest(EvidenceReviewOutcome.REJECTED, "needs correction", emptyMap(), null, fixture.participant),
        )
        assertThat(rejected.body.gateSatisfied).isFalse()

        val secondBytes = "corrected version".toByteArray()
        val secondSession = service.createSession(
            metadata(fixture.participant, "session-v2", rejected.body.evidenceRowVersion),
            sessionRequest(fixture.target, fixture.requirement, "primary", "corrected.txt", secondBytes),
        )
        val secondVersion = service.upload(
            metadata(fixture.participant, "upload-v2", rejected.body.evidenceRowVersion),
            secondSession.body.id,
            ByteArrayInputStream(secondBytes),
        )
        val submittedV2 = service.submit(
            metadata(fixture.participant, "submit-v2", secondVersion.body.evidenceRowVersion), secondVersion.body.evidenceId,
        )
        val acceptedFirstSlot = service.review(
            metadata(fixture.reviewer, "review-v2", submittedV2.body.rowVersion),
            secondVersion.body.evidenceId,
            EvidenceReviewRequest(EvidenceReviewOutcome.ACCEPTED, "verified", emptyMap(), null, fixture.participant),
        )
        assertThat(acceptedFirstSlot.body.gateSatisfied).isFalse()

        val otherBytes = "second slot".toByteArray()
        val otherSession = service.createSession(
            metadata(fixture.participant, "session-other", null),
            sessionRequest(fixture.target, fixture.requirement, "secondary", "second.txt", otherBytes),
        )
        val otherVersion = service.upload(
            metadata(fixture.participant, "upload-other", 0), otherSession.body.id, ByteArrayInputStream(otherBytes),
        )
        val submittedOther = service.submit(
            metadata(fixture.participant, "submit-other", otherVersion.body.evidenceRowVersion), otherVersion.body.evidenceId,
        )
        val accepted = service.review(
            metadata(fixture.reviewer, "review-other", submittedOther.body.rowVersion),
            otherVersion.body.evidenceId,
            EvidenceReviewRequest(EvidenceReviewOutcome.ACCEPTED, "verified", emptyMap(), null, fixture.participant),
        )

        assertThat(accepted.body.gateSatisfied).isTrue()
        assertThat(service.history(fixture.participant, UUID.randomUUID(), firstVersion.body.evidenceId, 20).items)
            .extracting<Int> { it.version }.containsExactly(1, 2)
        assertThat(runtimeJdbc.queryForObject(
            """SELECT count(*) FROM occ.evidence_review review JOIN occ.evidence_version version ON version.id=review.evidence_version_id
               JOIN occ.evidence evidence ON evidence.id=version.evidence_id WHERE evidence.target_entity_id=?""",
            Long::class.java, fixture.target,
        )).isEqualTo(3)
        assertThat(runtimeJdbc.queryForObject(
            "SELECT count(*) FROM occ.evidence_workflow_intent intent JOIN occ.evidence evidence ON evidence.id=intent.evidence_id WHERE evidence.target_entity_id=?",
            Long::class.java, fixture.target,
        )).isEqualTo(9)
        assertThat(runtimeJdbc.queryForObject(
            "SELECT count(*) FROM occ.evidence_notification_intent intent JOIN occ.evidence evidence ON evidence.id=intent.evidence_id WHERE evidence.target_entity_id=?",
            Long::class.java, fixture.target,
        )).isEqualTo(12)
        assertThat(service.download(fixture.participant, UUID.randomUUID(), secondVersion.body.evidenceId, 2).use {
            it.read.stream.readAllBytes().toString(Charsets.UTF_8)
        }).isEqualTo("corrected version")
    }

    @Test
    fun `session creation is an exact kernel replay and orphan cleanup observes grace`() {
        val bytes = "orphan".toByteArray()
        val command = metadata(fixture.participant, "session-replay", null)
        val request = sessionRequest(fixture.target, fixture.requirement, "orphan", "orphan.txt", bytes)
        val first = service.createSession(command, request)
        val replay = service.createSession(command, request)
        assertThat(replay).isEqualTo(first.copy(replayed = true))

        val record = repository.session(first.body.id)
        objectsPut(record.quarantineKey, bytes)
        org.springframework.transaction.support.TransactionTemplate(transactionManager).executeWithoutResult {
            repository.fail(record.id, "DISCONNECTED", NOW.plusSeconds(300), true)
        }
        val cleanup = EvidenceCleanupJob(repository, objectStore, transactionManager, Clock.fixed(NOW.plusSeconds(301), ZoneOffset.UTC))
        assertThat(cleanup.runBatch(UUID.randomUUID(), 100)).isPositive()
        assertThatThrownBy { objectStore.stat(record.quarantineKey) }.isInstanceOf(ObjectNotFoundException::class.java)
    }

    @Test
    fun `stale submit segregation and authorization denial fail without mutable history`() {
        val bytes = "review me".toByteArray()
        val session = service.createSession(
            metadata(fixture.participant, "guard-session", null),
            sessionRequest(fixture.target, fixture.requirement, "guard", "guard.txt", bytes),
        )
        val version = service.upload(metadata(fixture.participant, "guard-upload", 0), session.body.id, ByteArrayInputStream(bytes))
        assertThatThrownBy {
            service.submit(metadata(fixture.participant, "stale-submit", 0), version.body.evidenceId)
        }.isInstanceOf(OptimisticConflictException::class.java)
        val submitMetadata = metadata(fixture.participant, "guard-submit", version.body.evidenceRowVersion)
        val submitted = service.submit(submitMetadata, version.body.evidenceId)
        assertThat(service.submit(submitMetadata, version.body.evidenceId)).isEqualTo(submitted.copy(replayed = true))
        assertThatThrownBy {
            service.review(
                metadata(fixture.participant, "self-review", submitted.body.rowVersion), version.body.evidenceId,
                EvidenceReviewRequest(EvidenceReviewOutcome.REJECTED, "self review", emptyMap(), null, fixture.participant),
            )
        }.isInstanceOf(EvidenceReviewSegregationException::class.java)
        assertThat(runtimeJdbc.queryForObject(
            "SELECT count(*) FROM occ.evidence_review er JOIN occ.evidence_version ev ON ev.id=er.evidence_version_id WHERE ev.evidence_id=?",
            Long::class.java, version.body.evidenceId,
        )).isZero()
        authorization.denied += version.body.evidenceId
        assertThatThrownBy { service.metadata(fixture.participant, UUID.randomUUID(), version.body.evidenceId) }
            .isInstanceOf(AuthorizationDeniedException::class.java)
    }

    @Test
    fun `conditional hard gate persists followup and workflow failure rolls review back`() {
        val bytes = "conditional".toByteArray()
        val session = service.createSession(
            metadata(fixture.participant, "conditional-session", null),
            sessionRequest(fixture.target, fixture.requirement, "conditional", "conditional.txt", bytes),
        )
        val version = service.upload(metadata(fixture.participant, "conditional-upload", 0), session.body.id, ByteArrayInputStream(bytes))
        val submitted = service.submit(
            metadata(fixture.participant, "conditional-submit", version.body.evidenceRowVersion), version.body.evidenceId,
        )
        val delegate = EvidenceWorkflowIntentPort(runtimeJdbc)
        service = newService(workflow = EvidenceWorkflowPort { intent ->
            if (intent.type == "REVIEWED") throw IllegalStateException("workflow unavailable")
            delegate.persist(intent)
        })
        assertThatThrownBy {
            service.review(
                metadata(fixture.reviewer, "workflow-rollback", submitted.body.rowVersion), version.body.evidenceId,
                EvidenceReviewRequest(
                    EvidenceReviewOutcome.CONDITIONAL, "follow up", mapOf("field" to "value"),
                    NOW.plus(Duration.ofDays(1)), fixture.participant,
                ),
            )
        }.isInstanceOf(IllegalStateException::class.java)
        assertThat(repository.getHead(version.body.evidenceId).state).isEqualTo(EvidenceState.SUBMITTED)
        assertThat(runtimeJdbc.queryForObject(
            "SELECT count(*) FROM occ.evidence_review er JOIN occ.evidence_version ev ON ev.id=er.evidence_version_id WHERE ev.evidence_id=?",
            Long::class.java, version.body.evidenceId,
        )).isZero()

        service = newService()
        val conditional = service.review(
            metadata(fixture.reviewer, "conditional-review", submitted.body.rowVersion), version.body.evidenceId,
            EvidenceReviewRequest(
                EvidenceReviewOutcome.CONDITIONAL, "follow up", emptyMap(), NOW.plus(Duration.ofDays(1)), fixture.participant,
            ),
        )
        assertThat(conditional.body.followUpRequired).isTrue()
        assertThat(conditional.body.gateSatisfied).isFalse()
        assertThat(repository.getHead(version.body.evidenceId).state).isEqualTo(EvidenceState.REJECTED)
    }

    @Test
    fun `scanner error creates no downloadable object and cleanup removes quarantine`() {
        service = newService(scanner = ScannerSandbox { request ->
            ScanResult(ScanStatus.ERROR, "deterministic", "1.0", request.sha256)
        })
        val bytes = "scanner failure".toByteArray()
        val session = service.createSession(
            metadata(fixture.participant, "scanner-session", null),
            sessionRequest(fixture.target, fixture.requirement, "scanner", "scanner.txt", bytes),
        )
        assertThatThrownBy {
            service.upload(metadata(fixture.participant, "scanner-upload", 0), session.body.id, ByteArrayInputStream(bytes))
        }.isInstanceOf(EvidenceRejectedException::class.java)
        val failed = repository.session(session.body.id)
        assertThat(failed.status).isEqualTo(UploadSessionStatus.FAILED)
        assertThatThrownBy { service.download(fixture.participant, UUID.randomUUID(), failed.evidenceId, 1) }
            .isInstanceOf(EvidenceNotFoundException::class.java)
        val cleanup = EvidenceCleanupJob(repository, objectStore, transactionManager, Clock.fixed(NOW.plusSeconds(301), ZoneOffset.UTC))
        assertThat(cleanup.runBatch(UUID.randomUUID(), 100)).isPositive()
        assertThatThrownBy { objectStore.stat(failed.quarantineKey) }.isInstanceOf(ObjectNotFoundException::class.java)
    }

    @Test
    fun `session expires at thirty minutes and a disconnected streaming lease can be reclaimed`() {
        val bytes = "lease".toByteArray()
        val expiredSession = service.createSession(
            metadata(fixture.participant, "expiry-session", null),
            sessionRequest(fixture.target, fixture.requirement, "expiry", "expiry.txt", bytes),
        )
        val transactions = org.springframework.transaction.support.TransactionTemplate(transactionManager)
        val expired = transactions.execute {
            repository.acquireLease(
                expiredSession.body.id, UUID.randomUUID(), expiredSession.body.expiresAt,
                expiredSession.body.expiresAt.plusSeconds(60),
            )
        }!!
        assertThat(expired.status).isEqualTo(UploadSessionStatus.EXPIRED)

        val reclaimSession = service.createSession(
            metadata(fixture.participant, "reclaim-session", null),
            sessionRequest(fixture.target, fixture.requirement, "reclaim", "reclaim.txt", bytes),
        )
        val firstOwner = UUID.randomUUID()
        transactions.execute {
            repository.acquireLease(reclaimSession.body.id, firstOwner, NOW, NOW.plusSeconds(60))
        }
        val secondOwner = UUID.randomUUID()
        val reclaimed = transactions.execute {
            repository.acquireLease(reclaimSession.body.id, secondOwner, NOW.plusSeconds(61), NOW.plusSeconds(121))
        }!!
        assertThat(reclaimed.status).isEqualTo(UploadSessionStatus.STREAMING)
        assertThat(reclaimed.leaseOwner).isEqualTo(secondOwner)
    }

    @Test
    fun `client disconnect leaves streaming lease reclaimable and retry confirms once`() {
        val bytes = "disconnect-retry".toByteArray()
        val session = service.createSession(
            metadata(fixture.participant, "disconnect-session", null),
            sessionRequest(fixture.target, fixture.requirement, "disconnect", "disconnect.txt", bytes),
        )
        val disconnected = object : InputStream() {
            var emitted = false
            override fun read(): Int = throw IOException("disconnected")
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (emitted) throw IOException("disconnected")
                emitted = true
                buffer[offset] = bytes[0]
                return 1
            }
        }
        assertThatThrownBy {
            service.upload(metadata(fixture.participant, "disconnect-upload", 0), session.body.id, disconnected)
        }.isInstanceOf(EvidenceUploadConflictException::class.java)
        assertThat(repository.session(session.body.id).status).isEqualTo(UploadSessionStatus.STREAMING)

        service = newService(clock = Clock.fixed(NOW.plus(Duration.ofMinutes(2)).plusSeconds(1), ZoneOffset.UTC))
        val confirmed = service.upload(
            metadata(fixture.participant, "disconnect-upload", 0), session.body.id, ByteArrayInputStream(bytes),
        )
        assertThat(confirmed.body.version).isEqualTo(1)
        assertThat(runtimeJdbc.queryForObject(
            "SELECT count(*) FROM occ.evidence_version WHERE upload_session_id=?", Long::class.java, session.body.id,
        )).isEqualTo(1)
    }

    private fun objectsPut(key: String, bytes: ByteArray) {
        objectStore.putQuarantine(ObjectPut(key, ByteArrayInputStream(bytes), bytes.size.toLong(), sha256(bytes), "text/plain"))
    }

    private fun metadata(principal: UUID, key: String, version: Long?) =
        CommandMetadata(principal, "evidence.$key", key, version, UUID.randomUUID())

    private fun sessionRequest(target: UUID, requirement: UUID, slot: String, name: String, bytes: ByteArray) =
        CreateEvidenceSessionRequest(target, requirement, slot, name, sha256(bytes), bytes.size.toLong(), "participant")

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }

    private data class Fixture(val target: UUID, val requirement: UUID, val participant: UUID, val reviewer: UUID)

    private fun seed(): Fixture {
        val suffix = UUID.randomUUID().toString()
        val packageId = UUID.randomUUID()
        val packageVersion = UUID.randomUUID()
        val userType = UUID.randomUUID()
        val userVersion = UUID.randomUUID()
        val targetType = UUID.randomUUID()
        val targetVersion = UUID.randomUUID()
        val evidenceType = UUID.randomUUID()
        val evidenceVersion = UUID.randomUUID()
        val participant = UUID.randomUUID()
        val reviewer = UUID.randomUUID()
        val target = UUID.randomUUID()
        val requirement = UUID.randomUUID()
        adminJdbc.update("INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, ?, 'Evidence test', 'ACTIVE')", packageId, "evidence-$suffix")
        adminJdbc.update("INSERT INTO catalog.package_version(id, package_id, semver, status) VALUES (?, ?, '1.0.0', 'DRAFT')", packageVersion, packageId)
        listOf(
            arrayOf(userType, userVersion, "user", "PRINCIPAL"),
            arrayOf(targetType, targetVersion, "target", "RESOURCE"),
            arrayOf(evidenceType, evidenceVersion, "evidence", "RESOURCE"),
        ).forEach { (type, version, key, kind) ->
            adminJdbc.update("INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind) VALUES (?, ?, ?, ?, ?)", type, packageId, key, key, kind)
            adminJdbc.update("INSERT INTO catalog.entity_type_version(id, entity_type_id, package_version_id, schema_version, json_schema) VALUES (?, ?, ?, 1, '{}'::jsonb)", version, type, packageVersion)
        }
        fun entity(id: UUID, type: UUID, version: UUID, key: String) = adminJdbc.update(
            "INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state) VALUES (?, ?, ?, ?, 'ACTIVE')",
            id, type, version, "$key-$suffix",
        )
        entity(participant, userType, userVersion, "participant")
        entity(reviewer, userType, userVersion, "reviewer")
        entity(target, targetType, targetVersion, "target")
        adminJdbc.update("INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, 'USER', 'Participant', 'ACTIVE'), (?, 'USER', 'Reviewer', 'ACTIVE')", participant, reviewer)
        adminJdbc.update("INSERT INTO occ.business_object(id, entity_type_version_id, lifecycle_state, created_by) VALUES (?, ?, 'ACTIVE', ?)", target, targetVersion, participant)
        adminJdbc.update(
            """INSERT INTO catalog.evidence_requirement
               (id, package_version_id, requirement_key, allowed_types, max_size_bytes, min_count, validation_schema)
               VALUES (?, ?, ?, '["text/plain"]'::jsonb, 1048576, 2, ?::jsonb)""",
            requirement, packageVersion, "documents-$suffix", POLICY,
        )
        adminJdbc.update("UPDATE catalog.package_version SET status='PUBLISHED', content_hash=?, published_at=now() WHERE id=?", "a".repeat(64), packageVersion)
        return Fixture(target, requirement, participant, reviewer)
    }

    private class TestAuthorizationSnapshots : AuthorizationSnapshotSource {
        val denied = mutableSetOf<UUID>()
        override fun load(request: AuthorizationRequest): AuthorizationSnapshot = AuthorizationSnapshot(
            1, request.requestId, 1, mapOf(PolicyLayer.PLATFORM to POLICY_RELEASE),
            AuthorizationPrincipal(request.principalId, true), AuthorizationEntity(request.entityId), request.action,
            AuthorizationResource(request.resourceId, true), request.context, emptyList(),
            if (request.resourceId in denied) emptyList() else listOf(AuthorizationGrant(
                "evidence-test", PolicyLayer.PLATFORM, POLICY_RELEASE, GrantEffect.ALLOW, request.action,
                request.principalId.toString(), request.entityId.toString(), request.resourceId.toString(),
            )),
            POLICY_RELEASE, "platform-authz-v1", mapOf(request.entityId to 0, request.resourceId to 0), "0".repeat(64),
        )
    }

    private object NoOpDecisionLog : DecisionAuditLog {
        override fun persistInCallerTransaction(entry: DecisionLogEntry) = Unit
        override fun persistIndependently(entry: DecisionLogEntry) = Unit
    }

    private companion object {
        val MAPPER = ObjectMapper().findAndRegisterModules()
        val NOW: Instant = Instant.parse("2026-08-02T10:00:00Z")
        val POLICY_RELEASE: UUID = UUID.fromString("0198a8aa-8794-7000-8000-000000000001")
        const val CURSOR_SECRET = "evidence-service-cursor-secret-for-tests-12345"
        const val POLICY = """{"allowedExtensions":["txt"],"allowedMediaTypes":["text/plain"],"maximumBytes":1048576,"archive":{"maximumEntries":16,"maximumExpandedBytes":4194304,"maximumCompressionRatio":20.0},"conditionalHardGate":true}"""
        const val POSTGRES_IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        const val OPA_IMAGE = "openpolicyagent/opa:1.5.1@sha256:7d30d984125161b7f30599c6bdf80a6f2301dbbd526725714c231aad8179e4b9"
        const val MINIO_IMAGE = "minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e"
        const val MINIO_USER = "testrootadministrator"
        const val MINIO_PASSWORD = "testrootpassword0123456789abcdef"
        const val BUCKET = "evidence-lifecycle-test"

        @Container @JvmStatic
        val postgres = PostgreSQLContainer(DockerImageName.parse(POSTGRES_IMAGE).asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("innorder_occ").withUsername("innorder_admin").withPassword("admin-test-only")
            .withInitScript("postgres-test-init.sql")

        @Container @JvmStatic
        val opa = GenericContainer(DockerImageName.parse(OPA_IMAGE))
            .withCopyFileToContainer(MountableFile.forHostPath(policyDirectory()), "/policies")
            .withExposedPorts(8181).withCommand("run", "--server", "--addr=0.0.0.0:8181", "/policies")

        @Container @JvmStatic
        val minio = GenericContainer(DockerImageName.parse(MINIO_IMAGE))
            .withExposedPorts(9000).withEnv("MINIO_ROOT_USER", MINIO_USER).withEnv("MINIO_ROOT_PASSWORD", MINIO_PASSWORD)
            .withCommand("server", "/data")
            .waitingFor(Wait.forHttp("/minio/health/ready").forPort(9000).withStartupTimeout(Duration.ofMinutes(2)))

        lateinit var adminJdbc: JdbcTemplate
        lateinit var runtimeJdbc: JdbcTemplate
        lateinit var runtimeDataSource: DriverManagerDataSource
        lateinit var objectStore: ObjectStore

        @BeforeAll @JvmStatic
        fun infrastructure() {
            val flyway = DriverManagerDataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only")
            Flyway.configure().dataSource(flyway).locations("classpath:db/migration").load().migrate()
            adminJdbc = JdbcTemplate(flyway)
            runtimeDataSource = DriverManagerDataSource(postgres.jdbcUrl, "innorder_runtime", "runtime-test-only")
            runtimeJdbc = JdbcTemplate(runtimeDataSource)
            val endpoint = "http://${minio.host}:${minio.getMappedPort(9000)}"
            val admin = MinioClient.builder().endpoint(endpoint).credentials(MINIO_USER, MINIO_PASSWORD).build()
            if (!admin.bucketExists(BucketExistsArgs.builder().bucket(BUCKET).build())) {
                admin.makeBucket(MakeBucketArgs.builder().bucket(BUCKET).build())
            }
            objectStore = MinioObjectStore(EvidenceStorageProperties(endpoint, BUCKET, MINIO_USER, MINIO_PASSWORD, Duration.ofSeconds(10)))
        }

        private fun policyDirectory(): Path = sequenceOf(Path.of("policies", "opa"), Path.of("..", "..", "policies", "opa"))
            .map(Path::toAbsolutePath).firstOrNull(Files::isDirectory) ?: error("OPA policy directory is unavailable")
    }
}
