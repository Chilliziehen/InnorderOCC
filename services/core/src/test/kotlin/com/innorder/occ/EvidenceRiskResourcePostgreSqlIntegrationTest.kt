package com.innorder.occ

import org.assertj.core.api.Assertions.assertThat
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIf
import org.postgresql.util.PSQLException
import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.DockerClientFactory
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import java.util.UUID
import javax.sql.DataSource

@EnabledIf("dockerAvailableOrRequired")
@Testcontainers
class EvidenceRiskResourcePostgreSqlIntegrationTest {
    @Test
    fun `Flyway applies V014 and keeps trigger functions outside the runtime API`() {
        if (System.getenv("INNORDER_VERIFY_DATABASE_TEST_SELECTION") == "1") {
            assertThat(System.getProperty(REQUIRED_PROPERTY))
                .describedAs("explicit Gradle selection requires Docker")
                .isEqualTo("true")
        }
        assertThat(flywayJdbc.queryForObject(
            "SELECT success FROM flyway_schema_history WHERE version::integer = 14",
            Boolean::class.java,
        )).isTrue()
        assertThat(runtimeJdbc.queryForObject("SELECT current_user", String::class.java))
            .isEqualTo("innorder_runtime")
        assertThat(flywayJdbc.queryForObject(
            "SELECT has_table_privilege('innorder_runtime', 'occ.risk_action', 'SELECT,INSERT,UPDATE,DELETE')",
            Boolean::class.java,
        )).isTrue()
        assertThat(flywayJdbc.queryForObject(
            "SELECT has_function_privilege('innorder_runtime', 'occ.validate_resource_reservation()', 'EXECUTE')",
            Boolean::class.java,
        )).isFalse()
    }

    @Test
    fun `evidence facts are immutable segregated and protected from cleanup by legal hold`() {
        val fixture = seedEvidence()

        assertPostgresRejects("55000", "occ.evidence_version row is immutable") {
            runtimeJdbc.update("UPDATE occ.evidence_version SET mime_type = 'text/plain' WHERE id = ?", fixture.version)
        }
        assertPostgresRejects("55000", "occ.evidence_version row is immutable") {
            runtimeJdbc.update("DELETE FROM occ.evidence_version WHERE id = ?", fixture.version)
        }
        assertPostgresRejects("42501", "reviewer must differ from submitter and evidence creator") {
            runtimeJdbc.update(
                """INSERT INTO occ.evidence_review
                   (id, evidence_version_id, reviewer_id, decision, gate_satisfied)
                   VALUES (?, ?, ?, 'ACCEPTED', true)""",
                UUID.randomUUID(), fixture.version, fixture.submitter,
            )
        }
        assertPostgresRejects("42501", "reviewer must differ from submitter and evidence creator") {
            runtimeJdbc.update(
                """INSERT INTO occ.evidence_review
                   (id, evidence_version_id, reviewer_id, decision, gate_satisfied)
                   VALUES (?, ?, ?, 'ACCEPTED', true)""",
                UUID.randomUUID(), fixture.version, fixture.creator,
            )
        }

        val review = UUID.randomUUID()
        runtimeJdbc.update(
            """INSERT INTO occ.evidence_review
               (id, evidence_version_id, reviewer_id, decision, gate_satisfied)
               VALUES (?, ?, ?, 'ACCEPTED', true)""",
            review, fixture.version, fixture.reviewer,
        )
        assertPostgresRejects("55000", "occ.evidence_review row is immutable") {
            runtimeJdbc.update("UPDATE occ.evidence_review SET reason = 'changed' WHERE id = ?", review)
        }
        assertPostgresRejects("55000", "occ.evidence_review row is immutable") {
            runtimeJdbc.update("DELETE FROM occ.evidence_review WHERE id = ?", review)
        }

        runtimeJdbc.update(
            "UPDATE occ.evidence SET legal_hold_at = now(), legal_hold_by = ?, legal_hold_reason = 'litigation' WHERE id = ?",
            fixture.reviewer, fixture.evidence,
        )
        val disposition = UUID.randomUUID()
        runtimeJdbc.update(
            """INSERT INTO occ.evidence_object_disposition
               (id, evidence_version_id, upload_session_id, object_key, disposition_state)
               VALUES (?, ?, ?, ?, 'RETAINED')""",
            disposition, fixture.version, fixture.upload, fixture.objectKey,
        )
        assertPostgresRejects("55000", "legal hold or backup snapshot prevents object cleanup") {
            runtimeJdbc.update(
                "UPDATE occ.evidence_object_disposition SET disposition_state = 'CLEANUP_PENDING' WHERE id = ?",
                disposition,
            )
        }
    }

    @Test
    fun `risk occurrence and action history reject mutation and invalid lifecycle changes`() {
        val fixture = newFixture()
        val target = fixture.entity("risk-target")
        val risk = fixture.entity("risk-head")
        val actor = fixture.principal("risk-actor")
        val rule = UUID.randomUUID()
        val occurrence = UUID.randomUUID()
        val action = UUID.randomUUID()
        flywayJdbc.update(
            """INSERT INTO catalog.risk_rule_definition
               (id, package_version_id, rule_key, dmn_key, severity, content_hash)
               VALUES (?, ?, ?, 'risk-dmn', 'YELLOW', ?)""",
            rule, fixture.packageVersion, "rule-${fixture.key}", "b".repeat(64),
        )
        executeTransaction(
            """INSERT INTO occ.risk
               (id, rule_definition_id, target_entity_id, severity, state, reason,
                occurrence_key, detected_at, evaluated_at, calendar_version)
               VALUES ('$risk', '$rule', '$target', 'YELLOW', 'OPEN', 'threshold',
                       'occurrence-${fixture.key}', now(), now(), 'calendar-v1')""",
            """INSERT INTO occ.risk_occurrence
               (id, risk_id, rule_definition_id, target_entity_id, occurrence_key,
                triggering_fact_ids, threshold_kind, calendar_version, evaluated_at, detected_at)
               SELECT '$occurrence', id, rule_definition_id, target_entity_id, occurrence_key,
                      '[]'::jsonb, 'ELAPSED', calendar_version, evaluated_at, detected_at
               FROM occ.risk WHERE id = '$risk'""",
        )
        runtimeJdbc.update(
            "INSERT INTO occ.risk_action(id, risk_id, actor_id, action_type) VALUES (?, ?, ?, 'ACKNOWLEDGED')",
            action, risk, actor,
        )

        assertPostgresRejects("55000", "occ.risk_occurrence row is immutable") {
            runtimeJdbc.update("UPDATE occ.risk_occurrence SET calendar_version = 'v2' WHERE id = ?", occurrence)
        }
        assertPostgresRejects("55000", "occ.risk_occurrence row is immutable") {
            runtimeJdbc.update("DELETE FROM occ.risk_occurrence WHERE id = ?", occurrence)
        }
        assertPostgresRejects("55000", "occ.risk_action row is immutable") {
            runtimeJdbc.update("UPDATE occ.risk_action SET reason = 'changed' WHERE id = ?", action)
        }
        assertPostgresRejects("55000", "occ.risk_action row is immutable") {
            runtimeJdbc.update("DELETE FROM occ.risk_action WHERE id = ?", action)
        }
        runtimeJdbc.update("UPDATE occ.risk SET state = 'ACKNOWLEDGED' WHERE id = ?", risk)
        assertPostgresRejects("23514", "invalid risk state transition") {
            runtimeJdbc.update("UPDATE occ.risk SET state = 'OPEN' WHERE id = ?", risk)
        }
    }

    @Test
    fun `reservation DML enforces canonical ranges exclusivity and peak capacity`() {
        val fixture = newFixture()
        val requester = fixture.entity("requester")
        val exclusiveResource = fixture.resource("exclusive-resource", 10)
        val capacityResource = fixture.resource("capacity-resource", 10)

        reserve(exclusiveResource, requester, "[2035-01-01 09:00:00+00,2035-01-01 10:00:00+00)", 2, false)
        assertPostgresRejects("23P01", "reservation conflicts with exclusivity") {
            reserve(exclusiveResource, requester, "[2035-01-01 09:30:00+00,2035-01-01 09:45:00+00)", 1, true)
        }
        assertPostgresRejects("22000", "reservation range must be finite and canonical [)") {
            reserve(capacityResource, requester, "[2035-01-01 09:00:00+00,2035-01-01 10:00:00+00]", 1, false)
        }

        reserve(capacityResource, requester, "[2035-01-01 09:00:00+00,2035-01-01 10:00:00+00)", 6, false)
        reserve(capacityResource, requester, "[2035-01-01 09:30:00+00,2035-01-01 10:30:00+00)", 4, false)
        reserve(capacityResource, requester, "[2035-01-01 10:00:00+00,2035-01-01 11:00:00+00)", 6, false)
        assertPostgresRejects("23P01", "reservation exceeds peak resource capacity") {
            reserve(capacityResource, requester, "[2035-01-01 09:45:00+00,2035-01-01 10:15:00+00)", 1, false)
        }
        val reservation = reserve(
            exclusiveResource,
            requester,
            "[2035-01-01 10:00:00+00,2035-01-01 11:00:00+00)",
            1,
            false,
        )
        assertPostgresRejects("23514", "invalid reservation state transition") {
            runtimeJdbc.update(
                "UPDATE occ.resource_reservation SET state = 'COMPLETED', completed_at = now() WHERE id = ?",
                reservation,
            )
        }
    }

    private fun seedEvidence(): EvidenceFixture {
        val fixture = newFixture()
        val creator = fixture.principal("evidence-creator")
        val submitter = fixture.principal("evidence-submitter")
        val reviewer = fixture.principal("evidence-reviewer")
        val target = fixture.entity("evidence-target")
        val evidence = fixture.entity("evidence-head")
        val requirement = UUID.randomUUID()
        val upload = UUID.randomUUID()
        val version = UUID.randomUUID()
        val objectKey = "immutable/${fixture.key}"
        flywayJdbc.update(
            "INSERT INTO occ.business_object(id, entity_type_version_id, lifecycle_state, created_by) VALUES (?, ?, 'ACTIVE', ?)",
            target, fixture.entityTypeVersion, creator,
        )
        flywayJdbc.update(
            """INSERT INTO catalog.evidence_requirement(id, package_version_id, requirement_key)
               VALUES (?, ?, ?)""",
            requirement, fixture.packageVersion, "requirement-${fixture.key}",
        )
        runtimeJdbc.update(
            """INSERT INTO occ.evidence
               (id, business_object_id, requirement_id, state, created_by, target_entity_id, slot_key)
               VALUES (?, ?, ?, 'PENDING', ?, ?, 'primary')""",
            evidence, target, requirement, creator, target,
        )
        runtimeJdbc.update(
            """INSERT INTO occ.upload_session
               (id, uploader_id, target_entity_id, object_key, expected_sha256, expected_size_bytes,
                status, expires_at, requirement_id, evidence_id, slot_key, normalized_extension,
                quarantine_object_key, immutable_object_key, absolute_deadline_at,
                expected_evidence_version, original_filename)
               VALUES (?, ?, ?, ?, ?, 10, 'CREATED', now() + interval '20 minutes', ?, ?, 'primary',
                       'pdf', ?, ?, now() + interval '90 minutes', 0, 'claim.pdf')""",
            upload, submitter, target, "quarantine/${fixture.key}", "a".repeat(64), requirement, evidence,
            "quarantine/${fixture.key}", objectKey,
        )
        runtimeJdbc.update(
            """UPDATE occ.upload_session
               SET status = 'STREAMING', lease_owner = ?, lease_acquired_at = now(),
                   lease_heartbeat_at = now(), lease_expires_at = now() + interval '10 minutes'
               WHERE id = ?""",
            submitter, upload,
        )
        runtimeJdbc.update("UPDATE occ.upload_session SET status = 'INSPECTING' WHERE id = ?", upload)
        runtimeJdbc.update("UPDATE occ.upload_session SET status = 'SCANNING' WHERE id = ?", upload)
        runtimeJdbc.update(
            """UPDATE occ.upload_session
               SET status = 'PROMOTING', actual_sha256 = expected_sha256, actual_size_bytes = expected_size_bytes,
                   detected_media_type = 'application/pdf', scanner_engine = 'test-scanner',
                   scanner_version = '1', scanner_result_ref = 'scan-result'
               WHERE id = ?""",
            upload,
        )
        runtimeJdbc.update(
            """INSERT INTO occ.evidence_version
               (id, evidence_id, version, object_key, sha256, mime_type, size_bytes, submitted_by,
                upload_session_id, detected_media_type, normalized_extension, scanner_engine,
                scanner_version, scanner_result, scanner_result_ref)
               VALUES (?, ?, 1, ?, ?, 'application/pdf', 10, ?, ?, 'application/pdf', 'pdf',
                       'test-scanner', '1', 'CLEAN', 'scan-result')""",
            version, evidence, objectKey, "a".repeat(64), submitter, upload,
        )
        runtimeJdbc.update("UPDATE occ.evidence SET state = 'SUBMITTED', current_version = 1 WHERE id = ?", evidence)
        return EvidenceFixture(evidence, version, upload, objectKey, creator, submitter, reviewer)
    }

    private fun newFixture(): Fixture {
        val key = UUID.randomUUID().toString()
        val packageId = UUID.randomUUID()
        val packageVersion = UUID.randomUUID()
        val entityType = UUID.randomUUID()
        val entityTypeVersion = UUID.randomUUID()
        flywayJdbc.update(
            "INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, ?, 'Integration fixture', 'ACTIVE')",
            packageId, "integration.$key",
        )
        flywayJdbc.update(
            "INSERT INTO catalog.package_version(id, package_id, semver, status) VALUES (?, ?, '1.0.0', 'DRAFT')",
            packageVersion, packageId,
        )
        flywayJdbc.update(
            "INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind) VALUES (?, ?, ?, 'Fixture', 'PRINCIPAL')",
            entityType, packageId, "fixture_$key",
        )
        flywayJdbc.update(
            """INSERT INTO catalog.entity_type_version
               (id, entity_type_id, package_version_id, schema_version, json_schema)
               VALUES (?, ?, ?, 1, '{}'::jsonb)""",
            entityTypeVersion, entityType, packageVersion,
        )
        return Fixture(key, packageVersion, entityType, entityTypeVersion)
    }

    private fun Fixture.entity(suffix: String): UUID {
        val id = UUID.randomUUID()
        flywayJdbc.update(
            """INSERT INTO authz.entity
               (id, entity_type_id, entity_type_version_id, entity_key, state)
               VALUES (?, ?, ?, ?, 'ACTIVE')""",
            id, entityType, entityTypeVersion, "$suffix:$key",
        )
        return id
    }

    private fun Fixture.principal(suffix: String): UUID {
        val id = entity(suffix)
        flywayJdbc.update(
            "INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, 'USER', ?, 'ACTIVE')",
            id, suffix,
        )
        return id
    }

    private fun Fixture.resource(suffix: String, capacity: Int): UUID {
        val id = entity(suffix)
        runtimeJdbc.update(
            "INSERT INTO occ.managed_resource(id, resource_type, capacity, state) VALUES (?, 'ROOM', ?, 'AVAILABLE')",
            id, capacity,
        )
        return id
    }

    private fun reserve(resource: UUID, requester: UUID, range: String, capacity: Int, exclusive: Boolean): UUID {
        val id = UUID.randomUUID()
        runtimeJdbc.update(
            """INSERT INTO occ.resource_reservation
               (id, resource_id, requester_entity_id, time_range, capacity, exclusive, state)
               VALUES (?, ?, ?, ?::tstzrange, ?, ?, 'PENDING')""",
            id, resource, requester, range, capacity, exclusive,
        )
        return id
    }

    private fun executeTransaction(vararg statements: String) {
        flywayDataSource.connection.use { connection ->
            connection.autoCommit = false
            try {
                connection.createStatement().use { statement ->
                    statements.forEach(statement::executeUpdate)
                }
                connection.commit()
            } catch (error: Exception) {
                connection.rollback()
                throw error
            }
        }
    }

    private fun assertPostgresRejects(expectedState: String, expectedMessage: String, action: () -> Unit) {
        val thrown = runCatching(action).exceptionOrNull()
        assertThat(thrown).isInstanceOf(DataAccessException::class.java)
        val postgres = postgresException(thrown)
        assertThat(postgres?.sqlState).describedAs("nested PostgreSQL exception SQLSTATE").isEqualTo(expectedState)
        assertThat(postgres?.serverErrorMessage?.message)
            .describedAs("PostgreSQL server error message")
            .isEqualTo(expectedMessage)
    }

    private fun postgresException(error: Throwable?): PSQLException? {
        val visited = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Throwable, Boolean>())
        var current = error
        while (current != null && visited.add(current)) {
            if (current is PSQLException) return current
            current = current.cause
        }
        return null
    }

    private data class Fixture(
        val key: String,
        val packageVersion: UUID,
        val entityType: UUID,
        val entityTypeVersion: UUID,
    )

    private data class EvidenceFixture(
        val evidence: UUID,
        val version: UUID,
        val upload: UUID,
        val objectKey: String,
        val creator: UUID,
        val submitter: UUID,
        val reviewer: UUID,
    )

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        private const val REQUIRED_PROPERTY = "innorder.evidence-risk-resource-postgresql.required"
        @JvmStatic
        fun dockerAvailableOrRequired(): Boolean =
            System.getenv("INNORDER_STRICT_DATABASE_TESTS") == "1" ||
                System.getProperty(REQUIRED_PROPERTY) == "true" ||
                DockerClientFactory.instance().isDockerAvailable

        @Container
        @JvmStatic
        val postgres: PostgreSQLContainer<*> = PostgreSQLContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("innorder_occ")
            .withUsername("innorder_admin")
            .withPassword("admin-test-only")
            .withInitScript("postgres-test-init.sql")

        private lateinit var flywayDataSource: DataSource
        private lateinit var flywayJdbc: JdbcTemplate
        private lateinit var runtimeJdbc: JdbcTemplate

        @BeforeAll
        @JvmStatic
        fun migrate() {
            flywayDataSource = DriverManagerDataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only")
            Flyway.configure()
                .dataSource(flywayDataSource)
                .locations("classpath:db/migration")
                .load()
                .migrate()
            flywayJdbc = JdbcTemplate(flywayDataSource)
            runtimeJdbc = JdbcTemplate(DriverManagerDataSource(postgres.jdbcUrl, "innorder_runtime", "runtime-test-only"))
        }
    }
}
