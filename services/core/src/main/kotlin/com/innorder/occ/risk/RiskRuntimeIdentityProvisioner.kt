package com.innorder.occ.risk

import com.innorder.occ.iam.BootstrapIds
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.core.Ordered
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Component
import org.springframework.transaction.support.TransactionTemplate
import java.nio.charset.StandardCharsets
import java.util.UUID

enum class RiskRuntimeProvisioningResult { CREATED, ALREADY_PROVISIONED }

@Component
class RiskRuntimeIdentityProvisioner(
    private val jdbc: JdbcTemplate,
    private val transactions: TransactionTemplate,
    private val due: RiskDueProperties,
    private val metrics: RiskMetricsProperties,
) : ApplicationRunner, Ordered {
    override fun getOrder(): Int = ORDER

    override fun run(args: ApplicationArguments) {
        provision()
    }

    fun provision(): RiskRuntimeProvisioningResult {
        if (!due.enabled && !metrics.enabled) return RiskRuntimeProvisioningResult.ALREADY_PROVISIONED
        val systemId = due.systemPrincipalUuid.takeIf { due.enabled }
        val reportId = metrics.reportResourceUuid.takeIf { metrics.enabled }
        if (systemId != null && systemId == reportId) throw RiskRuntimeConfigurationException()
        return transactions.execute {
            jdbc.queryForObject("SELECT pg_advisory_xact_lock(?) IS NULL", Boolean::class.java, PROVISIONING_LOCK)
            jdbc.queryForObject("SELECT authz.lock_authorization_state_for_change()", Long::class.java)
            var created = false
            if (systemId != null) {
                created = ensureSystemEntity(systemId) || created
                created = ensureSystemPrincipal(systemId) || created
                created = ensureRoleAssignment(systemId) || created
            }
            if (reportId != null) created = ensureReportEntity(reportId) || created
            if (created) RiskRuntimeProvisioningResult.CREATED else RiskRuntimeProvisioningResult.ALREADY_PROVISIONED
        } ?: throw RiskRuntimeConfigurationException()
    }

    private fun ensureSystemEntity(id: UUID): Boolean = ensureExact(
        "authz.entity",
        "id = ? OR (entity_type_id = ? AND entity_key = ?)",
        arrayOf(id, BootstrapIds.USER_TYPE, SYSTEM_ENTITY_KEY),
        """id = ? AND entity_type_id = ? AND entity_type_version_id = ? AND entity_key = ?
           AND state = 'ACTIVE' AND auth_attributes = '{}'::jsonb AND row_version = 0
           AND created_by IS NULL AND updated_by IS NULL AND created_at = updated_at""",
        arrayOf(id, BootstrapIds.USER_TYPE, BootstrapIds.USER_TYPE_VERSION, SYSTEM_ENTITY_KEY),
    ) {
        jdbc.update(
            """INSERT INTO authz.entity
               (id, entity_type_id, entity_type_version_id, entity_key, state, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'ACTIVE', transaction_timestamp(), transaction_timestamp())""",
            id, BootstrapIds.USER_TYPE, BootstrapIds.USER_TYPE_VERSION, SYSTEM_ENTITY_KEY,
        )
    }

    private fun ensureSystemPrincipal(id: UUID): Boolean = ensureExact(
        "iam.principal",
        "id = ?",
        arrayOf(id),
        """id = ? AND principal_kind = 'SERVICE' AND display_name = ? AND status = 'ACTIVE'
           AND profile = '{}'::jsonb AND row_version = 0 AND created_by IS NULL AND updated_by IS NULL
           AND created_at = updated_at""",
        arrayOf(id, SYSTEM_DISPLAY_NAME),
    ) {
        jdbc.update(
            """INSERT INTO iam.principal
               (id, principal_kind, display_name, status, created_at, updated_at)
               VALUES (?, 'SERVICE', ?, 'ACTIVE', transaction_timestamp(), transaction_timestamp())""",
            id, SYSTEM_DISPLAY_NAME,
        )
    }

    private fun ensureReportEntity(id: UUID): Boolean = ensureExact(
        "authz.entity",
        "id = ? OR (entity_type_id = ? AND entity_key = ?)",
        arrayOf(id, BootstrapIds.SYSTEM_TYPE, REPORT_ENTITY_KEY),
        """id = ? AND entity_type_id = ? AND entity_type_version_id = ? AND entity_key = ?
           AND state = 'ACTIVE' AND auth_attributes = '{}'::jsonb AND row_version = 0
           AND created_by IS NULL AND updated_by IS NULL AND created_at = updated_at""",
        arrayOf(id, BootstrapIds.SYSTEM_TYPE, BootstrapIds.SYSTEM_TYPE_VERSION, REPORT_ENTITY_KEY),
    ) {
        jdbc.update(
            """INSERT INTO authz.entity
               (id, entity_type_id, entity_type_version_id, entity_key, state, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'ACTIVE', transaction_timestamp(), transaction_timestamp())""",
            id, BootstrapIds.SYSTEM_TYPE, BootstrapIds.SYSTEM_TYPE_VERSION, REPORT_ENTITY_KEY,
        )
    }

    private fun ensureRoleAssignment(systemId: UUID): Boolean {
        val relationshipId = UUID.nameUUIDFromBytes(
            "risk-runtime-role-assignment:$systemId".toByteArray(StandardCharsets.UTF_8),
        )
        return ensureExact(
            "authz.relationship",
            "id = ? OR (relation_definition_id = ? AND subject_entity_id = ? AND object_entity_id = ?)",
            arrayOf(relationshipId, BootstrapIds.ROLE_ASSIGNMENT_RELATION, systemId, BootstrapIds.RISK_RUNTIME_ROLE),
            """id = ? AND relation_definition_id = ? AND subject_entity_id = ? AND object_entity_id = ?
               AND attributes = '{}'::jsonb AND valid_until IS NULL AND revoked_at IS NULL AND revoked_by IS NULL
               AND source_kind = 'SYSTEM' AND source_ref = ? AND row_version = 0
               AND created_by IS NULL AND updated_by IS NULL AND valid_from = created_at AND created_at = updated_at""",
            arrayOf(
                relationshipId, BootstrapIds.ROLE_ASSIGNMENT_RELATION, systemId,
                BootstrapIds.RISK_RUNTIME_ROLE, RELATIONSHIP_SOURCE,
            ),
        ) {
            jdbc.update(
                """INSERT INTO authz.relationship
                   (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from,
                    source_kind, source_ref, created_at, updated_at)
                   VALUES (?, ?, ?, ?, transaction_timestamp(), 'SYSTEM', ?,
                           transaction_timestamp(), transaction_timestamp())""",
                relationshipId, BootstrapIds.ROLE_ASSIGNMENT_RELATION, systemId,
                BootstrapIds.RISK_RUNTIME_ROLE, RELATIONSHIP_SOURCE,
            )
        }
    }

    private fun ensureExact(
        table: String,
        selector: String,
        selectorArguments: Array<out Any>,
        exact: String,
        exactArguments: Array<out Any>,
        insert: () -> Unit,
    ): Boolean {
        val candidates = count("SELECT count(*) FROM $table WHERE $selector", *selectorArguments)
        if (candidates == 0L) {
            insert()
            return true
        }
        if (candidates != 1L || count(
                "SELECT count(*) FROM $table WHERE ($selector) AND ($exact)",
                *selectorArguments,
                *exactArguments,
            ) != 1L
        ) throw RiskRuntimeConfigurationException()
        return false
    }

    private fun count(sql: String, vararg arguments: Any): Long =
        jdbc.queryForObject(sql, Long::class.java, *arguments)!!

    companion object {
        const val ORDER = 10
        const val SYSTEM_ENTITY_KEY = "service:risk-runtime"
        const val REPORT_ENTITY_KEY = "system:risk-report"
        private const val SYSTEM_DISPLAY_NAME = "Risk runtime"
        private const val RELATIONSHIP_SOURCE = "risk-runtime-provisioner"
        private const val PROVISIONING_LOCK = 0x4f43435249534b49L
    }
}
