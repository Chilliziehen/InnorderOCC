package com.innorder.occ.cohort

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.authz.AuthorizationDecision
import com.innorder.occ.authz.AuthorizationDecisionValue
import com.innorder.occ.authz.AuthorizationEntity
import com.innorder.occ.authz.AuthorizationPrincipal
import com.innorder.occ.authz.AuthorizationResource
import com.innorder.occ.authz.AuthorizationAvailabilityException
import com.innorder.occ.authz.AuthorizationRevisionLockRepository
import com.innorder.occ.authz.AuthorizationService
import com.innorder.occ.authz.AuthorizationSnapshot
import com.innorder.occ.authz.DecisionAuditLog
import com.innorder.occ.authz.DecisionLogEntry
import com.innorder.occ.authz.PolicyLayer
import com.innorder.occ.authz.WorkflowAuthorizationRelationDefinitions
import com.innorder.occ.authz.WorkflowAuthorizationRoles
import com.innorder.occ.catalog.EmbeddedWorkflowCatalogIds
import com.innorder.occ.catalog.EmbeddedWorkflowCatalogInstaller
import com.innorder.occ.api.cursor.CursorFilterDigest
import com.innorder.occ.api.cursor.CursorKeyRing
import com.innorder.occ.api.cursor.CursorProperties
import com.innorder.occ.api.cursor.HmacCursorCodec
import com.innorder.occ.api.cursor.InvalidCursorException
import com.innorder.occ.command.AggregateLockRegistry
import com.innorder.occ.command.AggregateReference
import com.innorder.occ.command.AuditRepository
import com.innorder.occ.command.CommandExecutor
import com.innorder.occ.command.CanonicalJsonObject
import com.innorder.occ.command.IdempotencyConflictException
import com.innorder.occ.command.IdempotencyRepository
import com.innorder.occ.command.OptimisticConflictException
import com.innorder.occ.events.OutboxRepository
import com.innorder.occ.iam.BootstrapIds
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.postgresql.ds.PGSimpleDataSource
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import java.time.LocalDate
import java.time.Instant
import java.time.OffsetDateTime
import java.time.Clock
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

@Testcontainers(disabledWithoutDocker = true)
class CohortIntegrationTest {
    @Test
    fun `create command replays exactly conflicts on mismatch and reauthorizes before replay`() {
        val jdbc = JdbcTemplate(runtimeDataSource())
        val decisions = AtomicReference(AuthorizationDecisionValue.ALLOW)
        val service = commandService(jdbc, decisions)
        val request = CreateCohortRequest(
            "command-cohort", "Command", EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
            OWNER_ID, LocalDate.parse("2026-08-02"), null,
        )

        val first = service.create(ACTOR_ID, "cohort-create-command", CORRELATION_ID, request)
        val stored = jdbc.queryForMap(
            "SELECT response_body::text AS body, response_digest AS digest, resource_id FROM audit.idempotency_record WHERE principal_id = ? AND command_key = 'cohort.create' AND idempotency_key = 'cohort-create-command'",
            ACTOR_ID,
        )
        assertThat(CanonicalJsonObject.parse(stored.getValue("body").toString().toByteArray(), CanonicalJsonObject.MAX_BYTES).digest)
            .isEqualTo(stored["digest"])
        assertThat(stored["resource_id"]).isEqualTo(CUSTOMER_ID)
        val replay = service.create(ACTOR_ID, "cohort-create-command", CORRELATION_ID, request)

        assertThat(first.replayed).isFalse()
        assertThat(replay).isEqualTo(first.copy(replayed = true))
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM audit.outbox_event WHERE aggregate_id = ? AND event_type = 'cohort.created'",
            Long::class.java,
            first.value.id,
        )).isEqualTo(1)
        assertThatThrownBy {
            service.create(ACTOR_ID, "cohort-create-command", CORRELATION_ID, request.copy(name = "Mismatch"))
        }.isInstanceOf(IdempotencyConflictException::class.java)

        decisions.set(AuthorizationDecisionValue.DENY)
        assertThatThrownBy {
            service.create(ACTOR_ID, "cohort-create-command", CORRELATION_ID, request)
        }.isInstanceOf(com.innorder.occ.authz.AuthorizationDeniedException::class.java)
    }

    @Test
    fun `update command changes mutable fields once and rejects stale version`() {
        val jdbc = JdbcTemplate(runtimeDataSource())
        val service = commandService(jdbc)
        val created = service.create(
            ACTOR_ID,
            "cohort-update-create",
            CORRELATION_ID,
            CreateCohortRequest(
                "update-cohort", "Before", EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
                OWNER_ID, LocalDate.parse("2026-08-02"), null,
            ),
        ).value
        val update = ObjectMapper().findAndRegisterModules().readValue(
            """{"expectedVersion":1,"name":"After","startDate":"2026-08-03","endDate":"2026-08-04"}""",
            UpdateCohortRequest::class.java,
        )

        val changed = service.update(ACTOR_ID, "cohort-update", CORRELATION_ID, created.id, update).value

        assertThat(changed.name).isEqualTo("After")
        assertThat(changed.startDate).isEqualTo(LocalDate.parse("2026-08-03"))
        assertThat(changed.endDate).isEqualTo(LocalDate.parse("2026-08-04"))
        assertThat(changed.packageVersionId).isEqualTo(created.packageVersionId)
        assertThat(changed.version).isEqualTo(2)
        assertThatThrownBy {
            service.update(ACTOR_ID, "cohort-update-stale", CORRELATION_ID, created.id, update)
        }.isInstanceOf(OptimisticConflictException::class.java)
            .extracting("currentVersion").isEqualTo(2L)
    }

    @Test
    fun `membership commands close active intervals and permit re-enrollment with one revision each`() {
        val jdbc = JdbcTemplate(runtimeDataSource())
        val service = commandService(jdbc)
        val created = service.create(
            ACTOR_ID, "member-create", CORRELATION_ID,
            CreateCohortRequest(
                "member-cohort", "Members", EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
                OWNER_ID, LocalDate.parse("2026-08-02"), null,
            ),
        ).value
        val revision = authorizationRevision(jdbc)

        val added = service.addMember(
            ACTOR_ID, "member-add", CORRELATION_ID, created.id,
            AddCohortMemberRequest(created.version, MEMBER_ID, CohortMemberRole.TEACHER, Instant.now().plusSeconds(3600)),
        ).value
        assertThat(added.members.filter { it.role == CohortMemberRole.TEACHER }).hasSize(1)
        assertThat(authorizationRevision(jdbc)).isEqualTo(revision + 1)

        val removed = service.removeMember(
            ACTOR_ID, "member-remove", CORRELATION_ID, created.id,
            RemoveCohortMemberRequest(added.version, MEMBER_ID, CohortMemberRole.TEACHER),
        ).value
        assertThat(removed.members.filter { it.role == CohortMemberRole.TEACHER }).isEmpty()
        assertThat(authorizationRevision(jdbc)).isEqualTo(revision + 2)
        val closed = jdbc.queryForMap(
            """SELECT valid_from, valid_until, revoked_at FROM authz.relationship
               WHERE object_entity_id = ? AND subject_entity_id = ? AND relation_definition_id = ?""",
            created.id, MEMBER_ID, UUID.fromString(WorkflowAuthorizationRelationDefinitions.COHORT_TEACHER_ID),
        )
        assertThat(closed["valid_until"]).isEqualTo(closed["revoked_at"])

        val readded = service.addMember(
            ACTOR_ID, "member-readd", CORRELATION_ID, created.id,
            AddCohortMemberRequest(removed.version, MEMBER_ID, CohortMemberRole.TEACHER),
        ).value
        assertThat(readded.members.filter { it.role == CohortMemberRole.TEACHER }).hasSize(1)
        assertThat(authorizationRevision(jdbc)).isEqualTo(revision + 3)
        assertThat(jdbc.queryForObject(
            """SELECT count(*) FROM authz.relationship
               WHERE object_entity_id = ? AND subject_entity_id = ? AND relation_definition_id = ?""",
            Long::class.java, created.id, MEMBER_ID,
            UUID.fromString(WorkflowAuthorizationRelationDefinitions.COHORT_TEACHER_ID),
        )).isEqualTo(2)
    }

    @Test
    fun `owner transfer and archive are atomic versioned terminal commands`() {
        val jdbc = JdbcTemplate(runtimeDataSource())
        val service = commandService(jdbc)
        val created = service.create(
            ACTOR_ID, "owner-create", CORRELATION_ID,
            CreateCohortRequest(
                "owner-cohort", "Owner", EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
                OWNER_ID, LocalDate.parse("2026-08-02"), null,
            ),
        ).value
        val withTeacher = service.addMember(
            ACTOR_ID, "owner-teacher", CORRELATION_ID, created.id,
            AddCohortMemberRequest(created.version, MEMBER_ID, CohortMemberRole.TEACHER),
        ).value
        val beforeTransferRevision = authorizationRevision(jdbc)

        val transferred = service.transferOwner(
            ACTOR_ID, "owner-transfer", CORRELATION_ID, created.id,
            TransferCohortOwnerRequest(withTeacher.version, MEMBER_ID, "handover"),
        ).value

        assertThat(transferred.ownerPrincipalId).isEqualTo(MEMBER_ID)
        assertThat(transferred.members.filter { it.role == CohortMemberRole.OWNER })
            .extracting<UUID> { it.principalId }.containsExactly(MEMBER_ID)
        assertThat(authorizationRevision(jdbc)).isEqualTo(beforeTransferRevision + 1)
        assertThat(jdbc.queryForObject(
            """SELECT count(*) FROM authz.relationship relationship
               JOIN catalog.relation_definition definition ON definition.id = relationship.relation_definition_id
               WHERE relationship.object_entity_id = ? AND definition.relation_key = 'cohort_owner'""",
            Long::class.java, created.id,
        )).isEqualTo(2)

        val archived = service.archive(
            ACTOR_ID, "owner-archive", CORRELATION_ID, created.id,
            ArchiveCohortRequest(transferred.version, "complete"),
        ).value
        assertThat(archived.status).isEqualTo(CohortStatus.ARCHIVED)
        assertThat(archived.version).isEqualTo(transferred.version + 1)
        assertThatThrownBy {
            service.update(
                ACTOR_ID, "archived-update", CORRELATION_ID, created.id,
                ObjectMapper().findAndRegisterModules().readValue(
                    """{"expectedVersion":${archived.version},"name":"Forbidden"}""",
                    UpdateCohortRequest::class.java,
                ),
            )
        }.isInstanceOf(CohortConflictException::class.java)
        assertThat(jdbc.queryForList(
            "SELECT event_type FROM audit.outbox_event WHERE aggregate_id = ? ORDER BY aggregate_version",
            String::class.java,
            created.id,
        )).containsExactly(
            "cohort.created", "cohort.member-added", "cohort.owner-transferred", "cohort.archived",
        )
    }

    @Test
    fun `list authorizes candidates before seek and binds filters in a tamper evident cursor`() {
        val jdbc = JdbcTemplate(runtimeDataSource())
        val commands = commandService(jdbc)
        val created = (1..3).map { index ->
            commands.create(
                ACTOR_ID, "query-create-$index", CORRELATION_ID,
                CreateCohortRequest(
                    "query-cohort-$index", "Query $index", EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
                    OWNER_ID, LocalDate.parse("2026-08-0$index"), null,
                ),
            ).value
        }
        val authorizationCalls = mutableListOf<UUID>()
        val query = queryService(jdbc) { request ->
            authorizationCalls += request.resourceId
            AuthorizationDecisionValue.ALLOW
        }
        val filter = CohortListFilter(CohortStatus.DRAFT, EmbeddedWorkflowCatalogIds.PACKAGE_VERSION, null)

        val first = query.list(ACTOR_ID, CORRELATION_ID, filter, 1, null)
        val cursor = first.page.nextCursor!!
        authorizationCalls.clear()
        val second = query.list(ACTOR_ID, CORRELATION_ID, filter, 1, cursor)

        assertThat(first.items).hasSize(1)
        assertThat(second.items).hasSize(1)
        assertThat(second.items.single().id).isNotEqualTo(first.items.single().id)
        assertThat(authorizationCalls).containsAll(created.map { it.id })
        assertThat(authorizationCalls).doesNotHaveDuplicates()
        assertThatThrownBy {
            query.list(ACTOR_ID, CORRELATION_ID, filter, 1, cursor.dropLast(1) + if (cursor.last() == 'A') "B" else "A")
        }.isInstanceOf(InvalidCursorException::class.java)
        assertThatThrownBy {
            query.list(ACTOR_ID, CORRELATION_ID, filter.copy(status = CohortStatus.ARCHIVED), 1, cursor)
        }.isInstanceOf(InvalidCursorException::class.java)
    }

    @Test
    fun `get and list fail closed on denial and authorization unavailability`() {
        val jdbc = JdbcTemplate(runtimeDataSource())
        val created = commandService(jdbc).create(
            ACTOR_ID, "query-deny-create", CORRELATION_ID,
            CreateCohortRequest(
                "query-deny", "Deny", EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
                OWNER_ID, LocalDate.parse("2026-08-02"), null,
            ),
        ).value
        val denied = queryService(jdbc) { AuthorizationDecisionValue.DENY }
        val unavailable = queryService(jdbc) { AuthorizationDecisionValue.ERROR }

        assertThatThrownBy { denied.get(ACTOR_ID, CORRELATION_ID, created.id) }
            .isInstanceOf(com.innorder.occ.authz.AuthorizationDeniedException::class.java)
        assertThat(denied.list(ACTOR_ID, CORRELATION_ID, CohortListFilter(), 25, null).items).isEmpty()
        assertThatThrownBy { unavailable.list(ACTOR_ID, CORRELATION_ID, CohortListFilter(), 25, null) }
            .isInstanceOf(AuthorizationAvailabilityException::class.java)
    }

    @Test
    fun `create persists aggregate and sole owner relation while revision changes once`() {
        val jdbc = JdbcTemplate(runtimeDataSource())
        val repository = CohortRepository(jdbc)
        val beforeRevision = jdbc.queryForObject(
            "SELECT current_revision FROM authz.authorization_state WHERE singleton",
            Long::class.java,
        )!!
        val cohortId = UUID.randomUUID()

        val created = TransactionTemplate(DataSourceTransactionManager(jdbc.dataSource!!)).execute {
            assertThat(repository.publishedPackage(EmbeddedWorkflowCatalogIds.PACKAGE_VERSION)).isTrue()
            assertThat(repository.activeProcessOwner(OWNER_ID)).isTrue()
            repository.beginAuthorizationChange()
            val detail = repository.create(
                cohortId,
                CUSTOMER_ID,
                CreateCohortRequest(
                    "alpha-cohort", "Alpha", EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
                    OWNER_ID, LocalDate.parse("2026-08-02"), null,
                ),
                ACTOR_ID,
            )
            repository.finishAuthorizationChange()
            detail
        }!!

        assertThat(created.id).isEqualTo(cohortId)
        assertThat(created.version).isEqualTo(1)
        assertThat(created.status).isEqualTo(CohortStatus.DRAFT)
        assertThat(created.members).containsExactly(
            CohortMember(OWNER_ID, CohortMemberRole.OWNER, created.createdAt, null),
        )
        assertThat(jdbc.queryForObject(
            "SELECT current_revision FROM authz.authorization_state WHERE singleton",
            Long::class.java,
        )).isEqualTo(beforeRevision + 1)
        assertThat(jdbc.queryForObject(
            """SELECT count(*) FROM authz.relationship
               WHERE object_entity_id = ? AND revoked_at IS NULL""",
            Long::class.java,
            cohortId,
        )).isEqualTo(1)
    }

    @Test
    fun `cohort aggregate resolver locks and returns row version`() {
        val jdbc = JdbcTemplate(runtimeDataSource())
        val repository = CohortRepository(jdbc)
        val cohortId = UUID.randomUUID()
        TransactionTemplate(DataSourceTransactionManager(jdbc.dataSource!!)).executeWithoutResult {
            repository.beginAuthorizationChange()
            repository.create(
                cohortId, CUSTOMER_ID,
                CreateCohortRequest(
                    "lock-cohort", "Lock", EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
                    OWNER_ID, LocalDate.parse("2026-08-02"), null,
                ),
                ACTOR_ID,
            )
            repository.finishAuthorizationChange()
        }
        val resolver = cohortAggregateLockResolver()

        val version = TransactionTemplate(DataSourceTransactionManager(jdbc.dataSource!!)).execute {
            resolver.lock(jdbc, cohortId)
        }

        assertThat(resolver.type).isEqualTo(COHORT_AGGREGATE_TYPE)
        assertThat(version).isEqualTo(1)
        assertThat(AggregateReference(resolver.type, cohortId).id).isEqualTo(cohortId)
    }

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        private val CUSTOMER_ID = UUID.fromString("00000000-0000-7000-8000-000000000001")
        private val ACTOR_ID = UUID.fromString("61000000-0000-7000-8000-000000000001")
        private val OWNER_ID = UUID.fromString("61000000-0000-7000-8000-000000000002")
        private val CORRELATION_ID = UUID.fromString("61000000-0000-4000-8000-000000000003")
        private val MEMBER_ID = UUID.fromString("61000000-0000-7000-8000-000000000004")

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
            val admin = JdbcTemplate(adminDataSource())
            seedPlatformCatalog(admin)
            EmbeddedWorkflowCatalogInstaller(
                admin,
                TransactionTemplate(DataSourceTransactionManager(admin.dataSource!!)),
            ).installPackage()
            seedPrincipals(admin)
        }

        private fun seedPlatformCatalog(jdbc: JdbcTemplate) {
            jdbc.update(
                "INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, 'platform-iam', 'Platform IAM', 'ACTIVE')",
                BootstrapIds.PACKAGE,
            )
            jdbc.update(
                "INSERT INTO catalog.package_version(id, package_id, semver, status) VALUES (?, ?, '1.0.0', 'DRAFT')",
                BootstrapIds.PACKAGE_VERSION, BootstrapIds.PACKAGE,
            )
            listOf(
                arrayOf(BootstrapIds.USER_TYPE, "platform.user", "User", "PRINCIPAL"),
                arrayOf(BootstrapIds.ROLE_TYPE, "platform.role", "Role", "PRINCIPAL"),
            ).forEach { row ->
                jdbc.update(
                    "INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind, authorizable) VALUES (?, ?, ?, ?, ?, true)",
                    row[0], BootstrapIds.PACKAGE, row[1], row[2], row[3],
                )
            }
            listOf(
                arrayOf(BootstrapIds.USER_TYPE_VERSION, BootstrapIds.USER_TYPE),
                arrayOf(BootstrapIds.ROLE_TYPE_VERSION, BootstrapIds.ROLE_TYPE),
            ).forEach { row ->
                jdbc.update(
                    "INSERT INTO catalog.entity_type_version(id, entity_type_id, package_version_id, schema_version, json_schema) VALUES (?, ?, ?, 1, '{}'::jsonb)",
                    row[0], row[1], BootstrapIds.PACKAGE_VERSION,
                )
            }
            jdbc.update(
                """INSERT INTO catalog.relation_definition
                   (id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality, auth_relevant)
                   VALUES (?, ?, 'platform.role-assignment', ?, ?, 'MANY_TO_MANY', true)""",
                BootstrapIds.ROLE_ASSIGNMENT_RELATION, BootstrapIds.PACKAGE_VERSION,
                BootstrapIds.USER_TYPE, BootstrapIds.ROLE_TYPE,
            )
            jdbc.update(
                "UPDATE catalog.package_version SET status = 'PUBLISHED', content_hash = repeat('a', 64), published_at = transaction_timestamp() WHERE id = ?",
                BootstrapIds.PACKAGE_VERSION,
            )
        }

        private fun seedPrincipals(jdbc: JdbcTemplate) {
            listOf(
                arrayOf(ACTOR_ID, BootstrapIds.USER_TYPE, BootstrapIds.USER_TYPE_VERSION, "user:actor", "USER", "Actor"),
                arrayOf(OWNER_ID, BootstrapIds.USER_TYPE, BootstrapIds.USER_TYPE_VERSION, "user:owner", "USER", "Owner"),
                arrayOf(MEMBER_ID, BootstrapIds.USER_TYPE, BootstrapIds.USER_TYPE_VERSION, "user:member", "USER", "Member"),
                arrayOf(WorkflowAuthorizationRoles.processOwner.id, BootstrapIds.ROLE_TYPE, BootstrapIds.ROLE_TYPE_VERSION, WorkflowAuthorizationRoles.processOwner.key, "ROLE", "Process Owner"),
            ).forEach { row ->
                jdbc.update(
                    "INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state) VALUES (?, ?, ?, ?, 'ACTIVE')",
                    row[0], row[1], row[2], row[3],
                )
                jdbc.update(
                    "INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, ?, ?, 'ACTIVE')",
                    row[0], row[4], row[5],
                )
            }
            jdbc.update(
                """INSERT INTO authz.relationship
                   (id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref)
                   VALUES (?, ?, ?, ?, 'SYSTEM', 'cohort-test')""",
                UUID.randomUUID(), BootstrapIds.ROLE_ASSIGNMENT_RELATION,
                OWNER_ID, WorkflowAuthorizationRoles.processOwner.id,
            )
        }

        private fun runtimeDataSource() = PGSimpleDataSource().apply {
            setURL(postgres.jdbcUrl)
            user = "innorder_runtime"
            password = "runtime-test-only"
        }

        private fun adminDataSource() = PGSimpleDataSource().apply {
            setURL(postgres.jdbcUrl)
            user = postgres.username
            password = postgres.password
        }

        private fun commandService(
            jdbc: JdbcTemplate,
            decisions: AtomicReference<AuthorizationDecisionValue> = AtomicReference(AuthorizationDecisionValue.ALLOW),
        ): CohortCommandService {
            val releases = mapOf(PolicyLayer.PLATFORM to UUID.fromString("61000000-0000-7000-8000-000000000010"))
            val authorization = AuthorizationService(
                { request ->
                    AuthorizationSnapshot(
                        2,
                        request.requestId,
                        jdbc.queryForObject(
                            "SELECT current_revision FROM authz.authorization_state WHERE singleton",
                            Long::class.java,
                        )!!,
                        releases,
                        AuthorizationPrincipal(request.principalId, true),
                        AuthorizationEntity(request.entityId),
                        request.action,
                        AuthorizationResource(request.resourceId, true),
                        request.context,
                        emptyList(),
                        emptyList(),
                        emptyList(),
                        releases.getValue(PolicyLayer.PLATFORM),
                        "cohort-test-v1",
                        mapOf(request.principalId to 0L, request.entityId to 0L, request.resourceId to 0L),
                        "0".repeat(64),
                        OffsetDateTime.now(),
                    )
                },
                { snapshot ->
                    val outcome = decisions.get()
                    AuthorizationDecision(
                        2, snapshot.opaRevision, snapshot.requestId, snapshot.authorizationRevision,
                        snapshot.releases, outcome, outcome == AuthorizationDecisionValue.ALLOW,
                        listOf(if (outcome == AuthorizationDecisionValue.ALLOW) "ALLOW_TEST" else "DENY_TEST"),
                        listOf("policy:${"1".repeat(64)}"),
                        if (outcome == AuthorizationDecisionValue.ALLOW) listOf("policy:${"1".repeat(64)}") else emptyList(),
                    )
                },
                object : DecisionAuditLog {
                    override fun persistInCallerTransaction(entry: DecisionLogEntry) = Unit
                    override fun persistIndependently(entry: DecisionLogEntry) = Unit
                },
            )
            val repository = CohortRepository(jdbc)
            val executor = CommandExecutor(
                DataSourceTransactionManager(jdbc.dataSource!!),
                authorization,
                AuthorizationRevisionLockRepository(jdbc),
                IdempotencyRepository(jdbc),
                AuditRepository(jdbc),
                OutboxRepository(jdbc),
                AggregateLockRegistry(listOf(cohortAggregateLockResolver())),
                jdbc,
            )
            return CohortCommandService(executor, repository, ObjectMapper().findAndRegisterModules())
        }

        private fun authorizationRevision(jdbc: JdbcTemplate): Long = jdbc.queryForObject(
            "SELECT current_revision FROM authz.authorization_state WHERE singleton",
            Long::class.java,
        )!!

        private fun queryService(
            jdbc: JdbcTemplate,
            decide: (com.innorder.occ.authz.AuthorizationRequest) -> AuthorizationDecisionValue,
        ): CohortQueryService {
            val releases = mapOf(PolicyLayer.PLATFORM to UUID.fromString("61000000-0000-7000-8000-000000000010"))
            val requests = java.util.concurrent.ConcurrentHashMap<UUID, com.innorder.occ.authz.AuthorizationRequest>()
            val authorization = AuthorizationService(
                { request ->
                    requests[request.requestId] = request
                    AuthorizationSnapshot(
                        2, request.requestId, authorizationRevision(jdbc), releases,
                        AuthorizationPrincipal(request.principalId, true), AuthorizationEntity(request.entityId),
                        request.action, AuthorizationResource(request.resourceId, true), request.context,
                        emptyList(), emptyList(), emptyList(), releases.getValue(PolicyLayer.PLATFORM),
                        "cohort-test-v1", mapOf(request.principalId to 0L, request.resourceId to 0L),
                        "0".repeat(64), OffsetDateTime.now(),
                    )
                },
                { snapshot ->
                    val outcome = decide(requests.getValue(snapshot.requestId))
                    AuthorizationDecision(
                        2, snapshot.opaRevision, snapshot.requestId, snapshot.authorizationRevision,
                        snapshot.releases, outcome, outcome == AuthorizationDecisionValue.ALLOW,
                        listOf(outcome.name), listOf("policy:${"2".repeat(64)}"),
                        if (outcome == AuthorizationDecisionValue.ALLOW) listOf("policy:${"2".repeat(64)}") else emptyList(),
                    )
                },
                object : DecisionAuditLog {
                    override fun persistInCallerTransaction(entry: DecisionLogEntry) = Unit
                    override fun persistIndependently(entry: DecisionLogEntry) = Unit
                },
            )
            val keyFile = Files.createTempFile("cohort-cursor", ".key")
            Files.write(keyFile, ByteArray(64) { index -> (index + 1).toByte() })
            keyFile.toFile().deleteOnExit()
            val clock = Clock.systemUTC()
            val keys = CursorKeyRing.load(CursorProperties("cohort-test", keyFile.toString()), clock)
            val mapper = ObjectMapper().findAndRegisterModules()
            return CohortQueryService(
                CohortRepository(jdbc), authorization, DataSourceTransactionManager(jdbc.dataSource!!),
                HmacCursorCodec(keys, mapper, clock), CursorFilterDigest(mapper), keys, clock,
            )
        }
    }
}
