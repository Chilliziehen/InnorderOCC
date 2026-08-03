package com.innorder.occ.events

import org.apache.kafka.clients.producer.ProducerRecord
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.mockito.ArgumentCaptor
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.mock
import org.mockito.Mockito.verify
import org.mockito.Mockito.`when`
import org.springframework.kafka.core.KafkaTemplate
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CompletableFuture

class KafkaOutboxEventSenderTest {
    @Test
    @Suppress("UNCHECKED_CAST")
    fun `sends canonical bytes with aggregate key and exact headers then waits for ack`() {
        val kafka = mock(KafkaTemplate::class.java) as KafkaTemplate<String, ByteArray>
        `when`(kafka.send(any<ProducerRecord<String, ByteArray>>()))
            .thenReturn(CompletableFuture.completedFuture(null))
        val sender = KafkaOutboxEventSender(kafka, OutboxProperties())
        val event = EventEnvelope(
            id = UUID.fromString("20000000-0000-7000-8000-000000000001"),
            customerInstanceId = UUID.fromString("20000000-0000-7000-8000-000000000002"),
            type = "order.updated", schemaVersion = 2, aggregateType = "order",
            aggregateId = UUID.fromString("20000000-0000-7000-8000-000000000003"), aggregateVersion = 7,
            occurredAt = Instant.parse("2026-08-01T12:00:00Z"), actorId = null,
            correlationId = UUID.fromString("20000000-0000-7000-8000-000000000004"), causationId = null,
            payload = com.fasterxml.jackson.databind.ObjectMapper().readTree("""{"b":2,"a":1}"""),
        )

        sender.publish(event)

        val captor = ArgumentCaptor.forClass(ProducerRecord::class.java) as ArgumentCaptor<ProducerRecord<String, ByteArray>>
        verify(kafka).send(captor.capture())
        val record = captor.value
        assertThat(record.topic()).isEqualTo("occ.events.v1")
        assertThat(record.key()).isEqualTo(event.aggregateId.toString())
        assertThat(record.value()).isEqualTo(event.canonicalBytes())
        assertThat(record.headers().associate { it.key() to it.value().toString(StandardCharsets.UTF_8) }).containsExactlyInAnyOrderEntriesOf(
            mapOf(
                "eventId" to event.id.toString(), "eventType" to event.type,
                "schemaVersion" to "2", "correlationId" to event.correlationId.toString(),
                "customerInstanceId" to event.customerInstanceId.toString(), "content-type" to "application/json",
            ),
        )
    }
}
