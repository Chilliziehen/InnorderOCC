package com.innorder.occ.risk

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Configuration
import java.util.UUID

@ConfigurationProperties(prefix = "occ.risk-metrics", ignoreUnknownFields = false)
data class RiskMetricsProperties(
    val enabled: Boolean = false,
    val reportResourceId: String = "",
) {
    val reportResourceUuid: UUID? = configuredUuid(reportResourceId)

    init {
        require(!enabled || reportResourceUuid != null) {
            "Enabled risk metrics requires a report resource ID"
        }
    }
}

internal fun configuredUuid(value: String): UUID? {
    if (value.isBlank()) return null
    return try {
        UUID.fromString(value).also { require(it.toString().equals(value, ignoreCase = true)) }
    } catch (exception: Exception) {
        throw IllegalArgumentException("Risk runtime identity must be a canonical UUID", exception)
    }
}

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(RiskMetricsProperties::class)
class RiskMetricsConfiguration
