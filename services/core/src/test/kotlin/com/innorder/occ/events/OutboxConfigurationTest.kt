package com.innorder.occ.events

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.boot.env.YamlPropertySourceLoader
import org.springframework.core.io.ClassPathResource
import org.springframework.transaction.PlatformTransactionManager
import java.util.function.Supplier

class OutboxConfigurationTest {
    private val context = ApplicationContextRunner()
        .withUserConfiguration(OutboxConfiguration::class.java)
        .withBean(JdbcTemplate::class.java, Supplier { mock(JdbcTemplate::class.java) })
        .withBean(PlatformTransactionManager::class.java, Supplier { mock(PlatformTransactionManager::class.java) })
        .withBean("outboxKafkaTemplate", KafkaTemplate::class.java, Supplier { mock(KafkaTemplate::class.java) })

    @Test
    fun `production Kafka boundary disables producer retries and idempotent internal retry`() {
        val source = YamlPropertySourceLoader().load("application", ClassPathResource("application.yml")).single()

        assertThat(source.getProperty("spring.kafka.producer.retries")).isEqualTo(0)
        assertThat(source.getProperty("spring.kafka.producer.acks")).isEqualTo("all")
        assertThat(source.getProperty("spring.kafka.producer.properties.enable.idempotence")).isEqualTo(false)
        assertThat(source.getProperty("spring.kafka.producer.properties.delivery.timeout.ms")).isEqualTo(4000)
        assertThat(source.getProperty("spring.kafka.producer.properties.request.timeout.ms")).isEqualTo(3000)
    }

    @Test
    fun `binds valid test override and creates publisher boundary`() {
        context.withPropertyValues("occ.outbox.enabled=false", "occ.outbox.batch-size=10").run {
            assertThat(it).hasNotFailed()
            assertThat(it.getBean(OutboxProperties::class.java).enabled).isFalse()
            assertThat(it.getBean(OutboxProperties::class.java).batchSize).isEqualTo(10)
            assertThat(it).hasSingleBean(OutboxPublisher::class.java)
        }
    }

    @Test
    fun `rejects unknown outbox configuration`() {
        context.withPropertyValues("occ.outbox.unknown-setting=true").run {
            assertThat(it).hasFailed()
            assertThat(it.startupFailure).hasStackTraceContaining("unknown-setting")
        }
    }
}
