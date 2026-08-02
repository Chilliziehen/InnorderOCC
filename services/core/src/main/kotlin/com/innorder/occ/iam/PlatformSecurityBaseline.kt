package com.innorder.occ.iam

import com.innorder.occ.authz.PolicyLayer
import com.innorder.occ.authz.PolicyReleaseIntegrity
import com.innorder.occ.authz.PolicyReleaseItemIntegrity
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.core.Ordered
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Component
import org.springframework.transaction.support.TransactionTemplate
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.util.UUID

object BootstrapIds {
    // Reserved UUIDv7-shaped platform identities. These values are deployment-independent contracts.
    val PACKAGE: UUID = uuid("00000000-0000-7000-8000-000000000010")
    val PACKAGE_VERSION: UUID = uuid("00000000-0000-7000-8000-000000000011")
    val USER_TYPE: UUID = uuid("00000000-0000-7000-8000-000000000012")
    val USER_TYPE_VERSION: UUID = uuid("00000000-0000-7000-8000-000000000013")
    val ROLE_TYPE: UUID = uuid("00000000-0000-7000-8000-000000000014")
    val ROLE_TYPE_VERSION: UUID = uuid("00000000-0000-7000-8000-000000000015")
    val SYSTEM_TYPE: UUID = uuid("00000000-0000-7000-8000-000000000016")
    val SYSTEM_TYPE_VERSION: UUID = uuid("00000000-0000-7000-8000-000000000017")
    val ROLE_ASSIGNMENT_RELATION: UUID = uuid("00000000-0000-7000-8000-000000000002")
    val VIEWER_ROLE: UUID = uuid("00000000-0000-7000-8000-000000000020")
    val OPERATOR_ROLE: UUID = uuid("00000000-0000-7000-8000-000000000021")
    val ADMINISTRATOR_ROLE: UUID = uuid("00000000-0000-7000-8000-000000000022")
    val RISK_RUNTIME_ROLE: UUID = uuid("00000000-0000-7000-8000-000000000023")
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
        type|00000000-0000-7000-8000-000000000016|platform.system|System|SYSTEM|true
        type-version|00000000-0000-7000-8000-000000000017|00000000-0000-7000-8000-000000000016|1|{}|{}|{}|{}
        relation|00000000-0000-7000-8000-000000000002|platform.role-assignment|00000000-0000-7000-8000-000000000012|00000000-0000-7000-8000-000000000014|MANY_TO_MANY|false|false|true|null|null
    """.trimIndent()
    val contentHash: String = MessageDigest.getInstance("SHA-256")
        .digest(canonicalAssets.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
}

internal object BootstrapPolicyBaseline {
    const val OPA_REVISION = "platform-authz-v1"
    const val manifest = """{"forbiddenActions":[],"roleGrants":[{"action":"occ.read","effect":"ALLOW","entityId":"*","id":"platform-viewer-read","resourceId":"*","subjectRoleEntityKey":"role:viewer"},{"action":"occ.execute","effect":"ALLOW","entityId":"*","id":"platform-operator-execute","resourceId":"*","subjectRoleEntityKey":"role:operator"},{"action":"occ.read","effect":"ALLOW","entityId":"*","id":"platform-operator-read","resourceId":"*","subjectRoleEntityKey":"role:operator"},{"action":"occ.admin","effect":"ALLOW","entityId":"*","id":"platform-administrator-admin","resourceId":"*","subjectRoleEntityKey":"role:administrator"},{"action":"occ.execute","effect":"ALLOW","entityId":"*","id":"platform-administrator-execute","resourceId":"*","subjectRoleEntityKey":"role:administrator"},{"action":"occ.read","effect":"ALLOW","entityId":"*","id":"platform-administrator-read","resourceId":"*","subjectRoleEntityKey":"role:administrator"},{"action":"risk.escalate","effect":"ALLOW","entityId":"*","id":"platform-risk-runtime-escalate","resourceId":"*","subjectRoleEntityKey":"role:risk-runtime"},{"action":"risk.sla_breach","effect":"ALLOW","entityId":"*","id":"platform-risk-runtime-sla-breach","resourceId":"*","subjectRoleEntityKey":"role:risk-runtime"}],"version":1}"""
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
}

@Component
class PlatformSecurityBaseline(
    private val jdbc: JdbcTemplate,
    private val transactions: TransactionTemplate,
) : ApplicationRunner, Ordered {
    override fun getOrder(): Int = ORDER

    override fun run(args: ApplicationArguments) {
        ensure()
    }

    fun ensure() {
        try {
            transactions.executeWithoutResult {
                jdbc.queryForObject("SELECT pg_advisory_xact_lock(?) IS NULL", Boolean::class.java, ADVISORY_LOCK)
                val now = jdbc.queryForObject("SELECT transaction_timestamp()", OffsetDateTime::class.java)!!
                seedCatalog(now)
                jdbc.queryForObject("SELECT authz.lock_authorization_state_for_change()", Long::class.java)
                seedRoles(now)
                seedPolicyBaseline(now)
            }
        } catch (failure: RuntimeException) {
            if (failure is BootstrapBaselineException) throw failure
            throw BootstrapExecutionException()
        }
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
        ensureType(BootstrapIds.SYSTEM_TYPE, "platform.system", "System", "SYSTEM")
        ensureTypeVersion(BootstrapIds.USER_TYPE_VERSION, BootstrapIds.USER_TYPE)
        ensureTypeVersion(BootstrapIds.ROLE_TYPE_VERSION, BootstrapIds.ROLE_TYPE)
        ensureTypeVersion(BootstrapIds.SYSTEM_TYPE_VERSION, BootstrapIds.SYSTEM_TYPE)
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
        if (count("SELECT count(*) FROM catalog.entity_type WHERE package_id = ?", BootstrapIds.PACKAGE) != 3L ||
            count(
                """SELECT count(*) FROM catalog.entity_type
                   WHERE package_id = ? AND (
                      (id = ? AND type_key = 'platform.user' AND name = 'User' AND entity_kind = 'PRINCIPAL' AND authorizable)
                      OR (id = ? AND type_key = 'platform.role' AND name = 'Role' AND entity_kind = 'PRINCIPAL' AND authorizable)
                      OR (id = ? AND type_key = 'platform.system' AND name = 'System' AND entity_kind = 'SYSTEM' AND authorizable)
                    )""",
                BootstrapIds.PACKAGE, BootstrapIds.USER_TYPE, BootstrapIds.ROLE_TYPE, BootstrapIds.SYSTEM_TYPE,
            ) != 3L ||
            count(
                "SELECT count(*) FROM catalog.entity_type_version WHERE package_version_id = ?",
                BootstrapIds.PACKAGE_VERSION,
            ) != 3L ||
            count(
                """SELECT count(*) FROM catalog.entity_type_version
                   WHERE package_version_id = ? AND schema_version = 1
                     AND json_schema = '{}'::jsonb AND ui_schema = '{}'::jsonb
                     AND auth_schema = '{}'::jsonb AND index_spec = '{}'::jsonb
                      AND ((id = ? AND entity_type_id = ?) OR (id = ? AND entity_type_id = ?)
                        OR (id = ? AND entity_type_id = ?))""",
                BootstrapIds.PACKAGE_VERSION,
                BootstrapIds.USER_TYPE_VERSION, BootstrapIds.USER_TYPE,
                BootstrapIds.ROLE_TYPE_VERSION, BootstrapIds.ROLE_TYPE,
                BootstrapIds.SYSTEM_TYPE_VERSION, BootstrapIds.SYSTEM_TYPE,
            ) != 3L ||
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

    private fun ensureType(id: UUID, key: String, name: String, kind: String = "PRINCIPAL") {
        ensure(
            "catalog.entity_type", "id = ? OR (package_id = ? AND type_key = ?)", arrayOf(id, BootstrapIds.PACKAGE, key),
            "id = ? AND package_id = ? AND type_key = ? AND name = ? AND entity_kind = ? AND authorizable",
            arrayOf(id, BootstrapIds.PACKAGE, key, name, kind),
        ) {
            jdbc.update(
                """INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind, authorizable)
                   VALUES (?, ?, ?, ?, ?, true)""",
                id, BootstrapIds.PACKAGE, key, name, kind,
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
            Triple(BootstrapIds.RISK_RUNTIME_ROLE, "role:risk-runtime", "Risk runtime"),
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

    companion object {
        const val ORDER = 0
        internal const val ADVISORY_LOCK = 0x4f4343424f4f5453L
        private const val PACKAGE_KEY = "platform-iam"
    }
}
