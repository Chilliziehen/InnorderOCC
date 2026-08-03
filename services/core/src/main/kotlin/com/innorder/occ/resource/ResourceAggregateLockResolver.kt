package com.innorder.occ.resource

import com.innorder.occ.command.AggregateLockResolver
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

const val MANAGED_RESOURCE_AGGREGATE_TYPE = "managed-resource"
const val RESOURCE_RESERVATION_AGGREGATE_TYPE = "resource-reservation"

// A reservation is always locked after its resource so concurrent commands
// touching both take the two rows in the same order.
private const val MANAGED_RESOURCE_ORDER = 300
private const val RESOURCE_RESERVATION_ORDER = 310

fun managedResourceAggregateLockResolver() =
    AggregateLockResolver(MANAGED_RESOURCE_AGGREGATE_TYPE, MANAGED_RESOURCE_ORDER) { jdbc, id ->
        jdbc.query(
            "SELECT row_version FROM occ.managed_resource WHERE id = ? FOR UPDATE",
            { rs, _ -> rs.getLong("row_version") },
            id,
        ).singleOrNull()
    }

fun resourceReservationAggregateLockResolver() =
    AggregateLockResolver(RESOURCE_RESERVATION_AGGREGATE_TYPE, RESOURCE_RESERVATION_ORDER) { jdbc, id ->
        jdbc.query(
            "SELECT row_version FROM occ.resource_reservation WHERE id = ? FOR UPDATE",
            { rs, _ -> rs.getLong("row_version") },
            id,
        ).singleOrNull()
    }

@Configuration(proxyBeanMethods = false)
class ResourceAggregateLockConfiguration {
    @Bean
    fun managedResourceLockResolver(): AggregateLockResolver = managedResourceAggregateLockResolver()

    @Bean
    fun resourceReservationLockResolver(): AggregateLockResolver = resourceReservationAggregateLockResolver()
}
