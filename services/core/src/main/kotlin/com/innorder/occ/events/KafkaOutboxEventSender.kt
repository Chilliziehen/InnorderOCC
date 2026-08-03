package com.innorder.occ.events

import org.apache.kafka.clients.producer.ProducerRecord
import org.apache.kafka.common.header.internals.RecordHeader
import org.springframework.kafka.core.KafkaTemplate
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

fun interface OutboxEventSender {
    fun publish(event: EventEnvelope)
}

class KafkaOutboxEventSender(
    private val kafka: KafkaTemplate<String, ByteArray>,
    private val properties: OutboxProperties,
) : OutboxEventSender {
    override fun publish(event: EventEnvelope) {
        val record = ProducerRecord<String, ByteArray>(properties.topic, event.aggregateId.toString(), event.canonicalBytes()).apply {
            headers().add(header("eventId", event.id.toString()))
            headers().add(header("eventType", event.type))
            headers().add(header("schemaVersion", event.schemaVersion.toString()))
            headers().add(header("correlationId", event.correlationId.toString()))
            headers().add(header("customerInstanceId", event.customerInstanceId.toString()))
            headers().add(header("content-type", "application/json"))
        }
        kafka.send(record).get(properties.ackTimeout.toMillis(), TimeUnit.MILLISECONDS)
    }

    private fun header(name: String, value: String) =
        RecordHeader(name, value.toByteArray(StandardCharsets.UTF_8))
}
