package com.innorder.occ.iam

import com.innorder.occ.auth.PasswordService
import com.innorder.occ.authz.PolicyLayer
import com.innorder.occ.authz.PolicyReleaseIntegrity
import com.innorder.occ.authz.PolicyReleaseItemIntegrity
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.boot.autoconfigure.condition.ConditionOutcome
import org.springframework.boot.autoconfigure.condition.SpringBootCondition
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.ConditionContext
import org.springframework.context.annotation.Conditional
import org.springframework.context.annotation.Configuration
import org.springframework.core.type.AnnotatedTypeMetadata
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.util.StringUtils
import java.nio.file.Path
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.util.Locale
import java.util.UUID

@ConfigurationProperties(prefix = "occ.bootstrap-administrator", ignoreUnknownFields = false)
data class BootstrapAdministratorProperties(
    var passwordFile: String = "",
    var username: String = "admin",
    var displayName: String = "Platform Administrator",
    var deleteSecret: Boolean = false,
    var secretOwner: String = System.getProperty("user.name"),
)

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(BootstrapAdministratorProperties::class)
class BootstrapAdministratorConfiguration {
    @Bean
    internal fun bootstrapSecretReader(): BootstrapSecretReader = BootstrapSecretReader()

    @Bean
    @Conditional(BootstrapAdministratorConfiguredCondition::class)
    internal fun bootstrapAdministrator(
        jdbc: JdbcTemplate,
        authTransactions: TransactionTemplate,
        passwords: PasswordService,
        properties: BootstrapAdministratorProperties,
        secretReader: BootstrapSecretReader,
    ): BootstrapAdministrator = BootstrapAdministrator(jdbc, authTransactions, passwords, properties, secretReader)
}

internal class BootstrapAdministratorConfiguredCondition : SpringBootCondition() {
    override fun getMatchOutcome(context: ConditionContext, metadata: AnnotatedTypeMetadata): ConditionOutcome {
        val configured = StringUtils.hasText(context.environment.getProperty("occ.bootstrap-administrator.password-file"))
        return if (configured) {
            ConditionOutcome.match("administrator password file is configured")
        } else {
            ConditionOutcome.noMatch("administrator password file is not configured")
        }
    }
}

class BootstrapConfigurationException : IllegalStateException("Administrator bootstrap configuration is invalid")
class BootstrapBaselineException : IllegalStateException("Administrator bootstrap baseline conflicts with existing data")
class BootstrapExecutionException : IllegalStateException("Administrator bootstrap failed")
class BootstrapSecretCleanupException : IllegalStateException(
    "Administrator bootstrap committed, but secret cleanup failed; remove the configured secret manually",
)

enum class BootstrapResult { CREATED, ALREADY_INITIALIZED }

object BootstrapIds {
    // Reserved UUIDv7-shaped platform identities. These values are deployment-independent contracts.
    val PACKAGE: UUID = uuid("00000000-0000-7000-8000-000000000010")
    val PACKAGE_VERSION: UUID = uuid("00000000-0000-7000-8000-000000000011")
    val USER_TYPE: UUID = uuid("00000000-0000-7000-8000-000000000012")
    val USER_TYPE_VERSION: UUID = uuid("00000000-0000-7000-8000-000000000013")
    val ROLE_TYPE: UUID = uuid("00000000-0000-7000-8000-000000000014")
    val ROLE_TYPE_VERSION: UUID = uuid("00000000-0000-7000-8000-000000000015")
    val ROLE_ASSIGNMENT_RELATION: UUID = uuid("00000000-0000-7000-8000-000000000002")
    val VIEWER_ROLE: UUID = uuid("00000000-0000-7000-8000-000000000020")
    val OPERATOR_ROLE: UUID = uuid("00000000-0000-7000-8000-000000000021")
    val ADMINISTRATOR_ROLE: UUID = uuid("00000000-0000-7000-8000-000000000022")
    val POLICY_BUNDLE: UUID = uuid("00000000-0000-7000-8000-000000000030")
    val POLICY_BUNDLE_VERSION: UUID = uuid("00000000-0000-7000-8000-000000000031")
    val POLICY_RELEASE: UUID = uuid("00000000-0000-7000-8000-000000000032")

    private fun uuid(value: String): UUID = UUID.fromString(value)
}

internal object BootstrapBaseline {
    const val manifest = """{"bootstrap":"platform-iam","version":1}"""
    private val canonicalAssets = """
        package|00000000-0000-7000-8000-000000000010|platform-iam|Platform IAM|Immutable platform identity and role authorization baseline|ACTIVE
        version|00000000-0000-7000-8000-000000000011|1.0.0|$manifest
        type|00000000-0000-7000-8000-000000000012|platform.user|User|PRINCIPAL|true
        type-version|00000000-0000-7000-8000-000000000013|00000000-0000-7000-8000-000000000012|1|{}|{}|{}|{}
        type|00000000-0000-7000-8000-000000000014|platform.role|Role|PRINCIPAL|true
        type-version|00000000-0000-7000-8000-000000000015|00000000-0000-7000-8000-000000000014|1|{}|{}|{}|{}
        relation|00000000-0000-7000-8000-000000000002|platform.role-assignment|00000000-0000-7000-8000-000000000012|00000000-0000-7000-8000-000000000014|MANY_TO_MANY|false|false|true|null|null
    """.trimIndent()
    val contentHash: String = MessageDigest.getInstance("SHA-256")
        .digest(canonicalAssets.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
}

internal object BootstrapPolicyBaseline {
    const val OPA_REVISION = "platform-authz-v2"
    private val workflowActions = listOf(
        "cohort.create", "cohort.read", "cohort.update", "cohort.owner.transfer", "cohort.members.manage",
        "cohort.archive", "cohort.process.start", "process.read", "process.suspend", "process.resume",
        "process.cancel", "process.fail", "process.transfer", "process.reconcile", "process.wait.release",
        "task.read", "task.claim", "task.complete", "task.fail", "task.assignment.manage",
    )
    private val baselineGrants = listOf(
        grant("viewer", "occ.read", "platform-viewer-read"),
        grant("operator", "occ.execute", "platform-operator-execute"),
        grant("operator", "occ.read", "platform-operator-read"),
        grant("administrator", "occ.admin", "platform-administrator-admin"),
        grant("administrator", "occ.execute", "platform-administrator-execute"),
        grant("administrator", "occ.read", "platform-administrator-read"),
    )
    private val workflowGrants = listOf(
        "viewer" to setOf("cohort.read", "process.read", "task.read", "task.claim", "task.complete"),
        "operator" to workflowActions.toSet(),
        "administrator" to workflowActions.toSet(),
    ).flatMap { (role, actions) -> actions.sorted().map { action -> grant(role, action) } }
    val manifest = """{"forbiddenActions":[],"roleGrants":[${(baselineGrants + workflowGrants).joinToString(",")}],"version":1}"""
    val contentHash: String = sha256(manifest)
    val releaseHash: String = PolicyReleaseIntegrity.contentHash(
        OPA_REVISION,
        listOf(
            PolicyReleaseItemIntegrity(
                PolicyLayer.PLATFORM,
                BootstrapIds.POLICY_BUNDLE,
                BootstrapIds.POLICY_BUNDLE_VERSION,
                contentHash,
            ),
        ),
    )

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

    private fun grant(role: String, action: String, grantId: String? = null): String {
        val id = grantId ?: "platform-$role-${action.replace('.', '-')}"
        return """{"action":"$action","effect":"ALLOW","entityId":"*","id":"$id","resourceId":"*","subjectRoleEntityKey":"role:$role"}"""
    }
}

internal object CanonicalUsername {
    private const val MAX_LENGTH = 128
    private val allowed = Regex("^[a-z0-9][a-z0-9._@-]*${'$'}")

    fun normalize(raw: String): String? {
        val normalized = raw.trim().lowercase(Locale.ROOT)
        return normalized.takeIf { it.length <= MAX_LENGTH && allowed.matches(it) }
    }
}

class BootstrapAdministrator internal constructor(
    private val jdbc: JdbcTemplate,
    private val transactions: TransactionTemplate,
    private val passwords: PasswordService,
    private val properties: BootstrapAdministratorProperties,
    private val secretReader: BootstrapSecretReader,
) : ApplicationRunner {
    constructor(
        jdbc: JdbcTemplate,
        transactions: TransactionTemplate,
        passwords: PasswordService,
        properties: BootstrapAdministratorProperties,
    ) : this(jdbc, transactions, passwords, properties, BootstrapSecretReader())

    override fun run(args: ApplicationArguments) {
        bootstrap()
    }

    fun bootstrap(): BootstrapResult {
        val username = CanonicalUsername.normalize(properties.username) ?: throw BootstrapConfigurationException()
        val displayName = normalizeDisplayName(properties.displayName)
        val secretOwner = normalizeSecretOwner(properties.secretOwner)
        if (!StringUtils.hasText(properties.passwordFile)) throw BootstrapConfigurationException()
        var openedMaterial: BootstrapSecretMaterial? = null
        val outcome = try {
            transactions.execute {
                jdbc.queryForObject("SELECT pg_advisory_xact_lock(?) IS NULL", Boolean::class.java, BOOTSTRAP_LOCK)
                val initialized = jdbc.queryForObject(
                        """SELECT EXISTS (SELECT 1 FROM iam.principal WHERE principal_kind = 'USER')
                                  OR EXISTS (SELECT 1 FROM iam.user_account)""",
                        Boolean::class.java,
                    ) == true
                if (initialized) {
                    val now = jdbc.queryForObject("SELECT transaction_timestamp()", OffsetDateTime::class.java)!!
                    seedCatalog(now)
                    jdbc.queryForObject("SELECT authz.lock_authorization_state_for_change()", Long::class.java)
                    seedRoles(now)
                    seedPolicyBaseline(now)
                    return@execute BootstrapOutcome(BootstrapResult.ALREADY_INITIALIZED, null)
                }

                val path = try {
                    Path.of(properties.passwordFile)
                } catch (_: Exception) {
                    throw BootstrapConfigurationException()
                }
                val material = secretReader.open(path, secretOwner)
                openedMaterial = material
                val hash = passwords.encode(material.characters)
                val now = jdbc.queryForObject("SELECT transaction_timestamp()", OffsetDateTime::class.java)!!
                seedCatalog(now)
                jdbc.queryForObject("SELECT authz.lock_authorization_state_for_change()", Long::class.java)
                seedRoles(now)
                seedPolicyBaseline(now)
                val userId = UUID.randomUUID()
                jdbc.update(
                    """INSERT INTO authz.entity
                       (id, entity_type_id, entity_type_version_id, entity_key, state, created_at, updated_at)
                       VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)""",
                    userId, BootstrapIds.USER_TYPE, BootstrapIds.USER_TYPE_VERSION, "user:$username", now, now,
                )
                jdbc.update(
                    """INSERT INTO iam.principal
                       (id, principal_kind, display_name, status, created_at, updated_at)
                       VALUES (?, 'USER', ?, 'ACTIVE', ?, ?)""",
                    userId, displayName, now, now,
                )
                jdbc.update(
                    """INSERT INTO iam.user_account(principal_id, username, password_hash, password_version)
                       VALUES (?, ?, ?, 0)""",
                    userId, username, hash,
                )
                jdbc.update(
                    """INSERT INTO authz.relationship
                       (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from,
                        source_kind, source_ref, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, 'SYSTEM', 'initial-administrator', ?, ?)""",
                    UUID.randomUUID(), BootstrapIds.ROLE_ASSIGNMENT_RELATION, userId,
                    BootstrapIds.ADMINISTRATOR_ROLE, now, now, now,
                )
                BootstrapOutcome(BootstrapResult.CREATED, material)
            }
        } catch (failure: RuntimeException) {
            openedMaterial?.close()
            when (failure) {
                is BootstrapConfigurationException, is BootstrapBaselineException -> throw failure
                else -> throw BootstrapExecutionException()
            }
        } ?: throw BootstrapExecutionException()

        val material = outcome.secretMaterial
        if (material != null) {
            try {
                if (properties.deleteSecret) material.delete()
            } finally {
                material.close()
            }
        }
        return outcome.result
    }

    private fun seedCatalog(now: OffsetDateTime) {
        ensure(
            "catalog.domain_package", "id = ? OR package_key = ?",
            arrayOf(BootstrapIds.PACKAGE, PACKAGE_KEY),
            """id = ? AND package_key = ? AND name = ? AND description = ? AND status = 'ACTIVE'
               AND row_version = 0 AND created_by IS NULL AND updated_by IS NULL""",
            arrayOf(BootstrapIds.PACKAGE, PACKAGE_KEY, "Platform IAM", "Immutable platform identity and role authorization baseline"),
        ) {
            jdbc.update(
                """INSERT INTO catalog.domain_package
                   (id, package_key, name, description, status, created_at, updated_at)
                   VALUES (?, ?, 'Platform IAM', 'Immutable platform identity and role authorization baseline', 'ACTIVE', ?, ?)""",
                BootstrapIds.PACKAGE, PACKAGE_KEY, now, now,
            )
        }
        ensurePackageVersion(now)
        val status = jdbc.queryForObject(
            "SELECT status FROM catalog.package_version WHERE id = ?", String::class.java, BootstrapIds.PACKAGE_VERSION,
        )
        if (status == "PUBLISHED") {
            verifyExactPackageAssets()
            verifyPublishedVersion()
            return
        }
        if (status != "DRAFT") throw BootstrapBaselineException()
        ensureType(BootstrapIds.USER_TYPE, "platform.user", "User")
        ensureType(BootstrapIds.ROLE_TYPE, "platform.role", "Role")
        ensureTypeVersion(BootstrapIds.USER_TYPE_VERSION, BootstrapIds.USER_TYPE)
        ensureTypeVersion(BootstrapIds.ROLE_TYPE_VERSION, BootstrapIds.ROLE_TYPE)
        ensureRelationDefinition()
        verifyExactPackageAssets()
        jdbc.update(
            """UPDATE catalog.package_version
               SET status = 'PUBLISHED', content_hash = ?, published_at = ?
               WHERE id = ? AND status = 'DRAFT'""",
            BootstrapBaseline.contentHash, now, BootstrapIds.PACKAGE_VERSION,
        )
        verifyPublishedVersion()
    }

    private fun verifyPublishedVersion() {
        if (count(
                """SELECT count(*) FROM catalog.package_version
                   WHERE id = ? AND package_id = ? AND semver = '1.0.0' AND status = 'PUBLISHED'
                     AND manifest = ?::jsonb AND content_hash = ?
                     AND published_at IS NOT NULL""",
                BootstrapIds.PACKAGE_VERSION, BootstrapIds.PACKAGE,
                BootstrapBaseline.manifest, BootstrapBaseline.contentHash,
            ) != 1L
        ) throw BootstrapBaselineException()
    }

    private fun verifyExactPackageAssets() {
        if (count("SELECT count(*) FROM catalog.entity_type WHERE package_id = ?", BootstrapIds.PACKAGE) != 2L ||
            count(
                """SELECT count(*) FROM catalog.entity_type
                   WHERE package_id = ? AND (
                     (id = ? AND type_key = 'platform.user' AND name = 'User' AND entity_kind = 'PRINCIPAL' AND authorizable)
                     OR (id = ? AND type_key = 'platform.role' AND name = 'Role' AND entity_kind = 'PRINCIPAL' AND authorizable)
                   )""",
                BootstrapIds.PACKAGE, BootstrapIds.USER_TYPE, BootstrapIds.ROLE_TYPE,
            ) != 2L ||
            count(
                "SELECT count(*) FROM catalog.entity_type_version WHERE package_version_id = ?",
                BootstrapIds.PACKAGE_VERSION,
            ) != 2L ||
            count(
                """SELECT count(*) FROM catalog.entity_type_version
                   WHERE package_version_id = ? AND schema_version = 1
                     AND json_schema = '{}'::jsonb AND ui_schema = '{}'::jsonb
                     AND auth_schema = '{}'::jsonb AND index_spec = '{}'::jsonb
                     AND ((id = ? AND entity_type_id = ?) OR (id = ? AND entity_type_id = ?))""",
                BootstrapIds.PACKAGE_VERSION,
                BootstrapIds.USER_TYPE_VERSION, BootstrapIds.USER_TYPE,
                BootstrapIds.ROLE_TYPE_VERSION, BootstrapIds.ROLE_TYPE,
            ) != 2L ||
            count(
                "SELECT count(*) FROM catalog.relation_definition WHERE package_version_id = ?",
                BootstrapIds.PACKAGE_VERSION,
            ) != 1L ||
            count(
                """SELECT count(*) FROM catalog.relation_definition
                   WHERE package_version_id = ? AND id = ? AND relation_key = 'platform.role-assignment'
                     AND subject_type_id = ? AND object_type_id = ? AND cardinality = 'MANY_TO_MANY'
                     AND NOT transitive AND NOT acyclic AND auth_relevant
                     AND max_subjects IS NULL AND max_objects IS NULL""",
                BootstrapIds.PACKAGE_VERSION, BootstrapIds.ROLE_ASSIGNMENT_RELATION,
                BootstrapIds.USER_TYPE, BootstrapIds.ROLE_TYPE,
            ) != 1L ||
            count(
                """SELECT
                     (SELECT count(*) FROM catalog.action_definition WHERE package_version_id = ?)
                     + (SELECT count(*) FROM catalog.form_definition WHERE package_version_id = ?)
                     + (SELECT count(*) FROM catalog.evidence_requirement WHERE package_version_id = ?)
                     + (SELECT count(*) FROM catalog.risk_rule_definition WHERE package_version_id = ?)
                     + (SELECT count(*) FROM catalog.workflow_definition WHERE package_version_id = ?)""",
                BootstrapIds.PACKAGE_VERSION, BootstrapIds.PACKAGE_VERSION, BootstrapIds.PACKAGE_VERSION,
                BootstrapIds.PACKAGE_VERSION, BootstrapIds.PACKAGE_VERSION,
            ) != 0L
        ) throw BootstrapBaselineException()
    }

    private fun ensurePackageVersion(now: OffsetDateTime) {
        ensure(
            "catalog.package_version", "id = ? OR (package_id = ? AND semver = '1.0.0')",
            arrayOf(BootstrapIds.PACKAGE_VERSION, BootstrapIds.PACKAGE),
            """id = ? AND package_id = ? AND semver = '1.0.0' AND status IN ('DRAFT', 'PUBLISHED')
               AND manifest = ?::jsonb
               AND created_by IS NULL AND published_by IS NULL
               AND ((status = 'DRAFT' AND content_hash IS NULL AND published_at IS NULL)
                    OR (status = 'PUBLISHED' AND content_hash = ? AND published_at IS NOT NULL))""",
            arrayOf(
                BootstrapIds.PACKAGE_VERSION, BootstrapIds.PACKAGE,
                BootstrapBaseline.manifest, BootstrapBaseline.contentHash,
            ),
        ) {
            jdbc.update(
                """INSERT INTO catalog.package_version(id, package_id, semver, status, manifest, created_at)
                   VALUES (?, ?, '1.0.0', 'DRAFT', ?::jsonb, ?)""",
                BootstrapIds.PACKAGE_VERSION, BootstrapIds.PACKAGE, BootstrapBaseline.manifest, now,
            )
        }
    }

    private fun ensureType(id: UUID, key: String, name: String) {
        ensure(
            "catalog.entity_type", "id = ? OR (package_id = ? AND type_key = ?)", arrayOf(id, BootstrapIds.PACKAGE, key),
            "id = ? AND package_id = ? AND type_key = ? AND name = ? AND entity_kind = 'PRINCIPAL' AND authorizable",
            arrayOf(id, BootstrapIds.PACKAGE, key, name),
        ) {
            jdbc.update(
                """INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind, authorizable)
                   VALUES (?, ?, ?, ?, 'PRINCIPAL', true)""",
                id, BootstrapIds.PACKAGE, key, name,
            )
        }
    }

    private fun ensureTypeVersion(id: UUID, typeId: UUID) {
        ensure(
            "catalog.entity_type_version",
            "id = ? OR (entity_type_id = ? AND schema_version = 1) OR (entity_type_id = ? AND package_version_id = ?)",
            arrayOf(id, typeId, typeId, BootstrapIds.PACKAGE_VERSION),
            """id = ? AND entity_type_id = ? AND package_version_id = ? AND schema_version = 1
               AND json_schema = '{}'::jsonb AND ui_schema = '{}'::jsonb
               AND auth_schema = '{}'::jsonb AND index_spec = '{}'::jsonb""",
            arrayOf(id, typeId, BootstrapIds.PACKAGE_VERSION),
        ) {
            jdbc.update(
                """INSERT INTO catalog.entity_type_version
                   (id, entity_type_id, package_version_id, schema_version, json_schema)
                   VALUES (?, ?, ?, 1, '{}'::jsonb)""",
                id, typeId, BootstrapIds.PACKAGE_VERSION,
            )
        }
    }

    private fun ensureRelationDefinition() {
        ensure(
            "catalog.relation_definition",
            "id = ? OR (package_version_id = ? AND relation_key = 'platform.role-assignment')",
            arrayOf(BootstrapIds.ROLE_ASSIGNMENT_RELATION, BootstrapIds.PACKAGE_VERSION),
            """id = ? AND package_version_id = ? AND relation_key = 'platform.role-assignment'
               AND subject_type_id = ? AND object_type_id = ? AND cardinality = 'MANY_TO_MANY'
               AND NOT transitive AND NOT acyclic AND auth_relevant AND max_subjects IS NULL AND max_objects IS NULL""",
            arrayOf(
                BootstrapIds.ROLE_ASSIGNMENT_RELATION, BootstrapIds.PACKAGE_VERSION,
                BootstrapIds.USER_TYPE, BootstrapIds.ROLE_TYPE,
            ),
        ) {
            jdbc.update(
                """INSERT INTO catalog.relation_definition
                   (id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality,
                    transitive, acyclic, auth_relevant)
                   VALUES (?, ?, 'platform.role-assignment', ?, ?, 'MANY_TO_MANY', false, false, true)""",
                BootstrapIds.ROLE_ASSIGNMENT_RELATION, BootstrapIds.PACKAGE_VERSION,
                BootstrapIds.USER_TYPE, BootstrapIds.ROLE_TYPE,
            )
        }
    }

    private fun seedRoles(now: OffsetDateTime) {
        listOf(
            Triple(BootstrapIds.VIEWER_ROLE, "role:viewer", "Viewer"),
            Triple(BootstrapIds.OPERATOR_ROLE, "role:operator", "Operator"),
            Triple(BootstrapIds.ADMINISTRATOR_ROLE, "role:administrator", "Administrator"),
        ).forEach { (id, key, name) ->
            ensure(
                "authz.entity", "id = ? OR (entity_type_id = ? AND entity_key = ?)",
                arrayOf(id, BootstrapIds.ROLE_TYPE, key),
                """id = ? AND entity_type_id = ? AND entity_type_version_id = ? AND entity_key = ?
                   AND state = 'ACTIVE' AND auth_attributes = '{}'::jsonb AND row_version = 0
                   AND created_by IS NULL AND updated_by IS NULL""",
                arrayOf(id, BootstrapIds.ROLE_TYPE, BootstrapIds.ROLE_TYPE_VERSION, key),
            ) {
                jdbc.update(
                    """INSERT INTO authz.entity
                       (id, entity_type_id, entity_type_version_id, entity_key, state, created_at, updated_at)
                       VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)""",
                    id, BootstrapIds.ROLE_TYPE, BootstrapIds.ROLE_TYPE_VERSION, key, now, now,
                )
            }
            ensure(
                "iam.principal", "id = ?", arrayOf(id),
                """id = ? AND principal_kind = 'ROLE' AND display_name = ? AND status = 'ACTIVE'
                   AND profile = '{}'::jsonb AND row_version = 0 AND created_by IS NULL AND updated_by IS NULL""",
                arrayOf(id, name),
            ) {
                jdbc.update(
                    """INSERT INTO iam.principal
                       (id, principal_kind, display_name, status, created_at, updated_at)
                       VALUES (?, 'ROLE', ?, 'ACTIVE', ?, ?)""",
                    id, name, now, now,
                )
            }
        }
    }

    private fun seedPolicyBaseline(now: OffsetDateTime) {
        ensure(
            "authz.policy_bundle",
            "id = ? OR bundle_key = 'platform-core-authorization'",
            arrayOf(BootstrapIds.POLICY_BUNDLE),
            """id = ? AND bundle_key = 'platform-core-authorization' AND layer = 'PLATFORM'
               AND package_id IS NULL AND status = 'ACTIVE' AND created_by IS NULL""",
            arrayOf(BootstrapIds.POLICY_BUNDLE),
        ) {
            jdbc.update(
                """INSERT INTO authz.policy_bundle(id, bundle_key, layer, status, created_at)
                   VALUES (?, 'platform-core-authorization', 'PLATFORM', 'ACTIVE', ?)""",
                BootstrapIds.POLICY_BUNDLE,
                now,
            )
        }
        ensure(
            "authz.policy_bundle_version",
            "id = ? OR (bundle_id = ? AND version = 1)",
            arrayOf(BootstrapIds.POLICY_BUNDLE_VERSION, BootstrapIds.POLICY_BUNDLE),
            """id = ? AND bundle_id = ? AND version = 1 AND status IN ('DRAFT', 'PUBLISHED')
               AND manifest = ?::jsonb AND created_by IS NULL AND published_by IS NULL
               AND ((status = 'DRAFT' AND content_hash IS NULL AND published_at IS NULL)
                    OR (status = 'PUBLISHED' AND content_hash = ? AND published_at IS NOT NULL))""",
            arrayOf(
                BootstrapIds.POLICY_BUNDLE_VERSION,
                BootstrapIds.POLICY_BUNDLE,
                BootstrapPolicyBaseline.manifest,
                BootstrapPolicyBaseline.contentHash,
            ),
        ) {
            jdbc.update(
                """INSERT INTO authz.policy_bundle_version
                   (id, bundle_id, version, status, manifest, created_at)
                   VALUES (?, ?, 1, 'DRAFT', ?::jsonb, ?)""",
                BootstrapIds.POLICY_BUNDLE_VERSION,
                BootstrapIds.POLICY_BUNDLE,
                BootstrapPolicyBaseline.manifest,
                now,
            )
        }
        val versionStatus = jdbc.queryForObject(
            "SELECT status FROM authz.policy_bundle_version WHERE id = ?",
            String::class.java,
            BootstrapIds.POLICY_BUNDLE_VERSION,
        )
        if (versionStatus == "DRAFT") {
            jdbc.update(
                """UPDATE authz.policy_bundle_version
                   SET status = 'PUBLISHED', content_hash = ?, published_at = ?
                   WHERE id = ? AND status = 'DRAFT'""",
                BootstrapPolicyBaseline.contentHash,
                now,
                BootstrapIds.POLICY_BUNDLE_VERSION,
            )
        }
        if (count(
                """SELECT count(*) FROM authz.policy_bundle_version
                   WHERE id = ? AND bundle_id = ? AND version = 1 AND status = 'PUBLISHED'
                     AND manifest = ?::jsonb AND content_hash = ? AND published_at IS NOT NULL
                     AND created_by IS NULL AND published_by IS NULL""",
                BootstrapIds.POLICY_BUNDLE_VERSION,
                BootstrapIds.POLICY_BUNDLE,
                BootstrapPolicyBaseline.manifest,
                BootstrapPolicyBaseline.contentHash,
            ) != 1L
        ) throw BootstrapBaselineException()

        ensure(
            "authz.policy_release",
            "id = ? OR release_number = 1",
            arrayOf(BootstrapIds.POLICY_RELEASE),
            """id = ? AND release_number = 1 AND status IN ('STAGED', 'ACTIVE') AND content_hash = ?
               AND published_by IS NULL
               AND ((status = 'STAGED' AND opa_revision IS NULL AND published_at IS NULL)
                    OR (status = 'ACTIVE' AND opa_revision = ? AND published_at IS NOT NULL))""",
            arrayOf(
                BootstrapIds.POLICY_RELEASE,
                BootstrapPolicyBaseline.releaseHash,
                BootstrapPolicyBaseline.OPA_REVISION,
            ),
        ) {
            jdbc.update(
                """INSERT INTO authz.policy_release(id, release_number, status, content_hash, created_at)
                   VALUES (?, 1, 'STAGED', ?, ?)""",
                BootstrapIds.POLICY_RELEASE,
                BootstrapPolicyBaseline.releaseHash,
                now,
            )
        }
        val releaseStatus = jdbc.queryForObject(
            "SELECT status FROM authz.policy_release WHERE id = ?",
            String::class.java,
            BootstrapIds.POLICY_RELEASE,
        )
        if (releaseStatus == "STAGED") {
            ensure(
                "authz.policy_release_item",
                "release_id = ?",
                arrayOf(BootstrapIds.POLICY_RELEASE),
                "release_id = ? AND bundle_id = ? AND bundle_version_id = ?",
                arrayOf(BootstrapIds.POLICY_RELEASE, BootstrapIds.POLICY_BUNDLE, BootstrapIds.POLICY_BUNDLE_VERSION),
            ) {
                jdbc.update(
                    "INSERT INTO authz.policy_release_item(release_id, bundle_id, bundle_version_id) VALUES (?, ?, ?)",
                    BootstrapIds.POLICY_RELEASE,
                    BootstrapIds.POLICY_BUNDLE,
                    BootstrapIds.POLICY_BUNDLE_VERSION,
                )
            }
            try {
                jdbc.update(
                    """UPDATE authz.policy_release
                       SET status = 'ACTIVE', opa_revision = ?, published_at = ?
                       WHERE id = ? AND status = 'STAGED'""",
                    BootstrapPolicyBaseline.OPA_REVISION,
                    now,
                    BootstrapIds.POLICY_RELEASE,
                )
            } catch (_: Exception) {
                throw BootstrapBaselineException()
            }
        }
        if (count("SELECT count(*) FROM authz.policy_release WHERE status = 'ACTIVE'") != 1L ||
            count(
                """SELECT count(*) FROM authz.policy_release pr
                   JOIN authz.policy_release_item pri ON pri.release_id = pr.id
                   WHERE pr.id = ? AND pr.release_number = 1 AND pr.status = 'ACTIVE'
                     AND pr.content_hash = ? AND pr.opa_revision = ? AND pr.published_at IS NOT NULL
                     AND pr.published_by IS NULL AND pri.bundle_id = ? AND pri.bundle_version_id = ?""",
                BootstrapIds.POLICY_RELEASE,
                BootstrapPolicyBaseline.releaseHash,
                BootstrapPolicyBaseline.OPA_REVISION,
                BootstrapIds.POLICY_BUNDLE,
                BootstrapIds.POLICY_BUNDLE_VERSION,
            ) != 1L ||
            count("SELECT count(*) FROM authz.policy_release_item WHERE release_id = ?", BootstrapIds.POLICY_RELEASE) != 1L
        ) throw BootstrapBaselineException()
    }

    private fun ensure(
        table: String,
        collisionPredicate: String,
        collisionArguments: Array<Any>,
        expectedPredicate: String,
        expectedArguments: Array<Any>,
        insert: () -> Unit,
    ) {
        val collisions = count("SELECT count(*) FROM $table WHERE $collisionPredicate", *collisionArguments)
        if (collisions == 0L) {
            try {
                insert()
            } catch (_: Exception) {
                throw BootstrapBaselineException()
            }
            return
        }
        if (collisions != 1L || count("SELECT count(*) FROM $table WHERE $expectedPredicate", *expectedArguments) != 1L) {
            throw BootstrapBaselineException()
        }
    }

    private fun count(sql: String, vararg arguments: Any): Long =
        jdbc.queryForObject(sql, Long::class.java, *arguments) ?: 0L

    private fun normalizeDisplayName(raw: String): String {
        val normalized = raw.trim()
        var codePoints = 0
        var offset = 0
        while (offset < normalized.length) {
            val current = normalized[offset]
            offset += when {
                Character.isHighSurrogate(current) -> {
                    if (offset + 1 >= normalized.length || !Character.isLowSurrogate(normalized[offset + 1])) {
                        throw BootstrapConfigurationException()
                    }
                    2
                }
                Character.isLowSurrogate(current) -> throw BootstrapConfigurationException()
                else -> 1
            }
            if (++codePoints > 256) throw BootstrapConfigurationException()
        }
        if (codePoints == 0) throw BootstrapConfigurationException()
        return normalized
    }

    private fun normalizeSecretOwner(raw: String): String {
        val owner = raw.trim()
        if (owner.isEmpty() || owner.codePointCount(0, owner.length) > 256 ||
            owner.any { it == '\u0000' || Character.isISOControl(it) }
        ) throw BootstrapConfigurationException()
        return owner
    }

    private data class BootstrapOutcome(val result: BootstrapResult, val secretMaterial: BootstrapSecretMaterial?)

    private companion object {
        const val BOOTSTRAP_LOCK = 0x4f4343424f4f5453L
        const val PACKAGE_KEY = "platform-iam"
    }
}
