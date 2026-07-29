package com.innorder.occ.system

import jakarta.annotation.PreDestroy
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component
import java.time.Duration
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Callable
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

data class ProbeStatus(
    val id: String,
    val label: String,
    val state: ServiceState,
    val detail: String? = null,
) {
    companion object {
        fun ready(id: String, label: String) = ProbeStatus(id, label, ServiceState.READY)

        fun unreachable(id: String, label: String, detail: String) =
            ProbeStatus(id, label, ServiceState.UNREACHABLE, detail)

        fun checking(id: String, label: String) =
            ProbeStatus(id, label, ServiceState.CHECKING, "$label check disabled")
    }
}

interface StatusProbe {
    val id: String
    val label: String
    val external: Boolean
    fun check(): ProbeStatus
}

fun interface StatusProbeRunner {
    fun checkAll(): List<ProbeStatus>
}

@Component
class ConcurrentStatusProbeRunner(
    probes: List<StatusProbe>,
    @param:Value("\${occ.status-probes.deadline:2000ms}") private val deadline: Duration,
    @param:Value("\${occ.status-probes.external-enabled:true}") private val externalEnabled: Boolean,
) : StatusProbeRunner, AutoCloseable {
    private data class IndexedResult(val index: Int, val status: ProbeStatus)
    private class Attempt(val result: CompletableFuture<List<ProbeStatus>> = CompletableFuture())

    private val probes = probes.sortedBy { CANONICAL_ORDER.indexOf(it.id).takeIf { index -> index >= 0 } ?: Int.MAX_VALUE }
    private val lock = Any()
    private val executor = ThreadPoolExecutor(
        this.probes.size.coerceAtLeast(1),
        this.probes.size.coerceAtLeast(1),
        0,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(this.probes.size.coerceAtLeast(1)),
        Thread.ofVirtual().name("status-probe-", 0).factory(),
        ThreadPoolExecutor.AbortPolicy(),
    )

    @Volatile
    private var inFlight: Attempt? = null

    @Volatile
    private var closed = false

    init {
        require(!deadline.isZero && !deadline.isNegative && deadline <= Duration.ofMillis(2_500)) {
            "Status probe deadline must be between 1ms and 2500ms"
        }
        require(this.probes.map { it.id }.distinct().size == this.probes.size) { "Status probe IDs must be unique" }
        executor.prestartAllCoreThreads()
    }

    override fun checkAll(): List<ProbeStatus> {
        var owner = false
        val attempt = synchronized(lock) {
            if (closed) return unavailableResults()
            inFlight ?: Attempt().also {
                inFlight = it
                owner = true
            }
        }

        if (owner) {
            try {
                attempt.result.complete(executeProbes())
            } catch (_: Exception) {
                attempt.result.complete(unavailableResults())
            } finally {
                synchronized(lock) {
                    if (inFlight === attempt) inFlight = null
                }
            }
        }

        return try {
            attempt.result.get(deadline.toMillis() + 100, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {
            unavailableResults()
        }
    }

    private fun executeProbes(): List<ProbeStatus> {
        val startedAt = System.nanoTime()
        val results = arrayOfNulls<ProbeStatus>(probes.size)
        val completion = ExecutorCompletionService<IndexedResult>(executor)
        val futures = mutableListOf<Future<IndexedResult>>()

        probes.forEachIndexed { index, probe ->
            if (probe.external && !externalEnabled) {
                results[index] = ProbeStatus.checking(probe.id, probe.label)
            } else {
                try {
                    futures += completion.submit(Callable {
                        val status = try {
                            normalize(probe, probe.check())
                        } catch (_: Exception) {
                            unavailable(probe)
                        }
                        IndexedResult(index, status)
                    })
                } catch (_: RejectedExecutionException) {
                    results[index] = unavailable(probe)
                }
            }
        }

        var remaining = futures.size
        while (remaining > 0) {
            val remainingNanos = deadline.toNanos() - (System.nanoTime() - startedAt)
            if (remainingNanos <= 0) break
            val completed = completion.poll(remainingNanos, TimeUnit.NANOSECONDS) ?: break
            try {
                val result = completed.get()
                results[result.index] = result.status
            } catch (_: Exception) {
                // The indexed task converts probe failures; cancellation is filled below.
            }
            remaining--
        }

        futures.forEach { if (!it.isDone) it.cancel(true) }
        return probes.mapIndexed { index, probe -> results[index] ?: unavailable(probe) }
    }

    private fun normalize(probe: StatusProbe, status: ProbeStatus): ProbeStatus = when (status.state) {
        ServiceState.READY -> ProbeStatus.ready(probe.id, probe.label)
        ServiceState.DEGRADED -> ProbeStatus(probe.id, probe.label, ServiceState.DEGRADED, "${probe.label} degraded")
        ServiceState.UNREACHABLE -> unavailable(probe)
        ServiceState.CHECKING -> ProbeStatus.checking(probe.id, probe.label)
    }

    private fun unavailable(probe: StatusProbe) =
        ProbeStatus.unreachable(probe.id, probe.label, "${probe.label} unavailable")

    private fun unavailableResults() = probes.map(::unavailable)

    @PreDestroy
    override fun close() {
        synchronized(lock) { closed = true }
        executor.shutdownNow()
        executor.awaitTermination(500, TimeUnit.MILLISECONDS)
    }

    companion object {
        private val CANONICAL_ORDER = listOf("postgresql", "flowable", "opa", "kafka", "redis", "minio")
    }
}
