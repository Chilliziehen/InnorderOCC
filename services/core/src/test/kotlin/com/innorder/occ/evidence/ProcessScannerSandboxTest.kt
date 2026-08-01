package com.innorder.occ.evidence

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.system.exitProcess

class ProcessScannerSandboxTest {
    @TempDir
    lateinit var tempDirectory: Path

    @Test
    fun `scanner uses constrained named Docker invocation and proves cleanup`() {
        val commands = mutableListOf<List<String>>()
        scanner("clean", commands = commands).use { sandbox ->
            val result = sandbox.scan(scanRequest())

            assertThat(result).isEqualTo(ScanResult(ScanStatus.CLEAN, "fixture-scanner", "1.0", "clean"))
            val run = commands.single { it.getOrNull(1) == "run" }
            assertThat(run).contains(
                "--rm",
                "--network=none",
                "--memory=67108864",
                "--pids-limit=32",
                "--read-only",
                "--security-opt=no-new-privileges",
                "--cap-drop=ALL",
                "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16777216",
            )
            val name = run.single { it.startsWith("--name=") }.removePrefix("--name=")
            assertThat(name).matches("occ-scanner-[a-f0-9]{24}")
            assertThat(commands.takeLast(2)).containsExactly(
                listOf(fakeDocker().toString(), "rm", "-f", name),
                listOf(fakeDocker().toString(), "ps", "-a", "--no-trunc", "--filter", "name=^/$name$", "--format", "{{.Names}}"),
            )
        }
    }

    @Test
    fun `timeout malformed oversized and cleanup uncertainty fail closed`() {
        listOf(
            scanner("timeout", maximumRuntime = Duration.ofMillis(200)),
            scanner("malformed"),
            scanner("oversized"),
            scanner("clean", verificationExitCode = 1, verificationOutput = "daemon unavailable"),
            scanner("clean", verificationOutput = "occ-scanner-still-running"),
        ).forEach { sandbox ->
            sandbox.use {
                assertThat(it.scan(scanRequest()).status).isEqualTo(ScanStatus.ERROR)
            }
        }
    }

    @Test
    fun `interrupt ignoring scanner process cannot create unbounded workers or requests`() {
        val starts = AtomicInteger()
        val commands = mutableListOf<List<String>>()
        val base = scanner(
            "ignore-interrupt",
            commands = commands,
            maximumRuntime = Duration.ofMillis(200),
            maximumConcurrentScans = 1,
            maximumQueuedScans = 1,
            runStartBlock = {
                starts.incrementAndGet()
            },
        )
        val callers = Executors.newFixedThreadPool(12)
        val ready = CountDownLatch(12)
        val begin = CountDownLatch(1)
        try {
            val results = List(12) {
                callers.submit<ScanResult> {
                    ready.countDown()
                    begin.await()
                    base.scan(scanRequest(deadline = Instant.now().plusMillis(350)))
                }
            }
            assertThat(ready.await(2, TimeUnit.SECONDS)).isTrue()
            begin.countDown()
            results.forEach { assertThat(it.get(10, TimeUnit.SECONDS).status).isEqualTo(ScanStatus.ERROR) }
            assertThat(starts.get()).isLessThanOrEqualTo(2)
        } finally {
            callers.shutdownNow()
            base.close()
        }
    }

    private fun scanner(
        mode: String,
        commands: MutableList<List<String>> = mutableListOf(),
        maximumRuntime: Duration = Duration.ofSeconds(8),
        maximumConcurrentScans: Int = 2,
        maximumQueuedScans: Int = 2,
        verificationExitCode: Int = 0,
        verificationOutput: String = "",
        runStartBlock: (() -> Unit)? = null,
    ): ProcessScannerSandbox {
        val java = Path.of(System.getProperty("java.home"), "bin", if (System.getProperty("os.name").startsWith("Windows")) "java.exe" else "java")
        val workerArgs = tempDirectory.resolve("scanner-worker-$mode.args")
        Files.writeString(workerArgs, "-cp\n${System.getProperty("java.class.path")}\n${ScannerWorkerFixture::class.java.name}\n$mode\n")
        return ProcessScannerSandbox(
            ProcessScannerSandboxConfiguration(
                executable = fakeDocker(),
                arguments = secureArguments(),
                maximumRuntime = maximumRuntime,
                maximumRequestBytes = 4096,
                maximumOutputBytes = 1024,
                maximumContainerMemoryBytes = 128L * 1024 * 1024,
                maximumContainerPids = 64,
                maximumTmpfsBytes = 32L * 1024 * 1024,
                maximumConcurrentScans = maximumConcurrentScans,
                maximumQueuedScans = maximumQueuedScans,
            ),
            Clock.systemUTC(),
            ProcessStarter { command ->
                synchronized(commands) { commands += command }
                if (command.getOrNull(1) == "run") {
                    runStartBlock?.invoke()
                    ProcessBuilder(java.toString(), "@$workerArgs").redirectErrorStream(true).start()
                } else {
                    val verify = command.getOrNull(1) == "ps"
                    CompletedProcess(
                        if (verify) verificationExitCode else 0,
                        (if (verify) verificationOutput else "").toByteArray(),
                    )
                }
            },
        )
    }

    private fun scanRequest(deadline: Instant = Instant.now().plusSeconds(10)): ScanRequest {
        val path = tempDirectory.resolve("claim.pdf")
        if (!Files.exists(path)) Files.writeString(path, "fixture")
        return ScanRequest(path, Files.size(path), "a".repeat(64), "application/pdf", deadline)
    }

    private fun fakeDocker(): Path {
        val path = tempDirectory.resolve(if (System.getProperty("os.name").startsWith("Windows")) "docker.exe" else "docker")
        if (!Files.exists(path)) {
            Files.write(path, byteArrayOf(0))
            path.toFile().setExecutable(true)
        }
        return path.toAbsolutePath()
    }

    companion object {
        private val IMAGE = "registry.example/scanner@sha256:${"b".repeat(64)}"
        private fun secureArguments() = listOf(
            "run", "--rm", "--network=none", "--memory=67108864", "--pids-limit=32", "--read-only",
            "--security-opt=no-new-privileges", "--cap-drop=ALL", "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16777216",
            ProcessScannerSandboxConfiguration.INPUT_MOUNT_PLACEHOLDER, IMAGE,
        )
    }
}

object ScannerWorkerFixture {
    @JvmStatic
    fun main(args: Array<String>) {
        ScannerSandboxProtocol.readRequest(System.`in`)
        when (args.single()) {
            "timeout" -> Thread.sleep(30_000)
            "ignore-interrupt" -> while (true) {
                try {
                    Thread.sleep(30_000)
                } catch (_: InterruptedException) {
                    Unit
                }
            }
            "malformed" -> print("malformed")
            "oversized" -> print("x".repeat(4096))
            else -> ScannerSandboxProtocol.writeResult(
                System.out,
                ScanResult(ScanStatus.CLEAN, "fixture-scanner", "1.0", "clean"),
            )
        }
    }
}
