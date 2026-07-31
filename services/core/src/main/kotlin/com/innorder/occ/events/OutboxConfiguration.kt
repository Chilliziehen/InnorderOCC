package com.innorder.occ.events

import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.scheduling.annotation.EnableScheduling
import org.springframework.transaction.PlatformTransactionManager

@Configuration(proxyBeanMethods = false)
@EnableScheduling
@EnableConfigurationProperties(OutboxProperties::class)
class OutboxConfiguration {
    @Bean
    fun outboxPublishingRepository(
        jdbc: JdbcTemplate,
        transactionManager: PlatformTransactionManager,
        properties: OutboxProperties,
    ) = OutboxPublishingRepository(jdbc, transactionManager, properties)

    @Bean
    fun outboxEventSender(
        kafka: KafkaTemplate<String, ByteArray>,
        properties: OutboxProperties,
    ): OutboxEventSender = KafkaOutboxEventSender(kafka, properties)

    @Bean
    fun outboxPublisher(
        repository: OutboxPublishingRepository,
        sender: OutboxEventSender,
        properties: OutboxProperties,
    ) = OutboxPublisher(repository, sender, properties)
}
