package com.innorder.occ.api

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.slf4j.MDC
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.stereotype.Component
import org.springframework.web.filter.OncePerRequestFilter
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.time.Clock
import java.util.UUID

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
class CorrelationIdFilter(
    private val clock: Clock,
    private val secureRandom: SecureRandom,
) : OncePerRequestFilter() {
    @Autowired
    constructor(clock: Clock) : this(clock, SecureRandom())

    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain,
    ) {
        val correlationId = acceptedCorrelationId(request) ?: generateUuidV7().toString()
        val previousMdcValue = MDC.get(MDC_KEY)

        request.setAttribute(REQUEST_ATTRIBUTE, correlationId)
        response.setHeader(HEADER_NAME, correlationId)
        MDC.put(MDC_KEY, correlationId)
        try {
            filterChain.doFilter(request, response)
        } finally {
            if (previousMdcValue == null) {
                MDC.remove(MDC_KEY)
            } else {
                MDC.put(MDC_KEY, previousMdcValue)
            }
        }
    }

    private fun acceptedCorrelationId(request: HttpServletRequest): String? {
        val values = request.getHeaders(HEADER_NAME).toList()
        if (values.size != 1) return null

        val value = values.single()
        return value.takeIf(ApiContractValidation::isStandardUuid)
    }

    private fun generateUuidV7(): UUID {
        val timestamp = clock.millis()
        require(timestamp in 0..MAX_UUID_V7_TIMESTAMP) { "Clock is outside the UUIDv7 timestamp range" }

        val bytes = ByteArray(16)
        for (index in 0 until TIMESTAMP_BYTES) {
            bytes[index] = (timestamp ushr (40 - index * 8)).toByte()
        }
        val randomBytes = ByteArray(10).also(secureRandom::nextBytes)
        randomBytes.copyInto(bytes, destinationOffset = TIMESTAMP_BYTES)
        bytes[6] = ((bytes[6].toInt() and 0x0f) or 0x70).toByte()
        bytes[8] = ((bytes[8].toInt() and 0x3f) or 0x80).toByte()

        val buffer = ByteBuffer.wrap(bytes)
        return UUID(buffer.long, buffer.long)
    }

    companion object {
        const val HEADER_NAME = "X-Correlation-ID"
        const val REQUEST_ATTRIBUTE = "com.innorder.occ.correlationId"
        const val MDC_KEY = "correlationId"

        private const val TIMESTAMP_BYTES = 6
        private const val MAX_UUID_V7_TIMESTAMP = 0x0000FFFFFFFFFFFFL
    }
}
