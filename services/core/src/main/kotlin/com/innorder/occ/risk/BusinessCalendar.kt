package com.innorder.occ.risk

import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Collections

class BusinessCalendar(version: String, holidays: Set<LocalDate>) {
    val version: String = version.requireValue("calendar version")
    val holidays: Set<LocalDate> = Collections.unmodifiableSet(holidays.toSet())

    fun thresholdAfter(start: Instant, businessDays: Int, zone: ZoneId): Instant {
        require(businessDays > 0) { "businessDays must be positive" }
        var cursor = start.atZone(zone)
        var remaining = businessDays
        while (remaining > 0) {
            cursor = cursor.plusDays(1)
            if (cursor.dayOfWeek !in WEEKEND && cursor.toLocalDate() !in holidays) remaining--
        }
        return cursor.toInstant()
    }

    companion object {
        private val WEEKEND = setOf(DayOfWeek.SATURDAY, DayOfWeek.SUNDAY)
    }
}

internal fun String.requireValue(name: String): String = also {
    require(isNotBlank()) { "$name must not be blank" }
}
