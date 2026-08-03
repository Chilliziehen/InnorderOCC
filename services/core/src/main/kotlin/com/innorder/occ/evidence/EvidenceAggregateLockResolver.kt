package com.innorder.occ.evidence

import com.innorder.occ.command.AggregateLockResolver
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

const val EVIDENCE_AGGREGATE_TYPE = "evidence"

// Evidence heads lock before risks and resources so a command spanning several
// domains always takes them in the same order.
private const val EVIDENCE_ORDER = 200

fun evidenceAggregateLockResolver() =
    AggregateLockResolver(EVIDENCE_AGGREGATE_TYPE, EVIDENCE_ORDER) { jdbc, id ->
        jdbc.query(
            "SELECT row_version FROM occ.evidence WHERE id = ? FOR UPDATE",
            { rs, _ -> rs.getLong("row_version") },
            id,
        ).singleOrNull()
    }

@Configuration(proxyBeanMethods = false)
class EvidenceAggregateLockConfiguration {
    @Bean
    fun evidenceLockResolver(): AggregateLockResolver = evidenceAggregateLockResolver()
}
