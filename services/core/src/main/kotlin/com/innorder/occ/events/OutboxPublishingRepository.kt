package com.innorder.occ.events

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.sql.ResultSet
import java.sql.Timestamp
import java.time.Instant
import java.util.UUID

data class ClaimedOutboxEvent(
    val id: UUID,
    val customerInstanceId: UUID,
    val type: String,
    val schemaVersion: Long,
    val aggregateType: String,
    val aggregateId: UUID,
    val aggregateVersion: Long,
    val occurredAt: Instant,
    val actorId: UUID?,
    val correlationId: UUID,
    val causationId: UUID?,
    val payloadJson: String,
    val attempts: Int,
    val claimedAt: Instant,
) {
    fun envelope(): EventEnvelope = EventEnvelope(
        id, customerInstanceId, type, schemaVersion, aggregateType, aggregateId, aggregateVersion,
        occurredAt, actorId, correlationId, causationId, EventEnvelope.parsePayload(payloadJson),
    )
}

enum class FailureCategory { DELIVERY_FAILED, INVALID_EVENT, SHUTDOWN }
enum class FinalizeResult { UPDATED, CAS_LOST }

class OutboxPublishingRepository(
    private val jdbc: JdbcTemplate,
    transactionManager: PlatformTransactionManager,
    private val properties: OutboxProperties,
) {
    private val transactions = TransactionTemplate(transactionManager)

    fun claim(limit: Int = properties.batchSize): List<ClaimedOutboxEvent> {
        require(limit in 1..properties.batchSize && limit <= 100)
        return transactions.execute {
            jdbc.update(
                """UPDATE audit.outbox_event
                   SET status = 'DEAD', claimed_at = NULL, last_error = 'STALE_ATTEMPT_LIMIT'
                   WHERE status = 'PUBLISHING' AND attempts >= ?
                     AND claimed_at <= statement_timestamp() - interval '5 minutes'""",
                properties.maxAttempts,
            )
            jdbc.query(
                """WITH candidates AS (
                       SELECT id
                       FROM audit.outbox_event
                       WHERE attempts < ? AND (
                              (status = 'PENDING' AND next_attempt_at <= statement_timestamp())
                           OR (status = 'PUBLISHING' AND claimed_at <= statement_timestamp() - interval '5 minutes')
                       )
                       ORDER BY next_attempt_at, created_at, id
                       FOR UPDATE SKIP LOCKED
                       LIMIT ?
                   ), claimed AS (
                       UPDATE audit.outbox_event event
                       SET status = 'PUBLISHING', claimed_at = statement_timestamp(),
                           attempts = event.attempts + 1, last_error = NULL
                       FROM candidates
                       WHERE event.id = candidates.id
                       RETURNING event.*
                   )
                   SELECT * FROM claimed ORDER BY next_attempt_at, created_at, id""",
                ::mapClaim,
                properties.maxAttempts, limit,
            )
        } ?: emptyList()
    }

    fun succeed(event: ClaimedOutboxEvent): FinalizeResult = finalize(event) {
        jdbc.update(
            """UPDATE audit.outbox_event
               SET status = 'PUBLISHED', published_at = statement_timestamp(), claimed_at = NULL, last_error = NULL
               WHERE id = ? AND status = 'PUBLISHING' AND attempts = ? AND claimed_at = ?""",
            event.id, event.attempts, Timestamp.from(event.claimedAt),
        )
    }

    fun fail(event: ClaimedOutboxEvent, category: FailureCategory): FinalizeResult = finalize(event) {
        if (event.attempts >= properties.maxAttempts) {
            jdbc.update(
                """UPDATE audit.outbox_event
                   SET status = 'DEAD', claimed_at = NULL, last_error = ?
                   WHERE id = ? AND status = 'PUBLISHING' AND attempts = ? AND claimed_at = ?""",
                category.name, event.id, event.attempts, Timestamp.from(event.claimedAt),
            )
        } else {
            jdbc.update(
                """UPDATE audit.outbox_event
                   SET status = 'PENDING', next_attempt_at = statement_timestamp() + (? * interval '1 second'),
                       claimed_at = NULL, last_error = ?
                   WHERE id = ? AND status = 'PUBLISHING' AND attempts = ? AND claimed_at = ?""",
                properties.backoff(event.attempts).seconds, category.name,
                event.id, event.attempts, Timestamp.from(event.claimedAt),
            )
        }
    }

    private fun finalize(event: ClaimedOutboxEvent, update: () -> Int): FinalizeResult =
        if (transactions.execute { update() } == 1) FinalizeResult.UPDATED else FinalizeResult.CAS_LOST

    private fun mapClaim(rs: ResultSet, ignored: Int): ClaimedOutboxEvent = ClaimedOutboxEvent(
        id = rs.getObject("id", UUID::class.java),
        customerInstanceId = rs.getObject("customer_instance_id", UUID::class.java),
        type = rs.getString("event_type"),
        schemaVersion = rs.getLong("schema_version"),
        aggregateType = rs.getString("aggregate_type"),
        aggregateId = rs.getObject("aggregate_id", UUID::class.java),
        aggregateVersion = rs.getLong("aggregate_version"),
        occurredAt = rs.getTimestamp("created_at").toInstant(),
        actorId = rs.getObject("actor_entity_id", UUID::class.java),
        correlationId = rs.getObject("correlation_id", UUID::class.java),
        causationId = rs.getObject("causation_id", UUID::class.java),
        payloadJson = rs.getString("payload"),
        attempts = rs.getInt("attempts"),
        claimedAt = rs.getTimestamp("claimed_at").toInstant(),
    )
}
