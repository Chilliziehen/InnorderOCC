package com.innorder.occ.evidence

import java.io.ByteArrayOutputStream
import java.nio.file.Path
import java.time.Duration
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

internal object BoundedDockerTestCommand {
    private const val MAXIMUM_OUTPUT_BYTES = 64 * 1024
    private val readers = Executors.newFixedThreadPool(2) { work ->
        Thread(work, "bounded-docker-test-output").apply { isDaemon = true }
    }

    fun run(executable: Path, timeout: Duration, vararg arguments: String): DockerCommandResult {
        val process = ProcessBuilder(listOf(executable.toString()) + arguments)
            .redirectErrorStream(true)
            .start()
        val output = readers.submit<ByteArray> {
            val captured = ByteArrayOutputStream()
            process.inputStream.use { input ->
                val buffer = ByteArray(1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (captured.size() + count > MAXIMUM_OUTPUT_BYTES) {
                        process.destroyForcibly()
                        error("Docker test command output exceeded $MAXIMUM_OUTPUT_BYTES bytes")
                    }
                    captured.write(buffer, 0, count)
                }
            }
            captured.toByteArray()
        }
        try {
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                process.destroyForcibly()
                process.waitFor(2, TimeUnit.SECONDS)
                error("Docker test command exceeded ${timeout.toMillis()} ms")
            }
            return DockerCommandResult(
                process.exitValue(),
                output.get(2, TimeUnit.SECONDS).toString(Charsets.UTF_8),
            )
        } finally {
            if (process.isAlive) process.destroyForcibly()
            output.cancel(true)
        }
    }
}

internal data class DockerCommandResult(val exitCode: Int, val output: String)
