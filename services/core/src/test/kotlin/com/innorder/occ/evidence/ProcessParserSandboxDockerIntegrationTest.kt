package com.innorder.occ.evidence

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.condition.EnabledIfSystemProperty
import java.nio.file.Files
import java.nio.file.Path
import java.time.Clock
import java.time.Duration
import java.time.Instant

@Tag("full-integration")
@EnabledIfSystemProperty(named = "innorder.fullIntegration", matches = "true")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ProcessParserSandboxDockerIntegrationTest {
    private lateinit var tempDirectory: Path

    private lateinit var docker: Path
    private lateinit var image: String

    @BeforeAll
    fun buildSleeperImage() {
        tempDirectory = Files.createTempDirectory("occ-docker-integration-")
        docker = dockerExecutable()
        Files.writeString(
            tempDirectory.resolve("Dockerfile"),
            "FROM $ALPINE_IMAGE\nENTRYPOINT [\"sh\", \"-c\", \"sleep 30\"]\n",
        )
        val built = docker(Duration.ofMinutes(2), "build", "--quiet", tempDirectory.toString())
        assertThat(built.exitCode).withFailMessage(built.output).isZero()
        image = built.output.lineSequence().map(String::trim).last { it.startsWith("sha256:") }
    }

    @AfterAll
    fun removeSleeperImage() {
        if (::image.isInitialized) docker(Duration.ofSeconds(30), "image", "rm", "-f", image)
        if (::tempDirectory.isInitialized) {
            Files.walk(tempDirectory).use { paths ->
                paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists)
            }
        }
    }

    @Test
    fun `real Docker timeout removes daemon container before returning`() {
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
            val verification = docker(
                Duration.ofSeconds(15),
                "ps",
                "-a",
                "--no-trunc",
                "--filter",
                "name=^/$name$",
                "--format",
                "{{.Names}}",
            )
            assertThat(verification.exitCode).isZero()
            assertThat(verification.output).isBlank()
            assertThat(commands.map { it.getOrNull(1) }).containsExactly("run", "rm", "ps", "rm", "ps")
    }

    @Test
    fun `real Docker scanner timeout removes daemon container before returning`() {
        val commands = mutableListOf<List<String>>()
        ProcessScannerSandbox(scannerConfiguration(docker, image), Clock.systemUTC(), ProcessStarter { command ->
            commands += command
            ProcessBuilder(command).redirectErrorStream(true).start()
        }).use { sandbox ->
            val evidence = Files.writeString(tempDirectory.resolve("scan-claim.pdf"), "fixture")
            val request = ScanRequest(
                evidence,
                Files.size(evidence),
                "a".repeat(64),
                "application/pdf",
                Instant.now().plusSeconds(30),
            )

            val startedAt = System.nanoTime()
            assertThat(sandbox.scan(request).status).isEqualTo(ScanStatus.ERROR)
            assertThat(Duration.ofNanos(System.nanoTime() - startedAt)).isLessThan(Duration.ofSeconds(15))

            val name = commands.single { it.getOrNull(1) == "run" }
                .single { it.startsWith("--name=") }
                .removePrefix("--name=")
            val verification = docker(
                Duration.ofSeconds(15),
                "ps", "-a", "--no-trunc", "--filter", "name=^/$name$", "--format", "{{.Names}}",
            )
            assertThat(verification.exitCode).isZero()
            assertThat(verification.output).isBlank()
            assertThat(commands.map { it.getOrNull(1) }).containsExactly("run", "rm", "ps", "rm", "ps")
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

    private fun scannerConfiguration(docker: Path, image: String) = ProcessScannerSandboxConfiguration(
        executable = docker,
        arguments = listOf(
            "run", "--rm", "--network=none", "--memory=67108864", "--pids-limit=32", "--read-only",
            "--security-opt=no-new-privileges", "--cap-drop=ALL", "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16777216",
            ProcessScannerSandboxConfiguration.INPUT_MOUNT_PLACEHOLDER, image,
        ),
        maximumRuntime = Duration.ofMillis(250),
        maximumRequestBytes = 4096,
        maximumOutputBytes = 1024,
        maximumContainerMemoryBytes = 128L * 1024 * 1024,
        maximumContainerPids = 64,
        maximumTmpfsBytes = 32L * 1024 * 1024,
        maximumConcurrentScans = 1,
        maximumQueuedScans = 1,
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

    private fun docker(timeout: Duration, vararg arguments: String): DockerCommandResult =
        BoundedDockerTestCommand.run(docker, timeout, *arguments)

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

    companion object {
        private const val ALPINE_IMAGE =
            "alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c"
    }
}
