package com.innorder.occ.evidence

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import org.junit.jupiter.params.provider.ValueSource
import java.nio.file.Files
import java.nio.file.Path
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.system.exitProcess
import java.util.stream.Stream

class ProcessParserSandboxTest {
    @TempDir
    lateinit var tempDirectory: Path

    private val sandboxes = mutableListOf<ProcessParserSandbox>()

    @AfterEach
    fun closeSandboxes() {
        sandboxes.forEach(ProcessParserSandbox::close)
        sandboxes.clear()
    }

    @Test
    fun `ordinary process executable is rejected`() {
        val javaExecutable = Path.of(
            System.getProperty("java.home"),
            "bin",
            if (System.getProperty("os.name").startsWith("Windows")) "java.exe" else "java",
        )

        assertThatThrownBy { configuration(executable = javaExecutable) }
            .isInstanceOf(IllegalArgumentException::class.java)
    }

    @ParameterizedTest(name = "rejects unsafe Docker arguments {0}")
    @MethodSource("unsafeDockerArguments")
    fun `weakened overridden duplicated or additional Docker controls are rejected`(
        description: String,
        arguments: List<String>,
    ) {
        assertThatThrownBy { configuration(arguments = arguments) }
            .isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `fully constrained Docker invocation is accepted and mounts only requested file read-only`() {
        val commands = mutableListOf<List<String>>()
        val sandbox = sandbox("clean", commands = commands)
        val path = Files.writeString(tempDirectory.resolve("claim.pdf"), "fixture")

        assertThat(sandbox.inspect(parserRequest(path)))
            .isEqualTo(ParserSandboxResult.Accepted("application/pdf"))
        val runCommand = commands.single { it.getOrNull(1) == "run" }
        assertThat(runCommand).contains(
            "--network=none",
            "--memory=67108864",
            "--pids-limit=32",
            "--read-only",
            "--security-opt=no-new-privileges",
            "--cap-drop=ALL",
            "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16777216",
            "--mount=type=bind,src=${path.toAbsolutePath().normalize()},dst=/input/evidence,readonly",
        )
        assertThat(runCommand).doesNotContain(ProcessParserSandbox.INPUT_MOUNT_PLACEHOLDER)
        assertThat(runCommand.single { it.startsWith("--name=") })
            .matches("--name=occ-evidence-[a-f0-9]{24}")
        assertThat(commands.map { it.getOrNull(1) }).containsExactly("run", "rm", "ps", "rm", "ps")
    }

    @Test
    fun `container names are generated per invocation and cannot inject Docker arguments`() {
        val commands = mutableListOf<List<String>>()
        val sandbox = sandbox("clean", commands = commands)
        val first = Files.writeString(tempDirectory.resolve("first.pdf"), "fixture")
        val second = Files.writeString(tempDirectory.resolve("second.pdf"), "fixture")

        sandbox.inspect(parserRequest(first))
        sandbox.inspect(parserRequest(second))

        val names = commands.filter { it.getOrNull(1) == "run" }
            .map { command -> command.single { it.startsWith("--name=") }.removePrefix("--name=") }
        assertThat(names).hasSize(2).doesNotHaveDuplicates()
        assertThat(names).allMatch { it.matches(Regex("occ-evidence-[a-f0-9]{24}")) }
    }

    @Test
    fun `validated Docker flags cannot be weakened through caller mutation`() {
        val arguments = secureDockerArguments().toMutableList()
        val configuration = configuration(arguments = arguments)
        arguments[2] = "--network=host"
        val input = Files.writeString(tempDirectory.resolve("claim.pdf"), "fixture")

        assertThat(configuration.command(input, "--inspect"))
            .contains("--network=none")
            .doesNotContain("--network=host")
    }

    @ParameterizedTest
    @ValueSource(strings = ["malformed-output", "oversized-output"])
    fun `malformed or oversized worker output fails closed`(mode: String) {
        val commands = mutableListOf<List<String>>()
        val sandbox = sandbox(mode, commands = commands)
        val path = Files.writeString(tempDirectory.resolve("claim-$mode.pdf"), "fixture")

        assertThat(sandbox.inspect(parserRequest(path)))
            .isEqualTo(ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR))
        val name = commands.first().single { it.startsWith("--name=") }.removePrefix("--name=")
        assertThat(commands.takeLast(2)).containsExactly(
            listOf(fakeDockerExecutable().toString(), "rm", "-f", name),
            listOf(
                fakeDockerExecutable().toString(),
                "ps",
                "-a",
                "--no-trunc",
                "--filter",
                "name=^/$name$",
                "--format",
                "{{.Names}}",
            ),
        )
    }

    @Test
    fun `successful parser result fails closed when exact-name container remains`() {
        val commands = mutableListOf<List<String>>()
        val sandbox = sandbox("clean", commands = commands, verificationOutput = "occ-evidence-still-running\n")
        val path = Files.writeString(tempDirectory.resolve("claim.pdf"), "fixture")

        assertThat(sandbox.inspect(parserRequest(path)))
            .isEqualTo(ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR))
        assertThat(commands.map { it.getOrNull(1) }).containsExactly("run", "rm", "ps", "rm", "ps")
    }

    @Test
    fun `daemon unavailable during absence verification fails closed`() {
        val commands = mutableListOf<List<String>>()
        val sandbox = sandbox(
            "clean",
            commands = commands,
            verificationExitCode = 1,
            verificationOutput = "Cannot connect to the Docker daemon",
        )
        val path = Files.writeString(tempDirectory.resolve("daemon-unavailable.pdf"), "fixture")

        assertThat(sandbox.inspect(parserRequest(path)))
            .isEqualTo(ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR))
        assertThat(commands.map { it.getOrNull(1) }).containsExactly("run", "rm", "ps", "rm", "ps")
    }

    @Test
    fun `absence verification timeout fails closed`() {
        val sandbox = sandbox("clean", verificationDelayMillis = 5_000)
        val path = Files.writeString(tempDirectory.resolve("verification-timeout.pdf"), "fixture")

        assertThat(sandbox.inspect(parserRequest(path)))
            .isEqualTo(ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR))
    }

    @Test
    fun `oversized absence verification output fails closed`() {
        val sandbox = sandbox("clean", verificationOutput = "x".repeat(2048))
        val path = Files.writeString(tempDirectory.resolve("verification-oversized.pdf"), "fixture")

        assertThat(sandbox.inspect(parserRequest(path)))
            .isEqualTo(ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR))
    }

    @Test
    fun `worker timeout forcibly terminates launched container process`() {
        val pidFile = tempDirectory.resolve("worker.pid")
        val sandbox = sandbox("timeout", pidFile, maximumRuntime = Duration.ofSeconds(5))
        val path = Files.writeString(tempDirectory.resolve("claim.pdf"), "fixture")

        assertThat(sandbox.inspect(parserRequest(path)))
            .isEqualTo(ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR))
        val pid = Files.readString(pidFile).trim().toLong()
        assertThat(ProcessHandle.of(pid).map { it.isAlive }.orElse(false)).isFalse()
    }

    @Test
    fun `interruption cleans up and verifies container absence before restoring interrupt`() {
        val commands = mutableListOf<List<String>>()
        val sandbox = sandbox("timeout", maximumRuntime = Duration.ofSeconds(5), commands = commands)
        val path = Files.writeString(tempDirectory.resolve("interrupted.pdf"), "fixture")
        val testThread = Thread.currentThread()
        val interrupter = Executors.newSingleThreadScheduledExecutor()
        interrupter.schedule({ testThread.interrupt() }, 250, TimeUnit.MILLISECONDS)

        try {
            assertThat(sandbox.inspect(parserRequest(path)))
                .isEqualTo(ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR))
            assertThat(Thread.interrupted()).isTrue()
            assertThat(commands.map { it.getOrNull(1) }).containsExactly("run", "rm", "ps", "rm", "ps")
        } finally {
            Thread.interrupted()
            interrupter.shutdownNow()
        }
    }

    @Test
    fun `nonzero worker exit still removes and verifies daemon container`() {
        val commands = mutableListOf<List<String>>()
        val sandbox = sandbox("failure", commands = commands)
        val path = Files.writeString(tempDirectory.resolve("failure.pdf"), "fixture")

        assertThat(sandbox.inspect(parserRequest(path)))
            .isEqualTo(ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR))
        assertThat(commands.map { it.getOrNull(1) }).containsExactly("run", "rm", "ps", "rm", "ps")
    }

    @Test
    fun `request larger than configured protocol byte budget fails closed`() {
        val sandbox = sandbox("clean", maximumRequestBytes = 64)
        val path = Files.writeString(tempDirectory.resolve("claim.pdf"), "fixture")

        assertThat(sandbox.inspect(parserRequest(path)))
            .isEqualTo(ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR))
    }

    @Test
    fun `input larger than evidence policy is rejected before Docker launch`() {
        val commands = mutableListOf<List<String>>()
        val sandbox = sandbox("clean", commands = commands)
        val path = Files.write(tempDirectory.resolve("oversized.pdf"), ByteArray(2048))

        assertThat(sandbox.inspect(parserRequest(path)))
            .isEqualTo(ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR))
        assertThat(commands).isEmpty()
    }

    @Test
    fun `parser saturation bounds admitted launches and shared reader threads`() {
        val commands = java.util.Collections.synchronizedList(mutableListOf<List<String>>())
        val sandbox = sandbox(
            "timeout",
            maximumRuntime = Duration.ofMillis(200),
            commands = commands,
            maximumConcurrentParsers = 1,
            maximumQueuedParsers = 1,
        )
        val callers = Executors.newFixedThreadPool(12)
        val ready = CountDownLatch(12)
        val begin = CountDownLatch(1)
        try {
            val results = List(12) { index ->
                val path = Files.writeString(tempDirectory.resolve("saturation-$index.pdf"), "fixture")
                callers.submit<ParserSandboxResult> {
                    ready.countDown()
                    begin.await()
                    sandbox.inspect(parserRequest(path).copy(deadline = Instant.now().plusMillis(400)))
                }
            }
            assertThat(ready.await(2, TimeUnit.SECONDS)).isTrue()
            begin.countDown()
            results.forEach {
                assertThat(it.get(10, TimeUnit.SECONDS))
                    .isEqualTo(ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR))
            }
            assertThat(commands.count { it.getOrNull(1) == "run" }).isLessThanOrEqualTo(2)
            assertThat(parserReaderThreadCount()).isLessThanOrEqualTo(2)
        } finally {
            callers.shutdownNow()
            sandbox.close()
        }
        awaitParserReaderThreads(0)
    }

    private fun parserReaderThreadCount(): Int = Thread.getAllStackTraces().keys.count {
        it.isAlive && it.name.startsWith("evidence-parser-shared-output")
    }

    private fun awaitParserReaderThreads(expected: Int) {
        repeat(100) {
            if (parserReaderThreadCount() == expected) return
            Thread.sleep(10)
        }
        assertThat(parserReaderThreadCount()).isEqualTo(expected)
    }

    private fun sandbox(
        mode: String,
        pidFile: Path = tempDirectory.resolve("unused.pid"),
        maximumRuntime: Duration = Duration.ofSeconds(8),
        maximumRequestBytes: Int = 4096,
        commands: MutableList<List<String>> = mutableListOf(),
        verificationExitCode: Int = 0,
        verificationOutput: String = "",
        verificationDelayMillis: Long = 0,
        maximumConcurrentParsers: Int = 2,
        maximumQueuedParsers: Int = 2,
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
            configuration(
                maximumRuntime = maximumRuntime,
                maximumRequestBytes = maximumRequestBytes,
                maximumConcurrentParsers = maximumConcurrentParsers,
                maximumQueuedParsers = maximumQueuedParsers,
            ),
            Clock.systemUTC(),
            ProcessStarter { command ->
                commands += command
                val processArguments = if (command.getOrNull(1) == "run") {
                    listOf(javaExecutable.toString(), "@$argumentFile", command.last())
                } else {
                    val verifiesAbsence = command.getOrNull(1) == "ps"
                    val exitCode = if (verifiesAbsence) verificationExitCode else 0
                    val output = if (verifiesAbsence) verificationOutput else ""
                    val delayMillis = if (verifiesAbsence) verificationDelayMillis else 0
                    if (delayMillis > 0) return@ProcessStarter HangingProcess()
                    else return@ProcessStarter CompletedProcess(exitCode, output.toByteArray())
                }
                ProcessBuilder(processArguments)
                    .redirectErrorStream(true)
                    .start()
            },
        ).also(sandboxes::add)
    }

    private fun configuration(
        executable: Path = fakeDockerExecutable(),
        arguments: List<String> = secureDockerArguments(),
        maximumRuntime: Duration = Duration.ofSeconds(8),
        maximumRequestBytes: Int = 4096,
        maximumConcurrentParsers: Int = 2,
        maximumQueuedParsers: Int = 2,
    ) = ProcessParserSandboxConfiguration(
        executable = executable,
        arguments = arguments,
        maximumRuntime = maximumRuntime,
        maximumRequestBytes = maximumRequestBytes,
        maximumOutputBytes = 1024,
        maximumContainerMemoryBytes = 128L * 1024 * 1024,
        maximumContainerPids = 64,
        maximumTmpfsBytes = 32L * 1024 * 1024,
        maximumConcurrentParsers = maximumConcurrentParsers,
        maximumQueuedParsers = maximumQueuedParsers,
    )

    private fun fakeDockerExecutable(): Path {
        val path = tempDirectory.resolve(if (System.getProperty("os.name").startsWith("Windows")) "docker.exe" else "docker")
        if (!Files.exists(path)) {
            Files.write(path, byteArrayOf(0))
            path.toFile().setExecutable(true)
        }
        return path.toAbsolutePath()
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
        deadline = Instant.now().plusSeconds(30),
    )

    companion object {
        private val IMAGE = "registry.example/occ-evidence-parser@sha256:${"a".repeat(64)}"

        private fun secureDockerArguments() = listOf(
            "run",
            "--rm",
            "--network=none",
            "--memory=67108864",
            "--pids-limit=32",
            "--read-only",
            "--security-opt=no-new-privileges",
            "--cap-drop=ALL",
            "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16777216",
            ProcessParserSandbox.INPUT_MOUNT_PLACEHOLDER,
            IMAGE,
        )

        @JvmStatic
        fun unsafeDockerArguments(): Stream<Arguments> {
            val secure = secureDockerArguments()
            fun without(value: String) = secure - value
            fun replacing(old: String, new: String) = secure.map { if (it == old) new else it }
            return Stream.of(
                Arguments.of("missing network", without("--network=none")),
                Arguments.of("host network override", replacing("--network=none", "--network=host")),
                Arguments.of("duplicate network override", secure.toMutableList().apply { add(2, "--network=host") }),
                Arguments.of("missing memory", without("--memory=67108864")),
                Arguments.of("memory above configured limit", replacing("--memory=67108864", "--memory=268435456")),
                Arguments.of("missing pids limit", without("--pids-limit=32")),
                Arguments.of("writable root", without("--read-only")),
                Arguments.of("missing no-new-privileges", without("--security-opt=no-new-privileges")),
                Arguments.of("partial capability drop", replacing("--cap-drop=ALL", "--cap-drop=NET_ADMIN")),
                Arguments.of("writable input", replacing(ProcessParserSandbox.INPUT_MOUNT_PLACEHOLDER, "--mount=type=bind,src={EVIDENCE_INPUT},dst=/input/evidence")),
                Arguments.of("unbounded tmpfs", replacing("--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16777216", "--tmpfs=/tmp")),
                Arguments.of("additional volume", secure.toMutableList().apply { add(size - 1, "--volume=/host:/host") }),
                Arguments.of("privileged", secure.toMutableList().apply { add(size - 1, "--privileged") }),
                Arguments.of("caller supplied container name", secure.toMutableList().apply { add(size - 1, "--name=attacker") }),
                Arguments.of("unpinned image", secure.dropLast(1) + "registry.example/occ-evidence-parser:latest"),
            )
        }
    }
}

object ParserWorkerFixture {
    @JvmStatic
    fun main(args: Array<String>) {
        val mode = args[0]
        val pidFile = Path.of(args[1])
        ParserSandboxProtocol.readRequest(System.`in`)
        when (mode) {
            "timeout" -> {
                Files.writeString(pidFile, ProcessHandle.current().pid().toString())
                Thread.sleep(30_000)
            }
            "malformed-output" -> print("not-the-parser-protocol")
            "oversized-output" -> print("x".repeat(4096))
            "failure" -> exitProcess(2)
            else -> ParserSandboxProtocol.writeResult(System.out, ParserSandboxResult.Accepted("application/pdf"))
        }
    }
}

internal class CompletedProcess(private val code: Int, output: ByteArray) : Process() {
    private val standardInput = ByteArrayOutputStream()
    private val standardOutput = ByteArrayInputStream(output)

    override fun getOutputStream() = standardInput
    override fun getInputStream() = standardOutput
    override fun getErrorStream() = ByteArrayInputStream(ByteArray(0))
    override fun waitFor() = code
    override fun waitFor(timeout: Long, unit: TimeUnit) = true
    override fun exitValue() = code
    override fun destroy() = Unit
    override fun isAlive() = false
    override fun destroyForcibly(): Process = this
}

internal class HangingProcess : Process() {
    private var alive = true

    override fun getOutputStream() = ByteArrayOutputStream()
    override fun getInputStream() = ByteArrayInputStream(ByteArray(0))
    override fun getErrorStream() = ByteArrayInputStream(ByteArray(0))
    override fun waitFor(): Int = throw InterruptedException()
    override fun waitFor(timeout: Long, unit: TimeUnit) = false
    override fun exitValue(): Int = if (alive) throw IllegalThreadStateException() else -1
    override fun destroy() { alive = false }
    override fun isAlive() = alive
    override fun destroyForcibly(): Process = apply { alive = false }
}
