package com.innorder.occ.events

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

@ConfigurationProperties(prefix = "occ.outbox", ignoreUnknownFields = false)
data class OutboxProperties(
    val enabled: Boolean = true,
    val topic: String = TOPIC,
    val batchSize: Int = 50,
    val pollInterval: Duration = Duration.ofMillis(250),
    val ackTimeout: Duration = Duration.ofSeconds(5),
    val staleClaim: Duration = Duration.ofMinutes(5),
    val maxAttempts: Int = 10,
) {
    init {
        require(topic == TOPIC)
        require(batchSize in 1..100)
        require(pollInterval >= Duration.ofMillis(250))
        require(ackTimeout in Duration.ofSeconds(1)..Duration.ofSeconds(10))
        require(staleClaim == Duration.ofMinutes(5))
        require(maxAttempts == 10)
    }

    fun backoff(attempt: Int): Duration = when {
        attempt !in 1..maxAttempts -> throw IllegalArgumentException("Invalid outbox attempt")
        attempt == 1 -> Duration.ofSeconds(5)
        attempt == 2 -> Duration.ofSeconds(30)
        attempt == 3 -> Duration.ofSeconds(120)
        else -> Duration.ofSeconds(600)
    }

    companion object {
        const val TOPIC = "occ.events.v1"
    }
}
