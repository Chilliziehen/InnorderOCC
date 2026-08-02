package com.innorder.occ.risk

import com.innorder.occ.iam.BootstrapIds
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.core.Ordered
import org.springframework.jdbc.core.JdbcOperations
import org.springframework.stereotype.Component
import java.util.UUID

class RiskRuntimeConfigurationException : IllegalStateException("Risk runtime identity configuration is invalid")

@Component
class RiskRuntimeIdentityValidator(
    private val jdbc: JdbcOperations,
    private val due: RiskDueProperties,
    private val metrics: RiskMetricsProperties,
) : ApplicationRunner, Ordered {
    override fun getOrder(): Int = ORDER

    override fun run(args: ApplicationArguments) {
        if (due.enabled && !validSystemPrincipal(due.systemPrincipalUuid)) throw RiskRuntimeConfigurationException()
        if (metrics.enabled && !validReportResource(metrics.reportResourceUuid)) throw RiskRuntimeConfigurationException()
    }

    private fun validSystemPrincipal(id: UUID?): Boolean = id != null && jdbc.queryForObject(
        """SELECT EXISTS (
             SELECT 1 FROM authz.entity entity
             JOIN iam.principal principal ON principal.id = entity.id
             WHERE entity.id = ? AND entity.entity_type_id = ? AND entity.entity_type_version_id = ?
               AND entity.entity_key = ? AND entity.state = 'ACTIVE'
               AND principal.status = 'ACTIVE' AND principal.principal_kind = 'SERVICE'
           )""",
        Boolean::class.java,
        id,
        BootstrapIds.USER_TYPE,
        BootstrapIds.USER_TYPE_VERSION,
        RiskRuntimeIdentityProvisioner.SYSTEM_ENTITY_KEY,
    ) == true

    private fun validReportResource(id: UUID?): Boolean = id != null && jdbc.queryForObject(
        """SELECT EXISTS (
             SELECT 1 FROM authz.entity entity
             JOIN catalog.entity_type type ON type.id = entity.entity_type_id
             WHERE entity.id = ? AND entity.entity_type_id = ? AND entity.entity_type_version_id = ?
               AND entity.entity_key = ? AND entity.state = 'ACTIVE' AND type.authorizable
               AND type.entity_kind = 'SYSTEM'
           )""",
        Boolean::class.java,
        id,
        BootstrapIds.SYSTEM_TYPE,
        BootstrapIds.SYSTEM_TYPE_VERSION,
        RiskRuntimeIdentityProvisioner.REPORT_ENTITY_KEY,
    ) == true

    companion object {
        const val ORDER = 20
    }
}
