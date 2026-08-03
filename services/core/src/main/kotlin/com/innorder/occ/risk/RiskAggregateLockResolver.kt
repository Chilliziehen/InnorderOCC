package com.innorder.occ.risk

import com.innorder.occ.command.AggregateLockResolver
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

const val RISK_AGGREGATE_TYPE = "risk"
const val RISK_OCCURRENCE_COMMAND_AGGREGATE_TYPE = "risk-occurrence-command"
const val RISK_ADJUDICATION_AGGREGATE_TYPE = "risk-adjudication"

// Risks lock before the per-invocation command row and before the adjudication
// series, so any command touching several of them takes them in one order.
private const val RISK_ORDER = 500
private const val RISK_OCCURRENCE_COMMAND_ORDER = 510
private const val RISK_ADJUDICATION_ORDER = 520

private fun rowVersionResolver(type: String, order: Int, table: String) =
    AggregateLockResolver(type, order) { jdbc, id ->
        jdbc.query(
            "SELECT row_version FROM $table WHERE id = ? FOR UPDATE",
            { rs, _ -> rs.getLong("row_version") },
            id,
        ).singleOrNull()
    }

fun riskAggregateLockResolver() = rowVersionResolver(RISK_AGGREGATE_TYPE, RISK_ORDER, "occ.risk")

fun riskOccurrenceCommandAggregateLockResolver() = rowVersionResolver(
    RISK_OCCURRENCE_COMMAND_AGGREGATE_TYPE, RISK_OCCURRENCE_COMMAND_ORDER, "occ.risk_occurrence_command",
)

fun riskAdjudicationAggregateLockResolver() = rowVersionResolver(
    RISK_ADJUDICATION_AGGREGATE_TYPE, RISK_ADJUDICATION_ORDER, "occ.risk_adjudication_series",
)

@Configuration(proxyBeanMethods = false)
class RiskAggregateLockConfiguration {
    @Bean
    fun riskLockResolver(): AggregateLockResolver = riskAggregateLockResolver()

    @Bean
    fun riskOccurrenceCommandLockResolver(): AggregateLockResolver = riskOccurrenceCommandAggregateLockResolver()

    @Bean
    fun riskAdjudicationLockResolver(): AggregateLockResolver = riskAdjudicationAggregateLockResolver()
}
