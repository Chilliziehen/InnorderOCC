package com.innorder.occ.evidence

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.time.Clock
import java.time.Duration
import java.time.Instant

class ProcessParserSandboxDockerIntegrationTest {
    @TempDir
    lateinit var tempDirectory: Path

    @Test
    fun `real Docker timeout removes daemon container before returning`() {
        val docker = dockerExecutable()
        Files.writeString(
            tempDirectory.resolve("Dockerfile"),
            "FROM $ALPINE_IMAGE\nENTRYPOINT [\"sh\", \"-c\", \"sleep 30\"]\n",
        )
        val built = docker(docker, "build", "--quiet", tempDirectory.toString())
        assertThat(built.exitCode).withFailMessage(built.output).isZero()
        val image = built.output.lineSequence().map(String::trim).last { it.startsWith("sha256:") }

        try {
            val commands = mutableListOf<List<String>>()
            val sandbox = ProcessParserSandbox(
                configuration(docker, image),
                Clock.systemUTC(),
                ProcessStarter { command ->
                    commands += command
                    ProcessBuilder(command).redirectErrorStream(true).start()
                },
            )
            val evidence = Files.writeString(tempDirectory.resolve("claim.pdf"), "fixture")

            val startedAt = System.nanoTime()
            assertThat(sandbox.inspect(parserRequest(evidence)))
                .isEqualTo(ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR))
            assertThat(Duration.ofNanos(System.nanoTime() - startedAt)).isLessThan(Duration.ofSeconds(15))

            val name = commands.single { it.getOrNull(1) == "run" }
                .single { it.startsWith("--name=") }
                .removePrefix("--name=")
            val inspection = docker(docker, "inspect", name)
            assertThat(inspection.exitCode).isNotZero()
            assertThat(commands.map { it.getOrNull(1) }).containsExactly("run", "rm", "inspect")
        } finally {
            docker(docker, "image", "rm", "-f", image)
        }
    }

    private fun configuration(docker: Path, image: String) = ProcessParserSandboxConfiguration(
        executable = docker,
        arguments = listOf(
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
            image,
        ),
        maximumRuntime = Duration.ofMillis(250),
        maximumRequestBytes = 4096,
        maximumOutputBytes = 1024,
        maximumContainerMemoryBytes = 128L * 1024 * 1024,
        maximumContainerPids = 64,
        maximumTmpfsBytes = 32L * 1024 * 1024,
    )

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

    private fun docker(executable: Path, vararg arguments: String): CommandResult {
        val process = ProcessBuilder(listOf(executable.toString()) + arguments)
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader().use { it.readText() }
        assertThat(process.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)).isTrue()
        return CommandResult(process.exitValue(), output)
    }

    private fun dockerExecutable(): Path {
        val candidates = if (System.getProperty("os.name").startsWith("Windows")) {
            listOf(
                Path.of("C:/Program Files/Docker/Docker/resources/bin/docker.exe"),
                Path.of("C:/Windows/System32/docker.exe"),
            )
        } else {
            listOf(Path.of("/usr/bin/docker"), Path.of("/usr/local/bin/docker"))
        }
        return candidates.firstOrNull { Files.isRegularFile(it) && Files.isExecutable(it) }
            ?: error("An absolute Docker executable is required for this integration test")
    }

    private data class CommandResult(val exitCode: Int, val output: String)

    companion object {
        private const val ALPINE_IMAGE =
            "alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c"
    }
}
