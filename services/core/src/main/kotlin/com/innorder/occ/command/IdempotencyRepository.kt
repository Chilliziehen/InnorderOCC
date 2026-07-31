package com.innorder.occ.command

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.time.Duration
import java.util.UUID

sealed interface IdempotencyAcquisition {
    data class Owner(val recordId: UUID) : IdempotencyAcquisition
    data class Replay(val result: CommandResult) : IdempotencyAcquisition
}

@Repository
class IdempotencyRepository(
    private val jdbc: JdbcTemplate,
    private val mapper: ObjectMapper,
) {
    fun acquire(metadata: CommandMetadata, requestDigest: String): IdempotencyAcquisition {
        requireTransaction()
        val id = UUID.randomUUID()
        val inserted = jdbc.update(
            """INSERT INTO audit.idempotency_record
               (id, principal_id, command_key, idempotency_key, request_hash, state, expires_at)
               VALUES (?, ?, ?, ?, ?, 'IN_PROGRESS', statement_timestamp() + interval '24 hours')
               ON CONFLICT (principal_id, command_key, idempotency_key) DO NOTHING""",
            id, metadata.principalId, metadata.commandKey, metadata.idempotencyKey, requestDigest,
        )
        if (inserted == 1) return IdempotencyAcquisition.Owner(id)

        val row = jdbc.queryForObject(
            """SELECT request_hash, state, response_status, response_body::text, resource_id
               FROM audit.idempotency_record
               WHERE principal_id = ? AND command_key = ? AND idempotency_key = ?
               FOR UPDATE""",
            { result, _ -> ExistingRecord(
                result.getString("request_hash"),
                result.getString("state"),
                result.getObject("response_status", Integer::class.java)?.toInt(),
                result.getString("response_body"),
                result.getObject("resource_id", UUID::class.java),
            ) },
            metadata.principalId, metadata.commandKey, metadata.idempotencyKey,
        ) ?: throw IdempotencyInProgressException()
        if (row.requestDigest != requestDigest) throw IdempotencyConflictException()
        if (row.state != "COMPLETED" || row.status == null || row.body == null) throw IdempotencyInProgressException()
        return IdempotencyAcquisition.Replay(
            CommandResult(row.status, mapper.readTree(row.body), row.resourceId, replayed = true),
        )
    }

    fun complete(recordId: UUID, result: CommandResult, responseDigest: String) {
        requireTransaction()
        val updated = jdbc.update(
            """UPDATE audit.idempotency_record
               SET state = 'COMPLETED', response_status = ?, response_body = ?::jsonb,
                   response_digest = ?, resource_id = ?
               WHERE id = ? AND state = 'IN_PROGRESS'""",
            result.status, mapper.writeValueAsString(result.body), responseDigest, result.resourceId, recordId,
        )
        check(updated == 1) { "Idempotency ownership was lost" }
    }

    private fun requireTransaction() {
        check(TransactionSynchronizationManager.isActualTransactionActive()) { "Idempotency repository requires a transaction" }
    }

    private data class ExistingRecord(
        val requestDigest: String,
        val state: String,
        val status: Int?,
        val body: String?,
        val resourceId: UUID?,
    )

    companion object {
        val TTL: Duration = Duration.ofHours(24)
    }
}
