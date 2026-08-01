package com.innorder.occ.evidence

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.time.Clock
import java.time.Duration
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

data class ProcessParserSandboxConfiguration(
    val executable: Path,
    val arguments: List<String>,
    val startupTimeout: Duration,
    val maximumRuntime: Duration,
    val maximumRequestBytes: Int,
    val maximumOutputBytes: Int,
    val maximumWorkerMemoryBytes: Long,
) {
    init {
        require(executable.isAbsolute && Files.isRegularFile(executable) && Files.isExecutable(executable))
        require(arguments.size <= 32 && arguments.all { it.length in 1..32_767 && '\u0000' !in it })
        require(arguments.sumOf { it.length + 1 } <= 32_767)
        require(startupTimeout in Duration.ofMillis(100)..Duration.ofSeconds(30))
        require(maximumRuntime in Duration.ofMillis(100)..Duration.ofMinutes(5))
        require(maximumRequestBytes in 64..1024 * 1024)
        require(maximumOutputBytes in 64..64 * 1024)
        require(maximumWorkerMemoryBytes in 16L * 1024 * 1024..2L * 1024 * 1024 * 1024)
    }
}

class ProcessParserSandbox(
    private val configuration: ProcessParserSandboxConfiguration,
    private val clock: Clock = Clock.systemUTC(),
) : ParserSandbox {
    init {
        val capabilities = launch("--capabilities", null, configuration.startupTimeout)
        require(capabilities.exitCode == 0 && !capabilities.timedOut && !capabilities.oversized)
        val parsed = WorkerCapabilities.parse(capabilities.output)
        require(parsed.protocol == PROTOCOL_VERSION)
        require(parsed.processIsolation)
        require(parsed.networkIsolation)
        require(parsed.memoryLimitBytes in 1..configuration.maximumWorkerMemoryBytes)
    }

    override fun inspect(request: ParserSandboxRequest): ParserSandboxResult {
        val requestRemaining = Duration.between(clock.instant(), request.deadline)
        if (requestRemaining.isZero || requestRemaining.isNegative) {
            return ParserSandboxResult.Rejected(EvidenceRejectionCode.DEADLINE_EXCEEDED)
        }
        val timeout = minOf(requestRemaining, configuration.maximumRuntime)
        return try {
            val input = ByteArrayOutputStream().also { ParserSandboxProtocol.writeRequest(it, request) }.toByteArray()
            if (input.size > configuration.maximumRequestBytes) return sandboxError()
            val outcome = launch("--inspect", input, timeout)
            if (outcome.exitCode != 0 || outcome.timedOut || outcome.oversized) sandboxError()
            else ParserSandboxProtocol.readResult(outcome.output)
        } catch (_: Exception) {
            sandboxError()
        }
    }

    private fun launch(operation: String, input: ByteArray?, timeout: Duration): ProcessOutcome {
        val process = ProcessBuilder(
            configuration.executable.toString(),
            *configuration.arguments.toTypedArray(),
            operation,
        ).redirectErrorStream(true).start()
        val readerExecutor = Executors.newSingleThreadExecutor { work ->
            Thread(work, "evidence-parser-output").apply { isDaemon = true }
        }
        val outputFuture = readerExecutor.submit<BoundedOutput> {
            readBounded(process, configuration.maximumOutputBytes)
        }
        return try {
            try {
                process.outputStream.use { output -> input?.let(output::write) }
            } catch (_: IOException) {
                terminate(process)
                return ProcessOutcome(-1, ByteArray(0), timedOut = false, oversized = false)
            }
            val completed = process.waitFor(maxOf(1, timeout.toMillis()), TimeUnit.MILLISECONDS)
            if (!completed) {
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

    private fun readBounded(process: Process, maximumBytes: Int): BoundedOutput {
        val output = ByteArrayOutputStream(minOf(maximumBytes, 8192))
        process.inputStream.use { input ->
            val buffer = ByteArray(512)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (output.size() + count > maximumBytes) {
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

    private fun sandboxError() = ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR)

    private data class ProcessOutcome(
        val exitCode: Int,
        val output: ByteArray,
        val timedOut: Boolean,
        val oversized: Boolean,
    )

    private data class BoundedOutput(val bytes: ByteArray, val oversized: Boolean)

    private data class WorkerCapabilities(
        val protocol: Int,
        val processIsolation: Boolean,
        val networkIsolation: Boolean,
        val memoryLimitBytes: Long,
    ) {
        companion object {
            fun parse(bytes: ByteArray): WorkerCapabilities {
                require(bytes.size <= 4096)
                val values = linkedMapOf<String, String>()
                String(bytes, Charsets.US_ASCII).lineSequence().filter(String::isNotBlank).forEach { line ->
                    val separator = line.indexOf('=')
                    require(separator > 0 && separator < line.lastIndex)
                    val key = line.substring(0, separator)
                    require(values.put(key, line.substring(separator + 1)) == null)
                }
                require(values.keys == setOf("protocol", "processIsolation", "networkIsolation", "memoryLimitBytes"))
                return WorkerCapabilities(
                    values.getValue("protocol").toInt(),
                    values.getValue("processIsolation").toBooleanStrict(),
                    values.getValue("networkIsolation").toBooleanStrict(),
                    values.getValue("memoryLimitBytes").toLong(),
                )
            }
        }
    }

    companion object {
        private const val PROTOCOL_VERSION = 1
    }
}
