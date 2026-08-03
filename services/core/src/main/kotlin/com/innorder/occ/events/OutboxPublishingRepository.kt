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

    /** Higher aggregate versions remain ineligible until every lower version is PUBLISHED or DEAD. */
    fun claim(limit: Int = properties.batchSize): List<ClaimedOutboxEvent> {
        require(limit in 1..properties.batchSize && limit <= 100)
        return transactions.execute {
            jdbc.query(
                """WITH exhausted_candidates AS MATERIALIZED (
                       SELECT id
                       FROM audit.outbox_event
                       WHERE status = 'PUBLISHING' AND attempts >= ?
                         AND claimed_at <= statement_timestamp() - interval '5 minutes'
                       ORDER BY claimed_at, created_at, id
                       FOR UPDATE SKIP LOCKED
                       LIMIT ?
                   ), exhausted AS (
                       UPDATE audit.outbox_event event
                       SET status = 'DEAD', claimed_at = NULL, last_error = 'STALE_ATTEMPT_LIMIT'
                       FROM exhausted_candidates
                       WHERE event.id = exhausted_candidates.id
                       RETURNING event.id
                   ), candidates AS MATERIALIZED (
                       SELECT candidate.id
                       FROM audit.outbox_event candidate
                       WHERE candidate.attempts < ? AND (
                              (candidate.status = 'PENDING' AND candidate.next_attempt_at <= statement_timestamp())
                           OR (candidate.status = 'PUBLISHING' AND candidate.claimed_at <= statement_timestamp() - interval '5 minutes')
                       ) AND NOT EXISTS (
                           SELECT 1
                           FROM audit.outbox_event predecessor
                           WHERE predecessor.aggregate_id = candidate.aggregate_id
                             AND predecessor.aggregate_version < candidate.aggregate_version
                             AND predecessor.status IN ('PENDING', 'PUBLISHING')
                       )
                       ORDER BY candidate.next_attempt_at, candidate.created_at, candidate.id
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
                properties.maxAttempts, limit, properties.maxAttempts, limit,
            )
        } ?: emptyList()
    }

    fun renew(event: ClaimedOutboxEvent): ClaimedOutboxEvent? = transactions.execute {
        jdbc.query(
            """UPDATE audit.outbox_event
               SET claimed_at = statement_timestamp()
               WHERE id = ? AND status = 'PUBLISHING' AND attempts = ? AND claimed_at = ?
               RETURNING claimed_at""",
            { rs, _ -> rs.getTimestamp("claimed_at").toInstant() },
            event.id, event.attempts, Timestamp.from(event.claimedAt),
        ).singleOrNull()?.let { event.copy(claimedAt = it) }
    }

    fun release(event: ClaimedOutboxEvent): FinalizeResult = finalize(event) {
        jdbc.update(
            """UPDATE audit.outbox_event
               SET status = 'PENDING', attempts = greatest(attempts - 1, 0), claimed_at = NULL,
                   next_attempt_at = greatest(available_at, statement_timestamp()), last_error = 'SHUTDOWN'
               WHERE id = ? AND status = 'PUBLISHING' AND attempts = ? AND claimed_at = ?""",
            event.id, event.attempts, Timestamp.from(event.claimedAt),
        )
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
