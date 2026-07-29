package com.innorder.occ.system

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonFormat
import java.time.Instant

enum class ServiceState {
    READY,
    DEGRADED,
    UNREACHABLE,
    CHECKING,
}

@JsonInclude(JsonInclude.Include.NON_NULL)
data class ComponentStatus(
    val id: String,
    val label: String,
    val state: ServiceState,
    val detail: String? = null,
    @field:JsonFormat(shape = JsonFormat.Shape.STRING)
    val checkedAt: Instant,
)

data class SystemStatus(
    val service: String,
    val version: String,
    val state: ServiceState,
    @field:JsonFormat(shape = JsonFormat.Shape.STRING)
    val checkedAt: Instant,
    val components: List<ComponentStatus>,
)
