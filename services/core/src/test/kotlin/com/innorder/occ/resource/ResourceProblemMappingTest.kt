package com.innorder.occ.resource

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.api.ApiExceptionHandler
import com.innorder.occ.api.ApiFailureReporter
import com.innorder.occ.api.CorrelationIdFilter
import com.innorder.occ.api.OccProblemResponses
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.mock.web.MockHttpServletRequest
import java.util.UUID

class ResourceProblemMappingTest {
    private val handler = ApiExceptionHandler(OccProblemResponses(ObjectMapper()), ApiFailureReporter { _, _ -> })

    @Test
    fun `authorized conflict mapping preserves bounded reservation identity fields`() {
        val resource = UUID.randomUUID()
        val reservation = UUID.randomUUID()
        val requester = UUID.randomUUID()
        val request = MockHttpServletRequest().apply {
            setAttribute(CorrelationIdFilter.REQUEST_ATTRIBUTE, UUID.randomUUID().toString())
        }

        val response = handler.reservationConflict(
            ReservationConflictException(resource, testInstant(9), testInstant(10), reservation, requester),
            request,
        )

        assertThat(response.body?.resourceId).isEqualTo(resource.toString())
        assertThat(response.body?.intervalStart).isEqualTo(testInstant(9).toString())
        assertThat(response.body?.intervalEnd).isEqualTo(testInstant(10).toString())
        assertThat(response.body?.reservationId).isEqualTo(reservation.toString())
        assertThat(response.body?.requesterEntityId).isEqualTo(requester.toString())
    }

    private fun testInstant(hour: Int) = java.time.OffsetDateTime.parse("2035-01-01T%02d:00:00Z".format(hour))
}
