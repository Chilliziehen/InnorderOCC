package com.innorder.occ.cohort

import com.innorder.occ.command.AggregateLockResolver
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

const val COHORT_AGGREGATE_TYPE = "COHORT"

fun cohortAggregateLockResolver() = AggregateLockResolver(COHORT_AGGREGATE_TYPE, 100) { jdbc, id ->
    jdbc.query(
        "SELECT row_version FROM occ.cohort WHERE id = ? FOR UPDATE",
        { rs, _ -> rs.getLong("row_version") },
        id,
    ).singleOrNull()
}

@Configuration(proxyBeanMethods = false)
class CohortAggregateLockConfiguration {
    @Bean
    fun cohortLockResolver(): AggregateLockResolver = cohortAggregateLockResolver()
}
