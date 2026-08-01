package com.innorder.occ.events

import com.fasterxml.jackson.databind.ObjectMapper
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.time.Instant
import java.util.UUID

class EventEnvelopeTest {
    @Test
    fun `serializes the exact Task 1 contract canonically without operational fields`() {
        val envelope = envelope("""{"z":2,"a":{"y":2,"x":1}}""")

        assertThat(envelope.canonicalBytes().decodeToString()).isEqualTo(
            """{"id":"10000000-0000-7000-8000-000000000001","customerInstanceId":"10000000-0000-7000-8000-000000000002","type":"order.updated","schemaVersion":1,"aggregateType":"order","aggregateId":"10000000-0000-7000-8000-000000000003","aggregateVersion":4,"occurredAt":"2026-08-01T12:00:00Z","actorId":"10000000-0000-7000-8000-000000000004","correlationId":"10000000-0000-7000-8000-000000000005","causationId":"10000000-0000-7000-8000-000000000006","payload":{"a":{"x":1,"y":2},"z":2}}""",
        )
        assertThat(envelope.canonicalBytes().decodeToString()).doesNotContain("attempts", "status", "claimedAt")
    }

    @Test
    fun `payload is immutable and rejects unsafe numbers and secret-bearing keys`() {
        val source = JSON.readTree("""{"value":"before"}""")
        val envelope = envelope(source.toString())
        (source as com.fasterxml.jackson.databind.node.ObjectNode).put("value", "after")

        assertThat(envelope.canonicalBytes().decodeToString()).contains("\"value\":\"before\"")
        assertThatThrownBy { envelope("""{"value":9007199254740992}""") }
            .isInstanceOf(InvalidEventEnvelopeException::class.java)
        assertThatThrownBy { envelope("""{"api_password":"not-for-events"}""") }
            .isInstanceOf(InvalidEventEnvelopeException::class.java)
    }

    @Test
    fun `rejects unstable types unsafe versions and messages over 256 KiB`() {
        assertThatThrownBy { envelope("{}", type = "bad type") }
            .isInstanceOf(InvalidEventEnvelopeException::class.java)
        assertThatThrownBy { envelope("{}", aggregateVersion = EventPayloadPolicy.MAX_SAFE_INTEGER + 1) }
            .isInstanceOf(InvalidEventEnvelopeException::class.java)
        assertThatThrownBy {
            EventEnvelope(
                UUID.randomUUID(), UUID.randomUUID(), "order.updated", EventPayloadPolicy.MAX_SAFE_INTEGER + 1,
                "order", UUID.randomUUID(), 1, Instant.EPOCH, null, UUID.randomUUID(), null, JSON.readTree("{}"),
            )
        }.isInstanceOf(InvalidEventEnvelopeException::class.java)
        assertThatThrownBy { envelope("""{"value":"${"x".repeat(256 * 1024)}"}""") }
            .isInstanceOf(InvalidEventEnvelopeException::class.java)
    }

    private fun envelope(
        payload: String,
        type: String = "order.updated",
        aggregateVersion: Long = 4,
    ) = EventEnvelope(
        UUID.fromString("10000000-0000-7000-8000-000000000001"),
        UUID.fromString("10000000-0000-7000-8000-000000000002"),
        type,
        1,
        "order",
        UUID.fromString("10000000-0000-7000-8000-000000000003"),
        aggregateVersion,
        Instant.parse("2026-08-01T12:00:00Z"),
        UUID.fromString("10000000-0000-7000-8000-000000000004"),
        UUID.fromString("10000000-0000-7000-8000-000000000005"),
        UUID.fromString("10000000-0000-7000-8000-000000000006"),
        JSON.readTree(payload),
    )

    companion object {
        private val JSON = ObjectMapper().findAndRegisterModules()
    }
}
