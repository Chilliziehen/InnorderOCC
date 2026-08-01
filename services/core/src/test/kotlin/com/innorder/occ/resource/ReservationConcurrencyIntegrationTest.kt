package com.innorder.occ.resource

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class ReservationConcurrencyIntegrationTest : ResourceIntegrationSupport() {
    @Test
    fun `simultaneous exclusive and capacity contenders cannot both commit`() {
        val resource = createResource(capacity = 10)
        val requester = entity("requester")
        val outcomes = race(
            { reserve(resource.id, requester, instant(9), instant(10), 10) },
            { reserve(resource.id, requester, instant(9), instant(10), 1, exclusive = true) },
        )

        assertThat(outcomes.count { it }).isEqualTo(1)
        assertThat(activeCount(resource.id)).isEqualTo(1)
    }

    @Test
    fun `simultaneous aggregate capacity contenders never exceed capacity`() {
        val resource = createResource(capacity = 10)
        val requester = entity("requester")
        reserve(resource.id, requester, instant(9), instant(10), 4)
        val outcomes = race(
            { reserve(resource.id, requester, instant(9), instant(10), 6) },
            { reserve(resource.id, requester, instant(9), instant(10), 6) },
        )

        assertThat(outcomes.count { it }).isEqualTo(1)
        assertThat(activeCapacity(resource.id)).isEqualByComparingTo("10")
    }

    @Test
    fun `unavailability mutation racing reservation cannot invalidate a committed schedule`() {
        val resource = createResource()
        val requester = entity("requester")
        val availability = AddAvailabilityRequest(
            java.util.UUID.randomUUID(), instant(9), instant(10), AvailabilityMode.UNAVAILABLE, "maintenance",
        )
        val outcomes = race(
            {
                resources.addAvailability(
                    resource.id, metadata(expectedVersion = 0), mapper.writeValueAsBytes(availability), availability,
                )
            },
            { reserve(resource.id, requester, instant(9), instant(10), 1) },
        )

        assertThat(outcomes.count { it }).isEqualTo(1)
        val invalid = jdbc.queryForObject(
            """SELECT count(*) FROM occ.resource_reservation r JOIN occ.resource_availability a
               ON a.resource_id = r.resource_id AND a.mode = 'UNAVAILABLE' AND a.time_range && r.time_range
               WHERE r.resource_id = ? AND r.state IN ('PENDING','CONFIRMED')""",
            Long::class.java,
            resource.id,
        )!!
        assertThat(invalid).isZero()
    }

    private fun race(first: () -> Any, second: () -> Any): List<Boolean> {
        val ready = CountDownLatch(2)
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        return try {
            listOf(first, second).map { contender ->
                pool.submit<Boolean> {
                    ready.countDown()
                    check(start.await(10, TimeUnit.SECONDS))
                    runCatching { contender() }.isSuccess
                }
            }.also {
                check(ready.await(10, TimeUnit.SECONDS))
                start.countDown()
            }.map { it.get(30, TimeUnit.SECONDS) }
        } finally {
            pool.shutdownNow()
            check(pool.awaitTermination(10, TimeUnit.SECONDS))
        }
    }

    private fun activeCount(resourceId: java.util.UUID): Long = jdbc.queryForObject(
        "SELECT count(*) FROM occ.resource_reservation WHERE resource_id = ? AND state IN ('PENDING','CONFIRMED')",
        Long::class.java,
        resourceId,
    )!!

    private fun activeCapacity(resourceId: java.util.UUID): java.math.BigDecimal = jdbc.queryForObject(
        "SELECT coalesce(sum(capacity), 0) FROM occ.resource_reservation WHERE resource_id = ? AND state IN ('PENDING','CONFIRMED')",
        java.math.BigDecimal::class.java,
        resourceId,
    )!!
}
