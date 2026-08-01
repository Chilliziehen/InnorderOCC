package com.innorder.occ.risk

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.api.CursorCodec
import com.innorder.occ.authz.AuthorizationDecision
import com.innorder.occ.authz.AuthorizationDecisionValue
import com.innorder.occ.authz.AuthorizationDeniedException
import com.innorder.occ.authz.AuthorizationEntity
import com.innorder.occ.authz.AuthorizationGrant
import com.innorder.occ.authz.AuthorizationPrincipal
import com.innorder.occ.authz.AuthorizationRequest
import com.innorder.occ.authz.AuthorizationResource
import com.innorder.occ.authz.AuthorizationRevisionLockRepository
import com.innorder.occ.authz.AuthorizationService
import com.innorder.occ.authz.AuthorizationSnapshot
import com.innorder.occ.authz.AuthorizationSnapshotSource
import com.innorder.occ.authz.DecisionAuditLog
import com.innorder.occ.authz.DecisionLogEntry
import com.innorder.occ.authz.GrantEffect
import com.innorder.occ.authz.OpaClient
import com.innorder.occ.authz.OpaProperties
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
import org.postgresql.util.PSQLException
import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.testcontainers.containers.GenericContainer
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import java.nio.file.Files
import java.nio.file.Path
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.UUID

@Testcontainers
class RiskServiceIntegrationTest {
    private lateinit var fixture: Fixture
    private lateinit var service: RiskService
    private lateinit var repository: RiskRepository
    private lateinit var authorization: TestAuthorizationSnapshots
    private lateinit var notifications: RecordingRiskNotifications

    @BeforeEach
    fun setUp() {
        fixture = Fixture.seed()
        authorization = TestAuthorizationSnapshots(fixture.principal)
        notifications = RecordingRiskNotifications(RiskNotificationOutboxPort(runtimeJdbc))
        val authorizationService = AuthorizationService(
            authorization,
            OpaClient(MAPPER, OpaProperties("http://${opa.host}:${opa.getMappedPort(8181)}")),
            NoOpDecisionLog,
        )
        val transactionManager = DataSourceTransactionManager(runtimeDataSource)
        val executor = CommandExecutor(
            transactionManager,
            authorizationService,
            AuthorizationRevisionLockRepository(runtimeJdbc),
            IdempotencyRepository(runtimeJdbc),
            AuditRepository(runtimeJdbc),
            OutboxRepository(runtimeJdbc),
            runtimeJdbc,
        )
        repository = RiskRepository(runtimeJdbc)
        service = RiskService(
            repository,
            executor,
            authorizationService,
            CursorCodec(CURSOR_SECRET, Clock.fixed(NOW, ZoneOffset.UTC)),
            transactionManager,
            notifications,
        )
    }

    @Test
    fun `creation from a decision deduplicates the occurrence and preserves owner SLA and facts`() {
        val decision = fixture.decision(severity = RiskSeverity.YELLOW, sla = Duration.ofHours(4))

        val first = service.create(metadata("create-1"), decision)
        val exactReplay = service.create(metadata("create-1"), decision)
        val duplicate = service.create(metadata("create-2"), decision)

        assertThat(exactReplay).isEqualTo(first.copy(replayed = true))
        assertThat(duplicate.resourceId).isEqualTo(first.resourceId)
        assertThat(duplicate.replayed).isTrue()
        val risk = repository.get(requireNotNull(first.resourceId))
        assertThat(risk.state).isEqualTo(RiskState.OPEN)
        assertThat(risk.severity).isEqualTo(RiskSeverity.YELLOW)
        assertThat(risk.dueAt).isEqualTo(NOW.plus(Duration.ofHours(4)))
        assertThat(risk.ownerRelationshipId).isEqualTo(fixture.ownerRelationship)
        assertThat(runtimeJdbc.queryForObject("SELECT count(*) FROM occ.risk_occurrence WHERE risk_id = ?", Long::class.java, risk.id))
            .isEqualTo(1)
        assertThat(runtimeJdbc.queryForObject("SELECT triggering_fact_ids::text FROM occ.risk_occurrence WHERE risk_id = ?", String::class.java, risk.id))
            .contains(fixture.fact.toString())
        assertThat(auditCount(fixture.target)).isEqualTo(1)
        assertThat(outboxTypes(risk.id)).containsExactly("risk.opened")
        val intent = notifications.intents.single()
        assertThat(intent.type).isEqualTo("RISK_OPENED")
        assertThat(intent.templateData.keys).containsExactlyInAnyOrder("riskId", "severity", "dueAt")
        assertThat(runtimeJdbc.queryForObject(
            """SELECT count(*) FROM audit.outbox_event
               WHERE aggregate_type = 'notification-intent'
                 AND payload->>'recipientRelationshipId' = ? AND payload->>'resourceId' = ?""",
            Long::class.java,
            fixture.ownerRelationship.toString(),
            risk.id.toString(),
        )).isEqualTo(1)
        authorization.deniedResources += fixture.target
        assertThatThrownBy { service.create(metadata("create-denied"), decision) }
            .isInstanceOf(AuthorizationDeniedException::class.java)
    }

    @Test
    fun `lifecycle commands append immutable actions and enforce stale replay and terminal denial`() {
        val riskId = requireNotNull(service.create(metadata("lifecycle-create"), fixture.decision()).resourceId)

        val acknowledged = service.acknowledge(metadata("ack", 0), riskId, "accepted")
        val replay = service.acknowledge(metadata("ack", 0), riskId, "accepted")
        assertThat(replay).isEqualTo(acknowledged.copy(replayed = true))
        assertThatThrownBy { service.assign(metadata("stale-assign", 0), riskId, fixture.escalatedOwnerRelationship, "handoff") }
            .isInstanceOf(OptimisticConflictException::class.java)
        assertThatThrownBy { service.assign(metadata("invalid-owner", 1), riskId, UUID.randomUUID(), "redirect") }
            .isInstanceOf(InvalidRiskActionException::class.java)

        service.assign(metadata("assign", 1), riskId, fixture.escalatedOwnerRelationship, "handoff")
        assertThat(runtimeJdbc.queryForObject(
            "SELECT action_data->>'ownerRelationshipId' FROM occ.risk_action WHERE risk_id = ? AND action_type = 'ASSIGNED'",
            String::class.java,
            riskId,
        )).isEqualTo(fixture.escalatedOwnerRelationship.toString())
        service.mitigate(metadata("mitigate", 2), riskId, "containment complete", mapOf("control" to "isolate"))
        service.resolve(metadata("resolve", 3), riskId, "verified")

        val risk = repository.get(riskId)
        assertThat(risk.state).isEqualTo(RiskState.RESOLVED)
        assertThat(risk.rowVersion).isEqualTo(4)
        assertThat(repository.actions(riskId).map { it.type }).containsExactly(
            RiskActionType.ACKNOWLEDGED,
            RiskActionType.ASSIGNED,
            RiskActionType.MITIGATED,
            RiskActionType.RESOLVED,
        )
        assertThatThrownBy { service.mitigate(metadata("terminal", 4), riskId, "late", emptyMap()) }
            .isInstanceOf(TerminalRiskException::class.java)
        assertPostgresRejects("55000", "occ.risk_action row is immutable") {
            runtimeJdbc.update("UPDATE occ.risk_action SET reason = 'rewritten' WHERE risk_id = ?", riskId)
        }
        assertThat(auditCount(fixture.target)).isEqualTo(1)
        assertThat(auditCount(riskId)).isEqualTo(4)
        assertThat(outboxTypes(riskId)).containsExactly(
            "risk.opened", "risk.acknowledged", "risk.assigned", "risk.mitigated", "risk.resolved",
        )
    }

    @Test
    fun `dismissal is terminal and remains distinct from resolution`() {
        val riskId = requireNotNull(service.create(metadata("dismiss-create"), fixture.decision()).resourceId)

        service.dismiss(metadata("dismiss", 0), riskId, "not applicable")

        assertThat(repository.get(riskId).state).isEqualTo(RiskState.DISMISSED)
        assertThat(repository.actions(riskId).single().type).isEqualTo(RiskActionType.DISMISSED)
        assertThatThrownBy { service.acknowledge(metadata("dismiss-terminal", 1), riskId, "late") }
            .isInstanceOf(TerminalRiskException::class.java)
    }

    @Test
    fun `due escalation claims with skip locked and appends each level once`() {
        val decision = fixture.decision(
            escalationSteps = listOf(
                EscalationStep(Duration.ofHours(1), severity = RiskSeverity.RED),
                EscalationStep(Duration.ofHours(2), ownerRelationship = "escalated-owner"),
            ),
        )
        val riskId = requireNotNull(service.create(metadata("escalation-create"), decision).resourceId)

        val first = service.escalateDue(fixture.principal, NOW.plus(Duration.ofHours(3)), 10, UUID.randomUUID())
        val replay = service.escalateDue(fixture.principal, NOW.plus(Duration.ofHours(3)), 10, UUID.randomUUID())

        assertThat(first.map { it.resourceId }).containsExactly(riskId, riskId)
        assertThat(replay).isEmpty()
        assertThat(repository.actions(riskId).map { it.escalationLevel }).containsExactly(0, 1)
        val risk = repository.get(riskId)
        assertThat(risk.severity).isEqualTo(RiskSeverity.RED)
        assertThat(risk.ownerRelationshipId).isEqualTo(fixture.escalatedOwnerRelationship)
        assertThat(risk.lastEscalationLevel).isEqualTo(1)
        assertThat(runtimeJdbc.queryForObject(
            "SELECT count(*) FROM occ.risk_action WHERE risk_id = ? AND escalation_level IS NOT NULL",
            Long::class.java,
            riskId,
        )).isEqualTo(2)
        assertThat(notifications.intents.count { it.type == "RISK_ESCALATED" }).isEqualTo(2)
        assertThat(RiskRepository.DUE_ESCALATION_SQL).contains("FOR UPDATE", "SKIP LOCKED")
    }

    @Test
    fun `authorized cursor queue orders and filters risks while omitting denied rows and redacting reason`() {
        val lateYellow = requireNotNull(service.create(metadata("queue-yellow"), fixture.decision(
            occurrence = "yellow", severity = RiskSeverity.YELLOW, sla = Duration.ofHours(2),
        )).resourceId)
        val earlyRed = requireNotNull(service.create(metadata("queue-red"), fixture.decision(
            occurrence = "red", severity = RiskSeverity.RED, sla = Duration.ofHours(1),
        )).resourceId)
        val deniedRed = requireNotNull(service.create(metadata("queue-denied"), fixture.decision(
            occurrence = "denied", severity = RiskSeverity.RED, sla = Duration.ofMinutes(30),
        )).resourceId)
        service.create(metadata("queue-info"), fixture.decision(occurrence = "info", severity = RiskSeverity.INFO))
        authorization.deniedResources += deniedRed
        authorization.redactedResources += earlyRed

        val filters = RiskQueueFilters(
            severities = setOf(RiskSeverity.YELLOW, RiskSeverity.RED),
            states = setOf(RiskState.OPEN),
            slaStatus = RiskSlaStatus.OVERDUE,
            targetEntityId = fixture.target,
            ownerRelationshipId = fixture.ownerRelationship,
        )
        val first = service.interventionQueue(fixture.principal, UUID.randomUUID(), filters, NOW.plus(Duration.ofHours(3)), 1)
        val second = service.interventionQueue(
            fixture.principal, UUID.randomUUID(), filters, NOW.plus(Duration.ofHours(3)), 10, first.nextCursor,
        )

        assertThat(first.items.map { it.id }).containsExactly(earlyRed)
        assertThat(first.items.single().reason).isNull()
        assertThat(second.items.map { it.id }).containsExactly(lateYellow)
        assertThat((first.items + second.items).map { it.id }).doesNotContain(deniedRed)
        assertThat(authorization.requests.count { it.action == "risk.read" }).isGreaterThanOrEqualTo(3)
        assertThat(authorization.requests.count { it.action == "risk.reason.read" }).isGreaterThanOrEqualTo(2)
    }

    @Test
    fun `queue filters state SLA target and ownership before row authorization`() {
        val riskId = requireNotNull(service.create(metadata("queue-filter"), fixture.decision()).resourceId)
        service.acknowledge(metadata("queue-filter-ack", 0), riskId, "owned")

        val matching = service.interventionQueue(
            fixture.principal,
            UUID.randomUUID(),
            RiskQueueFilters(states = setOf(RiskState.ACKNOWLEDGED), slaStatus = RiskSlaStatus.NOT_DUE),
            NOW,
            10,
        )
        val wrongOwner = service.interventionQueue(
            fixture.principal,
            UUID.randomUUID(),
            RiskQueueFilters(ownerRelationshipId = fixture.escalatedOwnerRelationship),
            NOW,
            10,
        )

        assertThat(matching.items.map { it.id }).contains(riskId)
        assertThat(wrongOwner.items).isEmpty()
    }

    @Test
    fun `adjudication corrections append superseding facts and metrics use only latest versions`() {
        val falsePositiveRisk = requireNotNull(service.create(metadata("metric-risk"), fixture.decision(
            occurrence = "metric", severity = RiskSeverity.RED,
        )).resourceId)
        service.dismiss(metadata("metric-dismiss", 0), falsePositiveRisk, "teacher review")
        val missed = RiskAdjudicationRequest(
            LocalDate.parse("2026-07-01"), LocalDate.parse("2026-08-01"), "known-severe", fixture.target,
            severeEvent = true, riskId = null, outcome = RiskAdjudicationOutcome.MISSED, reason = "not detected",
        )
        service.adjudicate(metadata("adjudicate-missed", 0), missed)
        service.adjudicate(metadata("adjudicate-correct", 1), missed.copy(
            outcome = RiskAdjudicationOutcome.NOT_APPLICABLE,
            reason = "event invalidated",
        ))
        service.adjudicate(metadata("adjudicate-fp", 0), RiskAdjudicationRequest(
            LocalDate.parse("2026-07-01"), LocalDate.parse("2026-08-01"), "known-fp", fixture.target,
            severeEvent = false, riskId = falsePositiveRisk, outcome = RiskAdjudicationOutcome.FALSE_POSITIVE,
            reason = "expected variation",
        ))
        val resolvedRisk = requireNotNull(service.create(metadata("metric-resolved-risk"), fixture.decision(
            occurrence = "metric-resolved", severity = RiskSeverity.RED,
        )).resourceId)
        service.resolve(metadata("metric-resolved", 0), resolvedRisk, "verified event")
        service.adjudicate(metadata("adjudicate-resolved-fp", 0), RiskAdjudicationRequest(
            LocalDate.parse("2026-07-01"), LocalDate.parse("2026-08-01"), "known-resolved-fp", fixture.target,
            severeEvent = false, riskId = resolvedRisk, outcome = RiskAdjudicationOutcome.FALSE_POSITIVE,
            reason = "adjudicator label conflicts with lifecycle",
        ))

        val metrics = service.metrics(LocalDate.parse("2026-07-01"), LocalDate.parse("2026-08-01"))
        assertThat(metrics.severeMisses).isZero()
        assertThat(metrics.falsePositiveCount).isEqualTo(1)
        assertThat(metrics.adjudicatedSignificantRiskCount).isEqualTo(2)
        assertThat(metrics.falsePositiveRate).isEqualByComparingTo("0.5000")
        assertThat(repository.adjudications("known-severe", fixture.target).map { it.version }).containsExactly(1, 2)
        assertPostgresRejects("55000", "occ.risk_adjudication row is immutable") {
            runtimeJdbc.update("UPDATE occ.risk_adjudication SET reason = 'rewritten' WHERE known_event_key = 'known-severe'")
        }
    }

    private fun metadata(key: String, expectedVersion: Long? = null) = CommandMetadata(
        fixture.principal,
        "risk.$key",
        "${fixture.key}-$key",
        expectedVersion,
        UUID.randomUUID(),
    )

    private fun auditCount(riskId: UUID): Long = runtimeJdbc.queryForObject(
        "SELECT count(*) FROM audit.audit_record WHERE target_entity_id = ?",
        Long::class.java,
        riskId,
    )!!

    private fun outboxTypes(riskId: UUID): List<String> = runtimeJdbc.queryForList(
        "SELECT event_type FROM audit.outbox_event WHERE aggregate_id = ? ORDER BY aggregate_version",
        String::class.java,
        riskId,
    )

    private fun assertPostgresRejects(state: String, message: String, block: () -> Unit) {
        val error = runCatching(block).exceptionOrNull()
        assertThat(error).isInstanceOf(DataAccessException::class.java)
        var current = error
        while (current != null && current !is PSQLException) current = current.cause
        assertThat((current as PSQLException).sqlState).isEqualTo(state)
        assertThat(current.serverErrorMessage?.message).isEqualTo(message)
    }

    private class Fixture(
        val key: String,
        val packageVersion: UUID,
        val target: UUID,
        val principal: UUID,
        val ownerRelationship: UUID,
        val escalatedOwnerRelationship: UUID,
        val rules: Map<String, UUID>,
        val fact: UUID,
    ) {
        fun decision(
            occurrence: String = "default",
            severity: RiskSeverity = RiskSeverity.YELLOW,
            sla: Duration = Duration.ofHours(4),
            escalationSteps: List<EscalationStep> = emptyList(),
        ): RiskDecision {
            val ruleId = requireNotNull(rules[occurrence]) { "No fixture rule for $occurrence" }
            val parsed = RiskRule.parse(
                """{
                  "packageId":"pilot","packageVersion":"1.0.0","ruleDefinitionId":"$ruleId",
                  "ruleId":"rule-$occurrence","severity":"$severity","sla":"$sla",
                  "ownerRelationship":"owner","escalationSteps":[${escalationSteps.joinToString(",") { step ->
                    """{"after":"${step.after}"${step.ownerRelationship?.let { ",\"ownerRelationship\":\"$it\"" } ?: ""}${step.severity?.let { ",\"severity\":\"$it\"" } ?: ""}}"""
                }}],"thresholdKind":"ELAPSED","zone":"UTC",
                  "calendar":{"version":"calendar-v1","holidays":[]},
                  "trigger":{"type":"OVERDUE_CRITICAL_WORK"}
                }""".trimIndent(),
            )
            return requireNotNull(RiskEvaluator().evaluate(
                parsed,
                RiskEvaluationFacts(target, listOf(if (occurrence == "default") fact else UUID.randomUUID()),
                    RiskFactValues.CriticalWork(NOW.minusSeconds(1), true)),
                NOW,
            ))
        }

        companion object {
            fun seed(): Fixture {
                val key = UUID.randomUUID().toString()
                val packageId = UUID.randomUUID()
                val packageVersion = UUID.randomUUID()
                val userType = UUID.randomUUID()
                val userTypeVersion = UUID.randomUUID()
                val targetType = UUID.randomUUID()
                val targetTypeVersion = UUID.randomUUID()
                val riskType = UUID.randomUUID()
                val riskTypeVersion = UUID.randomUUID()
                val principal = UUID.randomUUID()
                val owner = UUID.randomUUID()
                val escalatedOwner = UUID.randomUUID()
                val target = UUID.randomUUID()
                val ownerDefinition = UUID.randomUUID()
                val escalatedDefinition = UUID.randomUUID()
                val ownerRelationship = UUID.randomUUID()
                val escalatedOwnerRelationship = UUID.randomUUID()
                val rules = mapOf(
                    "default" to UUID.randomUUID(),
                    "yellow" to UUID.randomUUID(),
                    "red" to UUID.randomUUID(),
                    "denied" to UUID.randomUUID(),
                    "info" to UUID.randomUUID(),
                    "metric" to UUID.randomUUID(),
                    "metric-resolved" to UUID.randomUUID(),
                )
                adminJdbc.update(
                    "INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, ?, 'Risk test', 'ACTIVE')",
                    packageId, "risk-$key",
                )
                adminJdbc.update(
                    """INSERT INTO catalog.package_version
                       (id, package_id, semver, status, content_hash, published_at)
                       VALUES (?, ?, '1.0.0', 'DRAFT', NULL, NULL)""",
                    packageVersion, packageId,
                )
                listOf(
                    arrayOf(userType, userTypeVersion, "user", "PRINCIPAL"),
                    arrayOf(targetType, targetTypeVersion, "target", "RESOURCE"),
                    arrayOf(riskType, riskTypeVersion, "risk", "RESOURCE"),
                ).forEach { (type, version, typeKey, kind) ->
                    adminJdbc.update(
                        "INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind) VALUES (?, ?, ?, ?, ?)",
                        type, packageId, typeKey, typeKey, kind,
                    )
                    adminJdbc.update(
                        """INSERT INTO catalog.entity_type_version
                           (id, entity_type_id, package_version_id, schema_version, json_schema)
                           VALUES (?, ?, ?, 1, '{}'::jsonb)""",
                        version, type, packageVersion,
                    )
                }
                fun entity(id: UUID, type: UUID, version: UUID, entityKey: String) = adminJdbc.update(
                    """INSERT INTO authz.entity
                       (id, entity_type_id, entity_type_version_id, entity_key, state)
                       VALUES (?, ?, ?, ?, 'ACTIVE')""",
                    id, type, version, "$entityKey-$key",
                )
                entity(principal, userType, userTypeVersion, "actor")
                entity(owner, userType, userTypeVersion, "owner")
                entity(escalatedOwner, userType, userTypeVersion, "escalated")
                entity(target, targetType, targetTypeVersion, "target")
                listOf(principal to "Actor", owner to "Owner", escalatedOwner to "Escalated owner").forEach { (id, name) ->
                    adminJdbc.update(
                        "INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, 'USER', ?, 'ACTIVE')",
                        id, name,
                    )
                }
                val relationFixtures = listOf(
                    arrayOf(ownerDefinition, "owner", ownerRelationship, owner),
                    arrayOf(escalatedDefinition, "escalated-owner", escalatedOwnerRelationship, escalatedOwner),
                )
                relationFixtures.forEach { (definition, relationKey, _, _) ->
                    adminJdbc.update(
                        """INSERT INTO catalog.relation_definition
                           (id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality)
                           VALUES (?, ?, ?, ?, ?, 'MANY_TO_MANY')""",
                        definition, packageVersion, relationKey, userType, targetType,
                    )
                }
                rules.forEach { (occurrence, ruleId) ->
                    val severity = when (occurrence) {
                        "red", "denied", "metric", "metric-resolved" -> RiskSeverity.RED
                        "info" -> RiskSeverity.INFO
                        else -> RiskSeverity.YELLOW
                    }
                    adminJdbc.update(
                        """INSERT INTO catalog.risk_rule_definition
                           (id, package_version_id, rule_key, dmn_key, severity, content_hash)
                           VALUES (?, ?, ?, 'risk-dmn', ?, ?)""",
                        ruleId, packageVersion, "rule-$key-$occurrence", severity.name, "b".repeat(64),
                    )
                }
                adminJdbc.update(
                    """UPDATE catalog.package_version
                       SET status = 'PUBLISHED', content_hash = ?, published_at = now()
                       WHERE id = ?""",
                    "a".repeat(64), packageVersion,
                )
                relationFixtures.forEach { (definition, _, relationship, subject) ->
                    adminJdbc.update(
                        """INSERT INTO authz.relationship
                           (id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref)
                           VALUES (?, ?, ?, ?, 'SYSTEM', ?)""",
                        relationship, definition, subject, target, "risk-test-$key",
                    )
                }
                return Fixture(
                    key, packageVersion, target, principal, ownerRelationship,
                    escalatedOwnerRelationship, rules, UUID.randomUUID(),
                )
            }
        }
    }

    private class TestAuthorizationSnapshots(private val principalId: UUID) : AuthorizationSnapshotSource {
        val deniedResources = mutableSetOf<UUID>()
        val redactedResources = mutableSetOf<UUID>()
        val requests = mutableListOf<AuthorizationRequest>()

        override fun load(request: AuthorizationRequest): AuthorizationSnapshot {
            requests += request
            val allowed = request.resourceId !in deniedResources &&
                !(request.action == "risk.reason.read" && request.resourceId in redactedResources)
            return AuthorizationSnapshot(
                1,
                request.requestId,
                1,
                mapOf(PolicyLayer.PLATFORM to POLICY_RELEASE),
                AuthorizationPrincipal(principalId, true),
                AuthorizationEntity(request.entityId),
                request.action,
                AuthorizationResource(request.resourceId, true),
                request.context,
                emptyList(),
                if (allowed) listOf(AuthorizationGrant(
                    "risk-test-grant", PolicyLayer.PLATFORM, POLICY_RELEASE, GrantEffect.ALLOW,
                    request.action, principalId.toString(), request.entityId.toString(), request.resourceId.toString(),
                )) else emptyList(),
                POLICY_RELEASE,
                "platform-authz-v1",
                mapOf(request.entityId to 0, request.resourceId to 0),
                "0".repeat(64),
            )
        }
    }

    private class RecordingRiskNotifications(private val delegate: RiskNotificationPort) : RiskNotificationPort {
        val intents = mutableListOf<RiskNotificationIntent>()
        override fun emit(intent: RiskNotificationIntent) {
            intents += intent
            delegate.emit(intent)
        }
    }

    private object NoOpDecisionLog : DecisionAuditLog {
        override fun persistInCallerTransaction(entry: DecisionLogEntry) = Unit
        override fun persistIndependently(entry: DecisionLogEntry) = Unit
    }

    companion object {
        private const val POSTGRES_IMAGE =
            "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        private const val OPA_IMAGE =
            "openpolicyagent/opa:1.5.1@sha256:7d30d984125161b7f30599c6bdf80a6f2301dbbd526725714c231aad8179e4b9"
        private const val CURSOR_SECRET = "risk-service-cursor-secret-for-tests-123456789"
        private val NOW = Instant.parse("2026-08-02T10:00:00Z")
        private val POLICY_RELEASE = UUID.fromString("0198a8aa-8794-7000-8000-000000000001")
        private val MAPPER = ObjectMapper().findAndRegisterModules()

        @Container
        @JvmStatic
        val postgres: PostgreSQLContainer<*> = PostgreSQLContainer(
            DockerImageName.parse(POSTGRES_IMAGE).asCompatibleSubstituteFor("postgres"),
        ).withDatabaseName("innorder_occ")
            .withUsername("innorder_admin")
            .withPassword("admin-test-only")
            .withInitScript("postgres-test-init.sql")

        @Container
        @JvmStatic
        val opa: GenericContainer<*> = GenericContainer(DockerImageName.parse(OPA_IMAGE))
            .withCopyFileToContainer(MountableFile.forHostPath(policyDirectory()), "/policies")
            .withExposedPorts(8181)
            .withCommand("run", "--server", "--addr=0.0.0.0:8181", "/policies")

        private lateinit var adminJdbc: JdbcTemplate
        private lateinit var runtimeJdbc: JdbcTemplate
        private lateinit var runtimeDataSource: DriverManagerDataSource

        @BeforeAll
        @JvmStatic
        fun migrate() {
            val flywayDataSource = DriverManagerDataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only")
            Flyway.configure().dataSource(flywayDataSource).locations("classpath:db/migration").load().migrate()
            adminJdbc = JdbcTemplate(flywayDataSource)
            runtimeDataSource = DriverManagerDataSource(postgres.jdbcUrl, "innorder_runtime", "runtime-test-only")
            runtimeJdbc = JdbcTemplate(runtimeDataSource)
        }

        private fun policyDirectory(): Path = sequenceOf(
            Path.of("policies", "opa"),
            Path.of("..", "..", "policies", "opa"),
        ).map(Path::toAbsolutePath).firstOrNull(Files::isDirectory)
            ?: error("Repository OPA policy directory is unavailable")
    }
}
