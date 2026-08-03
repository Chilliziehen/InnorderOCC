package com.innorder.occ.ai

import com.innorder.occ.command.AggregateLockResolver
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

const val KNOWLEDGE_SOURCE_AGGREGATE_TYPE = "knowledge-source"

private const val KNOWLEDGE_SOURCE_ORDER = 400

fun knowledgeSourceAggregateLockResolver() =
    AggregateLockResolver(KNOWLEDGE_SOURCE_AGGREGATE_TYPE, KNOWLEDGE_SOURCE_ORDER) { jdbc, id ->
        jdbc.query(
            "SELECT row_version FROM ai.knowledge_source WHERE id = ? FOR UPDATE",
            { rs, _ -> rs.getLong("row_version") },
            id,
        ).singleOrNull()
    }

@Configuration(proxyBeanMethods = false)
class KnowledgeAggregateLockConfiguration {
    @Bean
    fun knowledgeSourceLockResolver(): AggregateLockResolver = knowledgeSourceAggregateLockResolver()
}
