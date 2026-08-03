package com.innorder.occ.events

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.time.Duration

class OutboxPropertiesTest {
    @Test
    fun `production defaults are stable and retry policy is exact`() {
        val properties = OutboxProperties()

        assertThat(properties.enabled).isTrue()
        assertThat(properties.topic).isEqualTo("occ.events.v1")
        assertThat(properties.batchSize).isEqualTo(50)
        assertThat(properties.pollInterval).isEqualTo(Duration.ofMillis(250))
        assertThat(properties.ackTimeout).isEqualTo(Duration.ofSeconds(5))
        assertThat(properties.staleClaim).isEqualTo(Duration.ofMinutes(5))
        assertThat(properties.maxAttempts).isEqualTo(10)
        assertThat((1..10).map(properties::backoff)).containsExactly(
            Duration.ofSeconds(5), Duration.ofSeconds(30), Duration.ofSeconds(120),
            Duration.ofSeconds(600), Duration.ofSeconds(600), Duration.ofSeconds(600),
            Duration.ofSeconds(600), Duration.ofSeconds(600), Duration.ofSeconds(600), Duration.ofSeconds(600),
        )
    }

    @Test
    fun `rejects invalid immutable operational policy`() {
        assertThatThrownBy { OutboxProperties(batchSize = 0) }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { OutboxProperties(pollInterval = Duration.ofMillis(249)) }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { OutboxProperties(ackTimeout = Duration.ofMillis(999)) }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { OutboxProperties(ackTimeout = Duration.ofSeconds(11)) }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { OutboxProperties(topic = "different") }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { OutboxProperties(staleClaim = Duration.ofSeconds(1)) }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { OutboxProperties(maxAttempts = 9) }.isInstanceOf(IllegalArgumentException::class.java)
    }
}
