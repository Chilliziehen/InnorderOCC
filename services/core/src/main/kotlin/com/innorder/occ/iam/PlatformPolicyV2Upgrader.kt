package com.innorder.occ.iam

import com.innorder.occ.authz.PolicyLayer
import com.innorder.occ.authz.PolicyReleaseIntegrity
import com.innorder.occ.authz.PolicyReleaseItemIntegrity
import com.innorder.occ.authz.WorkflowAuthorizationRoles
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Component
import org.springframework.transaction.support.TransactionTemplate
import java.time.OffsetDateTime
import java.util.UUID

enum class PlatformPolicyUpgradeResult { NO_ACTION, UPGRADED }

class PlatformPolicyUpgradeException : IllegalStateException("Platform authorization policy upgrade failed")

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
class PlatformPolicyV2Upgrader(
    private val jdbc: JdbcTemplate,
    private val transactions: TransactionTemplate,
) : ApplicationRunner {
    override fun run(args: ApplicationArguments) {
        try {
            upgrade()
        } catch (failure: PlatformPolicyUpgradeException) {
            throw failure
        } catch (_: Exception) {
            throw PlatformPolicyUpgradeException()
        }
    }

    fun upgrade(): PlatformPolicyUpgradeResult = try {
        transactions.execute {
            if (!policySchemaInstalled()) return@execute PlatformPolicyUpgradeResult.NO_ACTION
            jdbc.queryForObject("SELECT authz.lock_authorization_state_for_change()", Long::class.java)
                ?: fail()
            upgradeLocked()
        } ?: fail()
    } catch (failure: PlatformPolicyUpgradeException) {
        throw failure
    } catch (_: Exception) {
        fail()
    }

    private fun policySchemaInstalled(): Boolean = jdbc.queryForObject(
        """SELECT count(*) FROM information_schema.tables
           WHERE lower(table_schema) = 'authz' AND lower(table_name) = 'policy_release'""",
        Long::class.java,
    ) == 1L

    private fun upgradeLocked(): PlatformPolicyUpgradeResult {
        val activePlatforms = jdbc.query(
            """SELECT pr.id AS release_id, pr.release_number, pr.content_hash AS release_hash,
                      pr.opa_revision, pr.published_at AS release_published_at,
                      pb.id AS bundle_id, pb.bundle_key, pb.layer, pb.status AS bundle_status,
                      pbv.id AS version_id, pbv.version, pbv.status AS version_status,
                      pbv.manifest::text AS manifest, pbv.content_hash AS version_hash,
                      pbv.published_at AS version_published_at
               FROM authz.policy_release pr
               JOIN authz.policy_release_item pri ON pri.release_id = pr.id
               JOIN authz.policy_bundle pb ON pb.id = pri.bundle_id
               JOIN authz.policy_bundle_version pbv ON pbv.id = pri.bundle_version_id
               WHERE pr.status = 'ACTIVE' AND pb.layer = 'PLATFORM'
               FOR UPDATE OF pr, pb, pbv""",
        ) { rs, _ ->
            ActivePlatform(
                rs.getObject("release_id", UUID::class.java), rs.getLong("release_number"),
                rs.getString("release_hash"), rs.getString("opa_revision"),
                rs.getObject("release_published_at", OffsetDateTime::class.java),
                rs.getObject("bundle_id", UUID::class.java), rs.getString("bundle_key"),
                rs.getString("layer"), rs.getString("bundle_status"),
                rs.getObject("version_id", UUID::class.java), rs.getInt("version"),
                rs.getString("version_status"), rs.getString("manifest"), rs.getString("version_hash"),
                rs.getObject("version_published_at", OffsetDateTime::class.java),
            )
        }
        if (activePlatforms.isEmpty()) {
            val policyRows = jdbc.queryForObject(
                """SELECT (SELECT count(*) FROM authz.policy_bundle WHERE layer = 'PLATFORM') +
                          (SELECT count(*) FROM authz.policy_release)""",
                Long::class.java,
            ) ?: fail()
            if (policyRows != 0L) fail()
            return PlatformPolicyUpgradeResult.NO_ACTION
        }
        if (activePlatforms.size != 1) fail()
        val active = activePlatforms.single()
        ensureWorkflowRoles()
        val items = loadItems(active.releaseId)
        validateReleaseHash(active, items)
        return when (active.opaRevision) {
            BootstrapPolicyV1Baseline.OPA_REVISION -> upgradeV1(active, items)
            BootstrapPolicyBaseline.OPA_REVISION -> {
                validateV2(active)
                PlatformPolicyUpgradeResult.NO_ACTION
            }
            else -> fail()
        }
    }

    private fun ensureWorkflowRoles() {
        val now = OffsetDateTime.now()
        WorkflowAuthorizationRoles.all.forEach { role ->
            ensure(
                "authz.entity",
                "id = ? OR (entity_type_id = ? AND entity_key = ?)",
                arrayOf(role.id, BootstrapIds.ROLE_TYPE, role.key),
                """id = ? AND entity_type_id = ? AND entity_type_version_id = ? AND entity_key = ?
                   AND state = 'ACTIVE' AND auth_attributes = '{}'::jsonb AND row_version = 0
                   AND created_by IS NULL AND updated_by IS NULL""",
                arrayOf(role.id, BootstrapIds.ROLE_TYPE, BootstrapIds.ROLE_TYPE_VERSION, role.key),
            ) {
                jdbc.update(
                    """INSERT INTO authz.entity
                       (id, entity_type_id, entity_type_version_id, entity_key, state, created_at, updated_at)
                       VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)""",
                    role.id, BootstrapIds.ROLE_TYPE, BootstrapIds.ROLE_TYPE_VERSION, role.key, now, now,
                )
            }
            ensure(
                "iam.principal", "id = ?", arrayOf(role.id),
                """id = ? AND principal_kind = 'ROLE' AND display_name = ? AND status = 'ACTIVE'
                   AND profile = '{}'::jsonb AND row_version = 0 AND created_by IS NULL AND updated_by IS NULL""",
                arrayOf(role.id, role.displayName),
            ) {
                jdbc.update(
                    """INSERT INTO iam.principal
                       (id, principal_kind, display_name, status, created_at, updated_at)
                       VALUES (?, 'ROLE', ?, 'ACTIVE', ?, ?)""",
                    role.id, role.displayName, now, now,
                )
            }
        }
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
            insert()
        } else if (collisions != 1L || count(
                "SELECT count(*) FROM $table WHERE $expectedPredicate", *expectedArguments,
            ) != 1L
        ) fail()
    }

    private fun count(sql: String, vararg arguments: Any): Long =
        jdbc.queryForObject(sql, Long::class.java, *arguments) ?: fail()

    private fun upgradeV1(active: ActivePlatform, items: List<ReleaseItem>): PlatformPolicyUpgradeResult {
        if (active.releaseId != BootstrapIds.POLICY_RELEASE_V1 || active.releaseNumber != 1L ||
            active.bundleId != BootstrapIds.POLICY_BUNDLE || active.bundleKey != "platform-core-authorization" ||
            active.layer != "PLATFORM" || active.bundleStatus != "ACTIVE" ||
            active.versionId != BootstrapIds.POLICY_BUNDLE_VERSION_V1 || active.version != 1 ||
            active.versionStatus != "PUBLISHED" || active.versionHash != BootstrapPolicyV1Baseline.contentHash ||
            PolicyReleaseIntegrity.manifestContentHash(active.manifest) != BootstrapPolicyV1Baseline.contentHash ||
            active.releasePublishedAt == null || active.versionPublishedAt == null
        ) fail()
        if (jdbc.queryForObject(
                """SELECT count(*) FROM authz.policy_bundle_version
                   WHERE id = ? OR (bundle_id = ? AND version = 2)""",
                Long::class.java, BootstrapIds.POLICY_BUNDLE_VERSION_V2, BootstrapIds.POLICY_BUNDLE,
            ) != 0L || jdbc.queryForObject(
                "SELECT count(*) FROM authz.policy_release WHERE id = ? OR release_number = 2",
                Long::class.java, BootstrapIds.POLICY_RELEASE_V2,
            ) != 0L
        ) fail()

        val now = OffsetDateTime.now()
        jdbc.update(
            """INSERT INTO authz.policy_bundle_version
               (id, bundle_id, version, status, manifest, content_hash, created_at, published_at)
               VALUES (?, ?, 2, 'PUBLISHED', ?::jsonb, ?, ?, ?)""",
            BootstrapIds.POLICY_BUNDLE_VERSION_V2, BootstrapIds.POLICY_BUNDLE,
            BootstrapPolicyBaseline.manifest, BootstrapPolicyBaseline.contentHash, now, now,
        )
        val upgradedItems = items.map { item ->
            if (item.layer == PolicyLayer.PLATFORM) {
                item.copy(
                    bundleVersionId = BootstrapIds.POLICY_BUNDLE_VERSION_V2,
                    bundleContentHash = BootstrapPolicyBaseline.contentHash,
                )
            } else item
        }
        val releaseHash = releaseHash(BootstrapPolicyBaseline.OPA_REVISION, upgradedItems)
        jdbc.update(
            """INSERT INTO authz.policy_release(id, release_number, status, content_hash, created_at)
               VALUES (?, 2, 'STAGED', ?, ?)""",
            BootstrapIds.POLICY_RELEASE_V2, releaseHash, now,
        )
        upgradedItems.forEach { item ->
            jdbc.update(
                "INSERT INTO authz.policy_release_item(release_id, bundle_id, bundle_version_id) VALUES (?, ?, ?)",
                BootstrapIds.POLICY_RELEASE_V2, item.bundleId, item.bundleVersionId,
            )
        }
        jdbc.update("UPDATE authz.policy_release SET status = 'RETIRED' WHERE id = ?", active.releaseId)
        jdbc.update(
            """UPDATE authz.policy_release SET status = 'ACTIVE', opa_revision = ?, published_at = ?
               WHERE id = ? AND status = 'STAGED'""",
            BootstrapPolicyBaseline.OPA_REVISION, now, BootstrapIds.POLICY_RELEASE_V2,
        )
        return PlatformPolicyUpgradeResult.UPGRADED
    }

    private fun validateV2(active: ActivePlatform) {
        if (active.bundleId != BootstrapIds.POLICY_BUNDLE || active.bundleKey != "platform-core-authorization" ||
            active.layer != "PLATFORM" || active.bundleStatus != "ACTIVE" ||
            active.versionId != BootstrapIds.POLICY_BUNDLE_VERSION_V2 || active.version != 2 ||
            active.versionStatus != "PUBLISHED" || active.versionHash != BootstrapPolicyBaseline.contentHash ||
            PolicyReleaseIntegrity.manifestContentHash(active.manifest) != BootstrapPolicyBaseline.contentHash ||
            active.releasePublishedAt == null || active.versionPublishedAt == null
        ) fail()
    }

    private fun loadItems(releaseId: UUID): List<ReleaseItem> = jdbc.query(
        """SELECT pb.layer, pri.bundle_id, pri.bundle_version_id, pbv.content_hash
           FROM authz.policy_release_item pri
           JOIN authz.policy_bundle pb ON pb.id = pri.bundle_id
           JOIN authz.policy_bundle_version pbv ON pbv.id = pri.bundle_version_id
           WHERE pri.release_id = ? ORDER BY pb.layer""",
        { rs, _ ->
            ReleaseItem(
                PolicyLayer.valueOf(rs.getString("layer")),
                rs.getObject("bundle_id", UUID::class.java),
                rs.getObject("bundle_version_id", UUID::class.java),
                rs.getString("content_hash"),
            )
        },
        releaseId,
    )

    private fun validateReleaseHash(active: ActivePlatform, items: List<ReleaseItem>) {
        if (items.isEmpty() || active.releaseHash != releaseHash(active.opaRevision, items)) fail()
    }

    private fun releaseHash(revision: String, items: List<ReleaseItem>) = PolicyReleaseIntegrity.contentHash(
        revision,
        items.map { PolicyReleaseItemIntegrity(it.layer, it.bundleId, it.bundleVersionId, it.bundleContentHash) },
    )

    private fun fail(): Nothing = throw PlatformPolicyUpgradeException()

    private data class ActivePlatform(
        val releaseId: UUID,
        val releaseNumber: Long,
        val releaseHash: String,
        val opaRevision: String,
        val releasePublishedAt: OffsetDateTime?,
        val bundleId: UUID,
        val bundleKey: String,
        val layer: String,
        val bundleStatus: String,
        val versionId: UUID,
        val version: Int,
        val versionStatus: String,
        val manifest: String,
        val versionHash: String,
        val versionPublishedAt: OffsetDateTime?,
    )

    private data class ReleaseItem(
        val layer: PolicyLayer,
        val bundleId: UUID,
        val bundleVersionId: UUID,
        val bundleContentHash: String,
    )
}
