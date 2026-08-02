package com.innorder.occ.risk

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Configuration
import java.util.UUID

@ConfigurationProperties(prefix = "occ.risk-metrics", ignoreUnknownFields = false)
data class RiskMetricsProperties(val reportResourceId: UUID? = null)

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(RiskMetricsProperties::class)
class RiskMetricsConfiguration
