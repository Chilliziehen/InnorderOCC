package com.innorder.occ.evidence

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.nio.file.Files

class EvidencePreviewServiceTest {
    private val previews = EvidencePreviewService()

    @Test
    fun `only bounded UTF8 text and markdown produce sanitized preview bytes`() {
        val path = Files.createTempFile("evidence-preview", ".txt")
        try {
            Files.write(path, "safe\u0000\ntext".toByteArray())
            assertThat(previews.generate(path, "text/plain")?.toString(Charsets.UTF_8))
                .isEqualTo("safe\uFFFD\ntext")
            assertThat(previews.generate(path, "application/pdf")).isNull()
            Files.write(path, byteArrayOf(0xc3.toByte(), 0x28))
            assertThat(previews.generate(path, "text/markdown")).isNull()
            Files.write(path, ByteArray(EvidencePreviewService.MAX_PREVIEW_BYTES))
            assertThat(previews.generate(path, "text/plain")).isNull()
        } finally {
            Files.deleteIfExists(path)
        }
    }
}
