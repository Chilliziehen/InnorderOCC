package com.innorder.occ.risk

import org.slf4j.LoggerFactory
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.annotation.Scheduled
import java.time.Clock
import java.time.Duration
import java.util.UUID

@ConfigurationProperties(prefix = "occ.risk-due", ignoreUnknownFields = false)
data class RiskDueProperties(
    val enabled: Boolean = false,
    val systemPrincipalId: UUID? = null,
    val batchSize: Int = 50,
    val pollInterval: Duration = Duration.ofMinutes(1),
) {
    init {
        require(batchSize in 1..100)
        require(pollInterval in Duration.ofSeconds(1)..Duration.ofHours(1))
        require(!enabled || systemPrincipalId != null)
    }
}

data class RiskDueEvaluationResult(val slaBreaches: Int, val escalations: Int)

class RiskDueEvaluator(
    private val risks: RiskService,
    private val properties: RiskDueProperties,
    private val clock: Clock,
) {
    fun runOnce(): RiskDueEvaluationResult {
        if (!properties.enabled) return RiskDueEvaluationResult(0, 0)
        val principalId = requireNotNull(properties.systemPrincipalId)
        val at = clock.instant()
        val correlationId = UUID.randomUUID()
        val breaches = risks.recordDueSlaBreaches(principalId, at, properties.batchSize, correlationId)
        val escalations = risks.escalateDue(principalId, at, properties.batchSize, correlationId)
        return RiskDueEvaluationResult(breaches.size, escalations.size)
    }

    @Scheduled(fixedDelayString = "#{@'occ.risk-due-com.innorder.occ.risk.RiskDueProperties'.pollInterval.toMillis()}")
    fun poll() {
        try {
            runOnce()
        } catch (error: Exception) {
            LOG.warn("Risk due evaluation failed", error)
        }
    }

    private companion object {
        val LOG = LoggerFactory.getLogger(RiskDueEvaluator::class.java)
    }
}

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(RiskDueProperties::class)
class RiskDueConfiguration {
    @Bean
    fun riskDueEvaluator(risks: RiskService, riskDueProperties: RiskDueProperties, clock: Clock) =
        RiskDueEvaluator(risks, riskDueProperties, clock)
}
