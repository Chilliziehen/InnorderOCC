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
        workflow: EvidenceWorkflowPort? = null,
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
            IdempotencyRepository(runtimeJdbc), AuditRepository(runtimeJdbc), OutboxRepository(runtimeJdbc),
            AggregateLockRegistry(listOf(evidenceAggregateLockResolver())), runtimeJdbc,
        )
        return EvidenceService(
            repository, executor, authorizationService,
            CursorCodec(CURSOR_SECRET, clock), objectStore,
            EvidenceContentInspector(
                scanner,
                ParserSandbox { ParserSandboxResult.Accepted("application/pdf") },
                clock,
            ),
            EvidenceWorkflowIntentPort(runtimeJdbc), listOfNotNull(workflow),
            EvidenceDomainNotificationPort(runtimeJdbc), emptyList(),
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
                  "minimumCount":2,
                  "hardGate":true,
                  "conditionalAdvancement":false,
                  "conditionalFollowUpHours":24,
                  "archive":{"maximumEntries":8,"maximumExpandedBytes":32768,"maximumCompressionRatio":10.0}
                }""".trimIndent(),
            ),
        )

        assertThat(policy.content.maximumBytes).isEqualTo(4096)
        assertThat(policy.content.allowedExtensions).containsExactlyInAnyOrder("txt", "pdf")
        assertThat(policy.hardGate).isTrue()
    }

    @Test
    fun `catalog policy rejects defaults unknown fields and conflicting limits`() {
        assertThatThrownBy {
            EvidenceRequirementPolicy.parse(MAPPER.readTree("{}"))
        }.isInstanceOf(InvalidEvidenceRequirementException::class.java)
        assertThatThrownBy {
            EvidenceRequirementPolicy.parse(
                MAPPER.readTree(
                    """{
                      "allowedExtensions":["txt"],"allowedMediaTypes":["text/plain"],
                      "maximumBytes":104857601,"minimumCount":1,"hardGate":true,
                      "conditionalAdvancement":false,"conditionalFollowUpHours":24,
                      "archive":{"maximumEntries":8,"maximumExpandedBytes":32768,"maximumCompressionRatio":10.0},
                      "unexpected":true
                    }""".trimIndent(),
                ),
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
        val firstVersion = confirmed(service.upload(
            metadata(fixture.participant, "upload-v1", 0), firstSession.body.id, ByteArrayInputStream(firstBytes),
        ))
        val submittedV1 = service.submit(
            metadata(fixture.participant, "submit-v1", firstVersion.body.version), firstVersion.body.evidenceId,
            SubmitEvidenceRequest(firstVersion.body.evidenceVersion),
        )
        val rejected = service.review(
            metadata(fixture.reviewer, "review-v1", submittedV1.body.version),
            firstVersion.body.evidenceId,
            EvidenceReviewRequest(firstVersion.body.evidenceVersion, EvidenceReviewOutcome.REJECTED, "needs correction"),
        )
        assertThat(rejected.body.gateSatisfied).isFalse()

        val secondBytes = "corrected version".toByteArray()
        val secondSession = service.createSession(
            metadata(fixture.participant, "session-v2", service.metadata(fixture.participant, UUID.randomUUID(), firstVersion.body.evidenceId).version),
            sessionRequest(fixture.target, fixture.requirement, "primary", "corrected.txt", secondBytes, firstVersion.body.evidenceId),
        )
        val secondVersion = confirmed(service.upload(
            metadata(
                fixture.participant, "upload-v2",
                service.metadata(fixture.participant, UUID.randomUUID(), secondSession.body.evidenceId).version,
            ),
            secondSession.body.id,
            ByteArrayInputStream(secondBytes),
        ))
        val submittedV2 = service.submit(
            metadata(fixture.participant, "submit-v2", secondVersion.body.version), secondVersion.body.evidenceId,
            SubmitEvidenceRequest(secondVersion.body.evidenceVersion),
        )
        val acceptedFirstSlot = service.review(
            metadata(fixture.reviewer, "review-v2", submittedV2.body.version),
            secondVersion.body.evidenceId,
            EvidenceReviewRequest(secondVersion.body.evidenceVersion, EvidenceReviewOutcome.ACCEPTED, "verified"),
        )
        assertThat(acceptedFirstSlot.body.gateSatisfied).isFalse()

        val otherBytes = "second slot".toByteArray()
        val otherSession = service.createSession(
            metadata(fixture.participant, "session-other", null),
            sessionRequest(fixture.target, fixture.requirement, "secondary", "second.txt", otherBytes),
        )
        val otherVersion = confirmed(service.upload(
            metadata(fixture.participant, "upload-other", 0), otherSession.body.id, ByteArrayInputStream(otherBytes),
        ))
        val submittedOther = service.submit(
            metadata(fixture.participant, "submit-other", otherVersion.body.version), otherVersion.body.evidenceId,
            SubmitEvidenceRequest(otherVersion.body.evidenceVersion),
        )
        val accepted = service.review(
            metadata(fixture.reviewer, "review-other", submittedOther.body.version),
            otherVersion.body.evidenceId,
            EvidenceReviewRequest(otherVersion.body.evidenceVersion, EvidenceReviewOutcome.ACCEPTED, "verified"),
        )

        assertThat(accepted.body.gateSatisfied).isTrue()
        assertThat(service.versions(fixture.participant, UUID.randomUUID(), firstVersion.body.evidenceId, 20, null).items)
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
        assertThat(runtimeJdbc.queryForList(
            "SELECT recipient_selector FROM occ.evidence_notification_intent WHERE evidence_id=? ORDER BY created_at,id",
            String::class.java, secondVersion.body.evidenceId,
        )).contains(
            "principal:${fixture.participant}", "requirement-reviewers:${fixture.requirement}",
            "evidence-submitter:${secondVersion.body.evidenceId}:${secondVersion.body.evidenceVersion}",
        )
        val preview = service.previewMetadata(fixture.participant, UUID.randomUUID(), secondVersion.body.evidenceId)
        assertThat(preview.mediaType).isEqualTo("text/plain")
        assertThat(preview.sizeBytes).isPositive()
        assertThat(service.download(fixture.participant, UUID.randomUUID(), secondVersion.body.evidenceId).use {
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
    fun `content command replays only the persisted canonical idempotency identity`() {
        val bytes = "idempotent content".toByteArray()
        val session = service.createSession(
            metadata(fixture.participant, "content-session", null),
            sessionRequest(fixture.target, fixture.requirement, "content-idempotency", "content.txt", bytes),
        )
        val command = metadata(fixture.participant, "content-put", 0)
        val first = try {
            service.upload(command, session.body.id, ByteArrayInputStream(bytes))
        } catch (failure: RuntimeException) {
            throw AssertionError("terminal failure code=${repository.session(session.body.id).failureCode}", failure)
        }
        assertThat(service.upload(command, session.body.id, ByteArrayInputStream(bytes)))
            .isEqualTo(first.copy(replayed = true))
        assertThatThrownBy {
            service.upload(
                metadata(fixture.participant, "different-content-put", 0),
                session.body.id,
                ByteArrayInputStream(bytes),
            )
        }.isInstanceOf(EvidenceUploadConflictException::class.java)
    }

    @Test
    fun `unauthorized PUT cannot prebind content identity or lease`() {
        val bytes = "authorized content".toByteArray()
        val session = service.createSession(
            metadata(fixture.participant, "authz-session", null),
            sessionRequest(fixture.target, fixture.requirement, "authorization-order", "authorized.txt", bytes),
        )
        val before = uploadMutationSnapshot(session.body.id)

        assertThatThrownBy {
            service.upload(
                metadata(fixture.reviewer, "attacker-prebind", 0), session.body.id, ByteArrayInputStream(bytes),
            )
        }.isInstanceOf(EvidenceUploadConflictException::class.java)
        assertThat(uploadMutationSnapshot(session.body.id)).isEqualTo(before)

        authorization.denied += session.body.evidenceId
        assertThatThrownBy {
            service.upload(
                metadata(fixture.participant, "denied-prebind", 0), session.body.id, ByteArrayInputStream(bytes),
            )
        }.isInstanceOf(AuthorizationDeniedException::class.java)
        assertThat(uploadMutationSnapshot(session.body.id)).isEqualTo(before)
        assertThat(runtimeJdbc.queryForObject(
            "SELECT count(*) FROM audit.idempotency_record WHERE idempotency_key IN ('attacker-prebind','denied-prebind')",
            Long::class.java,
        )).isZero()
        authorization.denied.clear()

        val confirmed = confirmed(service.upload(
            metadata(fixture.participant, "legitimate-content", 0), session.body.id, ByteArrayInputStream(bytes),
        ))
        assertThat(confirmed.body.status).isEqualTo(UploadSessionStatus.CONFIRMED)
    }

    @Test
    fun `stale submit segregation and authorization denial fail without mutable history`() {
        val bytes = "review me".toByteArray()
        val session = service.createSession(
            metadata(fixture.participant, "guard-session", null),
            sessionRequest(fixture.target, fixture.requirement, "guard", "guard.txt", bytes),
        )
        val version = confirmed(service.upload(metadata(fixture.participant, "guard-upload", 0), session.body.id, ByteArrayInputStream(bytes)))
        assertThatThrownBy {
            service.submit(metadata(fixture.participant, "stale-submit", 0), version.body.evidenceId, SubmitEvidenceRequest(version.body.evidenceVersion))
        }.isInstanceOf(OptimisticConflictException::class.java)
        val submitMetadata = metadata(fixture.participant, "guard-submit", version.body.version)
        val submitRequest = SubmitEvidenceRequest(version.body.evidenceVersion)
        val submitted = service.submit(submitMetadata, version.body.evidenceId, submitRequest)
        assertThat(service.submit(submitMetadata, version.body.evidenceId, submitRequest)).isEqualTo(submitted.copy(replayed = true))
        assertThatThrownBy {
            service.review(
                metadata(fixture.participant, "self-review", submitted.body.version), version.body.evidenceId,
                EvidenceReviewRequest(version.body.evidenceVersion, EvidenceReviewOutcome.REJECTED, "self review"),
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
        val version = confirmed(service.upload(metadata(fixture.participant, "conditional-upload", 0), session.body.id, ByteArrayInputStream(bytes)))
        val submitted = service.submit(
            metadata(fixture.participant, "conditional-submit", version.body.version), version.body.evidenceId,
            SubmitEvidenceRequest(version.body.evidenceVersion),
        )
        service = newService(workflow = EvidenceWorkflowPort { intent ->
            if (intent.type == "REVIEWED") throw IllegalStateException("workflow unavailable")
        })
        val rollbackCorrelation = UUID.randomUUID()
        val workflowIntentCount = count("occ.evidence_workflow_intent", version.body.evidenceId)
        val notificationIntentCount = count("occ.evidence_notification_intent", version.body.evidenceId)
        assertThatThrownBy {
            service.review(
                CommandMetadata(
                    fixture.reviewer, "evidence.workflow-rollback", "workflow-rollback",
                    submitted.body.version, rollbackCorrelation,
                ),
                version.body.evidenceId,
                EvidenceReviewRequest(
                    version.body.evidenceVersion, EvidenceReviewOutcome.CONDITIONAL, "follow up",
                    listOf(EvidenceReviewCondition("field", "value")),
                ),
            )
        }.isInstanceOf(IllegalStateException::class.java)
        assertThat(repository.getHead(version.body.evidenceId).state).isEqualTo(EvidenceState.SUBMITTED)
        assertThat(runtimeJdbc.queryForObject(
            "SELECT count(*) FROM occ.evidence_review er JOIN occ.evidence_version ev ON ev.id=er.evidence_version_id WHERE ev.evidence_id=?",
            Long::class.java, version.body.evidenceId,
        )).isZero()
        assertThat(count("occ.evidence_workflow_intent", version.body.evidenceId)).isEqualTo(workflowIntentCount)
        assertThat(count("occ.evidence_notification_intent", version.body.evidenceId)).isEqualTo(notificationIntentCount)
        assertThat(runtimeJdbc.queryForObject(
            "SELECT count(*) FROM audit.audit_record WHERE correlation_id=?", Long::class.java, rollbackCorrelation,
        )).isZero()
        assertThat(runtimeJdbc.queryForObject(
            "SELECT count(*) FROM audit.outbox_event WHERE correlation_id=?", Long::class.java, rollbackCorrelation,
        )).isZero()
        assertThat(runtimeJdbc.queryForObject(
            "SELECT count(*) FROM audit.idempotency_record WHERE principal_id=? AND idempotency_key='workflow-rollback'",
            Long::class.java, fixture.reviewer,
        )).isZero()

        service = newService()
        val conditional = service.review(
            metadata(fixture.reviewer, "conditional-review", submitted.body.version), version.body.evidenceId,
            EvidenceReviewRequest(
                version.body.evidenceVersion, EvidenceReviewOutcome.CONDITIONAL, "follow up",
                listOf(EvidenceReviewCondition("field", "value")),
            ),
        )
        assertThat(Duration.between(conditional.body.reviewedAt, conditional.body.followUpDueAt)).isBetween(
            Duration.ofHours(23).plusMinutes(59), Duration.ofHours(24).plusMinutes(1),
        )
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
        }.isInstanceOf(EvidenceInvalidContentException::class.java)
        val failed = repository.session(session.body.id)
        assertThat(failed.status).isEqualTo(UploadSessionStatus.FAILED)
        assertThat(runtimeJdbc.queryForObject(
            "SELECT state FROM audit.idempotency_record WHERE principal_id=? AND idempotency_key='scanner-upload'",
            String::class.java, fixture.participant,
        )).isEqualTo("COMPLETED")
        assertThat(runtimeJdbc.queryForObject(
            "SELECT event_type FROM audit.outbox_event WHERE aggregate_id=? AND event_type='EVIDENCE_UPLOAD_FAILED'",
            String::class.java, failed.evidenceId,
        )).isEqualTo("EVIDENCE_UPLOAD_FAILED")
        val failurePayload = MAPPER.readTree(runtimeJdbc.queryForObject(
            "SELECT payload::text FROM audit.outbox_event WHERE aggregate_id=? AND event_type='EVIDENCE_UPLOAD_FAILED'",
            String::class.java, failed.evidenceId,
        ))
        assertThat(failurePayload.fieldNames().asSequence().toSet()).containsExactlyInAnyOrder(
            "evidenceId", "uploadSessionId", "state", "version", "reasonCode",
        )
        assertThat(failurePayload["reasonCode"].textValue()).isEqualTo("SCANNER_ERROR")
        assertThatThrownBy { service.download(fixture.participant, UUID.randomUUID(), failed.evidenceId) }
            .isInstanceOf(EvidenceNotFoundException::class.java)
        val cleanup = EvidenceCleanupJob(repository, objectStore, transactionManager, Clock.fixed(cleanupAfter(failed.id).plusSeconds(1), ZoneOffset.UTC))
        assertThat(cleanup.runBatch(UUID.randomUUID(), 100)).isPositive()
        assertThatThrownBy { objectStore.stat(failed.quarantineKey) }.isInstanceOf(ObjectNotFoundException::class.java)
    }

    @Test
    fun `oversize and digest terminal failures complete authorized commands with stable contract status`() {
        val declared = "a".toByteArray()
        val oversize = service.createSession(
            metadata(fixture.participant, "oversize-session", null),
            sessionRequest(fixture.target, fixture.requirement, "oversize", "oversize.txt", declared),
        )
        assertThatThrownBy {
            service.upload(
                metadata(fixture.participant, "oversize-content", 0), oversize.body.id,
                ByteArrayInputStream("ab".toByteArray()),
            )
        }.isInstanceOf(EvidenceTooLargeException::class.java)
        assertTerminalFailure(oversize.body.id, "oversize-content", "FILE_TOO_LARGE", 413)

        val digest = service.createSession(
            metadata(fixture.participant, "digest-session", null),
            sessionRequest(fixture.target, fixture.requirement, "digest", "digest.txt", declared),
        )
        assertThatThrownBy {
            service.upload(
                metadata(fixture.participant, "digest-content", 0), digest.body.id,
                ByteArrayInputStream("b".toByteArray()),
            )
        }.isInstanceOf(EvidenceDigestMismatchException::class.java)
        assertTerminalFailure(digest.body.id, "digest-content", "HASH_MISMATCH", 422)
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
        val leaseStart = repository.session(reclaimSession.body.id).createdAt.plusMillis(1)
        transactions.execute {
            repository.acquireLease(reclaimSession.body.id, firstOwner, leaseStart, leaseStart.plusSeconds(60))
        }
        val secondOwner = UUID.randomUUID()
        val reclaimed = transactions.execute {
            repository.acquireLease(reclaimSession.body.id, secondOwner, leaseStart.plusSeconds(61), leaseStart.plusSeconds(121))
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

        val leaseExpiry = requireNotNull(repository.session(session.body.id).leaseExpiresAt)
        service = newService(clock = Clock.fixed(leaseExpiry.plusSeconds(1), ZoneOffset.UTC))
        val confirmed = confirmed(service.upload(
            metadata(fixture.participant, "disconnect-upload", 0), session.body.id, ByteArrayInputStream(bytes),
        ))
        assertThat(confirmed.body.evidenceVersion).isEqualTo(1)
        assertThat(runtimeJdbc.queryForObject(
            "SELECT count(*) FROM occ.evidence_version WHERE upload_session_id=?", Long::class.java, session.body.id,
        )).isEqualTo(1)
    }

    @Test
    fun `expired scanning lease inspects persisted object state and resumes without request bytes`() {
        val bytes = "persisted scanning content".toByteArray()
        val created = service.createSession(
            metadata(fixture.participant, "scanning-session", null),
            sessionRequest(fixture.target, fixture.requirement, "scanning-recovery", "scan.txt", bytes),
        )
        val record = repository.session(created.body.id)
        objectsPut(record.quarantineKey, bytes)
        val leaseStart = record.createdAt.plusMillis(1)
        val owner = UUID.randomUUID()
        org.springframework.transaction.support.TransactionTemplate(transactionManager).executeWithoutResult {
            repository.acquireLease(record.id, owner, leaseStart, leaseStart.plusSeconds(60))
            repository.inspecting(record.id)
            repository.scanned(record.id, InspectedEvidence(
                sha256(bytes), bytes.size.toLong(), "text/plain", "txt",
                ScanResult(ScanStatus.CLEAN, "deterministic", "1.0", sha256(bytes)),
            ))
        }
        service = newService(clock = Clock.fixed(leaseStart.plusSeconds(61), ZoneOffset.UTC))
        val unavailableSource = object : InputStream() {
            override fun read(): Int = error("recovery must not read request bytes")
        }
        val result = confirmed(service.upload(
            metadata(fixture.participant, "scanning-content", 0), record.id, unavailableSource,
        ))
        assertThat(result.body.status).isEqualTo(UploadSessionStatus.CONFIRMED)
    }

    @Test
    fun `unsafe inspection fails before scanner and equal clean content receives separate object keys`() {
        var scans = 0
        service = newService(scanner = ScannerSandbox { request ->
            scans++
            ScanResult(ScanStatus.CLEAN, "deterministic", "1.0", request.sha256)
        })
        val unsafe = "MZ executable disguised as text".toByteArray()
        val unsafeSession = service.createSession(
            metadata(fixture.participant, "unsafe-session", null),
            sessionRequest(fixture.target, fixture.requirement, "unsafe", "unsafe.txt", unsafe),
        )
        assertThatThrownBy {
            service.upload(metadata(fixture.participant, "unsafe-content", 0), unsafeSession.body.id, ByteArrayInputStream(unsafe))
        }.isInstanceOf(EvidenceInvalidContentException::class.java)
        assertThat(scans).isZero()
        assertThat(runtimeJdbc.queryForObject(
            "SELECT count(*) FROM occ.evidence_version WHERE upload_session_id=?", Long::class.java, unsafeSession.body.id,
        )).isZero()

        val clean = "same clean content".toByteArray()
        val sessions = listOf("equal-a", "equal-b").map { slot ->
            service.createSession(
                metadata(fixture.participant, "$slot-session", null),
                sessionRequest(fixture.target, fixture.requirement, slot, "$slot.txt", clean),
            )
        }
        sessions.forEachIndexed { index, session ->
            confirmed(service.upload(
                metadata(fixture.participant, "equal-$index-content", 0), session.body.id, ByteArrayInputStream(clean),
            ))
        }
        assertThat(runtimeJdbc.queryForList(
            "SELECT immutable_object_key FROM occ.upload_session WHERE id IN (?,?)", String::class.java,
            sessions[0].body.id, sessions[1].body.id,
        )).doesNotHaveDuplicates()
    }

    @Test
    fun `cleanup rechecks legal hold and confirmed references immediately before delete`() {
        val bytes = "cleanup race".toByteArray()
        val pending = service.createSession(
            metadata(fixture.participant, "cleanup-race-session", null),
            sessionRequest(fixture.target, fixture.requirement, "cleanup-race", "race.txt", bytes),
        )
        val pendingRecord = repository.session(pending.body.id)
        objectsPut(pendingRecord.quarantineKey, bytes)
        val eligibleAt = repository.transactionTime().minusSeconds(1)
        org.springframework.transaction.support.TransactionTemplate(transactionManager).executeWithoutResult {
            repository.fail(pendingRecord.id, "TEST_FAILURE", eligibleAt, true)
        }
        val owner = UUID.randomUUID()
        val lease = org.springframework.transaction.support.TransactionTemplate(transactionManager).execute {
            repository.claimCleanup(owner, repository.transactionTime(), repository.transactionTime().plusSeconds(60), 1).single()
        }!!
        adminJdbc.update(
            "UPDATE occ.evidence SET legal_hold_at=transaction_timestamp(),legal_hold_by=?,legal_hold_reason='test hold' WHERE id=?",
            fixture.participant, pendingRecord.evidenceId,
        )
        assertThat(org.springframework.transaction.support.TransactionTemplate(transactionManager).execute {
            repository.lockCleanupEligibility(lease, repository.transactionTime())
        }).isFalse()
        assertThat(objectStore.stat(pendingRecord.quarantineKey).size).isEqualTo(bytes.size.toLong())

        val retained = service.createSession(
            metadata(fixture.participant, "retained-race-session", null),
            sessionRequest(fixture.target, fixture.requirement, "retained-race", "retained.txt", bytes),
        )
        confirmed(service.upload(
            metadata(fixture.participant, "retained-race-content", 0), retained.body.id, ByteArrayInputStream(bytes),
        ))
        val retainedKey = repository.session(retained.body.id).immutableKey
        assertThat(org.springframework.transaction.support.TransactionTemplate(transactionManager).execute {
            repository.lockUnreferencedObject(retainedKey)
        }).isFalse()
        assertThat(objectStore.stat(retainedKey).size).isEqualTo(bytes.size.toLong())
    }

    private fun objectsPut(key: String, bytes: ByteArray) {
        objectStore.putQuarantine(ObjectPut(key, ByteArrayInputStream(bytes), bytes.size.toLong(), sha256(bytes), "text/plain"))
    }

    private fun cleanupAfter(sessionId: UUID): Instant = requireNotNull(runtimeJdbc.queryForObject(
        "SELECT cleanup_after FROM occ.upload_session WHERE id=?", java.sql.Timestamp::class.java, sessionId,
    )).toInstant()

    private fun count(table: String, evidenceId: UUID): Long {
        require(table in setOf("occ.evidence_workflow_intent", "occ.evidence_notification_intent"))
        return runtimeJdbc.queryForObject("SELECT count(*) FROM $table WHERE evidence_id=?", Long::class.java, evidenceId)!!
    }

    private fun uploadMutationSnapshot(sessionId: UUID): Map<String, Any?> = runtimeJdbc.queryForMap(
        """SELECT content_idempotency_key,content_request_hash,status,lease_owner,lease_acquired_at,
                  lease_heartbeat_at,lease_expires_at,row_version
           FROM occ.upload_session WHERE id=?""",
        sessionId,
    )

    private fun assertTerminalFailure(sessionId: UUID, key: String, code: String, status: Int) {
        val failed = repository.session(sessionId)
        assertThat(failed.status).isEqualTo(UploadSessionStatus.FAILED)
        assertThat(failed.failureCode).isEqualTo(code)
        assertThat(runtimeJdbc.queryForMap(
            """SELECT state,response_status FROM audit.idempotency_record
               WHERE principal_id=? AND idempotency_key=?""",
            fixture.participant, key,
        )).containsEntry("state", "COMPLETED").containsEntry("response_status", status)
        assertThat(runtimeJdbc.queryForObject(
            "SELECT count(*) FROM audit.audit_record WHERE target_entity_id=? AND reason=?",
            Long::class.java, failed.evidenceId, code,
        )).isEqualTo(1)
        assertThat(runtimeJdbc.queryForObject(
            "SELECT count(*) FROM audit.outbox_event WHERE aggregate_id=? AND event_type='EVIDENCE_UPLOAD_FAILED'",
            Long::class.java, failed.evidenceId,
        )).isEqualTo(1)
    }

    private fun metadata(principal: UUID, key: String, version: Long?) =
        CommandMetadata(principal, "evidence.$key", key, version, UUID.randomUUID())

    private fun sessionRequest(
        target: UUID, requirement: UUID, slot: String, name: String, bytes: ByteArray, evidenceId: UUID? = null,
    ) = CreateEvidenceSessionRequest(
        requirement, target, evidenceId, slot, name.substringAfterLast('.'), sha256(bytes), bytes.size.toLong(),
    )

    private fun confirmed(result: EvidenceCommandResult<EvidenceContentResult>) = EvidenceCommandResult(
        result.status, result.replayed, result.body as ConfirmedEvidenceContentResult,
    )

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
            emptyList(),
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
        const val POLICY = """{"allowedExtensions":["txt"],"allowedMediaTypes":["text/plain"],"maximumBytes":1048576,"minimumCount":2,"hardGate":true,"conditionalAdvancement":false,"conditionalFollowUpHours":24,"archive":{"maximumEntries":16,"maximumExpandedBytes":4194304,"maximumCompressionRatio":20.0}}"""
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
