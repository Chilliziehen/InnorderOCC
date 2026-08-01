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
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

class ProcessParserSandboxConfiguration(
    val executable: Path,
    arguments: List<String>,
    val maximumRuntime: Duration,
    val maximumRequestBytes: Int,
    val maximumOutputBytes: Int,
    val maximumContainerMemoryBytes: Long,
    val maximumContainerPids: Int,
    val maximumTmpfsBytes: Long,
) {
    val arguments: List<String> = java.util.List.copyOf(arguments)

    init {
        require(executable.isAbsolute && Files.isRegularFile(executable) && Files.isExecutable(executable))
        require(executable.fileName.toString().lowercase() in setOf("docker", "docker.exe"))
        require(maximumRuntime in Duration.ofMillis(100)..Duration.ofMinutes(5))
        require(maximumRequestBytes in 64..1024 * 1024)
        require(maximumOutputBytes in 64..64 * 1024)
        require(maximumContainerMemoryBytes in MINIMUM_MEMORY_BYTES..2L * 1024 * 1024 * 1024)
        require(maximumContainerPids in 1..1024)
        require(maximumTmpfsBytes in 1..1024L * 1024 * 1024)
        validateArguments()
    }

    fun command(input: Path, operation: String): List<String> {
        return invocation(input, operation).command
    }

    internal fun invocation(input: Path, operation: String): DockerInvocation {
        require(operation == "--inspect")
        val normalized = input.toAbsolutePath().normalize()
        require(Files.isRegularFile(normalized, LinkOption.NOFOLLOW_LINKS))
        require(normalized.toString().none { it == ',' || it == '\n' || it == '\r' || it == '\u0000' })
        val mount = "--mount=type=bind,src=$normalized,dst=$CONTAINER_INPUT_PATH,readonly"
        val name = CONTAINER_NAME_PREFIX + HexFormat.of().formatHex(ByteArray(CONTAINER_NAME_RANDOM_BYTES).also(RANDOM::nextBytes))
        val command = buildList {
            add(executable.toString())
            add(arguments.first())
            add("--name=$name")
            addAll(arguments.drop(1).map { if (it == INPUT_MOUNT_PLACEHOLDER) mount else it })
            add(operation)
        }
        return DockerInvocation(name, command)
    }

    internal fun removalCommand(name: String): List<String> {
        require(CONTAINER_NAME.matches(name))
        return listOf(executable.toString(), "rm", "-f", name)
    }

    internal fun absenceVerificationCommand(name: String): List<String> {
        require(CONTAINER_NAME.matches(name))
        return listOf(
            executable.toString(),
            "ps",
            "-a",
            "--no-trunc",
            "--filter",
            "name=^/$name$",
            "--format",
            "{{.Names}}",
        )
    }

    private fun validateArguments() {
        require(arguments.size == EXPECTED_ARGUMENT_COUNT)
        require(arguments.firstOrNull() == "run")
        require(IMAGE_REFERENCE.matches(arguments.last()))
        val options = arguments.subList(1, arguments.lastIndex)
        require(options.size == options.toSet().size)
        require(options.containsAll(REQUIRED_FIXED_OPTIONS))
        require(options.singleOrNull { it.startsWith("--network=") } == "--network=none")
        require(options.singleOrNull { it.startsWith("--security-opt=") } == "--security-opt=no-new-privileges")
        require(options.singleOrNull { it.startsWith("--cap-drop=") } == "--cap-drop=ALL")
        require(options.singleOrNull { it.startsWith("--mount=") } == INPUT_MOUNT_PLACEHOLDER)

        val memory = parsePositiveLong(options, "--memory=")
        require(memory in MINIMUM_MEMORY_BYTES..maximumContainerMemoryBytes)
        val pids = parsePositiveLong(options, "--pids-limit=")
        require(pids in 1..maximumContainerPids.toLong())
        val tmpfs = options.singleOrNull { it.startsWith("--tmpfs=") } ?: error("bounded tmpfs required")
        val prefix = "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size="
        require(tmpfs.startsWith(prefix))
        require(tmpfs.removePrefix(prefix).toLongOrNull()?.let { it in 1..maximumTmpfsBytes } == true)

        val recognized = REQUIRED_FIXED_OPTIONS + setOf(
            "--network=none",
            "--security-opt=no-new-privileges",
            "--cap-drop=ALL",
            INPUT_MOUNT_PLACEHOLDER,
            "--memory=$memory",
            "--pids-limit=$pids",
            tmpfs,
        )
        require(options.toSet() == recognized)
    }

    private fun parsePositiveLong(options: List<String>, prefix: String): Long {
        val option = options.singleOrNull { it.startsWith(prefix) } ?: error("required Docker option missing")
        return option.removePrefix(prefix).toLongOrNull()?.takeIf { it > 0 } ?: error("invalid Docker limit")
    }

    companion object {
        const val INPUT_MOUNT_PLACEHOLDER = "--mount=type=bind,src={EVIDENCE_INPUT},dst=/input/evidence,readonly"
        const val CONTAINER_INPUT_PATH = "/input/evidence"
        private const val EXPECTED_ARGUMENT_COUNT = 11
        private const val MINIMUM_MEMORY_BYTES = 16L * 1024 * 1024
        private const val CONTAINER_NAME_PREFIX = "occ-evidence-"
        private const val CONTAINER_NAME_RANDOM_BYTES = 12
        private val REQUIRED_FIXED_OPTIONS = setOf("--rm", "--read-only")
        private val IMAGE_REFERENCE = Regex("^(?:[a-z0-9][a-z0-9._/-]{0,254}@)?sha256:[0-9a-f]{64}$")
        private val CONTAINER_NAME = Regex("^$CONTAINER_NAME_PREFIX[a-f0-9]{${CONTAINER_NAME_RANDOM_BYTES * 2}}$")
        private val RANDOM = SecureRandom()
    }
}

internal data class DockerInvocation(val containerName: String, val command: List<String>)

internal fun interface ProcessStarter {
    fun start(command: List<String>): Process
}

class ProcessParserSandbox internal constructor(
    private val configuration: ProcessParserSandboxConfiguration,
    private val clock: Clock,
    private val processStarter: ProcessStarter,
) : ParserSandbox {
    constructor(
        configuration: ProcessParserSandboxConfiguration,
        clock: Clock = Clock.systemUTC(),
    ) : this(
        configuration,
        clock,
        ProcessStarter { command -> ProcessBuilder(command).redirectErrorStream(true).start() },
    )

    override fun inspect(request: ParserSandboxRequest): ParserSandboxResult {
        val requestRemaining = Duration.between(clock.instant(), request.deadline)
        if (requestRemaining.isZero || requestRemaining.isNegative) {
            return ParserSandboxResult.Rejected(EvidenceRejectionCode.DEADLINE_EXCEEDED)
        }
        val timeout = minOf(requestRemaining, configuration.maximumRuntime)
        val invocation = try {
            if (Files.size(request.path) > request.policy.maximumBytes) return sandboxError()
            val workerRequest = request.copy(path = Path.of(ProcessParserSandboxConfiguration.CONTAINER_INPUT_PATH))
            val input = ByteArrayOutputStream().also { ParserSandboxProtocol.writeRequest(it, workerRequest) }.toByteArray()
            if (input.size > configuration.maximumRequestBytes) return sandboxError()
            configuration.invocation(request.path, "--inspect") to input
        } catch (_: Exception) {
            return sandboxError()
        }
        var interrupted = false
        val result = try {
            val outcome = launch(invocation.first.command, invocation.second, timeout)
            if (outcome.exitCode != 0 || outcome.timedOut || outcome.oversized) sandboxError()
            else ParserSandboxProtocol.readResult(outcome.output)
        } catch (_: InterruptedException) {
            interrupted = true
            sandboxError()
        } catch (_: Exception) {
            sandboxError()
        }
        val cleanup = cleanup(invocation.first.containerName)
        if (interrupted || cleanup.interrupted) Thread.currentThread().interrupt()
        return if (cleanup.absent) result else sandboxError()
    }

    private fun cleanup(containerName: String): CleanupOutcome {
        val firstRemoval = control(configuration.removalCommand(containerName))
        val firstVerification = control(configuration.absenceVerificationCommand(containerName))
        var settleInterrupted = false
        try {
            Thread.sleep(CLEANUP_SETTLE_MILLIS)
        } catch (_: InterruptedException) {
            settleInterrupted = true
        }
        val finalRemoval = control(configuration.removalCommand(containerName))
        val finalVerification = control(configuration.absenceVerificationCommand(containerName))
        return CleanupOutcome(
            absent = provesAbsent(firstVerification) && provesAbsent(finalVerification),
            interrupted = firstRemoval.interrupted || firstVerification.interrupted || settleInterrupted ||
                finalRemoval.interrupted || finalVerification.interrupted,
        )
    }

    private fun provesAbsent(outcome: ControlOutcome) = outcome.completed && !outcome.oversized &&
        outcome.exitCode == 0 && outcome.output.toString(Charsets.UTF_8).trim().isEmpty()

    private fun control(command: List<String>): ControlOutcome {
        val process = try {
            processStarter.start(command)
        } catch (_: Exception) {
            return ControlOutcome(-1, ByteArray(0), completed = false, oversized = false, interrupted = false)
        }
        val readerExecutor = Executors.newSingleThreadExecutor { work ->
            Thread(work, "evidence-parser-docker-control-output").apply { isDaemon = true }
        }
        val outputFuture = readerExecutor.submit<BoundedOutput> { readBounded(process) }
        return try {
            process.outputStream.close()
            if (!process.waitFor(CONTROL_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)) {
                terminate(process)
                ControlOutcome(-1, ByteArray(0), completed = false, oversized = false, interrupted = false)
            } else {
                val bounded = try {
                    outputFuture.get(CONTROL_OUTPUT_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
                } catch (_: ExecutionException) {
                    terminate(process)
                    BoundedOutput(ByteArray(0), oversized = true)
                } catch (_: TimeoutException) {
                    terminate(process)
                    BoundedOutput(ByteArray(0), oversized = true)
                }
                ControlOutcome(
                    process.exitValue(),
                    bounded.bytes,
                    completed = true,
                    oversized = bounded.oversized,
                    interrupted = false,
                )
            }
        } catch (_: InterruptedException) {
            terminateWithoutWaiting(process)
            ControlOutcome(-1, ByteArray(0), completed = false, oversized = false, interrupted = true)
        } catch (_: Exception) {
            terminateWithoutWaiting(process)
            ControlOutcome(-1, ByteArray(0), completed = false, oversized = false, interrupted = false)
        } finally {
            if (process.isAlive) terminateWithoutWaiting(process)
            outputFuture.cancel(true)
            readerExecutor.shutdownNow()
        }
    }

    private fun launch(command: List<String>, input: ByteArray, timeout: Duration): ProcessOutcome {
        val process = processStarter.start(command)
        val readerExecutor = Executors.newSingleThreadExecutor { work ->
            Thread(work, "evidence-parser-output").apply { isDaemon = true }
        }
        val outputFuture = readerExecutor.submit<BoundedOutput> { readBounded(process) }
        return try {
            try {
                process.outputStream.use { it.write(input) }
            } catch (_: IOException) {
                terminate(process)
                return ProcessOutcome(-1, ByteArray(0), timedOut = false, oversized = false)
            }
            if (!process.waitFor(maxOf(1, timeout.toMillis()), TimeUnit.MILLISECONDS)) {
                terminate(process)
                return ProcessOutcome(-1, ByteArray(0), timedOut = true, oversized = false)
            }
            val bounded = try {
                outputFuture.get(1, TimeUnit.SECONDS)
            } catch (_: ExecutionException) {
                BoundedOutput(ByteArray(0), oversized = true)
            } catch (_: TimeoutException) {
                terminate(process)
                return ProcessOutcome(-1, ByteArray(0), timedOut = true, oversized = false)
            }
            ProcessOutcome(process.exitValue(), bounded.bytes, timedOut = false, oversized = bounded.oversized)
        } finally {
            if (process.isAlive) terminate(process)
            outputFuture.cancel(true)
            readerExecutor.shutdownNow()
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
                    return BoundedOutput(ByteArray(0), oversized = true)
                }
                output.write(buffer, 0, count)
            }
        }
        return BoundedOutput(output.toByteArray(), oversized = false)
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

    private fun sandboxError() = ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR)
    private data class ProcessOutcome(val exitCode: Int, val output: ByteArray, val timedOut: Boolean, val oversized: Boolean)
    private data class BoundedOutput(val bytes: ByteArray, val oversized: Boolean)
    private data class ControlOutcome(
        val exitCode: Int,
        val output: ByteArray,
        val completed: Boolean,
        val oversized: Boolean,
        val interrupted: Boolean,
    )
    private data class CleanupOutcome(val absent: Boolean, val interrupted: Boolean)

    companion object {
        const val INPUT_MOUNT_PLACEHOLDER = ProcessParserSandboxConfiguration.INPUT_MOUNT_PLACEHOLDER
        private const val CONTROL_TIMEOUT_MILLIS = 2_000L
        private const val CONTROL_OUTPUT_TIMEOUT_MILLIS = 1_000L
        private const val CLEANUP_SETTLE_MILLIS = 500L
    }
}
