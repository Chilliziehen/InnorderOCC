package com.innorder.occ.evidence

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.time.Instant

class ProcessParserSandboxTest {
    @TempDir
    lateinit var tempDirectory: Path

    @Test
    fun `production process sandbox accepts only attested isolated worker`() {
        val sandbox = sandbox("clean")
        val path = Files.writeString(tempDirectory.resolve("claim.pdf"), "fixture")

        assertThat(sandbox.inspect(parserRequest(path)))
            .isEqualTo(ParserSandboxResult.Accepted("application/pdf"))
    }

    @ParameterizedTest
    @ValueSource(strings = ["missing-process-isolation", "missing-network-isolation", "excessive-memory"])
    fun `missing worker isolation capability fails adapter startup`(mode: String) {
        assertThatThrownBy { sandbox(mode) }
            .isInstanceOf(IllegalArgumentException::class.java)
    }

    @ParameterizedTest
    @ValueSource(strings = ["malformed-output", "oversized-output"])
    fun `malformed or oversized worker output fails closed`(mode: String) {
        val sandbox = sandbox(mode)
        val path = Files.writeString(tempDirectory.resolve("claim-$mode.pdf"), "fixture")

        assertThat(sandbox.inspect(parserRequest(path)))
            .isEqualTo(ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR))
    }

    @Test
    fun `worker timeout forcibly terminates process`() {
        val pidFile = tempDirectory.resolve("worker.pid")
        val sandbox = sandbox("timeout", pidFile, maximumRuntime = Duration.ofSeconds(2))
        val path = Files.writeString(tempDirectory.resolve("claim.pdf"), "fixture")

        assertThat(sandbox.inspect(parserRequest(path)))
            .isEqualTo(ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR))
        val pid = Files.readString(pidFile).trim().toLong()
        assertThat(ProcessHandle.of(pid).map { it.isAlive }.orElse(false)).isFalse()
    }

    @Test
    fun `request larger than configured protocol byte budget fails closed`() {
        val sandbox = sandbox("clean", maximumRequestBytes = 64)
        val path = Files.writeString(tempDirectory.resolve("claim.pdf"), "fixture")

        assertThat(sandbox.inspect(parserRequest(path)))
            .isEqualTo(ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR))
    }

    private fun sandbox(
        mode: String,
        pidFile: Path = tempDirectory.resolve("unused.pid"),
        maximumRuntime: Duration = Duration.ofSeconds(3),
        maximumRequestBytes: Int = 4096,
    ): ProcessParserSandbox {
        val javaExecutable = Path.of(
            System.getProperty("java.home"),
            "bin",
            if (System.getProperty("os.name").startsWith("Windows")) "java.exe" else "java",
        )
        val argumentFile = tempDirectory.resolve("worker-$mode.args")
        Files.writeString(
            argumentFile,
            "-cp\n${System.getProperty("java.class.path")}\n${ParserWorkerFixture::class.java.name}\n$mode\n$pidFile\n",
        )
        return ProcessParserSandbox(
            ProcessParserSandboxConfiguration(
                executable = javaExecutable,
                arguments = listOf("@$argumentFile"),
                startupTimeout = Duration.ofSeconds(3),
                maximumRuntime = maximumRuntime,
                maximumRequestBytes = maximumRequestBytes,
                maximumOutputBytes = 1024,
                maximumWorkerMemoryBytes = 128L * 1024 * 1024,
            ),
        )
    }

    private fun parserRequest(path: Path) = ParserSandboxRequest(
        path = path,
        fileName = path.fileName.toString(),
        format = ParserFormat.PDF,
        policy = EvidencePolicy(
            setOf("pdf"),
            setOf("application/pdf"),
            1024,
            ArchiveLimits(10, 2048, 20.0),
        ),
        deadline = Instant.now().plusSeconds(10),
    )
}

object ParserWorkerFixture {
    @JvmStatic
    fun main(args: Array<String>) {
        val mode = args[0]
        val pidFile = Path.of(args[1])
        when (args[2]) {
            "--capabilities" -> capabilities(mode)
            "--inspect" -> inspect(mode, pidFile)
            else -> error("unknown operation")
        }
    }

    private fun capabilities(mode: String) {
        val processIsolated = mode != "missing-process-isolation"
        val networkIsolated = mode != "missing-network-isolation"
        val memory = if (mode == "excessive-memory") 256L * 1024 * 1024 else 64L * 1024 * 1024
        print(
            "protocol=1\n" +
                "processIsolation=$processIsolated\n" +
                "networkIsolation=$networkIsolated\n" +
                "memoryLimitBytes=$memory\n",
        )
    }

    private fun inspect(mode: String, pidFile: Path) {
        ParserSandboxProtocol.readRequest(System.`in`)
        when (mode) {
            "timeout" -> {
                Files.writeString(pidFile, ProcessHandle.current().pid().toString())
                Thread.sleep(30_000)
            }
            "malformed-output" -> print("not-the-parser-protocol")
            "oversized-output" -> print("x".repeat(4096))
            else -> ParserSandboxProtocol.writeResult(
                System.out,
                ParserSandboxResult.Accepted("application/pdf"),
            )
        }
    }
}
