package com.innorder.occ.iam

import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import com.innorder.occ.auth.AccessTokenService
import com.innorder.occ.auth.AuthService
import com.innorder.occ.auth.InvalidCredentialsException
import com.innorder.occ.auth.PasswordService
import com.innorder.occ.auth.SessionRepository
import com.innorder.occ.authz.WorkflowAuthorizationRoles
import com.innorder.occ.risk.RiskDueProperties
import com.innorder.occ.risk.RiskMetricsProperties
import com.innorder.occ.risk.RiskRuntimeConfigurationException
import com.innorder.occ.risk.RiskRuntimeIdentityProvisioner
import com.innorder.occ.risk.RiskRuntimeIdentityValidator
import com.innorder.occ.risk.RiskRuntimeProvisioningResult
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.springframework.boot.DefaultApplicationArguments
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.mockito.Mockito.mock
import org.mockito.Mockito.RETURNS_DEFAULTS
import org.mockito.Mockito.verifyNoInteractions
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import org.flywaydb.core.Flyway
import org.postgresql.ds.PGSimpleDataSource
import org.springframework.security.crypto.password.PasswordEncoder
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFilePermission
import java.security.SecureRandom
import java.time.Clock
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class BootstrapAdministratorIntegrationTest {
    @TempDir
    lateinit var temp: Path

    @Test
    fun `fresh bootstrap provisions exact risk runtime identities and due-only role grants`() {
        database { jdbc, transactions ->
            bootstrapPlatform(jdbc, transactions)
            val before = revision(jdbc)
            val provisioner = riskProvisioner(jdbc, transactions)

            assertThat(provisioner.provision()).isEqualTo(RiskRuntimeProvisioningResult.CREATED)
            assertThat(revision(jdbc)).isEqualTo(before + 1)
            assertThat(jdbc.queryForMap(
                """SELECT e.id, e.entity_type_id, e.entity_type_version_id, e.entity_key, e.state,
                          p.principal_kind, p.display_name, p.status
                   FROM authz.entity e JOIN iam.principal p ON p.id = e.id WHERE e.id = ?""",
                RISK_SYSTEM_ID,
            )).containsAllEntriesOf(mapOf(
                "id" to RISK_SYSTEM_ID,
                "entity_type_id" to BootstrapIds.USER_TYPE,
                "entity_type_version_id" to BootstrapIds.USER_TYPE_VERSION,
                "entity_key" to "service:risk-runtime",
                "state" to "ACTIVE",
                "principal_kind" to "SERVICE",
                "display_name" to "Risk runtime",
                "status" to "ACTIVE",
            ))
            assertThat(jdbc.queryForMap(
                """SELECT id, entity_type_id, entity_type_version_id, entity_key, state
                   FROM authz.entity WHERE id = ?""",
                RISK_REPORT_ID,
            )).containsAllEntriesOf(mapOf(
                "id" to RISK_REPORT_ID,
                "entity_type_id" to BootstrapIds.SYSTEM_TYPE,
                "entity_type_version_id" to BootstrapIds.SYSTEM_TYPE_VERSION,
                "entity_key" to "system:risk-report",
                "state" to "ACTIVE",
            ))
            assertThat(jdbc.queryForObject(
                """SELECT count(*) FROM authz.relationship
                   WHERE relation_definition_id = ? AND subject_entity_id = ? AND object_entity_id = ?
                     AND source_kind = 'SYSTEM' AND source_ref = 'risk-runtime-provisioner'
                     AND revoked_at IS NULL AND valid_until IS NULL""",
                Long::class.java,
                BootstrapIds.ROLE_ASSIGNMENT_RELATION,
                RISK_SYSTEM_ID,
                BootstrapIds.RISK_RUNTIME_ROLE,
            )).isEqualTo(1)
            assertThat(jdbc.queryForObject(
                """SELECT count(*) FROM jsonb_array_elements(
                     (SELECT manifest FROM authz.policy_bundle_version WHERE id = ?)->'roleGrants'
                   ) grant_item
                   WHERE grant_item->>'subjectRoleEntityKey' = 'role:risk-runtime'
                     AND grant_item->>'effect' = 'ALLOW' AND grant_item->>'entityId' = '*'
                     AND grant_item->>'resourceId' = '*'
                     AND grant_item->>'action' IN ('risk.escalate', 'risk.sla_breach')""",
                Long::class.java,
                BootstrapIds.POLICY_BUNDLE_VERSION,
            )).isEqualTo(2)
            assertThat(jdbc.queryForObject(
                """SELECT count(*) FROM jsonb_array_elements(
                     (SELECT manifest FROM authz.policy_bundle_version WHERE id = ?)->'roleGrants'
                   ) grant_item WHERE grant_item->>'subjectRoleEntityKey' = 'role:risk-runtime'""",
                Long::class.java,
                BootstrapIds.POLICY_BUNDLE_VERSION,
            )).isEqualTo(2)

            RiskRuntimeIdentityValidator(jdbc, riskDue(), riskMetrics()).run(DefaultApplicationArguments())
        }
    }

    @Test
    fun `risk runtime provisioning restart is idempotent without revision or row changes`() {
        database { jdbc, transactions ->
            bootstrapPlatform(jdbc, transactions)
            val provisioner = riskProvisioner(jdbc, transactions)
            provisioner.provision()
            val before = runtimeState(jdbc)

            assertThat(provisioner.provision()).isEqualTo(RiskRuntimeProvisioningResult.ALREADY_PROVISIONED)
            assertThat(runtimeState(jdbc)).isEqualTo(before)
        }
    }

    @Test
    fun `risk runtime provisioning fails closed and rolls back on identity collision`() {
        database { jdbc, transactions ->
            bootstrapPlatform(jdbc, transactions)
            jdbc.update(
                """INSERT INTO authz.entity
                   (id, entity_type_id, entity_type_version_id, entity_key, state)
                   VALUES (?, ?, ?, 'service:collision', 'ACTIVE')""",
                RISK_SYSTEM_ID,
                BootstrapIds.USER_TYPE,
                BootstrapIds.USER_TYPE_VERSION,
            )
            val before = revision(jdbc)

            assertThatThrownBy { riskProvisioner(jdbc, transactions).provision() }
                .isInstanceOf(RiskRuntimeConfigurationException::class.java)
            assertThat(revision(jdbc)).isEqualTo(before)
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM authz.entity WHERE id = ?",
                Long::class.java,
                RISK_REPORT_ID,
            )).isZero()
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM iam.principal WHERE id = ?",
                Long::class.java,
                RISK_SYSTEM_ID,
            )).isZero()
        }
    }

    @Test
    fun `risk runtime runners execute after administrator bootstrap and before validation`() {
        assertThat(PlatformSecurityBaseline.ORDER).isLessThan(BootstrapAdministrator.ORDER)
        assertThat(BootstrapAdministrator.ORDER).isLessThan(RiskRuntimeIdentityProvisioner.ORDER)
        assertThat(RiskRuntimeIdentityProvisioner.ORDER).isLessThan(RiskRuntimeIdentityValidator.ORDER)
    }

    @Test
    fun `secret reader accepts one newline and rejects weak malformed oversized and nul secrets`() {
        val valid = secret("bootstrap-password-value\r\n")
        val material = testReader().open(valid, currentOwner())
        val chars = material.characters
        try {
            assertThat(chars.toString()).isEqualTo("bootstrap-password-value")
        } finally {
            material.close()
        }

        listOf(
            "short-value",
            "valid-password\u0000",
            "x".repeat(1025),
        ).forEachIndexed { index, value ->
            val path = secret(value, "invalid-$index")
            assertThatThrownBy { testReader().open(path, currentOwner()) }
                .isInstanceOf(BootstrapConfigurationException::class.java)
                .hasMessage("Administrator bootstrap configuration is invalid")
        }

        val malformed = temp.resolve("malformed")
        Files.write(malformed, byteArrayOf(0xc3.toByte(), 0x28))
        ownerOnly(malformed)
        assertThatThrownBy { testReader().open(malformed, currentOwner()) }
            .isInstanceOf(BootstrapConfigurationException::class.java)
    }

    @Test
    fun `real secret reader rejects directories`() {
        assertThatThrownBy { testReader().open(temp, currentOwner()) }
            .isInstanceOf(BootstrapConfigurationException::class.java)
    }

    @Test
    fun `first bootstrap creates only an active administrator and bumps authorization once`() {
        database { jdbc, transactions ->
            val password = TEST_PASSWORD
            val path = secret(password)
            val before = jdbc.queryForObject(
                "SELECT current_revision FROM authz.authorization_state WHERE singleton",
                Long::class.java,
            )!!
            val bootstrap = administrator(
                jdbc,
                transactions,
                PasswordService(),
                BootstrapAdministratorProperties(path.toString(), "  ADMIN  ", " Platform Administrator ", false),
            )

            assertThat(bootstrap.bootstrap()).isEqualTo(BootstrapResult.CREATED)

            assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java)).isEqualTo(1)
            val account = jdbc.queryForMap(
                """SELECT ua.principal_id, ua.username, ua.password_hash, ua.password_version,
                          p.display_name, p.status, e.state
                   FROM iam.user_account ua
                   JOIN iam.principal p ON p.id = ua.principal_id
                   JOIN authz.entity e ON e.id = ua.principal_id""",
            )
            assertThat(account["username"]).isEqualTo("admin")
            assertThat(account["display_name"]).isEqualTo("Platform Administrator")
            assertThat(account["status"]).isEqualTo("ACTIVE")
            assertThat(account["state"]).isEqualTo("ACTIVE")
            assertThat(account["password_version"]).isEqualTo(0)
            assertThat((account["principal_id"] as UUID).version()).isEqualTo(4)
            val hash = account["password_hash"] as String
            assertThat(hash).startsWith("${'$'}argon2id${'$'}").doesNotContain(password)
            assertThat(PasswordService().matches(password, hash)).isTrue()
            assertThat(jdbc.queryForObject(
                "SELECT current_revision FROM authz.authorization_state WHERE singleton",
                Long::class.java,
            )).isEqualTo(before + 3)
            assertThat(jdbc.queryForObject(
                """SELECT count(*) FROM authz.relationship
                   WHERE relation_definition_id = ? AND object_entity_id = ? AND source_kind = 'SYSTEM'
                     AND source_ref = 'initial-administrator' AND revoked_at IS NULL""",
                Long::class.java,
                BootstrapIds.ROLE_ASSIGNMENT_RELATION,
                BootstrapIds.ADMINISTRATOR_ROLE,
            )).isEqualTo(1)
            assertThat(jdbc.queryForObject("SELECT count(*) FROM authz.relationship", Long::class.java)).isEqualTo(1)
            assertThat(jdbc.queryForMap(
                """SELECT pr.id AS release_id, pr.release_number, pr.status AS release_status,
                          pr.content_hash AS release_hash, pr.opa_revision,
                          pb.id AS bundle_id, pb.bundle_key, pb.layer, pb.status AS bundle_status,
                          pbv.id AS version_id, pbv.version, pbv.status AS version_status,
                          pbv.content_hash AS version_hash, pbv.manifest = ?::jsonb AS manifest_matches
                   FROM authz.policy_release pr
                   JOIN authz.policy_release_item pri ON pri.release_id = pr.id
                   JOIN authz.policy_bundle pb ON pb.id = pri.bundle_id
                   JOIN authz.policy_bundle_version pbv ON pbv.id = pri.bundle_version_id
                   WHERE pr.status = 'ACTIVE'""",
                BootstrapPolicyBaseline.manifest,
            )).containsAllEntriesOf(mapOf(
                "release_id" to BootstrapIds.POLICY_RELEASE,
                "release_number" to 2L,
                "release_status" to "ACTIVE",
                "release_hash" to BootstrapPolicyBaseline.releaseHash,
                "opa_revision" to BootstrapPolicyBaseline.OPA_REVISION,
                "bundle_id" to BootstrapIds.POLICY_BUNDLE,
                "bundle_key" to "platform-core-authorization",
                "layer" to "PLATFORM",
                "bundle_status" to "ACTIVE",
                "version_id" to BootstrapIds.POLICY_BUNDLE_VERSION_V2,
                "version" to 2,
                "version_status" to "PUBLISHED",
                "version_hash" to BootstrapPolicyBaseline.contentHash,
                "manifest_matches" to true,
            ))
            assertThat(jdbc.queryForMap(
                """SELECT id, package_key, name, description, status
                   FROM catalog.domain_package WHERE id = ?""",
                BootstrapIds.PACKAGE,
            )).containsAllEntriesOf(mapOf(
                "id" to BootstrapIds.PACKAGE,
                "package_key" to "platform-iam",
                "name" to "Platform IAM",
                "description" to "Immutable platform identity and role authorization baseline",
                "status" to "ACTIVE",
            ))
            assertThat(jdbc.queryForMap(
                """SELECT id, package_version_id, relation_key, subject_type_id, object_type_id,
                          cardinality, transitive, acyclic, auth_relevant, max_subjects, max_objects
                   FROM catalog.relation_definition WHERE id = ?""",
                BootstrapIds.ROLE_ASSIGNMENT_RELATION,
            )).containsAllEntriesOf(mapOf(
                "id" to BootstrapIds.ROLE_ASSIGNMENT_RELATION,
                "package_version_id" to BootstrapIds.PACKAGE_VERSION,
                "relation_key" to "platform.role-assignment",
                "subject_type_id" to BootstrapIds.USER_TYPE,
                "object_type_id" to BootstrapIds.ROLE_TYPE,
                "cardinality" to "MANY_TO_MANY",
                "transitive" to false,
                "acyclic" to false,
                "auth_relevant" to true,
                "max_subjects" to null,
                "max_objects" to null,
            ))
            assertThat(jdbc.queryForMap(
                """SELECT pv.id, pv.package_id, pv.semver, pv.status, pv.content_hash, dp.package_key,
                          pv.manifest = '{"bootstrap":"platform-iam","version":1}'::jsonb AS manifest_matches
                   FROM catalog.package_version pv
                   JOIN catalog.domain_package dp ON dp.id = pv.package_id
                   WHERE pv.id = ?""",
                BootstrapIds.PACKAGE_VERSION,
            )).containsAllEntriesOf(mapOf(
                "id" to BootstrapIds.PACKAGE_VERSION,
                "package_id" to BootstrapIds.PACKAGE,
                "semver" to "1.0.0",
                "status" to "PUBLISHED",
                "content_hash" to BootstrapBaseline.contentHash,
                "package_key" to "platform-iam",
                "manifest_matches" to true,
            ))
            assertThat(jdbc.queryForObject(
                """SELECT count(*) FROM catalog.entity_type et
                   JOIN catalog.entity_type_version etv ON etv.entity_type_id = et.id
                    WHERE (et.id, etv.id, et.type_key, et.name, et.entity_kind, et.authorizable) IN
                      ((?, ?, 'platform.user', 'User', 'PRINCIPAL', true),
                       (?, ?, 'platform.role', 'Role', 'PRINCIPAL', true),
                       (?, ?, 'platform.system', 'System', 'SYSTEM', true))
                     AND etv.package_version_id = ? AND etv.schema_version = 1
                     AND etv.json_schema = '{}'::jsonb AND etv.ui_schema = '{}'::jsonb
                     AND etv.auth_schema = '{}'::jsonb AND etv.index_spec = '{}'::jsonb""",
                Long::class.java,
                BootstrapIds.USER_TYPE,
                BootstrapIds.USER_TYPE_VERSION,
                BootstrapIds.ROLE_TYPE,
                BootstrapIds.ROLE_TYPE_VERSION,
                BootstrapIds.SYSTEM_TYPE,
                BootstrapIds.SYSTEM_TYPE_VERSION,
                BootstrapIds.PACKAGE_VERSION,
            )).isEqualTo(3)
            assertThat(jdbc.queryForList(
                """SELECT e.id, e.entity_key, e.entity_type_id, e.entity_type_version_id, e.state,
                          p.display_name, p.status, p.principal_kind
                   FROM authz.entity e JOIN iam.principal p ON p.id = e.id
                   WHERE e.id IN (?, ?, ?, ?, ?, ?, ?) ORDER BY e.entity_key""",
                BootstrapIds.VIEWER_ROLE,
                BootstrapIds.OPERATOR_ROLE,
                BootstrapIds.ADMINISTRATOR_ROLE,
                BootstrapIds.RISK_RUNTIME_ROLE,
                *WorkflowAuthorizationRoles.all.map { it.id }.toTypedArray(),
            )).containsExactly(
                roleRow(BootstrapIds.ADMINISTRATOR_ROLE, "role:administrator", "Administrator"),
                roleRow(WorkflowAuthorizationRoles.domainModeler.id, "role:domain-modeler", "Domain Modeler"),
                roleRow(BootstrapIds.OPERATOR_ROLE, "role:operator", "Operator"),
                roleRow(WorkflowAuthorizationRoles.participant.id, "role:participant", "Participant"),
                roleRow(WorkflowAuthorizationRoles.processOwner.id, "role:process-owner", "Process Owner"),
                roleRow(BootstrapIds.RISK_RUNTIME_ROLE, "role:risk-runtime", "Risk runtime"),
                roleRow(BootstrapIds.VIEWER_ROLE, "role:viewer", "Viewer"),
            )
            assertThat(jdbc.queryForMap(
                """SELECT r.relation_definition_id, r.subject_entity_id, r.object_entity_id,
                          r.attributes = '{}'::jsonb AS attributes_match, r.source_kind, r.source_ref,
                          r.valid_until, r.revoked_at, p.principal_kind AS subject_kind,
                          r.valid_from = r.created_at AND r.created_at = r.updated_at AS timestamps_match,
                          r.created_by IS NULL AND r.updated_by IS NULL AND r.revoked_by IS NULL AS actors_match,
                          r.row_version
                   FROM authz.relationship r
                   JOIN iam.principal p ON p.id = r.subject_entity_id""",
            )).containsAllEntriesOf(mapOf(
                "relation_definition_id" to BootstrapIds.ROLE_ASSIGNMENT_RELATION,
                "subject_entity_id" to account["principal_id"],
                "object_entity_id" to BootstrapIds.ADMINISTRATOR_ROLE,
                "attributes_match" to true,
                "source_kind" to "SYSTEM",
                "source_ref" to "initial-administrator",
                "valid_until" to null,
                "revoked_at" to null,
                "subject_kind" to "USER",
                "timestamps_match" to true,
                "actors_match" to true,
                "row_version" to 0L,
            ))
            assertThat(jdbc.queryForObject(
                """SELECT count(*) FROM authz.relationship
                   WHERE relation_definition_id = ? AND object_entity_id IN (?, ?, ?) AND revoked_at IS NULL""",
                Long::class.java,
                BootstrapIds.ROLE_ASSIGNMENT_RELATION,
                *WorkflowAuthorizationRoles.all.map { it.id }.toTypedArray(),
            )).isZero()
            assertThat(Files.exists(path)).isTrue()

            val principals = PrincipalRepository(jdbc)
            val sessions = SessionRepository(jdbc, transactions, Clock.systemUTC(), SecureRandom())
            val tokens = mock(AccessTokenService::class.java) { invocation ->
                when (invocation.method.name) {
                    "issue" -> "test-access-token"
                    "expiresInSeconds" -> 900L
                    else -> RETURNS_DEFAULTS.answer(invocation)
                }
            }
            val authentication = AuthService(
                principals, PasswordService(), sessions, tokens, transactions, Clock.systemUTC(),
            )
            assertThat(authentication.login(" ADMIN ", password).user.capabilities)
                .containsExactly("occ.admin", "occ.execute", "occ.read")
            assertThatThrownBy { authentication.login("admin", "wrong-test-only-password") }
                .isInstanceOf(InvalidCredentialsException::class.java)

            Files.delete(path)
            assertThat(bootstrap.bootstrap()).isEqualTo(BootstrapResult.ALREADY_INITIALIZED)
            assertThat(jdbc.queryForObject(
                "SELECT current_revision FROM authz.authorization_state WHERE singleton",
                Long::class.java,
            )).isEqualTo(before + 3)
        }
    }

    @Test
    fun `concurrent first bootstraps create one user and loser does not need its secret`() {
        database { jdbc, transactions ->
            val firstSecret = secret(TEST_PASSWORD, "first-secret")
            val secondSecret = secret("second-bootstrap-test-only-8g!R", "second-secret")
            val first = administrator(
                jdbc,
                transactions,
                PasswordService(),
                BootstrapAdministratorProperties(firstSecret.toString(), deleteSecret = true),
            )
            val second = administrator(
                jdbc,
                transactions,
                PasswordService(),
                BootstrapAdministratorProperties(secondSecret.toString(), deleteSecret = true),
            )
            val start = CountDownLatch(1)
            val pool = Executors.newFixedThreadPool(2)
            try {
                val attempts = listOf(first, second).map { bootstrap ->
                    pool.submit<BootstrapResult> {
                        start.await()
                        bootstrap.bootstrap()
                    }
                }
                start.countDown()
                val results = attempts.map { runCatching { it.get(30, TimeUnit.SECONDS) } }
                val successes = results.mapNotNull { it.getOrNull() }
                assertThat(successes).containsExactlyInAnyOrder(
                    BootstrapResult.CREATED,
                    BootstrapResult.ALREADY_INITIALIZED,
                )
                assertThat(listOf(Files.exists(firstSecret), Files.exists(secondSecret)).count { it }).isEqualTo(1)
                assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java)).isEqualTo(1)
                assertThat(jdbc.queryForObject("SELECT count(*) FROM authz.relationship", Long::class.java)).isEqualTo(1)
            } finally {
                start.countDown()
                pool.shutdownNow()
                assertThat(pool.awaitTermination(15, TimeUnit.SECONDS)).isTrue()
            }
        }
    }

    @Test
    fun `existing account and orphan USER principal both bypass a missing secret without writes`() {
        database { jdbc, transactions ->
            val initialSecret = secret(TEST_PASSWORD, "gate-initial-secret")
            val bootstrap = administrator(
                jdbc,
                transactions,
                PasswordService(),
                BootstrapAdministratorProperties(initialSecret.toString()),
            )
            assertThat(bootstrap.bootstrap()).isEqualTo(BootstrapResult.CREATED)
            Files.delete(initialSecret)
            val missing = temp.resolve("deliberately-missing-secret")
            val restart = administrator(
                jdbc,
                transactions,
                PasswordService(),
                BootstrapAdministratorProperties(missing.toString()),
            )

            val accountState = bootstrapState(jdbc)
            assertThat(restart.bootstrap()).isEqualTo(BootstrapResult.ALREADY_INITIALIZED)
            assertThat(bootstrapState(jdbc)).isEqualTo(accountState)

            jdbc.update("DELETE FROM iam.user_account")
            val orphanPrincipalState = bootstrapState(jdbc)
            assertThat(restart.bootstrap()).isEqualTo(BootstrapResult.ALREADY_INITIALIZED)
            assertThat(bootstrapState(jdbc)).isEqualTo(orphanPrincipalState)
            assertThat(Files.exists(missing)).isFalse()
        }
    }

    @Test
    fun `existing administrator identity creates policy baseline without reading a missing credential`() {
        database { jdbc, transactions ->
            seedPublishedBaseline(jdbc, includeRelation = true)
            seedInitializedIdentity(jdbc)
            val missing = temp.resolve("missing-existing-identity-secret")

            val result = administrator(
                jdbc,
                transactions,
                PasswordService(),
                BootstrapAdministratorProperties(missing.toString()),
            ).bootstrap()

            assertThat(result).isEqualTo(BootstrapResult.ALREADY_INITIALIZED)
            assertThat(Files.exists(missing)).isFalse()
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM authz.policy_release WHERE id = ? AND status = 'ACTIVE'",
                Long::class.java,
                BootstrapIds.POLICY_RELEASE,
            )).isEqualTo(1)
        }
    }

    @Test
    fun `existing administrator identity rejects conflicting fixed policy metadata without reading credential`() {
        database { jdbc, transactions ->
            seedPublishedBaseline(jdbc, includeRelation = true)
            seedInitializedIdentity(jdbc)
            jdbc.update(
                "INSERT INTO authz.policy_bundle(id, bundle_key, layer, status) VALUES (?, 'spoofed-policy', 'PLATFORM', 'ACTIVE')",
                BootstrapIds.POLICY_BUNDLE,
            )
            val missing = temp.resolve("missing-policy-conflict-secret")

            assertThatThrownBy {
                administrator(
                    jdbc,
                    transactions,
                    PasswordService(),
                    BootstrapAdministratorProperties(missing.toString()),
                ).bootstrap()
            }.isInstanceOf(BootstrapBaselineException::class.java)
                .hasMessage("Administrator bootstrap baseline conflicts with existing data")
            assertThat(Files.exists(missing)).isFalse()
            assertThat(jdbc.queryForObject("SELECT count(*) FROM authz.policy_release", Long::class.java)).isZero()
        }
    }

    @Test
    fun `fixed ID conflict fails generically and rolls back all bootstrap writes`() {
        database { jdbc, transactions ->
            jdbc.update(
                "INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, 'spoofed-platform', 'Spoofed', 'ACTIVE')",
                BootstrapIds.PACKAGE,
            )
            val path = secret(TEST_PASSWORD)
            val bootstrap = administrator(
                jdbc, transactions, PasswordService(), BootstrapAdministratorProperties(path.toString()),
            )

            assertThatThrownBy { bootstrap.bootstrap() }
                .isInstanceOf(BootstrapBaselineException::class.java)
                .hasMessage("Administrator bootstrap baseline conflicts with existing data")
                .hasMessageNotContaining(TEST_PASSWORD)
                .hasMessageNotContaining(path.toString())
            assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java)).isZero()
            assertThat(jdbc.queryForObject("SELECT count(*) FROM authz.entity", Long::class.java)).isZero()
            assertThat(Files.exists(path)).isTrue()
        }
    }

    @Test
    fun `published baseline missing an expected asset is rejected without mutation`() {
        database { jdbc, transactions ->
            seedPublishedBaseline(jdbc, includeRelation = false)
            val before = bootstrapState(jdbc)
            val path = secret(TEST_PASSWORD, "missing-published-asset")

            assertThatThrownBy {
                administrator(
                    jdbc,
                    transactions,
                    PasswordService(),
                    BootstrapAdministratorProperties(path.toString()),
                ).bootstrap()
            }.isInstanceOf(BootstrapBaselineException::class.java)
            assertThat(bootstrapState(jdbc)).isEqualTo(before)
        }
    }

    @Test
    fun `published baseline with an extra same-package asset is rejected without mutation`() {
        database { jdbc, transactions ->
            seedPublishedBaseline(jdbc, includeRelation = true, includeExtraType = true)
            val before = bootstrapState(jdbc)
            val path = secret(TEST_PASSWORD, "extra-published-asset")

            assertThatThrownBy {
                administrator(
                    jdbc,
                    transactions,
                    PasswordService(),
                    BootstrapAdministratorProperties(path.toString()),
                ).bootstrap()
            }.isInstanceOf(BootstrapBaselineException::class.java)
            assertThat(bootstrapState(jdbc)).isEqualTo(before)
        }
    }

    @Test
    fun `published baseline with extra action and form definitions is rejected without mutation`() {
        database { jdbc, transactions ->
            seedPublishedBaseline(jdbc, includeRelation = true, includeExtraDefinitions = true)
            val before = bootstrapState(jdbc)
            val path = secret(TEST_PASSWORD, "extra-published-definitions")

            assertThatThrownBy {
                administrator(
                    jdbc,
                    transactions,
                    PasswordService(),
                    BootstrapAdministratorProperties(path.toString()),
                ).bootstrap()
            }.isInstanceOf(BootstrapBaselineException::class.java)
            assertThat(bootstrapState(jdbc)).isEqualTo(before)
        }
    }

    @Test
    fun `delete secret happens after commit and refuses a replacement`() {
        database { jdbc, transactions ->
            val path = secret(TEST_PASSWORD)
            val bootstrap = administrator(
                jdbc,
                transactions,
                PasswordService(),
                BootstrapAdministratorProperties(path.toString(), deleteSecret = true),
            )
            assertThat(bootstrap.bootstrap()).isEqualTo(BootstrapResult.CREATED)
            assertThat(Files.exists(path)).isFalse()
            assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java)).isEqualTo(1)
        }
    }

    @Test
    fun `replacement during post commit deletion fails while administrator remains committed`() {
        database { jdbc, transactions ->
            val path = secret(TEST_PASSWORD, "post-commit-race")
            val bootstrap = administrator(
                jdbc,
                transactions,
                PasswordService(),
                BootstrapAdministratorProperties(path.toString(), deleteSecret = true),
                testReader(failDelete = true),
            )

            assertThatThrownBy { bootstrap.bootstrap() }
                .isInstanceOf(BootstrapSecretCleanupException::class.java)
                .hasMessage("Administrator bootstrap committed, but secret cleanup failed; remove the configured secret manually")
                .hasMessageNotContaining(path.toString())
                .hasMessageNotContaining(TEST_PASSWORD)
            assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java)).isEqualTo(1)
            assertThat(jdbc.queryForObject("SELECT count(*) FROM authz.relationship", Long::class.java)).isEqualTo(1)
            assertThat(Files.exists(path)).isFalse()
            assertThat(Files.list(path.parent).use { paths ->
                paths.anyMatch { it.fileName.toString().startsWith(".occ-bootstrap-quarantine-") }
            }).isTrue()
        }
    }

    @Test
    fun `invalid values and unknown properties fail before bootstrap work`() {
        val jdbc = mock(JdbcTemplate::class.java)
        val transactions = mock(TransactionTemplate::class.java)
        listOf(
            BootstrapAdministratorProperties(temp.resolve("unused").toString(), "+invalid", "Administrator", false),
            BootstrapAdministratorProperties(temp.resolve("unused").toString(), "admin", "", false),
            BootstrapAdministratorProperties(temp.resolve("unused").toString(), "admin", "x".repeat(257), false),
            BootstrapAdministratorProperties(temp.resolve("unused").toString(), secretOwner = ""),
            BootstrapAdministratorProperties(temp.resolve("unused").toString(), secretOwner = "invalid\nowner"),
        ).forEach { properties ->
            assertThatThrownBy { administrator(jdbc, transactions, PasswordService(), properties).bootstrap() }
                .isInstanceOf(BootstrapConfigurationException::class.java)
        }
        verifyNoInteractions(jdbc, transactions)

        ApplicationContextRunner()
            .withUserConfiguration(BootstrapAdministratorConfiguration::class.java)
            .withPropertyValues("occ.bootstrap-administrator.unexpected=true")
            .run { context ->
                assertThat(context.startupFailure).isNotNull()
            }

        ApplicationContextRunner()
            .withUserConfiguration(BootstrapAdministratorConfiguration::class.java)
            .withBean(JdbcTemplate::class.java, { mock(JdbcTemplate::class.java) })
            .withBean(TransactionTemplate::class.java, { mock(TransactionTemplate::class.java) })
            .withBean(PasswordService::class.java, { PasswordService() })
            .run { context ->
                assertThat(context).doesNotHaveBean(BootstrapAdministrator::class.java)
            }

        ApplicationContextRunner()
            .withUserConfiguration(BootstrapAdministratorConfiguration::class.java)
            .withBean(JdbcTemplate::class.java, { mock(JdbcTemplate::class.java) })
            .withBean(TransactionTemplate::class.java, { mock(TransactionTemplate::class.java) })
            .withBean(PasswordService::class.java, { PasswordService() })
            .withBean(PlatformSecurityBaseline::class.java, { mock(PlatformSecurityBaseline::class.java) })
            .withPropertyValues("occ.bootstrap-administrator.password-file=configured-secret")
            .run { context ->
                assertThat(context).hasSingleBean(BootstrapAdministrator::class.java)
                val properties = context.getBean(BootstrapAdministratorProperties::class.java)
                assertThat(properties.username).isEqualTo("admin")
                assertThat(properties.displayName).isEqualTo("Platform Administrator")
                assertThat(properties.deleteSecret).isFalse()
                assertThat(properties.secretOwner).isEqualTo(System.getProperty("user.name"))
            }
    }

    @Test
    fun `bootstrap success and failures never log credentials hashes content or paths`() {
        val captured = mutableListOf<ILoggingEvent>()
        var encodedHash = ""
        val successPath = temp.resolve("success-log-secret")
        database { jdbc, transactions ->
            secret(LOG_PASSWORD, successPath.fileName.toString())
            captured += captureBootstrapLogs {
                administrator(
                    jdbc,
                    transactions,
                    PasswordService(),
                    BootstrapAdministratorProperties(successPath.toString(), LOG_RAW_USERNAME, "Log Test Administrator"),
                ).bootstrap()
            }
            encodedHash = jdbc.queryForObject("SELECT password_hash FROM iam.user_account", String::class.java)!!
        }

        val failurePath = temp.resolve("failure-log-secret")
        database { jdbc, transactions ->
            jdbc.update(
                "INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, 'log-conflict', 'Log Conflict', 'ACTIVE')",
                BootstrapIds.PACKAGE,
            )
            secret(LOG_FAILURE_CONTENT, failurePath.fileName.toString())
            val deterministicPasswords = PasswordService(object : PasswordEncoder {
                override fun encode(rawPassword: CharSequence): String = LOG_FAILURE_HASH
                override fun matches(rawPassword: CharSequence, encodedPassword: String): Boolean = false
            })
            captured += captureBootstrapLogs {
                assertThatThrownBy {
                    administrator(
                        jdbc,
                        transactions,
                        deterministicPasswords,
                        BootstrapAdministratorProperties(failurePath.toString(), LOG_FAILURE_RAW_USERNAME, "Failure Administrator"),
                    ).bootstrap()
                }.isInstanceOf(BootstrapBaselineException::class.java)
                    .hasMessageNotContaining(LOG_FAILURE_CONTENT)
                    .hasMessageNotContaining(LOG_FAILURE_RAW_USERNAME)
                    .hasMessageNotContaining(LOG_FAILURE_NORMALIZED_USERNAME)
                    .hasMessageNotContaining(LOG_FAILURE_HASH)
                    .hasMessageNotContaining(failurePath.toAbsolutePath().toString())
            }
        }

        val rendered = captured.joinToString("\n") { event ->
            listOf(
                event.formattedMessage,
                event.argumentArray?.joinToString(" ").orEmpty(),
                event.throwableProxy?.message.orEmpty(),
            ).joinToString(" ")
        }
        listOf(
            LOG_PASSWORD,
            LOG_RAW_USERNAME,
            LOG_NORMALIZED_USERNAME,
            encodedHash,
            successPath.toAbsolutePath().toString(),
            LOG_FAILURE_CONTENT,
            LOG_FAILURE_RAW_USERNAME,
            LOG_FAILURE_NORMALIZED_USERNAME,
            LOG_FAILURE_HASH,
            failurePath.toAbsolutePath().toString(),
        ).forEach { forbidden -> assertThat(rendered).doesNotContain(forbidden) }
    }

    private fun secret(value: String, name: String = "admin-secret"): Path = temp.resolve(name).also {
        Files.writeString(it, value)
        ownerOnly(it)
    }

    private fun administrator(
        jdbc: JdbcTemplate,
        transactions: TransactionTemplate,
        passwords: PasswordService,
        properties: BootstrapAdministratorProperties,
        reader: BootstrapSecretReader = testReader(),
    ): BootstrapAdministrator = BootstrapAdministrator(jdbc, transactions, passwords, properties, reader)

    private fun bootstrapPlatform(jdbc: JdbcTemplate, transactions: TransactionTemplate) {
        administrator(
            jdbc,
            transactions,
            PasswordService(),
            BootstrapAdministratorProperties(secret(TEST_PASSWORD, "risk-runtime-secret").toString()),
        ).bootstrap()
    }

    private fun riskProvisioner(jdbc: JdbcTemplate, transactions: TransactionTemplate) =
        RiskRuntimeIdentityProvisioner(jdbc, transactions, riskDue(), riskMetrics())

    private fun riskDue() = RiskDueProperties(enabled = true, systemPrincipalId = RISK_SYSTEM_ID.toString())

    private fun riskMetrics() = RiskMetricsProperties(enabled = true, reportResourceId = RISK_REPORT_ID.toString())

    private fun revision(jdbc: JdbcTemplate): Long = jdbc.queryForObject(
        "SELECT current_revision FROM authz.authorization_state WHERE singleton",
        Long::class.java,
    )!!

    private fun runtimeState(jdbc: JdbcTemplate): Map<String, Any> = jdbc.queryForMap(
        """SELECT
             (SELECT current_revision FROM authz.authorization_state WHERE singleton) AS revision,
             (SELECT count(*) FROM authz.entity WHERE id IN ('$RISK_SYSTEM_ID', '$RISK_REPORT_ID')) AS entities,
             (SELECT coalesce(sum(row_version), 0) FROM authz.entity
                WHERE id IN ('$RISK_SYSTEM_ID', '$RISK_REPORT_ID')) AS entity_versions,
             (SELECT count(*) FROM iam.principal WHERE id = '$RISK_SYSTEM_ID') AS principals,
             (SELECT coalesce(sum(row_version), 0) FROM iam.principal
                WHERE id = '$RISK_SYSTEM_ID') AS principal_versions,
             (SELECT count(*) FROM authz.relationship
                WHERE subject_entity_id = '$RISK_SYSTEM_ID' AND object_entity_id = '${BootstrapIds.RISK_RUNTIME_ROLE}') AS relationships,
             (SELECT coalesce(sum(row_version), 0) FROM authz.relationship
                WHERE subject_entity_id = '$RISK_SYSTEM_ID' AND object_entity_id = '${BootstrapIds.RISK_RUNTIME_ROLE}') AS relationship_versions""",
    )

    private fun testReader(failDelete: Boolean = false): BootstrapSecretReader = BootstrapSecretReader(
        SecureSecretDirectoryFactory { parent ->
            object : SecureSecretDirectory {
                override fun inspectParent(): SecretFileMetadata = SecretFileMetadata(
                    SecretFileKind.DIRECTORY,
                    0,
                    parent.toAbsolutePath().normalize().toString(),
                    java.time.Instant.EPOCH,
                    java.time.Instant.EPOCH,
                    setOf(
                        PosixFilePermission.OWNER_READ,
                        PosixFilePermission.OWNER_WRITE,
                        PosixFilePermission.OWNER_EXECUTE,
                    ),
                    currentOwner(),
                )

                override fun inspect(relativeName: Path): SecretFileMetadata {
                    val path = parent.resolve(relativeName)
                    val attributes = Files.readAttributes(
                        path,
                        BasicFileAttributes::class.java,
                        LinkOption.NOFOLLOW_LINKS,
                    )
                    val kind = when {
                        attributes.isSymbolicLink -> SecretFileKind.SYMLINK
                        attributes.isRegularFile -> SecretFileKind.REGULAR
                        attributes.isDirectory -> SecretFileKind.DIRECTORY
                        else -> SecretFileKind.REPARSE
                    }
                    return SecretFileMetadata(
                        kind,
                        attributes.size(),
                        "${attributes.creationTime().toInstant()}:${attributes.size()}",
                        attributes.creationTime().toInstant(),
                        attributes.lastModifiedTime().toInstant(),
                        setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE),
                        currentOwner(),
                    )
                }

                override fun openChannel(relativeName: Path, maximumBytes: Int): SecureSecretChannel {
                    val bytes = Files.readAllBytes(parent.resolve(relativeName)).also {
                        check(it.size <= maximumBytes)
                    }
                    return object : SecureSecretChannel {
                        override fun read(): ByteArray = bytes.copyOf()
                        override fun close() = Unit
                    }
                }

                override fun move(source: Path, target: Path) {
                    Files.move(parent.resolve(source), parent.resolve(target))
                }

                override fun delete(relativeName: Path) {
                    check(!TransactionSynchronizationManager.isActualTransactionActive())
                    if (failDelete) error("test cleanup failure")
                    Files.delete(parent.resolve(relativeName))
                }

                override fun close() = Unit
            }
        },
    )

    private fun currentOwner(): String = System.getProperty("user.name")

    private fun ownerOnly(path: Path) {
        if (Files.getFileStore(path).supportsFileAttributeView("posix")) {
            Files.setPosixFilePermissions(path, setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE))
        }
    }

    private fun migrate(postgres: PostgreSQLContainer<*>) {
        Flyway.configure()
            .dataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only")
            .locations("filesystem:../../database/migrations")
            .load()
            .migrate()
    }

    private fun database(block: (JdbcTemplate, TransactionTemplate) -> Unit) {
        PostgreSQLContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres")).use { postgres ->
            postgres.withDatabaseName("innorder_occ")
                .withUsername("innorder_admin")
                .withPassword("admin-test-only")
                .withCopyFileToContainer(
                    MountableFile.forClasspathResource("postgres-test-init.sql"),
                    "/docker-entrypoint-initdb.d/010-test-roles.sql",
                )
                .start()
            migrate(postgres)
            val dataSource = PGSimpleDataSource().apply {
                setURL(postgres.jdbcUrl)
                user = "innorder_runtime"
                password = "runtime-test-only"
            }
            block(JdbcTemplate(dataSource), TransactionTemplate(DataSourceTransactionManager(dataSource)))
        }
    }

    private fun bootstrapState(jdbc: JdbcTemplate): Map<String, Any> = jdbc.queryForMap(
        """SELECT
             (SELECT current_revision FROM authz.authorization_state WHERE singleton) AS revision,
             (SELECT count(*) FROM catalog.domain_package) AS packages,
             (SELECT count(*) FROM catalog.package_version) AS package_versions,
             (SELECT count(*) FROM catalog.entity_type) AS entity_types,
             (SELECT count(*) FROM catalog.entity_type_version) AS entity_type_versions,
             (SELECT count(*) FROM catalog.relation_definition) AS relation_definitions,
             (SELECT count(*) FROM authz.entity) AS entities,
             (SELECT coalesce(sum(row_version), 0) FROM authz.entity) AS entity_row_versions,
             (SELECT max(updated_at) FROM authz.entity) AS entity_updated_at,
             (SELECT count(*) FROM iam.principal) AS principals,
             (SELECT coalesce(sum(row_version), 0) FROM iam.principal) AS principal_row_versions,
             (SELECT max(updated_at) FROM iam.principal) AS principal_updated_at,
             (SELECT count(*) FROM iam.user_account) AS accounts,
             (SELECT count(*) FROM authz.relationship) AS relationships,
             (SELECT coalesce(sum(row_version), 0) FROM authz.relationship) AS relationship_row_versions,
             (SELECT max(updated_at) FROM authz.relationship) AS relationship_updated_at""",
    )

    private fun seedPublishedBaseline(
        jdbc: JdbcTemplate,
        includeRelation: Boolean,
        includeExtraType: Boolean = false,
        includeExtraDefinitions: Boolean = false,
    ) {
        jdbc.update(
            """INSERT INTO catalog.domain_package(id, package_key, name, description, status)
               VALUES (?, 'platform-iam', 'Platform IAM', 'Immutable platform identity and role authorization baseline', 'ACTIVE')""",
            BootstrapIds.PACKAGE,
        )
        jdbc.update(
            """INSERT INTO catalog.package_version(id, package_id, semver, status, manifest)
               VALUES (?, ?, '1.0.0', 'DRAFT', '{"bootstrap":"platform-iam","version":1}'::jsonb)""",
            BootstrapIds.PACKAGE_VERSION,
            BootstrapIds.PACKAGE,
        )
        jdbc.update(
            """INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind, authorizable)
                VALUES (?, ?, 'platform.user', 'User', 'PRINCIPAL', true),
                       (?, ?, 'platform.role', 'Role', 'PRINCIPAL', true),
                       (?, ?, 'platform.system', 'System', 'SYSTEM', true)""",
            BootstrapIds.USER_TYPE,
            BootstrapIds.PACKAGE,
            BootstrapIds.ROLE_TYPE,
            BootstrapIds.PACKAGE,
            BootstrapIds.SYSTEM_TYPE,
            BootstrapIds.PACKAGE,
        )
        jdbc.update(
            """INSERT INTO catalog.entity_type_version
               (id, entity_type_id, package_version_id, schema_version, json_schema)
                VALUES (?, ?, ?, 1, '{}'::jsonb), (?, ?, ?, 1, '{}'::jsonb),
                       (?, ?, ?, 1, '{}'::jsonb)""",
            BootstrapIds.USER_TYPE_VERSION,
            BootstrapIds.USER_TYPE,
            BootstrapIds.PACKAGE_VERSION,
            BootstrapIds.ROLE_TYPE_VERSION,
            BootstrapIds.ROLE_TYPE,
            BootstrapIds.PACKAGE_VERSION,
            BootstrapIds.SYSTEM_TYPE_VERSION,
            BootstrapIds.SYSTEM_TYPE,
            BootstrapIds.PACKAGE_VERSION,
        )
        if (includeRelation) {
            jdbc.update(
                """INSERT INTO catalog.relation_definition
                   (id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality,
                    transitive, acyclic, auth_relevant)
                   VALUES (?, ?, 'platform.role-assignment', ?, ?, 'MANY_TO_MANY', false, false, true)""",
                BootstrapIds.ROLE_ASSIGNMENT_RELATION,
                BootstrapIds.PACKAGE_VERSION,
                BootstrapIds.USER_TYPE,
                BootstrapIds.ROLE_TYPE,
            )
        }
        if (includeExtraType) {
            jdbc.update(
                """INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind, authorizable)
                   VALUES (?, ?, 'platform.extra', 'Extra', 'PRINCIPAL', true)""",
                EXTRA_TYPE_ID,
                BootstrapIds.PACKAGE,
            )
            jdbc.update(
                """INSERT INTO catalog.entity_type_version
                   (id, entity_type_id, package_version_id, schema_version, json_schema)
                   VALUES (?, ?, ?, 1, '{}'::jsonb)""",
                EXTRA_TYPE_VERSION_ID,
                EXTRA_TYPE_ID,
                BootstrapIds.PACKAGE_VERSION,
            )
        }
        if (includeExtraDefinitions) {
            jdbc.update(
                """INSERT INTO catalog.action_definition
                   (id, package_version_id, action_key, resource_type_id, context_schema, risk_level)
                   VALUES (?, ?, 'platform.extra-action', ?, '{}'::jsonb, 'LOW')""",
                EXTRA_ACTION_ID,
                BootstrapIds.PACKAGE_VERSION,
                BootstrapIds.USER_TYPE,
            )
            jdbc.update(
                """INSERT INTO catalog.form_definition
                   (id, package_version_id, form_key, json_schema, ui_schema, content_hash)
                   VALUES (?, ?, 'platform.extra-form', '{}'::jsonb, '{}'::jsonb, repeat('a', 64))""",
                EXTRA_FORM_ID,
                BootstrapIds.PACKAGE_VERSION,
            )
        }
        jdbc.update(
            """UPDATE catalog.package_version
               SET status = 'PUBLISHED', content_hash = ?, published_at = transaction_timestamp()
               WHERE id = ?""",
            BootstrapBaseline.contentHash,
            BootstrapIds.PACKAGE_VERSION,
        )
    }

    private fun seedInitializedIdentity(jdbc: JdbcTemplate) {
        listOf(
            Triple(BootstrapIds.VIEWER_ROLE, "role:viewer", "Viewer"),
            Triple(BootstrapIds.OPERATOR_ROLE, "role:operator", "Operator"),
            Triple(BootstrapIds.ADMINISTRATOR_ROLE, "role:administrator", "Administrator"),
            Triple(BootstrapIds.RISK_RUNTIME_ROLE, "role:risk-runtime", "Risk runtime"),
        ).forEach { (id, key, name) ->
            jdbc.update(
                """INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state)
                   VALUES (?, ?, ?, ?, 'ACTIVE')""",
                id,
                BootstrapIds.ROLE_TYPE,
                BootstrapIds.ROLE_TYPE_VERSION,
                key,
            )
            jdbc.update(
                "INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, 'ROLE', ?, 'ACTIVE')",
                id,
                name,
            )
        }
        val userId = UUID.fromString("71000000-0000-7000-8000-000000000005")
        jdbc.update(
            """INSERT INTO authz.entity(id, entity_type_id, entity_type_version_id, entity_key, state)
               VALUES (?, ?, ?, 'existing:user', 'ACTIVE')""",
            userId,
            BootstrapIds.USER_TYPE,
            BootstrapIds.USER_TYPE_VERSION,
        )
        jdbc.update(
            "INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, 'USER', 'Existing User', 'ACTIVE')",
            userId,
        )
    }

    private fun roleRow(id: UUID, key: String, displayName: String): Map<String, Any> = mapOf(
        "id" to id,
        "entity_key" to key,
        "entity_type_id" to BootstrapIds.ROLE_TYPE,
        "entity_type_version_id" to BootstrapIds.ROLE_TYPE_VERSION,
        "state" to "ACTIVE",
        "display_name" to displayName,
        "status" to "ACTIVE",
        "principal_kind" to "ROLE",
    )

    private fun captureBootstrapLogs(action: () -> Unit): List<ILoggingEvent> {
        val logger = org.slf4j.LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME) as Logger
        val appender = ListAppender<ILoggingEvent>().also {
            it.start()
            logger.addAppender(it)
        }
        return try {
            action()
            appender.list.toList()
        } finally {
            logger.detachAppender(appender)
            appender.stop()
        }
    }

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        private const val TEST_PASSWORD = "bootstrap-test-only-7f!Q"
        private const val LOG_PASSWORD = "log-success-test-only-4k!V"
        private const val LOG_RAW_USERNAME = " Log.Success@Test "
        private const val LOG_NORMALIZED_USERNAME = "log.success@test"
        private const val LOG_FAILURE_CONTENT = "log-failure-test-only-5m!W"
        private const val LOG_FAILURE_RAW_USERNAME = " Log.Failure@Test "
        private const val LOG_FAILURE_NORMALIZED_USERNAME = "log.failure@test"
        private const val LOG_FAILURE_HASH = "encoded-bootstrap-failure-hash-sensitive"
        private val EXTRA_TYPE_ID = UUID.fromString("71000000-0000-7000-8000-000000000001")
        private val EXTRA_TYPE_VERSION_ID = UUID.fromString("71000000-0000-7000-8000-000000000002")
        private val EXTRA_ACTION_ID = UUID.fromString("71000000-0000-7000-8000-000000000003")
        private val EXTRA_FORM_ID = UUID.fromString("71000000-0000-7000-8000-000000000004")
        private val RISK_SYSTEM_ID = UUID.fromString("00000000-0000-7000-8000-000000000040")
        private val RISK_REPORT_ID = UUID.fromString("00000000-0000-7000-8000-000000000041")
    }
}
