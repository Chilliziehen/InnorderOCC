package com.innorder.occ.command

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.stereotype.Repository
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.time.Clock
import java.time.Duration
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID

sealed interface IdempotencyAcquisition {
    data class Owner(val recordId: UUID) : IdempotencyAcquisition
    data class Replay(val recordId: UUID) : IdempotencyAcquisition
}

@Repository
class IdempotencyRepository private constructor(
    private val jdbc: JdbcTemplate,
    private val clock: Clock,
) {
    @Autowired
    constructor(jdbc: JdbcTemplate) : this(jdbc, Clock.systemUTC())

    fun acquire(
        descriptor: CommandDescriptor,
        idempotencyKey: String,
        requestDigest: String,
    ): IdempotencyAcquisition {
        requireTransaction()
        val id = UUID.randomUUID()
        val createdAt = OffsetDateTime.ofInstant(clock.instant(), ZoneOffset.UTC)
        val expiresAt = createdAt.plus(TTL)
        val inserted = jdbc.update(
            """INSERT INTO audit.idempotency_record
               (id, principal_id, command_key, idempotency_key, request_hash, state, created_at, updated_at, expires_at)
               VALUES (?, ?, ?, ?, ?, 'IN_PROGRESS', ?, ?, ?)
               ON CONFLICT (principal_id, command_key, idempotency_key) DO NOTHING""",
            id, descriptor.principalId, descriptor.commandKey, idempotencyKey, requestDigest,
            createdAt, createdAt, expiresAt,
        )
        if (inserted == 1) return IdempotencyAcquisition.Owner(id)

        val row = jdbc.queryForObject(
            """SELECT id, request_hash, state, expires_at
               FROM audit.idempotency_record
               WHERE principal_id = ? AND command_key = ? AND idempotency_key = ?
               FOR UPDATE""",
            { result, _ -> ExistingRecord(
                result.getObject("id", UUID::class.java),
                result.getString("request_hash"),
                result.getString("state"),
                result.getObject("expires_at", OffsetDateTime::class.java).toInstant(),
            ) },
            descriptor.principalId, descriptor.commandKey, idempotencyKey,
        ) ?: throw IdempotencyInProgressException()
        if (!clock.instant().isBefore(row.expiresAt)) throw IdempotencyExpiredException()
        if (row.requestDigest != requestDigest) throw IdempotencyConflictException()
        if (row.state == "IN_PROGRESS") throw IdempotencyInProgressException()
        if (row.state != "COMPLETED") throw CommandIntegrityException()
        return IdempotencyAcquisition.Replay(row.id)
    }

    fun replay(recordId: UUID): CommandResult {
        requireTransaction()
        val row = jdbc.queryForObject(
            """SELECT response_status, response_body::text, response_digest, resource_id
               FROM audit.idempotency_record WHERE id = ?""",
            { result, _ -> StoredResult(
                result.getObject("response_status", Integer::class.java)?.toInt(),
                result.getString("response_body"),
                result.getString("response_digest"),
                result.getObject("resource_id", UUID::class.java),
            ) },
            recordId,
        ) ?: throw CommandIntegrityException()
        if (row.status !in 100..599 || row.body == null || row.responseDigest == null || row.resourceId == null) {
            throw CommandIntegrityException()
        }
        val body = try {
            CanonicalJsonObject.parse(row.body.toByteArray(Charsets.UTF_8), CanonicalJsonObject.MAX_BYTES)
        } catch (_: InvalidCommandRequestException) {
            throw CommandIntegrityException()
        }
        if (body.digest != row.responseDigest) throw CommandIntegrityException()
        return CommandResult(row.status!!, body, row.resourceId, replayed = true)
    }

    fun complete(recordId: UUID, result: CommandResult) {
        requireTransaction()
        val updated = jdbc.update(
            """UPDATE audit.idempotency_record
               SET state = 'COMPLETED', response_status = ?, response_body = ?::jsonb,
                   response_digest = ?, resource_id = ?
               WHERE id = ? AND state = 'IN_PROGRESS'""",
            result.status, result.body.canonicalText(), result.body.digest, result.resourceId, recordId,
        )
        check(updated == 1) { "Idempotency ownership was lost" }
    }

    private fun requireTransaction() {
        check(TransactionSynchronizationManager.isActualTransactionActive()) { "Idempotency repository requires a transaction" }
    }

    private data class ExistingRecord(
        val id: UUID,
        val requestDigest: String,
        val state: String,
        val expiresAt: java.time.Instant,
    )

    private data class StoredResult(
        val status: Int?,
        val body: String?,
        val responseDigest: String?,
        val resourceId: UUID?,
    )

    companion object {
        val TTL: Duration = Duration.ofHours(24)
        internal fun forTesting(jdbc: JdbcTemplate, clock: Clock): IdempotencyRepository =
            IdempotencyRepository(jdbc, clock)
    }
}
