package com.innorder.occ.resource

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import java.math.BigDecimal
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID

@Repository
class ResourceRepository(
    private val jdbc: JdbcTemplate,
    private val mapper: ObjectMapper,
) {
    fun lockResource(id: UUID): Long? = jdbc.query(
        "SELECT row_version FROM occ.managed_resource WHERE id = ? FOR UPDATE",
        { rs, _ -> rs.getLong(1) },
        id,
    ).singleOrNull()

    fun lockResourceEntity(id: UUID) {
        check(jdbc.query(
            "SELECT id FROM authz.entity WHERE id = ? AND state = 'ACTIVE' FOR UPDATE",
            { rs, _ -> rs.getObject(1, UUID::class.java) },
            id,
        ).singleOrNull() == id) { "Resource entity is unavailable" }
    }

    fun resource(id: UUID): ManagedResource? = jdbc.query(
        "SELECT id, resource_type, capacity, state, data::text, row_version FROM occ.managed_resource WHERE id = ?",
        ::mapResource,
        id,
    ).singleOrNull()

    fun insertResource(request: CreateResourceRequest): ManagedResource {
        jdbc.update(
            """INSERT INTO occ.managed_resource(id, resource_type, capacity, state, data)
               VALUES (?, ?, ?, ?, ?::jsonb)""",
            request.id, request.resourceType, request.capacity, request.state.name, mapper.writeValueAsString(request.data),
        )
        return requireNotNull(resource(request.id))
    }

    fun updateResource(id: UUID, request: UpdateResourceRequest, nextVersion: Long): ManagedResource {
        check(jdbc.update(
            """UPDATE occ.managed_resource SET capacity = ?, state = ?, data = ?::jsonb, row_version = ?
               WHERE id = ?""",
            request.capacity, request.state.name, mapper.writeValueAsString(request.data), nextVersion, id,
        ) == 1)
        return requireNotNull(resource(id))
    }

    fun insertAvailability(resourceId: UUID, principalId: UUID, request: AddAvailabilityRequest) {
        jdbc.update(
            """INSERT INTO occ.resource_availability(id, resource_id, time_range, mode, reason, created_by)
               VALUES (?, ?, tstzrange(?::timestamptz, ?::timestamptz, '[)'), ?, ?, ?)""",
            request.id, resourceId, request.start, request.end, request.mode.name, request.reason, principalId,
        )
    }

    fun advanceResourceVersion(id: UUID, nextVersion: Long): ManagedResource {
        check(jdbc.update("UPDATE occ.managed_resource SET row_version = ? WHERE id = ?", nextVersion, id) == 1)
        return requireNotNull(resource(id))
    }

    fun availability(resourceId: UUID, start: OffsetDateTime, end: OffsetDateTime): List<AvailabilityWindow> = jdbc.query(
        """SELECT id, resource_id, lower(time_range) AS starts_at, upper(time_range) AS ends_at, mode, reason, created_by
           FROM occ.resource_availability
           WHERE resource_id = ? AND time_range && tstzrange(?::timestamptz, ?::timestamptz, '[)')
           ORDER BY lower(time_range), id""",
        { rs, _ ->
            AvailabilityWindow(
                rs.getObject("id", UUID::class.java), rs.getObject("resource_id", UUID::class.java),
                utc(rs.getObject("starts_at", OffsetDateTime::class.java)),
                utc(rs.getObject("ends_at", OffsetDateTime::class.java)),
                AvailabilityMode.valueOf(rs.getString("mode")), rs.getString("reason"),
                rs.getObject("created_by", UUID::class.java),
            )
        },
        resourceId, start, end,
    )

    fun inventory(afterId: UUID?, inclusive: Boolean, limit: Int): List<ManagedResource> = if (afterId == null) {
        jdbc.query(
            """SELECT id, resource_type, capacity, state, data::text, row_version
               FROM occ.managed_resource ORDER BY id LIMIT ?""",
            ::mapResource,
            limit,
        )
    } else {
        jdbc.query(
            """SELECT id, resource_type, capacity, state, data::text, row_version
               FROM occ.managed_resource WHERE id ${if (inclusive) ">=" else ">"} ? ORDER BY id LIMIT ?""",
            ::mapResource,
            afterId, limit,
        )
    }

    fun reservationParent(id: UUID): ReservationIdentity? = jdbc.query(
        "SELECT resource_id, requester_entity_id FROM occ.resource_reservation WHERE id = ?",
        { rs, _ -> ReservationIdentity(rs.getObject(1, UUID::class.java), rs.getObject(2, UUID::class.java)) },
        id,
    ).singleOrNull()

    fun lockReservation(id: UUID): Long? = jdbc.query(
        "SELECT row_version FROM occ.resource_reservation WHERE id = ? FOR UPDATE",
        { rs, _ -> rs.getLong(1) },
        id,
    ).singleOrNull()

    fun reservation(id: UUID): Reservation? = jdbc.query(
        """SELECT id, resource_id, requester_entity_id, process_instance_id, task_id,
                  lower(time_range) AS starts_at, upper(time_range) AS ends_at,
                  capacity, exclusive, state, row_version
           FROM occ.resource_reservation WHERE id = ?""",
        ::mapReservation,
        id,
    ).singleOrNull()

    fun insertReservation(resourceId: UUID, request: ReserveResourceRequest): Reservation {
        jdbc.update(
            """INSERT INTO occ.resource_reservation
               (id, resource_id, requester_entity_id, process_instance_id, task_id, time_range,
                capacity, exclusive, state)
               VALUES (?, ?, ?, ?, ?, tstzrange(?::timestamptz, ?::timestamptz, '[)'), ?, ?, 'PENDING')""",
            request.id, resourceId, request.requesterEntityId, request.processInstanceId, request.taskId,
            request.start, request.end, request.capacity, request.exclusive,
        )
        return requireNotNull(reservation(request.id))
    }

    fun changeReservation(id: UUID, request: ChangeReservationRequest, nextVersion: Long): Reservation {
        check(jdbc.update(
            """UPDATE occ.resource_reservation
               SET time_range = tstzrange(?::timestamptz, ?::timestamptz, '[)'), capacity = ?, exclusive = ?, row_version = ?
               WHERE id = ?""",
            request.start, request.end, request.capacity, request.exclusive, nextVersion, id,
        ) == 1)
        return requireNotNull(reservation(id))
    }

    fun cancelReservation(id: UUID, nextVersion: Long): Reservation {
        check(jdbc.update(
            """UPDATE occ.resource_reservation
               SET state = 'CANCELLED', cancelled_at = statement_timestamp(), row_version = ? WHERE id = ?""",
            nextVersion, id,
        ) == 1)
        return requireNotNull(reservation(id))
    }

    fun schedule(
        resourceId: UUID,
        start: OffsetDateTime,
        end: OffsetDateTime,
        afterStart: OffsetDateTime?,
        afterId: UUID?,
        inclusive: Boolean,
        limit: Int,
    ): List<Reservation> {
        val cursorClause = if (afterStart == null) "" else
            "AND (lower(time_range), id) ${if (inclusive) ">=" else ">"} (?::timestamptz, ?)"
        val arguments = mutableListOf<Any>(resourceId, start, end)
        if (afterStart != null) {
            arguments += afterStart
            arguments += requireNotNull(afterId)
        }
        arguments += limit
        return jdbc.query(
            """SELECT id, resource_id, requester_entity_id, process_instance_id, task_id,
                      lower(time_range) AS starts_at, upper(time_range) AS ends_at,
                      capacity, exclusive, state, row_version
               FROM occ.resource_reservation
               WHERE resource_id = ? AND state IN ('PENDING','CONFIRMED')
                 AND time_range && tstzrange(?::timestamptz, ?::timestamptz, '[)')
                 $cursorClause
               ORDER BY lower(time_range), id LIMIT ?""",
            ::mapReservation,
            *arguments.toTypedArray(),
        )
    }

    fun conflicts(resourceId: UUID, start: OffsetDateTime, end: OffsetDateTime): List<ReservationIdentityDetail> = jdbc.query(
        """SELECT id, requester_entity_id, lower(time_range) AS starts_at, upper(time_range) AS ends_at
           FROM occ.resource_reservation
           WHERE resource_id = ? AND state IN ('PENDING','CONFIRMED')
             AND time_range && tstzrange(?::timestamptz, ?::timestamptz, '[)')
           ORDER BY lower(time_range), id LIMIT 20""",
        { rs, _ ->
            ReservationIdentityDetail(
                rs.getObject("id", UUID::class.java), rs.getObject("requester_entity_id", UUID::class.java),
                utc(rs.getObject("starts_at", OffsetDateTime::class.java)),
                utc(rs.getObject("ends_at", OffsetDateTime::class.java)),
            )
        },
        resourceId, start, end,
    )

    fun commitmentInterval(resourceId: UUID): Pair<OffsetDateTime, OffsetDateTime>? = jdbc.query(
        """SELECT min(lower(time_range)) AS starts_at, max(upper(time_range)) AS ends_at
           FROM occ.resource_reservation WHERE resource_id = ? AND state IN ('PENDING','CONFIRMED')""",
        { rs, _ ->
            val start = rs.getObject("starts_at", OffsetDateTime::class.java)
            val end = rs.getObject("ends_at", OffsetDateTime::class.java)
            if (start == null || end == null) null else utc(start) to utc(end)
        },
        resourceId,
    ).singleOrNull()

    private fun mapResource(rs: ResultSet, ignored: Int): ManagedResource = ManagedResource(
        rs.getObject("id", UUID::class.java), rs.getString("resource_type"), rs.getBigDecimal("capacity"),
        ResourceState.valueOf(rs.getString("state")),
        mapper.readValue(rs.getString("data"), object : TypeReference<Map<String, Any?>>() {}),
        rs.getLong("row_version"),
    )

    private fun mapReservation(rs: ResultSet, ignored: Int): Reservation = Reservation(
        rs.getObject("id", UUID::class.java), rs.getObject("resource_id", UUID::class.java),
        rs.getObject("requester_entity_id", UUID::class.java),
        rs.getObject("process_instance_id", UUID::class.java), rs.getObject("task_id", UUID::class.java),
        utc(rs.getObject("starts_at", OffsetDateTime::class.java)), utc(rs.getObject("ends_at", OffsetDateTime::class.java)),
        rs.getBigDecimal("capacity"), rs.getBoolean("exclusive"), ReservationState.valueOf(rs.getString("state")),
        rs.getLong("row_version"),
    )

    private fun utc(value: OffsetDateTime): OffsetDateTime = value.withOffsetSameInstant(ZoneOffset.UTC)
}

data class ReservationIdentity(val resourceId: UUID, val requesterEntityId: UUID)
data class ReservationIdentityDetail(
    val reservationId: UUID,
    val requesterEntityId: UUID,
    val start: OffsetDateTime,
    val end: OffsetDateTime,
)
