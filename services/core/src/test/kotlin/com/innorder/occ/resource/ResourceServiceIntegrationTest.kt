package com.innorder.occ.resource

import com.innorder.occ.command.IdempotencyConflictException
import com.innorder.occ.command.OptimisticConflictException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.post
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
    }

    @Test
    fun `managed resource availability inventory and schedule use canonical UTC cursors and per-row authorization`() {
        val resource = createResource()
        val requester = entity("requester")
        val availability = AddAvailabilityRequest(UUID.randomUUID(), instant(8), instant(18), AvailabilityMode.AVAILABLE, null)
        val updated = resources.addAvailability(
            resource.id, metadata(expectedVersion = 0), mapper.writeValueAsBytes(availability), availability,
        )
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
        assertThat(changed).isEqualTo(replay)
        assertThat(changed.version).isEqualTo(1)
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
        )
        assertThat(maintained.state).isEqualTo(ResourceState.MAINTENANCE)
        assertThatThrownBy { reserve(resource.id, requester, instant(11), instant(12), 1) }
            .isInstanceOf(ReservationConflictException::class.java)

        val archivedResource = createResource()
        val archive = UpdateResourceRequest(10.toBigDecimal(), ResourceState.ARCHIVED, archivedResource.data)
        resources.update(archivedResource.id, metadata(expectedVersion = 0), mapper.writeValueAsBytes(archive), archive)
        assertThatThrownBy { reserve(archivedResource.id, requester, instant(11), instant(12), 1) }
            .isInstanceOf(ReservationConflictException::class.java)
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
