package com.innorder.occ.api

import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component

fun interface ApiFailureReporter {
    fun report(correlationId: String, exceptionClassName: String)
}

@Component
class Slf4jApiFailureReporter : ApiFailureReporter {
    private val logger = LoggerFactory.getLogger(javaClass)

    override fun report(correlationId: String, exceptionClassName: String) {
        logger.error(
            "Unhandled API failure correlationId={} exceptionClass={}",
            correlationId,
            exceptionClassName,
        )
    }
}
