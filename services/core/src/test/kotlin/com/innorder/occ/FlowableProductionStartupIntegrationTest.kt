package com.innorder.occ

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.flowable.engine.RepositoryService
import org.flowable.spring.SpringProcessEngineConfiguration
import org.flowable.spring.boot.EngineConfigurationConfigurer
import org.junit.jupiter.api.Test
import org.postgresql.ds.PGSimpleDataSource
import org.springframework.boot.builder.SpringApplicationBuilder
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.ApplicationListener
import org.springframework.context.annotation.Bean
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.util.concurrent.atomic.AtomicBoolean

@Testcontainers
class FlowableProductionStartupIntegrationTest {
    @Test
    fun `shipped initializer creates Flowable schema and production startup performs no schema DDL`() {
        val flywayJdbc = flywayJdbc()
        assertThat(flowableTables(flywayJdbc)).isEmpty()

        val initializer = SpringApplicationBuilder(OccCoreApplication::class.java)
            .run(*arguments("flowable-init", schemaUpdate = true, web = false))
        if (initializer.isActive) initializer.close()

        val before = flowableMetadata(flywayJdbc)
        assertThat(before).isNotEmpty()
        flywayJdbc.execute("REVOKE CREATE ON SCHEMA flowable FROM innorder_runtime")
        try {
            SpringApplicationBuilder(OccCoreApplication::class.java)
                .run(*arguments("production", schemaUpdate = false, web = true)).use { context ->
                    val webContext = context as ServletWebServerApplicationContext
                    val response = HttpClient.newHttpClient().send(
                        HttpRequest.newBuilder(URI("http://127.0.0.1:${webContext.webServer.port}/actuator/health/readiness"))
                            .GET().build(),
                        HttpResponse.BodyHandlers.ofString(),
                    )
                    assertThat(response.statusCode()).isEqualTo(200)
                    assertThat(response.body()).contains("\"status\":\"UP\"")
                    assertThat(context.getBean(RepositoryService::class.java).createDeploymentQuery().count()).isZero()
                }
            assertThat(flowableMetadata(flywayJdbc)).containsExactlyElementsOf(before)
        } finally {
            flywayJdbc.execute("GRANT CREATE ON SCHEMA flowable TO innorder_runtime")
        }
    }

    @Test
    fun `full Boot startup rejects Flowable auto configuration redirected to a distinct transaction boundary`() {
        MisconfiguredFlowableConfiguration.jdbcUrl = postgres.jdbcUrl
        val ready = AtomicBoolean()
        assertThatThrownBy {
            SpringApplicationBuilder(OccCoreApplication::class.java, MisconfiguredFlowableConfiguration::class.java)
                .listeners(ApplicationListener<ApplicationReadyEvent> { ready.set(true) })
                .run(*arguments("test", schemaUpdate = true, web = false))
        }.hasRootCauseInstanceOf(IllegalStateException::class.java)
            .hasRootCauseMessage("Flowable transaction boundary is invalid")
        assertThat(ready).isFalse()
    }

    private fun arguments(profile: String, schemaUpdate: Boolean, web: Boolean): Array<String> = arrayOf(
        "--spring.profiles.active=$profile",
        "--spring.main.web-application-type=${if (web) "servlet" else "none"}",
        "--server.port=0",
        "--spring.datasource.url=${postgres.jdbcUrl}",
        "--spring.datasource.username=innorder_runtime",
        "--spring.datasource.password=runtime-test-only",
        "--spring.flyway.url=${postgres.jdbcUrl}",
        "--spring.flyway.user=innorder_flyway",
        "--spring.flyway.password=flyway-test-only",
        "--flowable.database-schema=flowable",
        "--flowable.database-schema-update=$schemaUpdate",
        "--occ.outbox.enabled=false",
        "--occ.status-probes.external-enabled=false",
    )

    private fun flywayJdbc() = JdbcTemplate(PGSimpleDataSource().apply {
        setURL(postgres.jdbcUrl)
        user = "innorder_flyway"
        password = "flyway-test-only"
    })

    private fun flowableTables(jdbc: JdbcTemplate): List<String> = jdbc.queryForList(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'flowable' ORDER BY tablename",
        String::class.java,
    )

    private fun flowableMetadata(jdbc: JdbcTemplate): List<String> = jdbc.queryForList(
        """SELECT table_name || ':' || column_name || ':' || data_type
           FROM information_schema.columns
           WHERE table_schema = 'flowable'
           ORDER BY table_name, ordinal_position""",
        String::class.java,
    )

    @TestConfiguration(proxyBeanMethods = false)
    class MisconfiguredFlowableConfiguration {
        @Bean
        @Order(Ordered.HIGHEST_PRECEDENCE)
        fun redirectFlowableBoundary(): EngineConfigurationConfigurer<SpringProcessEngineConfiguration> {
            val separateFlowableDataSource = PGSimpleDataSource().apply {
                setURL(jdbcUrl)
                user = "innorder_runtime"
                password = "runtime-test-only"
            }
            val separateFlowableTransactionManager = DataSourceTransactionManager(separateFlowableDataSource)
            return EngineConfigurationConfigurer { configuration ->
            configuration.dataSource = separateFlowableDataSource
            configuration.transactionManager = separateFlowableTransactionManager
            }
        }

        companion object {
            lateinit var jdbcUrl: String
        }
    }

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"

        @Container
        @JvmStatic
        val postgres: PostgreSQLContainer<*> = PostgreSQLContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("innorder_occ")
            .withUsername("innorder_admin")
            .withPassword("admin-test-only")
            .withCopyFileToContainer(
                MountableFile.forClasspathResource("postgres-test-init.sql"),
                "/docker-entrypoint-initdb.d/010-test-roles.sql",
            )
    }
}
