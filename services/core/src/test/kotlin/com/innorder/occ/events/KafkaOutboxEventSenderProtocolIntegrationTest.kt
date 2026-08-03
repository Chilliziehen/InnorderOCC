package com.innorder.occ.events

import com.fasterxml.jackson.databind.ObjectMapper
import org.apache.kafka.clients.consumer.ConsumerConfig
import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.ProducerConfig
import org.apache.kafka.common.serialization.ByteArrayDeserializer
import org.apache.kafka.common.serialization.ByteArraySerializer
import org.apache.kafka.common.serialization.StringDeserializer
import org.apache.kafka.common.serialization.StringSerializer
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.kafka.core.DefaultKafkaProducerFactory
import org.springframework.kafka.core.KafkaTemplate
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.kafka.KafkaContainer
import org.testcontainers.utility.DockerImageName
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.time.Instant
import java.util.UUID

@Testcontainers(disabledWithoutDocker = true)
class KafkaOutboxEventSenderProtocolIntegrationTest {
    @Test
    fun `real broker receives exact canonical record after acknowledgement with retries disabled`() {
        val producerProperties = mapOf<String, Any>(
            ProducerConfig.BOOTSTRAP_SERVERS_CONFIG to kafka.bootstrapServers,
            ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG to StringSerializer::class.java,
            ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG to ByteArraySerializer::class.java,
            ProducerConfig.ACKS_CONFIG to "all",
            ProducerConfig.RETRIES_CONFIG to 0,
            ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG to false,
            ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG to 4000,
            ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG to 3000,
        )
        val producerFactory = DefaultKafkaProducerFactory<String, ByteArray>(producerProperties)
        val sender = KafkaOutboxEventSender(KafkaTemplate(producerFactory), OutboxProperties())
        val event = envelope()
        val consumer = KafkaConsumer<String, ByteArray>(
            mapOf(
                ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG to kafka.bootstrapServers,
                ConsumerConfig.GROUP_ID_CONFIG to "outbox-protocol-${UUID.randomUUID()}",
                ConsumerConfig.AUTO_OFFSET_RESET_CONFIG to "earliest",
                ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG to false,
                ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG to StringDeserializer::class.java,
                ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG to ByteArrayDeserializer::class.java,
            ),
        )
        try {
            assertThat(producerFactory.configurationProperties)
                .containsEntry(ProducerConfig.RETRIES_CONFIG, 0)
                .containsEntry(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, false)
                .containsEntry(ProducerConfig.ACKS_CONFIG, "all")

            sender.publish(event)
            consumer.subscribe(listOf(OutboxProperties.TOPIC))
            val deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos()
            var received: org.apache.kafka.clients.consumer.ConsumerRecord<String, ByteArray>? = null
            while (received == null && System.nanoTime() < deadline) {
                received = consumer.poll(Duration.ofMillis(250)).firstOrNull()
            }

            assertThat(received).isNotNull
            assertThat(received!!.topic()).isEqualTo(OutboxProperties.TOPIC)
            assertThat(received.key()).isEqualTo(event.aggregateId.toString())
            assertThat(received.value()).isEqualTo(event.canonicalBytes())
            assertThat(received.headers().associate { it.key() to it.value().toString(StandardCharsets.UTF_8) })
                .containsExactlyInAnyOrderEntriesOf(
                    mapOf(
                        "eventId" to event.id.toString(),
                        "eventType" to event.type,
                        "schemaVersion" to event.schemaVersion.toString(),
                        "correlationId" to event.correlationId.toString(),
                        "customerInstanceId" to event.customerInstanceId.toString(),
                        "content-type" to "application/json",
                    ),
                )
        } finally {
            consumer.close(Duration.ofSeconds(2))
            producerFactory.destroy()
        }
    }

    private fun envelope() = EventEnvelope(
        id = UUID.fromString("30000000-0000-7000-8000-000000000001"),
        customerInstanceId = UUID.fromString("30000000-0000-7000-8000-000000000002"),
        type = "order.updated",
        schemaVersion = 1,
        aggregateType = "order",
        aggregateId = UUID.fromString("30000000-0000-7000-8000-000000000003"),
        aggregateVersion = 8,
        occurredAt = Instant.parse("2026-08-01T12:00:00Z"),
        actorId = null,
        correlationId = UUID.fromString("30000000-0000-7000-8000-000000000004"),
        causationId = null,
        payload = ObjectMapper().readTree("""{"z":2,"a":1}"""),
    )

    companion object {
        private const val IMAGE = "apache/kafka:3.9.1@sha256:4ceccc577f03f51f6af8dbfda55194d0d892f4fa7913ffbded567ce3895622ed"

        @Container
        @JvmStatic
        val kafka = KafkaContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("apache/kafka"))
    }
}
