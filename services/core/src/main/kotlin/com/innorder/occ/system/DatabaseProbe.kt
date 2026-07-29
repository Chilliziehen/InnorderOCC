package com.innorder.occ.system

import jakarta.annotation.PreDestroy
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import javax.sql.DataSource

fun interface DatabaseProbe {
    fun check(): DatabaseProbeResult
}

data class DatabaseProbeResult(
    val reachable: Boolean,
    val detail: String? = null,
) {
    companion object {
        fun ready() = DatabaseProbeResult(reachable = true)

        fun unreachable(detail: String) = DatabaseProbeResult(reachable = false, detail = detail)
    }
}

@Component
class DataSourceDatabaseProbe(
    private val dataSource: DataSource,
    @param:Value("\${occ.database-probe.timeout:1500ms}") private val timeout: Duration,
) : DatabaseProbe, AutoCloseable {
    private class Attempt {
        val result = CompletableFuture<DatabaseProbeResult>()

        @Volatile
        var thread: Thread? = null
    }

    private val lock = Any()
    private val executor = Executors.newSingleThreadExecutor(
        Thread.ofVirtual().name("database-probe-", 0).factory(),
    )

    @Volatile
    private var inFlight: Attempt? = null

    init {
        require(!timeout.isZero && !timeout.isNegative && timeout <= Duration.ofSeconds(2)) {
            "Database probe timeout must be between 1ms and 2s"
        }
    }

    override fun check(): DatabaseProbeResult {
        val attempt = synchronized(lock) {
            inFlight ?: startAttempt()
        }
        return try {
            attempt.result.get(timeout.toMillis(), TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            attempt.thread?.interrupt()
            DatabaseProbeResult.unreachable("Database connection timed out")
        } catch (_: Exception) {
            DatabaseProbeResult.unreachable("Database connection unavailable")
        }
    }

    private fun startAttempt(): Attempt {
        val attempt = Attempt()
        inFlight = attempt
        executor.execute {
            attempt.thread = Thread.currentThread()
            try {
                val validationSeconds = ((timeout.toMillis() + 999) / 1000).toInt().coerceIn(1, 2)
                val valid = dataSource.connection.use { connection -> connection.isValid(validationSeconds) }
                attempt.result.complete(
                    if (valid) DatabaseProbeResult.ready()
                    else DatabaseProbeResult.unreachable("Database connection unavailable"),
                )
            } catch (_: Exception) {
                attempt.result.complete(DatabaseProbeResult.unreachable("Database connection unavailable"))
            } finally {
                synchronized(lock) {
                    if (inFlight === attempt) inFlight = null
                }
            }
        }
        return attempt
    }

    @PreDestroy
    override fun close() {
        executor.shutdownNow()
    }
}
