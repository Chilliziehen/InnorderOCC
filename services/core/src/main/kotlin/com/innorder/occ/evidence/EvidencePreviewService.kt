package com.innorder.occ.evidence

import org.springframework.stereotype.Service
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

@Service
class EvidencePreviewService {
    fun generate(path: Path, mediaType: String): String? {
        if (mediaType !in setOf("text/plain", "text/markdown")) return null
        val bytes = Files.newInputStream(path).use { it.readNBytes(MAX_PREVIEW_BYTES + 1) }
        if (bytes.size > MAX_PREVIEW_BYTES) return null
        val text = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(java.nio.ByteBuffer.wrap(bytes)).toString()
        return text.map { character ->
            when {
                character == '\n' || character == '\r' || character == '\t' -> character
                character.isISOControl() -> '\uFFFD'
                else -> character
            }
        }.joinToString("")
    }

    companion object { const val MAX_PREVIEW_BYTES = 64 * 1024 }
}
