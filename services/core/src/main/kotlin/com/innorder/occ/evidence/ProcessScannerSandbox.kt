package com.innorder.occ.evidence

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.security.SecureRandom
import java.time.Clock
import java.time.Duration
import java.util.HexFormat
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ExecutionException
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.Semaphore
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

class ProcessScannerSandboxConfiguration(
    val executable: Path,
    arguments: List<String>,
    val maximumRuntime: Duration,
    val maximumRequestBytes: Int,
    val maximumOutputBytes: Int,
    val maximumContainerMemoryBytes: Long,
    val maximumContainerPids: Int,
    val maximumTmpfsBytes: Long,
    val maximumConcurrentScans: Int,
    val maximumQueuedScans: Int,
) {
    val arguments: List<String> = java.util.List.copyOf(arguments)

    init {
        require(executable.isAbsolute && Files.isRegularFile(executable) && Files.isExecutable(executable))
        require(executable.fileName.toString().lowercase() in setOf("docker", "docker.exe"))
        require(maximumRuntime in Duration.ofMillis(100)..Duration.ofMinutes(5))
        require(maximumRequestBytes in 64..1024 * 1024)
        require(maximumOutputBytes in 64..64 * 1024)
        require(maximumContainerMemoryBytes in 16L * 1024 * 1024..2L * 1024 * 1024 * 1024)
        require(maximumContainerPids in 1..1024)
        require(maximumTmpfsBytes in 1..1024L * 1024 * 1024)
        require(maximumConcurrentScans in 1..16)
        require(maximumQueuedScans in 0..64)
        validateArguments()
    }

    internal fun invocation(input: Path): ScannerDockerInvocation {
        val normalized = input.toAbsolutePath().normalize()
        require(Files.isRegularFile(normalized, LinkOption.NOFOLLOW_LINKS))
        require(normalized.toString().none { it == ',' || it == '\n' || it == '\r' || it == '\u0000' })
        val name = "occ-scanner-" + HexFormat.of().formatHex(ByteArray(12).also(RANDOM::nextBytes))
        val mount = "--mount=type=bind,src=$normalized,dst=$CONTAINER_INPUT_PATH,readonly"
        return ScannerDockerInvocation(name, buildList {
            add(executable.toString())
            add("run")
            add("--name=$name")
            addAll(arguments.drop(1).map { if (it == INPUT_MOUNT_PLACEHOLDER) mount else it })
            add("--scan")
        })
    }

    internal fun removalCommand(name: String) = controlCommand(name, listOf("rm", "-f"))
    internal fun absenceCommand(name: String) = controlCommand(
        name,
        listOf("ps", "-a", "--no-trunc", "--filter", "name=^/$name$", "--format", "{{.Names}}"),
        nameLast = false,
    )

    private fun controlCommand(name: String, arguments: List<String>, nameLast: Boolean = true): List<String> {
        require(CONTAINER_NAME.matches(name))
        return if (nameLast) listOf(executable.toString()) + arguments + name else listOf(executable.toString()) + arguments
    }

    private fun validateArguments() {
        require(arguments.size == 11 && arguments.first() == "run" && IMAGE_REFERENCE.matches(arguments.last()))
        val options = arguments.subList(1, arguments.lastIndex)
        require(options.size == options.toSet().size)
        val memory = positive(options, "--memory=")
        val pids = positive(options, "--pids-limit=")
        val tmpfs = options.singleOrNull { it.startsWith("--tmpfs=") } ?: error("bounded tmpfs required")
        require(memory in 16L * 1024 * 1024..maximumContainerMemoryBytes)
        require(pids in 1..maximumContainerPids.toLong())
        val tmpfsPrefix = "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size="
        require(tmpfs.startsWith(tmpfsPrefix) && tmpfs.removePrefix(tmpfsPrefix).toLongOrNull()?.let { it in 1..maximumTmpfsBytes } == true)
        require(options.toSet() == setOf(
            "--rm", "--network=none", "--memory=$memory", "--pids-limit=$pids", "--read-only",
            "--security-opt=no-new-privileges", "--cap-drop=ALL", tmpfs, INPUT_MOUNT_PLACEHOLDER,
        ))
    }

    private fun positive(options: List<String>, prefix: String): Long =
        options.singleOrNull { it.startsWith(prefix) }?.removePrefix(prefix)?.toLongOrNull()?.takeIf { it > 0 }
            ?: error("required positive Docker limit")

    companion object {
        const val INPUT_MOUNT_PLACEHOLDER = "--mount=type=bind,src={EVIDENCE_INPUT},dst=/input/evidence,readonly"
        const val CONTAINER_INPUT_PATH = "/input/evidence"
        private val IMAGE_REFERENCE = Regex("^(?:[a-z0-9][a-z0-9._/-]{0,254}@)?sha256:[0-9a-f]{64}$")
        private val CONTAINER_NAME = Regex("^occ-scanner-[a-f0-9]{24}$")
        private val RANDOM = SecureRandom()
    }
}

internal data class ScannerDockerInvocation(val containerName: String, val command: List<String>)

class ProcessScannerSandbox internal constructor(
    private val configuration: ProcessScannerSandboxConfiguration,
    private val clock: Clock,
    private val processStarter: ProcessStarter,
) : ScannerSandbox, AutoCloseable {
    private val admission = Semaphore(configuration.maximumConcurrentScans + configuration.maximumQueuedScans, true)
    private val active = Semaphore(configuration.maximumConcurrentScans, true)
    private val readers = ThreadPoolExecutor(
        configuration.maximumConcurrentScans * 2,
        configuration.maximumConcurrentScans * 2,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(configuration.maximumConcurrentScans * 2),
        { work -> Thread(work, "evidence-scanner-output").apply { isDaemon = true } },
        ThreadPoolExecutor.AbortPolicy(),
    )

    constructor(configuration: ProcessScannerSandboxConfiguration, clock: Clock = Clock.systemUTC()) : this(
        configuration,
        clock,
        ProcessStarter { command -> ProcessBuilder(command).redirectErrorStream(true).start() },
    )

    override fun scan(request: ScanRequest): ScanResult {
        if (!admission.tryAcquire()) return scannerError("saturated")
        try {
            val waitingMillis = remainingMillis(request)
            if (waitingMillis <= 0 || !active.tryAcquire(waitingMillis, TimeUnit.MILLISECONDS)) return scannerError("deadline")
            try {
                return execute(request)
            } finally {
                active.release()
            }
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            return scannerError("interrupted")
        } finally {
            admission.release()
        }
    }

    private fun execute(request: ScanRequest): ScanResult {
        val invocation: ScannerDockerInvocation
        val input: ByteArray
        try {
            if (Files.size(request.path) != request.sizeBytes) return scannerError("size")
            invocation = configuration.invocation(request.path)
            val workerRequest = request.copy(path = Path.of(ProcessScannerSandboxConfiguration.CONTAINER_INPUT_PATH))
            input = ByteArrayOutputStream().also { ScannerSandboxProtocol.writeRequest(it, workerRequest) }.toByteArray()
            if (input.size > configuration.maximumRequestBytes) return scannerError("request")
        } catch (_: Exception) {
            return scannerError("request")
        }
        var interrupted = false
        val result = try {
            val timeout = minOf(Duration.ofMillis(remainingMillis(request)), configuration.maximumRuntime)
            val outcome = launch(invocation.command, input, timeout)
            if (!outcome.completed || outcome.exitCode != 0 || outcome.oversized) scannerError("process")
            else ScannerSandboxProtocol.readResult(outcome.output)
        } catch (_: InterruptedException) {
            interrupted = true
            scannerError("interrupted")
        } catch (_: Exception) {
            scannerError("protocol")
        }
        val cleanup = cleanup(invocation.containerName)
        if (interrupted || cleanup.interrupted) Thread.currentThread().interrupt()
        return when {
            !cleanup.absent -> scannerError("cleanup-unverified")
            !clock.instant().isBefore(request.deadline) -> scannerError("deadline")
            else -> result
        }
    }

    private fun launch(command: List<String>, input: ByteArray, timeout: Duration): ProcessOutcome {
        if (timeout.isZero || timeout.isNegative) return ProcessOutcome(-1, ByteArray(0), false, false)
        val process = processStarter.start(command)
        val output = try {
            readers.submit<BoundedOutput> { readBounded(process) }
        } catch (_: RejectedExecutionException) {
            terminate(process)
            return ProcessOutcome(-1, ByteArray(0), false, true)
        }
        return try {
            try {
                process.outputStream.use { it.write(input) }
            } catch (_: IOException) {
                terminate(process)
                return ProcessOutcome(-1, ByteArray(0), false, false)
            }
            if (!process.waitFor(maxOf(1, timeout.toMillis()), TimeUnit.MILLISECONDS)) {
                terminate(process)
                return ProcessOutcome(-1, ByteArray(0), false, false)
            }
            val bounded = output.get(1, TimeUnit.SECONDS)
            ProcessOutcome(process.exitValue(), bounded.bytes, true, bounded.oversized)
        } finally {
            if (process.isAlive) terminate(process)
            output.cancel(true)
        }
    }

    private fun cleanup(name: String): CleanupOutcome {
        val firstRemoval = control(configuration.removalCommand(name))
        val firstVerification = control(configuration.absenceCommand(name))
        var settleInterrupted = false
        try {
            Thread.sleep(CLEANUP_SETTLE_MILLIS)
        } catch (_: InterruptedException) {
            settleInterrupted = true
        }
        val finalRemoval = control(configuration.removalCommand(name))
        val finalVerification = control(configuration.absenceCommand(name))
        return CleanupOutcome(
            provesAbsent(firstVerification) && provesAbsent(finalVerification),
            firstRemoval.interrupted || firstVerification.interrupted || settleInterrupted ||
                finalRemoval.interrupted || finalVerification.interrupted,
        )
    }

    private fun provesAbsent(outcome: ControlOutcome) = outcome.completed && outcome.exitCode == 0 && !outcome.oversized &&
        outcome.output.toString(Charsets.UTF_8).trim().isEmpty()

    private fun control(command: List<String>): ControlOutcome {
        val process = try { processStarter.start(command) } catch (_: Exception) {
            return ControlOutcome(-1, ByteArray(0), false, false, false)
        }
        val output = try { readers.submit<BoundedOutput> { readBounded(process) } } catch (_: RejectedExecutionException) {
            terminate(process)
            return ControlOutcome(-1, ByteArray(0), false, true, false)
        }
        return try {
            process.outputStream.close()
            if (!process.waitFor(CONTROL_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)) {
                terminate(process)
                ControlOutcome(-1, ByteArray(0), false, false, false)
            } else {
                val bounded = output.get(CONTROL_OUTPUT_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
                ControlOutcome(process.exitValue(), bounded.bytes, true, bounded.oversized, false)
            }
        } catch (_: InterruptedException) {
            terminateWithoutWaiting(process)
            ControlOutcome(-1, ByteArray(0), false, false, true)
        } catch (_: Exception) {
            terminateWithoutWaiting(process)
            ControlOutcome(-1, ByteArray(0), false, true, false)
        } finally {
            if (process.isAlive) terminateWithoutWaiting(process)
            output.cancel(true)
        }
    }

    private fun readBounded(process: Process): BoundedOutput {
        val output = ByteArrayOutputStream(minOf(configuration.maximumOutputBytes, 8192))
        process.inputStream.use { input ->
            val buffer = ByteArray(512)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (output.size() + count > configuration.maximumOutputBytes) {
                    terminate(process)
                    return BoundedOutput(ByteArray(0), true)
                }
                output.write(buffer, 0, count)
            }
        }
        return BoundedOutput(output.toByteArray(), false)
    }

    private fun terminate(process: Process) {
        process.destroy()
        if (!process.waitFor(100, TimeUnit.MILLISECONDS)) {
            process.destroyForcibly()
            process.waitFor(2, TimeUnit.SECONDS)
        }
    }

    private fun terminateWithoutWaiting(process: Process) {
        process.destroy()
        if (process.isAlive) process.destroyForcibly()
    }

    private fun remainingMillis(request: ScanRequest) = Duration.between(clock.instant(), request.deadline).toMillis()
    private fun scannerError(reference: String) = ScanResult(ScanStatus.ERROR, "process-scanner", "1", reference)

    override fun close() {
        readers.shutdownNow()
    }

    private data class BoundedOutput(val bytes: ByteArray, val oversized: Boolean)
    private data class ProcessOutcome(val exitCode: Int, val output: ByteArray, val completed: Boolean, val oversized: Boolean)
    private data class ControlOutcome(val exitCode: Int, val output: ByteArray, val completed: Boolean, val oversized: Boolean, val interrupted: Boolean)
    private data class CleanupOutcome(val absent: Boolean, val interrupted: Boolean)

    companion object {
        private const val CONTROL_TIMEOUT_MILLIS = 2_000L
        private const val CONTROL_OUTPUT_TIMEOUT_MILLIS = 1_000L
        private const val CLEANUP_SETTLE_MILLIS = 500L
    }
}
