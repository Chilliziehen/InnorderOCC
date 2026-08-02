package com.innorder.occ.evidence

import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import java.nio.file.Path
import java.time.Clock
import java.time.Duration

@Configuration(proxyBeanMethods = false)
@Profile("!test & !flowable-init")
class EvidenceInspectionConfiguration {
    @Bean(destroyMethod = "close")
    fun parserSandbox(
        clock: Clock,
        @Value("\${occ.evidence-inspection.docker-executable}") docker: String,
        @Value("\${occ.evidence-inspection.parser-image}") image: String,
    ): ProcessParserSandbox = ProcessParserSandbox(parserConfiguration(Path.of(docker), image), clock)

    @Bean(destroyMethod = "close")
    fun scannerSandbox(
        clock: Clock,
        @Value("\${occ.evidence-inspection.docker-executable}") docker: String,
        @Value("\${occ.evidence-inspection.scanner-image}") image: String,
    ): ProcessScannerSandbox = ProcessScannerSandbox(scannerConfiguration(Path.of(docker), image), clock)

    @Bean
    fun evidenceContentInspector(scanner: ScannerSandbox, parser: ParserSandbox, clock: Clock) =
        EvidenceContentInspector(scanner, parser, clock)

    private fun parserConfiguration(docker: Path, image: String) = ProcessParserSandboxConfiguration(
        docker,
        listOf(
            "run", "--rm", "--network=none", "--memory=134217728", "--pids-limit=64", "--read-only",
            "--security-opt=no-new-privileges", "--cap-drop=ALL",
            "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=33554432", ProcessParserSandbox.INPUT_MOUNT_PLACEHOLDER, image,
        ),
        Duration.ofMinutes(2), 16 * 1024, 4 * 1024, 128L * 1024 * 1024, 64, 32L * 1024 * 1024,
    )

    private fun scannerConfiguration(docker: Path, image: String) = ProcessScannerSandboxConfiguration(
        docker,
        listOf(
            "run", "--rm", "--network=none", "--memory=134217728", "--pids-limit=64", "--read-only",
            "--security-opt=no-new-privileges", "--cap-drop=ALL",
            "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=33554432",
            ProcessScannerSandboxConfiguration.INPUT_MOUNT_PLACEHOLDER, image,
        ),
        Duration.ofMinutes(2), 16 * 1024, 4 * 1024, 128L * 1024 * 1024, 64, 32L * 1024 * 1024, 4, 16,
    )
}
