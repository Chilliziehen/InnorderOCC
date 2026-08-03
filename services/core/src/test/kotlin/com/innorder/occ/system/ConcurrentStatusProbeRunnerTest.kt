package com.innorder.occ.system

import org.assertj.core.api.Assertions.assertThat
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.Test
import java.time.Duration
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class ConcurrentStatusProbeRunnerTest {
    private val definitions = listOf(
        "postgresql" to "PostgreSQL",
        "flowable" to "Flowable",
        "opa" to "OPA",
        "kafka" to "Kafka",
        "redis" to "Redis",
        "minio" to "MinIO",
    )

    @Test
    fun `all hanging probes share one global deadline and return sanitized unreachable results`() {
        val probes = definitions.map { (id, label) ->
            object : StatusProbe {
                override val id = id
                override val label = label
                override val external = id != "postgresql"
                override fun check(): ProbeStatus {
                    Thread.sleep(1_000)
                    throw IllegalStateException("secret-$id-host")
                }
            }
        }

        val started = System.nanoTime()
        val results = ConcurrentStatusProbeRunner(probes, Duration.ofMillis(75), true).use { it.checkAll() }
        val elapsed = Duration.ofNanos(System.nanoTime() - started)

        assertThat(elapsed).isLessThan(Duration.ofMillis(350))
        assertThat(results.map { it.id }).containsExactlyElementsOf(definitions.map { it.first })
        assertThat(results).allMatch { it.state == ServiceState.UNREACHABLE }
        assertThat(results.mapNotNull { it.detail }).noneMatch { it.contains("secret-") }
    }

    @Test
    fun `disabled external probes report checking without invocation`() {
        val calls = AtomicInteger()
        val probes = definitions.map { (id, label) ->
            object : StatusProbe {
                override val id = id
                override val label = label
                override val external = id != "postgresql"
                override fun check(): ProbeStatus {
                    calls.incrementAndGet()
                    return ProbeStatus.ready(id, label)
                }
            }
        }

        val results = ConcurrentStatusProbeRunner(probes, Duration.ofMillis(100), false).use { it.checkAll() }

        assertThat(calls.get()).isEqualTo(1)
        assertThat(results.single { it.id == "postgresql" }.state).isEqualTo(ServiceState.READY)
        assertThat(results.filter { it.id != "postgresql" }).allMatch { it.state == ServiceState.CHECKING }
    }

    @Test
    fun `concurrent callers share one in-flight probe execution`() {
        val calls = AtomicInteger()
        val callersReady = CountDownLatch(4)
        val start = CountDownLatch(1)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val probe = object : StatusProbe {
            override val id = "postgresql"
            override val label = "PostgreSQL"
            override val external = false
            override fun check(): ProbeStatus {
                calls.incrementAndGet()
                entered.countDown()
                release.await()
                return ProbeStatus.ready(id, label)
            }
        }

        ConcurrentStatusProbeRunner(listOf(probe), Duration.ofSeconds(1), true).use { runner ->
            Executors.newFixedThreadPool(4).use { callers ->
                val results = (1..4).map {
                    callers.submit<List<ProbeStatus>> {
                        callersReady.countDown()
                        start.await()
                        runner.checkAll()
                    }
                }
                assertThat(callersReady.await(250, TimeUnit.MILLISECONDS)).isTrue()
                start.countDown()
                assertThat(entered.await(250, TimeUnit.MILLISECONDS)).isTrue()
                Thread.sleep(50)
                release.countDown()

                assertThat(results.flatMap { it.get(1, TimeUnit.SECONDS) }).hasSize(4)
                assertThat(calls.get()).isEqualTo(1)
            }
        }
    }

    @Test
    fun `close interrupts an active probe and terminates managed execution`() {
        val entered = CountDownLatch(1)
        val interrupted = CountDownLatch(1)
        val probeThread = AtomicReference<Thread>()
        val probe = object : StatusProbe {
            override val id = "postgresql"
            override val label = "PostgreSQL"
            override val external = false
            override fun check(): ProbeStatus {
                probeThread.set(Thread.currentThread())
                entered.countDown()
                try {
                    Thread.sleep(5_000)
                } catch (_: InterruptedException) {
                    interrupted.countDown()
                }
                return ProbeStatus.unreachable(id, label, "PostgreSQL unavailable")
            }
        }
        val runner = ConcurrentStatusProbeRunner(listOf(probe), Duration.ofSeconds(2), true)
        val caller = Executors.newSingleThreadExecutor()

        try {
            val pending = caller.submit<List<ProbeStatus>> { runner.checkAll() }
            assertThat(entered.await(250, TimeUnit.MILLISECONDS)).isTrue()
            runner.close()

            assertThat(interrupted.await(500, TimeUnit.MILLISECONDS)).isTrue()
            await().atMost(1, TimeUnit.SECONDS).untilAsserted { assertThat(probeThread.get().isAlive).isFalse() }
            assertThat(pending.get(1, TimeUnit.SECONDS).single().state).isEqualTo(ServiceState.UNREACHABLE)
        } finally {
            caller.shutdownNow()
        }
    }
}
