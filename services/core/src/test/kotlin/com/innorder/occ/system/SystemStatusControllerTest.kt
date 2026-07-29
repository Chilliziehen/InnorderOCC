package com.innorder.occ.system

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import org.assertj.core.api.Assertions.assertThat
import org.hamcrest.Matchers.matchesPattern
import org.junit.jupiter.api.Test
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

class SystemStatusControllerTest {
    private val checkedAt = Instant.parse("2026-07-28T12:34:56.789Z")
    private val dependencies = listOf(
        ProbeStatus.ready("postgresql", "PostgreSQL"),
        ProbeStatus.ready("flowable", "Flowable"),
        ProbeStatus.ready("opa", "OPA"),
        ProbeStatus.ready("kafka", "Kafka"),
        ProbeStatus.ready("redis", "Redis"),
        ProbeStatus.ready("minio", "MinIO"),
    )

    @Test
    fun `GET status delegates and returns every canonical component`() {
        val service = SystemStatusService("0.1.0", Clock.fixed(checkedAt, ZoneOffset.UTC), StatusProbeRunner { dependencies })
        val mockMvc = MockMvcBuilders.standaloneSetup(SystemStatusController(service))
            .setMessageConverters(
                org.springframework.http.converter.json.MappingJackson2HttpMessageConverter(
                    ObjectMapper().registerKotlinModule().findAndRegisterModules(),
                ),
            ).build()

        mockMvc.get("/api/v1/system/status") { accept = MediaType.APPLICATION_JSON }
            .andExpect {
                status { isOk() }
                content { contentTypeCompatibleWith(MediaType.APPLICATION_JSON) }
                jsonPath("$.length()") { value(5) }
                jsonPath("$.state") { value("READY") }
                jsonPath("$.checkedAt") {
                    value(matchesPattern("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$"))
                }
                jsonPath("$.components.length()") { value(7) }
                jsonPath("$.components[0].id") { value("core-runtime") }
                jsonPath("$.components[1].id") { value("postgresql") }
                jsonPath("$.components[2].id") { value("flowable") }
                jsonPath("$.components[3].id") { value("opa") }
                jsonPath("$.components[4].id") { value("kafka") }
                jsonPath("$.components[5].id") { value("redis") }
                jsonPath("$.components[6].id") { value("minio") }
            }
    }

    @Test
    fun `all ready probes report ready Core and all stable IDs`() {
        val status = SystemStatusService(
            "0.1.0",
            Clock.fixed(checkedAt, ZoneOffset.UTC),
            StatusProbeRunner { dependencies },
        ).currentStatus()

        assertThat(status.state).isEqualTo(ServiceState.READY)
        assertThat(status.components.map { it.id }).containsExactly(
            "core-runtime", "postgresql", "flowable", "opa", "kafka", "redis", "minio",
        )
        assertThat(status.components).allMatch { it.state == ServiceState.READY }
    }

    @Test
    fun `one unreachable probe degrades Core with fixed sanitized detail`() {
        val raw = "http://user:password@secret-host"
        val results = dependencies.map {
            if (it.id == "opa") ProbeStatus.unreachable("opa", "OPA", "OPA unavailable") else it
        }
        val status = SystemStatusService(
            "0.1.0",
            Clock.fixed(checkedAt, ZoneOffset.UTC),
            StatusProbeRunner { results },
        ).currentStatus()
        val serialized = ObjectMapper().registerKotlinModule().findAndRegisterModules().writeValueAsString(status)

        assertThat(status.state).isEqualTo(ServiceState.DEGRADED)
        assertThat(status.components.single { it.id == "opa" }.state).isEqualTo(ServiceState.UNREACHABLE)
        assertThat(serialized).doesNotContain(raw).doesNotContain("password")
    }

    @Test
    fun `runner exception degrades Core without leaking internals`() {
        val raw = "bootstrap.servers=secret-kafka:9092"
        val status = SystemStatusService(
            "0.1.0",
            Clock.fixed(checkedAt, ZoneOffset.UTC),
            StatusProbeRunner { throw IllegalStateException(raw) },
        ).currentStatus()
        val serialized = ObjectMapper().registerKotlinModule().findAndRegisterModules().writeValueAsString(status)

        assertThat(status.state).isEqualTo(ServiceState.DEGRADED)
        assertThat(serialized).doesNotContain(raw).doesNotContain("secret-kafka")
    }
}
