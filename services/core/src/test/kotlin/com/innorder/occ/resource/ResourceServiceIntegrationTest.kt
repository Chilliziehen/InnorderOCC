package com.innorder.occ.resource

import com.innorder.occ.command.IdempotencyConflictException
import com.innorder.occ.command.OptimisticConflictException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.post
import org.springframework.test.web.servlet.patch
import java.util.UUID

class ResourceServiceIntegrationTest : ResourceIntegrationSupport() {
    @Test
    fun `HTTP reservation conflict is generic and includes only resource and interval`() {
        val resource = createResource(capacity = 1)
        val requester = entity("requester")
        reserve(resource.id, requester, instant(9), instant(10), 1)
        val token = loginToken()
        val request = ReserveResourceRequest(
            UUID.randomUUID(), requester, null, null, instant(9), instant(10), 1.toBigDecimal(), false,
        )

        val response = mockMvc.post("/api/v1/resources/${resource.id}/reservations") {
            header("Authorization", "Bearer $token")
            header("X-Correlation-Id", UUID.randomUUID())
            header("Idempotency-Key", "http-conflict-${UUID.randomUUID()}")
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsBytes(request)
        }.andExpect { status { isConflict() } }.andReturn().response.contentAsString

        assertThat(response).contains("OCC-RESERVATION-CONFLICT", resource.id.toString(), instant(9).toString(), instant(10).toString())
        assertThat(response).doesNotContain(requester.toString(), "reservationId", "requesterEntityId")
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM audit.outbox_event WHERE aggregate_id = ?",
            Long::class.java,
            request.id,
        )).isZero()
    }

    @Test
    fun `HTTP create preserves 201 and exact replay header`() {
        val id = entity("http-resource")
        val request = CreateResourceRequest(id, "ROOM", 2.toBigDecimal())
        val token = loginToken()
        val key = "http-create-${UUID.randomUUID()}"

        fun execute(replayed: Boolean) = mockMvc.post("/api/v1/resources") {
            header("Authorization", "Bearer $token")
            header("X-Correlation-Id", UUID.randomUUID())
            header("Idempotency-Key", key)
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsBytes(request)
        }.andExpect {
            status { isCreated() }
            header { string("X-Idempotent-Replay", replayed.toString()) }
        }.andReturn().response

        execute(false)
        execute(true)
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM audit.outbox_event WHERE aggregate_id = ? AND event_type = 'resource.created'",
            Long::class.java,
            id,
        )).isEqualTo(1)
    }

    @Test
    fun `managed resource availability inventory and schedule use canonical UTC cursors and per-row authorization`() {
        val resource = createResource()
        val requester = entity("requester")
        val availability = AddAvailabilityRequest(UUID.randomUUID(), instant(8), instant(18), AvailabilityMode.AVAILABLE, null)
        val updated = resources.addAvailability(
            resource.id, metadata(expectedVersion = 0), mapper.writeValueAsBytes(availability), availability,
        ).body
        val first = reserve(resource.id, requester, instant(9), instant(10), 3)
        val second = reserve(resource.id, requester, instant(10), instant(11), 4)

        assertThat(updated.version).isEqualTo(1)
        assertThat(resources.inventory(administratorId, UUID.randomUUID(), 10, null).items.map { it.id })
            .contains(resource.id)
        assertThat(resources.availability(administratorId, UUID.randomUUID(), resource.id, instant(8), instant(12)))
            .extracting("mode").containsExactly(AvailabilityMode.AVAILABLE)

        val page1 = resources.schedule(administratorId, UUID.randomUUID(), resource.id, instant(8), instant(12), 1, null)
        val page2 = resources.schedule(administratorId, UUID.randomUUID(), resource.id, instant(8), instant(12), 1, page1.nextCursor)
        assertThat(page1.items.map { it.id }).containsExactly(first.id)
        assertThat(page2.items.map { it.id }).containsExactly(second.id)
        assertThat(page1.items.single().requesterEntityId).isNull()
        assertThat(page1.items.single().start.offset).isEqualTo(java.time.ZoneOffset.UTC)
        assertThat(jdbc.queryForObject(
            """SELECT count(*) FROM authz.decision_log WHERE principal_entity_id = ?
               AND action_key = 'occ.reservation.identity.read' AND decision = 'DENY'""",
            Long::class.java,
            administratorId,
        )).isGreaterThanOrEqualTo(2)
        assertThat(jdbc.queryForObject(
            """SELECT count(*) FROM authz.decision_log WHERE principal_entity_id = ?
               AND action_key = 'occ.read' AND resource_entity_id = ? AND decision = 'ALLOW'""",
            Long::class.java,
            administratorId,
            resource.id,
        )).isGreaterThanOrEqualTo(2)
        val availabilityEvent = mapper.readTree(jdbc.queryForObject(
            "SELECT payload::text FROM audit.outbox_event WHERE aggregate_id = ? AND event_type = 'resource.availability-changed'",
            String::class.java,
            resource.id,
        ))
        assertThat(availabilityEvent.path("mode").textValue()).isEqualTo("AVAILABLE")
        assertThat(availabilityEvent.path("start").textValue()).isEqualTo(instant(8).toString())
        assertThat(availabilityEvent.path("end").textValue()).isEqualTo(instant(18).toString())
    }

    @Test
    fun `inventory scans denied database rows and does not return a false terminal page`() {
        val ids = (1..3).map { index -> UUID.fromString("10000000-0000-7000-8000-00000000000$index") }
        ids.forEach { id ->
            entity(id, "paged-resource")
            val request = CreateResourceRequest(id, "ROOM", 1.toBigDecimal())
            resources.create(metadata(), mapper.writeValueAsBytes(request), request)
        }
        jdbc.update("UPDATE authz.entity SET state = 'ARCHIVED' WHERE id IN (?, ?)", ids[0], ids[1])

        val page = resources.inventory(administratorId, UUID.randomUUID(), 1, null)

        assertThat(page.items.map { it.id }).containsExactly(ids[2])
        assertThat(page.nextCursor).isNull()
    }

    @Test
    fun `exact capacity succeeds peak is not interval sum and conflicts are bounded and redacted`() {
        val resource = createResource(capacity = 10)
        val requester = entity("requester")
        reserve(resource.id, requester, instant(9), instant(10), 6)
        reserve(resource.id, requester, instant(9, 30), instant(10), 4)
        reserve(resource.id, requester, instant(10), instant(11), 6)

        assertThatThrownBy { reserve(resource.id, requester, instant(9, 45), instant(10, 15), 1) }
            .isInstanceOfSatisfying(ReservationConflictException::class.java) { conflict ->
                assertThat(conflict.resourceId).isEqualTo(resource.id)
                assertThat(conflict.start).isEqualTo(instant(9, 45))
                assertThat(conflict.end).isEqualTo(instant(10, 15))
                assertThat(conflict.reservationId).isNull()
                assertThat(conflict.requesterEntityId).isNull()
                assertThat(conflict.message).doesNotContain(requester.toString())
            }
        assertThat(jdbc.queryForObject(
            """SELECT count(*) FROM authz.decision_log
               WHERE principal_entity_id = ? AND action_key = 'occ.reservation.identity.read' AND decision = 'DENY'""",
            Long::class.java,
            administratorId,
        )).isEqualTo(1)
        val event = mapper.readTree(jdbc.queryForObject(
            """SELECT payload::text FROM audit.outbox_event
               WHERE aggregate_id IN (SELECT id FROM occ.resource_reservation WHERE resource_id = ?)
                 AND event_type = 'resource-reservation.created' ORDER BY created_at LIMIT 1""",
            String::class.java,
            resource.id,
        ))
        assertThat(event.path("state").textValue()).isEqualTo("PENDING")
        assertThat(event.path("start").textValue()).isNotBlank()
        assertThat(event.path("end").textValue()).isNotBlank()
        assertThat(event.path("capacity").decimalValue()).isPositive()
        assertThat(event.path("exclusive").isBoolean).isTrue()
    }

    @Test
    fun `stale commands fail replay is exact and reservation parent links stay immutable`() {
        val resource = createResource()
        val requester = entity("requester")
        val reservation = reserve(resource.id, requester, instant(9), instant(10), 2, key = "reserve-replay-${UUID.randomUUID()}")
        val change = ChangeReservationRequest(instant(10), instant(11), 3.toBigDecimal(), false)
        val key = "change-${UUID.randomUUID()}"
        val metadata = metadata(key, expectedVersion = 0)

        val changed = resources.change(reservation.id, metadata, mapper.writeValueAsBytes(change), change)
        val replay = resources.change(reservation.id, metadata, mapper.writeValueAsBytes(change), change)
        assertThat(changed.body).isEqualTo(replay.body)
        assertThat(changed.status).isEqualTo(200)
        assertThat(changed.replayed).isFalse()
        assertThat(replay.replayed).isTrue()
        assertThat(changed.body.version).isEqualTo(1)
        assertThatThrownBy {
            resources.cancel(reservation.id, metadata(expectedVersion = 0), byteArrayOf('{'.code.toByte(), '}'.code.toByte()))
        }.isInstanceOf(OptimisticConflictException::class.java)
        assertThatThrownBy {
            resources.change(
                reservation.id, metadata(key, expectedVersion = 1),
                mapper.writeValueAsBytes(change.copy(capacity = 4.toBigDecimal())), change.copy(capacity = 4.toBigDecimal()),
            )
        }.isInstanceOf(IdempotencyConflictException::class.java)
        assertThatThrownBy {
            jdbc.update("UPDATE occ.resource_reservation SET requester_entity_id = ? WHERE id = ?", entity("other"), reservation.id)
        }.hasRootCauseInstanceOf(org.postgresql.util.PSQLException::class.java)
    }

    @Test
    fun `capacity reduction archive maintenance and unavailable windows preserve active commitments`() {
        val resource = createResource(capacity = 10)
        val requester = entity("requester")
        reserve(resource.id, requester, instant(9), instant(10), 7)

        val reduce = UpdateResourceRequest(6.toBigDecimal(), ResourceState.AVAILABLE, resource.data)
        assertThatThrownBy {
            resources.update(resource.id, metadata(expectedVersion = 0), mapper.writeValueAsBytes(reduce), reduce)
        }.isInstanceOf(ReservationConflictException::class.java)

        val maintenance = UpdateResourceRequest(10.toBigDecimal(), ResourceState.MAINTENANCE, resource.data)
        val maintained = resources.update(
            resource.id, metadata(expectedVersion = 0), mapper.writeValueAsBytes(maintenance), maintenance,
        ).body
        assertThat(maintained.state).isEqualTo(ResourceState.MAINTENANCE)
        assertThatThrownBy { reserve(resource.id, requester, instant(11), instant(12), 1) }
            .isInstanceOf(ReservationConflictException::class.java)

        val archivedResource = createResource()
        val archive = UpdateResourceRequest(10.toBigDecimal(), ResourceState.ARCHIVED, archivedResource.data)
        resources.update(archivedResource.id, metadata(expectedVersion = 0), mapper.writeValueAsBytes(archive), archive)
        assertThatThrownBy { reserve(archivedResource.id, requester, instant(11), instant(12), 1) }
            .isInstanceOf(ReservationConflictException::class.java)
    }

    @Test
    fun `terminal reservation and domain constraint SQL states map to bounded HTTP responses`() {
        val resource = createResource(capacity = 2)
        val requester = entity("terminal-requester")
        val reservation = reserve(resource.id, requester, instant(9), instant(10), 1)
        val token = loginToken()

        mockMvc.post("/api/v1/reservations/${reservation.id}/cancel") {
            header("Authorization", "Bearer $token")
            header("X-Correlation-Id", UUID.randomUUID())
            header("Idempotency-Key", "cancel-${UUID.randomUUID()}")
            header("Expected-Version", 0)
        }.andExpect { status { isOk() } }

        val terminal = mockMvc.post("/api/v1/reservations/${reservation.id}/cancel") {
            header("Authorization", "Bearer $token")
            header("X-Correlation-Id", UUID.randomUUID())
            header("Idempotency-Key", "cancel-terminal-${UUID.randomUUID()}")
            header("Expected-Version", 1)
        }.andExpect { status { isConflict() } }.andReturn().response.contentAsString
        assertThat(terminal).contains("OCC-RESERVATION-STATE-CONFLICT").doesNotContain("PSQLException", "55000")

        val constrainedReservation = reserve(resource.id, requester, instant(10), instant(11), 1)
        val invalid = ChangeReservationRequest(instant(10), instant(11), 3.toBigDecimal(), false)
        val constrained = mockMvc.patch("/api/v1/reservations/${constrainedReservation.id}") {
            header("Authorization", "Bearer $token")
            header("X-Correlation-Id", UUID.randomUUID())
            header("Idempotency-Key", "invalid-capacity-${UUID.randomUUID()}")
            header("Expected-Version", 0)
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsBytes(invalid)
        }.andExpect { status { isBadRequest() } }.andReturn().response.contentAsString
        assertThat(constrained).contains("OCC-API-VALIDATION").doesNotContain("PSQLException", "23514")
    }

    private fun loginToken(): String {
        val response = mockMvc.post("/api/v1/auth/login") {
            header("X-Correlation-Id", UUID.randomUUID())
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"admin","password":"resource-bootstrap-test-only"}"""
        }.andExpect { status { isOk() } }.andReturn().response.contentAsString
        return mapper.readTree(response).path("accessToken").textValue()
    }
}
