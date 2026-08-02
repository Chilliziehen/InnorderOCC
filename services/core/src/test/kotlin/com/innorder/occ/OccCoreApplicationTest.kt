package com.innorder.occ

import com.innorder.occ.iam.PlatformSecurityBaseline
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.mock.mockito.MockBean
import org.springframework.core.env.Environment
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.get

@SpringBootTest(
    properties = [
        "spring.datasource.url=jdbc:h2:mem:occ-core-test;DB_CLOSE_DELAY=-1",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "spring.datasource.hikari.connection-init-sql=CREATE SCHEMA IF NOT EXISTS \"flowable\"",
        "spring.flyway.enabled=false",
    ],
)
@AutoConfigureMockMvc
class OccCoreApplicationTest(
    @param:Autowired private val mockMvc: MockMvc,
    @param:Autowired private val environment: Environment,
    @param:Autowired private val jdbcTemplate: JdbcTemplate,
) {
    @MockBean
    private lateinit var platformSecurityBaseline: PlatformSecurityBaseline

    @Test
    fun `application enables bounded graceful shutdown`() {
        assertThat(environment.getProperty("server.shutdown")).isEqualTo("graceful")
        assertThat(environment.getProperty("spring.lifecycle.timeout-per-shutdown-phase")).isEqualTo("30s")
    }

    @Test
    fun `database probe and pool acquisition share a sub two second budget`() {
        assertThat(environment.getProperty("occ.database-probe.timeout")).isEqualTo("1500ms")
        assertThat(environment.getProperty("spring.datasource.hikari.connection-timeout")).isEqualTo("1500")
        assertThat(environment.getProperty("occ.status-probes.deadline")).isEqualTo("2000ms")
        assertThat(environment.getProperty("occ.status-probes.external-enabled")).isEqualTo("true")
        assertThat(environment.getProperty("spring.data.redis.timeout")).isEqualTo("1500ms")
    }

    @Test
    fun `application separates migration and runtime database identities`() {
        assertThat(environment.getProperty("spring.datasource.username")).isEqualTo("sa")
        assertThat(environment.getProperty("spring.flyway.user")).isEqualTo("innorder_flyway")
        assertThat(environment.getProperty("spring.flyway.password")).isEqualTo("")
    }

    @Test
    fun `Flowable owns and updates its internal schema by default`() {
        assertThat(environment.getProperty("flowable.database-schema-update")).isEqualTo("true")

        val internalTableCount = jdbcTemplate.queryForObject(
            """
            SELECT COUNT(*)
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = 'flowable'
              AND TABLE_NAME LIKE 'ACT_%'
            """.trimIndent(),
            Int::class.java,
        )
        assertThat(internalTableCount).isPositive()
    }

    @Test
    fun `status is public through the application security filter chain`() {
        mockMvc.get("/api/v1/system/status")
            .andExpect {
                status { isOk() }
                jsonPath("$.service") { value("occ-core") }
            }
    }

    @Test
    fun `readiness exposes only ping and database health contributors`() {
        mockMvc.get("/actuator/health/readiness")
            .andExpect {
                status { isOk() }
                jsonPath("$.components.length()") { value(2) }
                jsonPath("$.components.ping.status") { value("UP") }
                jsonPath("$.components.db.status") { value("UP") }
            }
    }

    @Test
    fun `generic actuator health is not anonymously exposed`() {
        mockMvc.get("/actuator/health")
            .andExpect {
                status { isUnauthorized() }
            }
    }

    @Test
    fun `unlisted endpoints reject anonymous requests`() {
        mockMvc.get("/api/v1/unlisted")
            .andExpect {
                status { isUnauthorized() }
            }
    }
}
