package com.innorder.occ.system

import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service
import java.time.Clock
import java.time.Instant

@Service
class SystemStatusService(
    @param:Value("\${spring.application.version}") private val version: String,
    private val clock: Clock,
    private val probeRunner: StatusProbeRunner,
) {
    fun currentStatus(): SystemStatus {
        val checkedAt = Instant.now(clock)
        val reported = try {
            probeRunner.checkAll().associateBy { it.id }
        } catch (_: Exception) {
            emptyMap()
        }
        val dependencies = DEPENDENCIES.map { (id, label) ->
            val status = reported[id]
            ComponentStatus(
                id = id,
                label = label,
                state = status?.state ?: ServiceState.UNREACHABLE,
                detail = status?.detail ?: "$label unavailable",
                checkedAt = checkedAt,
            )
        }
        return SystemStatus(
            service = "occ-core",
            version = version,
            state = if (dependencies.all { it.state == ServiceState.READY }) ServiceState.READY else ServiceState.DEGRADED,
            checkedAt = checkedAt,
            components = listOf(
                ComponentStatus(
                    id = "core-runtime",
                    label = "Core Runtime",
                    state = ServiceState.READY,
                    checkedAt = checkedAt,
                ),
            ) + dependencies,
        )
    }

    companion object {
        private val DEPENDENCIES = listOf(
            "postgresql" to "PostgreSQL",
            "flowable" to "Flowable",
            "opa" to "OPA",
            "kafka" to "Kafka",
            "redis" to "Redis",
            "minio" to "MinIO",
        )
    }
}
