package com.innorder.occ.authz

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.command.AggregateChange
import com.innorder.occ.command.AggregateLockPlan
import com.innorder.occ.command.AggregateLockRegistry
import com.innorder.occ.command.AggregateLockResolver
import com.innorder.occ.command.AggregateReference
import com.innorder.occ.command.AuditRepository
import com.innorder.occ.command.AuthorizedCommand
import com.innorder.occ.command.CanonicalJsonObject
import com.innorder.occ.command.CommandContext
import com.innorder.occ.command.CommandExecutor
import com.innorder.occ.command.CommandMetadata
import com.innorder.occ.command.CommandMutation
import com.innorder.occ.command.IdempotencyRepository
import com.innorder.occ.command.PendingEventSpec
import com.innorder.occ.events.OutboxRepository
import com.innorder.occ.iam.BootstrapIds
import com.innorder.occ.iam.BootstrapPolicyBaseline
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.testcontainers.containers.BindMode
import org.testcontainers.containers.GenericContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import org.testcontainers.containers.wait.strategy.Wait
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID

@Testcontainers(disabledWithoutDocker = true)
class WorkflowAuthorizationSnapshotIntegrationTest : AuthorizationSnapshotIntegrityIntegrationTest() {
    @Test
    fun `relationship facts expose the strict v2 workflow vocabulary`() {
        val subjectId = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        val objectId = UUID.fromString("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")

        val facts = AuthorizationRelation.entries.map { relation ->
            AuthorizationRelationshipFact(relation, subjectId, objectId)
        }

        assertThat(facts.map { it.relation }).containsExactly(
            AuthorizationRelation.COHORT_OWNER,
            AuthorizationRelation.COHORT_TEACHER,
            AuthorizationRelation.COHORT_PARTICIPANT,
            AuthorizationRelation.TASK_CANDIDATE,
            AuthorizationRelation.TASK_ASSIGNEE,
        )
    }

    @Test
    fun `snapshot includes only active allowlisted target relationships in immutable order`() = scenario { jdbc ->
        seedActiveRelease(
            jdbc,
            mapOf(PolicyLayer.PLATFORM to
                """{"version":1,"roleGrants":[],"forbiddenActions":[]}"""),
        )
        val principalId = UUID.fromString("73000000-0000-7000-8000-000000000007")
        val entityId = UUID.fromString("73000000-0000-7000-8000-000000000008")
        val resourceId = UUID.fromString("73000000-0000-7000-8000-000000000009")
        jdbc.update(
            """INSERT INTO occ.cohort
               (id, customer_instance_id, code, name, package_version_id, owner_principal_id,
                start_date, status, created_by, updated_by)
               VALUES (?, '00000000-0000-7000-8000-000000000001', 'authz-snapshot', 'Authz snapshot',
                       '73000000-0000-7000-8000-000000000002', ?, current_date, 'DRAFT', ?, ?)""",
            entityId, principalId, principalId, principalId,
        )
        val relationships = listOf(
            RelationshipSeed(WorkflowAuthorizationRelationDefinitions.TASK_CANDIDATE_ID, resourceId, "active-candidate", "transaction_timestamp()", "NULL", "NULL"),
            RelationshipSeed(WorkflowAuthorizationRelationDefinitions.COHORT_TEACHER_ID, entityId, "expired-teacher", "transaction_timestamp() - interval '2 hours'", "transaction_timestamp() - interval '1 hour'", "NULL"),
            RelationshipSeed(WorkflowAuthorizationRelationDefinitions.COHORT_PARTICIPANT_ID, entityId, "future-participant", "transaction_timestamp() + interval '1 hour'", "NULL", "NULL"),
            RelationshipSeed(WorkflowAuthorizationRelationDefinitions.TASK_ASSIGNEE_ID, resourceId, "revoked-assignee", "transaction_timestamp() - interval '2 hours'", "NULL", "transaction_timestamp() - interval '1 hour'"),
            RelationshipSeed("74000000-0000-7000-8000-000000000006", entityId, "unknown-relation", "transaction_timestamp()", "NULL", "NULL"),
        )
        relationships.forEach { relationship ->
            jdbc.update(
                """INSERT INTO authz.relationship
                   (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until,
                    revoked_at, source_kind, source_ref)
                   VALUES (?, ?::uuid, ?, ?, ${relationship.validFrom}, ${relationship.validUntil},
                           ${relationship.revokedAt}, 'SYSTEM', ?)""",
                UUID.randomUUID(), relationship.definitionId, principalId, relationship.objectId, relationship.sourceRef,
            )
        }

        val snapshot = repository(jdbc).load(request().copy(action = "cohort.read"))

        assertThat(snapshot.contractVersion).isEqualTo(2)
        assertThat(snapshot.relationships).containsExactly(
            AuthorizationRelationshipFact(AuthorizationRelation.COHORT_OWNER, principalId, entityId),
            AuthorizationRelationshipFact(AuthorizationRelation.TASK_CANDIDATE, principalId, resourceId),
        )
        assertThatThrownBy { (snapshot.relationships as MutableList<AuthorizationRelationshipFact>).clear() }
            .isInstanceOf(UnsupportedOperationException::class.java)
    }

    @Test
    fun `snapshot excludes non canonical and non authorization workflow relations`() = scenario { jdbc ->
        seedActiveRelease(jdbc, mapOf(PolicyLayer.PLATFORM to EMPTY_MANIFEST))
        jdbc.update(
            "INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, 'spoof-relations', 'Spoof relations', 'ACTIVE')",
            SPOOF_PACKAGE_ID,
        )
        jdbc.update(
            "INSERT INTO catalog.package_version(id, package_id, semver, status) VALUES (?, ?, '1.0.0', 'DRAFT')",
            SPOOF_PACKAGE_VERSION_ID, SPOOF_PACKAGE_ID,
        )
        listOf(
            Triple(SPOOF_TEACHER_RELATION_ID, "cohort_teacher", true),
            Triple(SPOOF_ASSIGNEE_RELATION_ID, "task_assignee", false),
        ).forEach { (id, key, relevant) ->
            jdbc.update(
                """INSERT INTO catalog.relation_definition
                   (id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality, auth_relevant)
                   VALUES (?, ?, ?, ?, ?, 'MANY_TO_MANY', ?)""",
                id, SPOOF_PACKAGE_VERSION_ID, key, TYPE_ID, TYPE_ID, relevant,
            )
        }
        jdbc.update(
            "UPDATE catalog.package_version SET status = 'PUBLISHED', content_hash = repeat('f', 64), published_at = transaction_timestamp() WHERE id = ?",
            SPOOF_PACKAGE_VERSION_ID,
        )
        listOf(
            SPOOF_TEACHER_RELATION_ID to COHORT_ID,
            SPOOF_ASSIGNEE_RELATION_ID to TASK_ID,
        ).forEach { (definitionId, objectId) ->
            jdbc.update(
                """INSERT INTO authz.relationship
                   (id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref)
                   VALUES (?, ?, ?, ?, 'SYSTEM', 'spoof')""",
                UUID.randomUUID(), definitionId, PRINCIPAL_ID, objectId,
            )
        }

        assertThat(repository(jdbc).load(request().copy(action = "cohort.read")).relationships).isEmpty()
    }

    @Test
    fun `snapshot fails closed when canonical workflow relation metadata drifts`() {
        listOf(
            "relation_key = 'spoofed_owner'",
            "auth_relevant = false",
        ).forEach { mutation ->
            adminScenario { jdbc ->
                seedActiveRelease(jdbc, mapOf(PolicyLayer.PLATFORM to EMPTY_MANIFEST))
                jdbc.execute("SET LOCAL session_replication_role = replica")
                jdbc.update(
                    "UPDATE catalog.relation_definition SET $mutation WHERE id = ?",
                    UUID.fromString(WorkflowAuthorizationRelationDefinitions.COHORT_OWNER_ID),
                )

                assertThatThrownBy { repository(jdbc).load(request().copy(action = "cohort.read")) }
                    .isInstanceOf(AuthorizationSnapshotException::class.java)
            }
        }
    }

    @Test
    fun `workflow action fails closed when canonical definitions are absent`() = adminScenario { jdbc ->
        seedActiveRelease(jdbc, mapOf(PolicyLayer.PLATFORM to EMPTY_MANIFEST))
        jdbc.execute("SET LOCAL session_replication_role = replica")
        jdbc.update(
            "DELETE FROM catalog.relation_definition WHERE id IN (${WorkflowAuthorizationRelationDefinitions.all.joinToString(",") { "?" }})",
            *WorkflowAuthorizationRelationDefinitions.all.map { it.id }.toTypedArray(),
        )

        assertThatThrownBy { repository(jdbc).load(request().copy(action = "cohort.create")) }
            .isInstanceOf(AuthorizationSnapshotException::class.java)
    }

    @Test
    fun `snapshot excludes an oversized flood of non canonical same key relationships`() = scenario { jdbc ->
        seedActiveRelease(
            jdbc,
            mapOf(PolicyLayer.PLATFORM to
                """{"version":1,"roleGrants":[],"forbiddenActions":[]}"""),
        )
        val principalId = UUID.fromString("73000000-0000-7000-8000-000000000007")
        val resourceId = UUID.fromString("73000000-0000-7000-8000-000000000009")
        repeat(257) { index ->
            val versionId = UUID.randomUUID()
            val relationId = UUID.randomUUID()
            jdbc.update(
                """INSERT INTO catalog.package_version(id, package_id, semver, status)
                   VALUES (?, '73000000-0000-7000-8000-000000000001', ?, 'DRAFT')""",
                versionId, "2.0.$index",
            )
            jdbc.update(
                """INSERT INTO catalog.relation_definition
                   (id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality, auth_relevant)
                   VALUES (?, ?, 'task_candidate', '73000000-0000-7000-8000-000000000003',
                           '73000000-0000-7000-8000-000000000003', 'MANY_TO_MANY', true)""",
                relationId, versionId,
            )
            jdbc.update(
                """UPDATE catalog.package_version SET status = 'PUBLISHED', content_hash = ?,
                       published_at = transaction_timestamp() WHERE id = ?""",
                "%064x".format(index + 1), versionId,
            )
            jdbc.update(
                """INSERT INTO authz.relationship
                   (id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref)
                   VALUES (?, ?, ?, ?, 'SYSTEM', ?)""",
                UUID.randomUUID(), relationId, principalId, resourceId, "oversize-$index",
            )
        }

        assertThat(repository(jdbc).load(request().copy(action = "cohort.read")).relationships).isEmpty()
    }

    @Test
    fun `task complete context uses running process and blocker free target facts instead of caller values`() = scenario { jdbc ->
        seedActiveRelease(jdbc, mapOf(PolicyLayer.PLATFORM to EMPTY_MANIFEST))
        seedTask(jdbc)

        val callerFalse = repository(jdbc).load(taskCompleteRequest(false, "SUSPENDED"))
        val callerTrue = repository(jdbc).load(taskCompleteRequest(true, "RUNNING"))

        assertThat(callerFalse.context).containsEntry("processState", "RUNNING")
            .containsEntry("hardBlockersAbsent", true)
            .containsEntry("taskState", "CLAIMED")
            .containsEntry("commandKey", "task.complete")
        assertThat(callerFalse.contextDigest).isEqualTo(callerTrue.contextDigest)
    }

    @Test
    fun `task complete context denies caller spoof for suspended process and active hard blocker`() {
        scenario { jdbc ->
            seedActiveRelease(jdbc, mapOf(PolicyLayer.PLATFORM to EMPTY_MANIFEST))
            seedTask(jdbc)
            jdbc.update("UPDATE occ.process_instance SET state = 'SUSPENDED' WHERE id = ?", PROCESS_ID)

            val snapshot = repository(jdbc).load(taskCompleteRequest(true, "RUNNING"))

            assertThat(snapshot.context).containsEntry("processState", "SUSPENDED")
                .containsEntry("hardBlockersAbsent", true)
        }
        scenario { jdbc ->
            seedActiveRelease(jdbc, mapOf(PolicyLayer.PLATFORM to EMPTY_MANIFEST))
            seedTask(jdbc)
            jdbc.update(
                """INSERT INTO occ.task_blocker
                   (id, task_id, source_entity_id, source_row_version, blocker_code, severity)
                   VALUES (?, ?, ?, 0, 'PREREQUISITE_UNSATISFIED', 'HARD')""",
                UUID.randomUUID(), TASK_ID, PRINCIPAL_ID,
            )

            val snapshot = repository(jdbc).load(taskCompleteRequest(true, "RUNNING"))

            assertThat(snapshot.context).containsEntry("processState", "RUNNING")
                .containsEntry("hardBlockersAbsent", false)
        }
    }

    @Test
    fun `task complete context treats missing and non ready gate providers as blockers`() {
        listOf(false, true).forEach { seedProvider ->
            scenario { jdbc ->
                seedActiveRelease(jdbc, mapOf(PolicyLayer.PLATFORM to EMPTY_MANIFEST))
                seedTask(jdbc)
                jdbc.update(
                    "INSERT INTO occ.task_gate_requirement(task_id, provider_key) VALUES (?, 'resource.ready')",
                    TASK_ID,
                )
                if (seedProvider) {
                    jdbc.update(
                        """INSERT INTO occ.task_gate_provider_state(task_id, provider_key, status, safe_failure_code)
                           VALUES (?, 'resource.ready', 'UNAVAILABLE', 'NOT_READY')""",
                        TASK_ID,
                    )
                }

                val snapshot = repository(jdbc).load(taskCompleteRequest(true, "RUNNING"))

                assertThat(snapshot.context).containsEntry("hardBlockersAbsent", false)
            }
        }
    }

    @Test
    fun `task complete context size limit applies after authoritative properties are added`() = scenario { jdbc ->
        seedActiveRelease(jdbc, mapOf(PolicyLayer.PLATFORM to EMPTY_MANIFEST))
        seedTask(jdbc)
        val callerContext = (0 until 31).associate { "caller$it" to it }
        val request = AuthorizationRequest(
            UUID.randomUUID(), PRINCIPAL_ID, "task.complete", COHORT_ID, TASK_ID, callerContext,
        )

        assertThatThrownBy { repository(jdbc).load(request) }
            .isInstanceOf(AuthorizationSnapshotException::class.java)
    }

    @Test
    fun `real PostgreSQL assignments and OPA enforce the exact workflow role matrix`() {
        WORKFLOW_ROLE_MATRIX.forEach { (role, allowedActions) ->
            scenario { jdbc ->
                seedActiveRelease(jdbc, mapOf(PolicyLayer.PLATFORM to BootstrapPolicyBaseline.manifest))
                seedTask(jdbc)
                seedWorkflowRoleMatrix(jdbc)
                jdbc.update(
                    """UPDATE authz.relationship SET revoked_at = transaction_timestamp()
                       WHERE relation_definition_id = ? AND subject_entity_id = ?""",
                    BootstrapIds.ROLE_ASSIGNMENT_RELATION, PRINCIPAL_ID,
                )
                jdbc.update(
                    """INSERT INTO authz.relationship
                       (id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref)
                       VALUES (?, ?, ?, ?, 'SYSTEM', 'workflow-role-matrix')""",
                    UUID.randomUUID(), BootstrapIds.ROLE_ASSIGNMENT_RELATION, PRINCIPAL_ID, role.id,
                )
                val authorization = realAuthorization(jdbc)

                WORKFLOW_ACTIONS.forEach { action ->
                    val allowed = try {
                        authorization.authorize(workflowRequest(action))
                        true
                    } catch (_: AuthorizationDeniedException) {
                        false
                    }
                    assertThat(allowed).describedAs("${role.key} -> $action")
                        .isEqualTo(action in allowedActions)
                }
            }
        }
    }

    @Test
    fun `real command executor and OPA bind task completion to target process and blockers`() = scenario { jdbc ->
        seedActiveRelease(jdbc, mapOf(PolicyLayer.PLATFORM to TASK_COMPLETE_MANIFEST))
        seedTask(jdbc)
        val authorization = realAuthorization(jdbc)
        val executor = commandExecutor(jdbc, authorization)

        val allowed = executor.execute(commandMetadata(1), "{}".toByteArray(), taskProbeCommand())
        assertThat(allowed.status).isEqualTo(200)

        jdbc.update(
            """INSERT INTO occ.task_blocker
               (id, task_id, source_entity_id, source_row_version, blocker_code, severity)
               VALUES (?, ?, ?, 0, 'PREREQUISITE_UNSATISFIED', 'HARD')""",
            UUID.randomUUID(), TASK_ID, PRINCIPAL_ID,
        )
        assertThatThrownBy {
            executor.execute(commandMetadata(2), "{}".toByteArray(), taskProbeCommand())
        }.isInstanceOf(AuthorizationDeniedException::class.java)

        jdbc.update("UPDATE occ.task_blocker SET resolved_at = transaction_timestamp() WHERE task_id = ?", TASK_ID)
        jdbc.update("UPDATE occ.process_instance SET state = 'SUSPENDED' WHERE id = ?", PROCESS_ID)
        assertThatThrownBy {
            executor.execute(commandMetadata(2), "{}".toByteArray(), taskProbeCommand())
        }.isInstanceOf(AuthorizationDeniedException::class.java)
        assertThatThrownBy {
            authorization.authorize(taskCompleteRequest(true, "RUNNING"))
        }.isInstanceOf(AuthorizationDeniedException::class.java)
    }

    @Test
    fun `real command executor and OPA deny every non claimed task state and caller spoof`() {
        val transitions = mapOf(
            "AVAILABLE" to "assignee_id = NULL, claimed_at = NULL",
            "COMPLETED" to "completed_at = transaction_timestamp()",
            "CANCELLED" to "cancelled_at = transaction_timestamp()",
            "FAILED" to "failed_at = transaction_timestamp(), failure_code = 'TEST_FAILURE'",
        )
        transitions.forEach { (state, stateFields) ->
            scenario { jdbc ->
                seedActiveRelease(jdbc, mapOf(PolicyLayer.PLATFORM to TASK_COMPLETE_MANIFEST))
                seedTask(jdbc)
                jdbc.update("UPDATE occ.task_projection SET state = '$state', $stateFields WHERE id = ?", TASK_ID)
                val authorization = realAuthorization(jdbc)

                assertThatThrownBy {
                    commandExecutor(jdbc, authorization).execute(
                        commandMetadata(2), "{}".toByteArray(), taskProbeCommand(),
                    )
                }.describedAs(state).isInstanceOf(AuthorizationDeniedException::class.java)
                if (state == "AVAILABLE") {
                    assertThatThrownBy {
                        authorization.authorize(taskCompleteRequest(true, "RUNNING", "CLAIMED"))
                    }.isInstanceOf(AuthorizationDeniedException::class.java)
                }
            }
        }
    }

    private fun realAuthorization(jdbc: org.springframework.jdbc.core.JdbcTemplate): AuthorizationService {
        val mapper = ObjectMapper().findAndRegisterModules()
        return AuthorizationService(
            repository(jdbc),
            OpaClient(mapper, OpaProperties("http://${opa.host}:${opa.getMappedPort(8181)}")),
            RecordingDecisionLog(),
        )
    }

    private fun seedWorkflowRoleMatrix(jdbc: org.springframework.jdbc.core.JdbcTemplate) {
        WORKFLOW_ROLE_MATRIX.keys.filter { it.id != MATRIX_ADMINISTRATOR_ROLE_ID }.forEach { role ->
            jdbc.update(
                """INSERT INTO authz.entity
                   (id, entity_type_id, entity_type_version_id, entity_key, state)
                   VALUES (?, ?, ?, ?, 'ACTIVE')""",
                role.id, MATRIX_ROLE_TYPE_ID, MATRIX_ROLE_TYPE_VERSION_ID, role.key,
            )
            jdbc.update(
                """INSERT INTO iam.principal(id, principal_kind, display_name, status)
                   VALUES (?, 'ROLE', ?, 'ACTIVE')""",
                role.id, role.displayName,
            )
        }
        listOf(
            WorkflowAuthorizationRelationDefinitions.COHORT_PARTICIPANT_ID to COHORT_ID,
            WorkflowAuthorizationRelationDefinitions.TASK_CANDIDATE_ID to TASK_ID,
        ).forEach { (definitionId, objectId) ->
            jdbc.update(
                """INSERT INTO authz.relationship
                   (id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref)
                   VALUES (?, ?::uuid, ?, ?, 'SYSTEM', 'workflow-role-matrix')""",
                UUID.randomUUID(), definitionId, PRINCIPAL_ID, objectId,
            )
        }
    }

    private fun workflowRequest(action: String): AuthorizationRequest {
        val entityId = if (action == "cohort.create") MATRIX_ENTITY_ID else COHORT_ID
        val resourceId = when {
            action.startsWith("task.") -> TASK_ID
            action.startsWith("process.") -> PROCESS_ID
            else -> entityId
        }
        return AuthorizationRequest(
            UUID.randomUUID(), PRINCIPAL_ID, action, entityId, resourceId,
            mapOf("commandKey" to action),
        )
    }

    private fun commandExecutor(
        jdbc: org.springframework.jdbc.core.JdbcTemplate,
        authorization: AuthorizationService,
    ) = CommandExecutor(
        DataSourceTransactionManager(jdbc.dataSource!!), authorization,
        AuthorizationRevisionLockRepository(jdbc), IdempotencyRepository(jdbc), AuditRepository(jdbc),
        OutboxRepository(jdbc),
        AggregateLockRegistry(listOf(AggregateLockResolver("task-probe", 100) { operations, id ->
            operations.query(
                "SELECT row_version FROM occ.task_projection WHERE id = ? FOR UPDATE",
                { rs, _ -> rs.getLong(1) },
                id,
            ).singleOrNull()
        })),
        jdbc,
    )

    private fun commandMetadata(version: Long) = CommandMetadata(
        PRINCIPAL_ID, "task.complete", "task-complete-$version-${UUID.randomUUID()}", version, UUID.randomUUID(),
    )

    private fun taskProbeCommand() = object : AuthorizedCommand {
        override val action = "task.complete"
        override val entityId = COHORT_ID
        override val resourceId = TASK_ID
        override val aggregateType = "task-probe"
        override val aggregateId = TASK_ID
        override val expectedVersionRequired = true
        override val changesAuthorizationFacts = false
        override val lockPlan = AggregateLockPlan(existing = listOf(AggregateReference(aggregateType, aggregateId)))

        override fun execute(context: CommandContext): CommandMutation {
            context.jdbc.update("UPDATE occ.task_projection SET row_version = 2 WHERE id = ?", TASK_ID)
            val body = CanonicalJsonObject.from(ObjectMapper().readTree("""{"result":"authorized"}"""))
            val detail = CanonicalJsonObject.from(ObjectMapper().readTree("""{"changed":true}"""))
            return CommandMutation(
                200, body, resourceId,
                listOf(AggregateChange(AggregateReference(aggregateType, aggregateId), 1, 2)),
                "authorized task completion probe", detail,
                listOf(PendingEventSpec(
                    "task-probe.updated", 1, detail,
                    AggregateReference(aggregateType, aggregateId), 2,
                )),
            )
        }
    }

    private class RecordingDecisionLog : DecisionAuditLog {
        override fun persistInCallerTransaction(entry: DecisionLogEntry) = Unit
        override fun persistIndependently(entry: DecisionLogEntry) = Unit
    }

    private fun seedTask(jdbc: org.springframework.jdbc.core.JdbcTemplate) {
        jdbc.update(
            """INSERT INTO occ.cohort
               (id, customer_instance_id, code, name, package_version_id, owner_principal_id,
                start_date, status, created_by, updated_by)
               VALUES (?, '00000000-0000-7000-8000-000000000001', 'task-authz', 'Task authz', ?, ?,
                       current_date, 'DRAFT', ?, ?)""",
            COHORT_ID, PACKAGE_VERSION_ID, PRINCIPAL_ID, PRINCIPAL_ID, PRINCIPAL_ID,
        )
        jdbc.update("UPDATE occ.cohort SET status = 'ACTIVE' WHERE id = ?", COHORT_ID)
        jdbc.update(
            "INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state) VALUES (?, ?, ?, 'process:task-authz', 'ACTIVE')",
            PROCESS_ID, TYPE_ID, TYPE_VERSION_ID,
        )
        jdbc.update(
            """INSERT INTO occ.process_instance
               (id, definition_binding_id, package_version_id, flowable_instance_id, business_key, state,
                started_by, cohort_id, started_for_participant_id, participant_id, route_key, route_version)
               VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, 'task-authz', 1)""",
            PROCESS_ID, BINDING_ID, PACKAGE_VERSION_ID, "instance-$PROCESS_ID", "business-$PROCESS_ID",
            PRINCIPAL_ID, COHORT_ID, PRINCIPAL_ID, PRINCIPAL_ID,
        )
        jdbc.update(
            """INSERT INTO occ.task_projection
               (id, process_instance_id, activity_key, activity_name, flowable_task_id,
                flowable_execution_id, state)
               VALUES (?, ?, 'complete', 'Complete', ?, ?, 'AVAILABLE')""",
            TASK_ID, PROCESS_ID, "task-$TASK_ID", "execution-$TASK_ID",
        )
        jdbc.update(
            """UPDATE occ.task_projection SET state = 'CLAIMED', assignee_id = ?, claimed_at = transaction_timestamp()
               WHERE id = ?""",
            PRINCIPAL_ID, TASK_ID,
        )
        jdbc.update(
            """INSERT INTO authz.relationship
               (id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref)
               VALUES (?, ?, ?, ?, 'SYSTEM', 'task-assignee')""",
            UUID.randomUUID(), UUID.fromString(WorkflowAuthorizationRelationDefinitions.TASK_ASSIGNEE_ID), PRINCIPAL_ID, TASK_ID,
        )
    }

    private fun taskCompleteRequest(
        hardBlockersAbsent: Boolean,
        processState: String,
        taskState: String = "AVAILABLE",
    ) = AuthorizationRequest(
        UUID.randomUUID(), PRINCIPAL_ID, "task.complete", COHORT_ID, TASK_ID,
        mapOf(
            "commandKey" to "task.complete",
            "processState" to processState,
            "hardBlockersAbsent" to hardBlockersAbsent,
            "taskState" to taskState,
        ),
    )

    private data class RelationshipSeed(
        val definitionId: String,
        val objectId: UUID,
        val sourceRef: String,
        val validFrom: String,
        val validUntil: String,
        val revokedAt: String,
    )

    companion object {
        private const val EMPTY_MANIFEST = """{"version":1,"roleGrants":[],"forbiddenActions":[]}"""
        private const val TASK_COMPLETE_MANIFEST = """{"version":1,"roleGrants":[{"id":"task-complete-allow","effect":"ALLOW","action":"task.complete","entityId":"*","resourceId":"*","subjectRoleEntityKey":"role:administrator"}],"forbiddenActions":[]}"""
        private val PACKAGE_VERSION_ID = UUID.fromString("73000000-0000-7000-8000-000000000002")
        private val TYPE_ID = UUID.fromString("73000000-0000-7000-8000-000000000003")
        private val TYPE_VERSION_ID = UUID.fromString("73000000-0000-7000-8000-000000000004")
        private val PRINCIPAL_ID = UUID.fromString("73000000-0000-7000-8000-000000000007")
        private val COHORT_ID = UUID.fromString("73000000-0000-7000-8000-000000000008")
        private val TASK_ID = UUID.fromString("73000000-0000-7000-8000-000000000009")
        private val WORKFLOW_ID = UUID.fromString("75000000-0000-7000-8000-000000000001")
        private val BINDING_ID = UUID.fromString("75000000-0000-7000-8000-000000000002")
        private val PROCESS_ID = UUID.fromString("75000000-0000-7000-8000-000000000003")
        private val MATRIX_ENTITY_ID = UUID.fromString("73000000-0000-7000-8000-000000000008")
        private val MATRIX_ADMINISTRATOR_ROLE_ID = UUID.fromString("73000000-0000-7000-8000-000000000010")
        private val MATRIX_ROLE_TYPE_ID = UUID.fromString("73000000-0000-7000-8000-000000000005")
        private val MATRIX_ROLE_TYPE_VERSION_ID = UUID.fromString("73000000-0000-7000-8000-000000000006")
        private val SPOOF_PACKAGE_ID = UUID.fromString("76000000-0000-7000-8000-000000000001")
        private val SPOOF_PACKAGE_VERSION_ID = UUID.fromString("76000000-0000-7000-8000-000000000002")
        private val SPOOF_TEACHER_RELATION_ID = UUID.fromString("76000000-0000-7000-8000-000000000003")
        private val SPOOF_ASSIGNEE_RELATION_ID = UUID.fromString("76000000-0000-7000-8000-000000000004")
        private val WORKFLOW_ACTIONS = WorkflowAuthorizationRoles.processOwnerActions +
            WorkflowAuthorizationRoles.participantActions
        private val WORKFLOW_ROLE_MATRIX = linkedMapOf(
            WorkflowAuthorizationRole(MATRIX_ADMINISTRATOR_ROLE_ID, "role:administrator", "Administrator") to emptySet(),
            WorkflowAuthorizationRole(BootstrapIds.OPERATOR_ROLE, "role:operator", "Operator") to emptySet(),
            WorkflowAuthorizationRole(BootstrapIds.VIEWER_ROLE, "role:viewer", "Viewer") to emptySet(),
            WorkflowAuthorizationRoles.domainModeler to emptySet(),
            WorkflowAuthorizationRoles.processOwner to WorkflowAuthorizationRoles.processOwnerActions,
            WorkflowAuthorizationRoles.participant to WorkflowAuthorizationRoles.participantActions,
        )

        @Container
        @JvmStatic
        val opa: GenericContainer<*> = GenericContainer(
            DockerImageName.parse(System.getenv("OPA_DOCKER_IMAGE") ?: "openpolicyagent/opa:1.5.1"),
        ).withFileSystemBind(policyDirectory().toString(), "/workspace/policies/opa", BindMode.READ_ONLY)
            .withWorkingDirectory("/workspace")
            .withCommand("run", "--server", "--addr=0.0.0.0:8181", "policies/opa")
            .withExposedPorts(8181)
            .waitingFor(Wait.forHttp("/health"))

        private fun policyDirectory(): Path = sequenceOf(
            Path.of("policies", "opa"),
            Path.of("..", "..", "policies", "opa"),
        ).map(Path::toAbsolutePath).firstOrNull(Files::isDirectory)
            ?: error("OPA policy directory is unavailable")
    }
}
