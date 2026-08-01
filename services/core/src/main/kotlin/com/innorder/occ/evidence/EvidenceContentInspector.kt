package com.innorder.occ.evidence

import java.io.IOException
import java.io.InputStreamReader
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

data class InspectionRequest(
    val path: Path,
    val fileName: String,
    val expectedSha256: String,
    val expectedSizeBytes: Long,
    val policy: EvidencePolicy,
    val deadline: Instant,
) {
    init {
        require(HASH.matches(expectedSha256))
        require(expectedSizeBytes >= 0)
        require(fileName.length in 1..255 && '/' !in fileName && '\\' !in fileName)
    }

    companion object {
        private val HASH = Regex("^[0-9a-f]{64}$")
    }
}

data class InspectedEvidence(
    val sha256: String,
    val sizeBytes: Long,
    val detectedMediaType: String,
    val extension: String,
    val scannerResult: ScanResult,
)

enum class EvidenceRejectionCode {
    DEADLINE_EXCEEDED,
    CONTENT_READ_ERROR,
    FILE_TOO_LARGE,
    SIZE_MISMATCH,
    HASH_MISMATCH,
    EXTENSION_NOT_ALLOWED,
    MEDIA_TYPE_NOT_ALLOWED,
    EXTENSION_MEDIA_MISMATCH,
    UNSUPPORTED_SIGNATURE,
    POLYGLOT,
    PDF_ENCRYPTED,
    PDF_ACTIVE_CONTENT,
    MALFORMED_PDF,
    ARCHIVE_ENCRYPTED,
    ARCHIVE_TRAVERSAL,
    NESTED_ARCHIVE,
    MALFORMED_ARCHIVE,
    ARCHIVE_ENTRY_LIMIT,
    ARCHIVE_EXPANDED_SIZE_LIMIT,
    ARCHIVE_COMPRESSION_RATIO_LIMIT,
    OOXML_MACRO,
    OOXML_ENCRYPTED,
    OOXML_ACTIVE_CONTENT,
    PARSER_SANDBOX_ERROR,
    MALWARE_DETECTED,
    SCANNER_ERROR,
}

class EvidenceRejectedException(
    val code: EvidenceRejectionCode,
    cause: Throwable? = null,
) : RuntimeException(code.name, cause)

class EvidenceContentInspector(
    private val malwareScanner: MalwareScanner,
    private val parserSandbox: ParserSandbox,
    private val clock: Clock = Clock.systemUTC(),
) {
    fun inspect(request: InspectionRequest): InspectedEvidence {
        checkDeadline(request.deadline)
        if (!Files.isRegularFile(request.path, LinkOption.NOFOLLOW_LINKS)) reject(EvidenceRejectionCode.CONTENT_READ_ERROR)
        val extension = request.fileName.substringAfterLast('.', "")
        val observation = observe(request)
        if (observation.sizeBytes != request.expectedSizeBytes) reject(EvidenceRejectionCode.SIZE_MISMATCH)
        if (observation.sha256 != request.expectedSha256) reject(EvidenceRejectionCode.HASH_MISMATCH)
        if (observation.magic.startsWith(PDF_MAGIC) && (observation.sawZip || observation.sawUnsupportedSignature) ||
            observation.magic.hasUnsupportedMagic() && (observation.sawPdf || observation.sawZip)
        ) reject(EvidenceRejectionCode.POLYGLOT)

        val mediaType = when {
            observation.magic.startsWith(PDF_MAGIC) -> inspectInSandbox(request, ParserFormat.PDF)
            observation.magic.isZipMagic() -> inspectInSandbox(request, ParserFormat.ZIP)
            observation.magic.startsWith(OLE_MAGIC) && extension in OOXML_EXTENSIONS -> reject(EvidenceRejectionCode.OOXML_ENCRYPTED)
            observation.magic.startsWith(OLE_MAGIC) -> reject(EvidenceRejectionCode.UNSUPPORTED_SIGNATURE)
            observation.magic.hasUnsupportedMagic() -> reject(EvidenceRejectionCode.UNSUPPORTED_SIGNATURE)
            isUtf8Text(request.path, request.deadline) -> {
                if (extension !in request.policy.allowedExtensions) reject(EvidenceRejectionCode.EXTENSION_NOT_ALLOWED)
                EvidencePolicy.MEDIA_BY_EXTENSION[extension]
                    ?.takeIf { extension == "txt" || extension == "md" }
                    ?: reject(EvidenceRejectionCode.EXTENSION_MEDIA_MISMATCH)
            }
            else -> reject(EvidenceRejectionCode.UNSUPPORTED_SIGNATURE)
        }
        if (extension !in request.policy.allowedExtensions) reject(EvidenceRejectionCode.EXTENSION_NOT_ALLOWED)
        if (mediaType !in request.policy.allowedMediaTypes) reject(EvidenceRejectionCode.MEDIA_TYPE_NOT_ALLOWED)
        if (EvidencePolicy.MEDIA_BY_EXTENSION[extension] != mediaType) reject(EvidenceRejectionCode.EXTENSION_MEDIA_MISMATCH)

        val scanResult = scanWithDeadline(
            ScanRequest(request.path, observation.sizeBytes, observation.sha256, mediaType, request.deadline),
        )
        when (scanResult.status) {
            ScanStatus.CLEAN -> Unit
            ScanStatus.INFECTED -> reject(EvidenceRejectionCode.MALWARE_DETECTED)
            ScanStatus.ERROR -> reject(EvidenceRejectionCode.SCANNER_ERROR)
        }
        return InspectedEvidence(observation.sha256, observation.sizeBytes, mediaType, extension, scanResult)
    }

    private fun inspectInSandbox(request: InspectionRequest, format: ParserFormat): String =
        when (
            val result = parserSandbox.inspect(
                ParserSandboxRequest(request.path, request.fileName, format, request.policy, request.deadline),
            )
        ) {
            is ParserSandboxResult.Accepted -> result.detectedMediaType
            is ParserSandboxResult.Rejected -> reject(result.code)
        }

    private fun observe(request: InspectionRequest): Observation {
        val digest = MessageDigest.getInstance("SHA-256")
        var size = 0L
        var magic = ByteArray(0)
        var tail = ByteArray(0)
        var sawPdf = false
        var sawZip = false
        var sawUnsupportedSignature = false
        try {
            Files.newInputStream(request.path).buffered().use { input ->
                val buffer = ByteArray(BUFFER_SIZE)
                while (true) {
                    checkDeadline(request.deadline)
                    val count = input.read(buffer)
                    if (count < 0) break
                    size += count
                    if (size > request.policy.maximumBytes) reject(EvidenceRejectionCode.FILE_TOO_LARGE)
                    if (size > request.expectedSizeBytes) reject(EvidenceRejectionCode.SIZE_MISMATCH)
                    digest.update(buffer, 0, count)
                    if (magic.size < MAGIC_BYTES) {
                        val needed = minOf(MAGIC_BYTES - magic.size, count)
                        magic += buffer.copyOfRange(0, needed)
                    }
                    val window = tail + buffer.copyOfRange(0, count)
                    val text = String(window, StandardCharsets.ISO_8859_1)
                    sawPdf = sawPdf || text.contains(PDF_SIGNATURE)
                    sawZip = sawZip || ZIP_SIGNATURES.any(text::contains)
                    sawUnsupportedSignature = sawUnsupportedSignature || UNSUPPORTED_SIGNATURES.any(text::contains)
                    tail = window.takeLastBytes(SCAN_OVERLAP)
                }
            }
        } catch (rejected: EvidenceRejectedException) {
            throw rejected
        } catch (failure: IOException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.CONTENT_READ_ERROR, failure)
        }
        return Observation(size, digest.digest().toHex(), magic, sawPdf, sawZip, sawUnsupportedSignature)
    }

    private fun isUtf8Text(path: Path, deadline: Instant): Boolean = try {
        val decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        InputStreamReader(Files.newInputStream(path).buffered(), decoder).use { reader ->
            val characters = CharArray(BUFFER_SIZE)
            while (true) {
                checkDeadline(deadline)
                val count = reader.read(characters)
                if (count < 0) break
                if ((0 until count).any { characters[it] == '\u0000' }) return false
            }
        }
        true
    } catch (rejected: EvidenceRejectedException) {
        throw rejected
    } catch (_: IOException) {
        false
    }

    private fun scanWithDeadline(request: ScanRequest): ScanResult {
        checkDeadline(request.deadline)
        val remaining = Duration.between(clock.instant(), request.deadline).toMillis()
        if (remaining <= 0) reject(EvidenceRejectionCode.DEADLINE_EXCEEDED)
        val executor = Executors.newSingleThreadExecutor { work -> Thread(work, "evidence-malware-scan").apply { isDaemon = true } }
        return try {
            executor.submit<ScanResult> { malwareScanner.scan(request) }.get(remaining, TimeUnit.MILLISECONDS)
                ?: reject(EvidenceRejectionCode.SCANNER_ERROR)
        } catch (_: ExecutionException) {
            reject(EvidenceRejectionCode.SCANNER_ERROR)
        } catch (_: TimeoutException) {
            reject(EvidenceRejectionCode.SCANNER_ERROR)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            reject(EvidenceRejectionCode.SCANNER_ERROR)
        } finally {
            executor.shutdownNow()
        }
    }

    private fun checkDeadline(deadline: Instant) {
        if (!clock.instant().isBefore(deadline)) reject(EvidenceRejectionCode.DEADLINE_EXCEEDED)
    }

    private fun reject(code: EvidenceRejectionCode): Nothing = throw EvidenceRejectedException(code)

    private data class Observation(
        val sizeBytes: Long,
        val sha256: String,
        val magic: ByteArray,
        val sawPdf: Boolean,
        val sawZip: Boolean,
        val sawUnsupportedSignature: Boolean,
    )

    companion object {
        private const val BUFFER_SIZE = 8 * 1024
        private const val MAGIC_BYTES = 16
        private const val SCAN_OVERLAP = 64
        private val PDF_MAGIC = "%PDF-".toByteArray(StandardCharsets.ISO_8859_1)
        private const val PDF_SIGNATURE = "%PDF-"
        private val ZIP_MAGIC = byteArrayOf(0x50, 0x4b, 0x03, 0x04)
        private val ZIP_END_MAGIC = byteArrayOf(0x50, 0x4b, 0x05, 0x06)
        private val ZIP_SIGNATURES = listOf("PK\u0003\u0004", "PK\u0005\u0006", "PK\u0007\u0008")
        private val UNSUPPORTED_SIGNATURE_BYTES = listOf(
            byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
            "GIF87a".toByteArray(StandardCharsets.ISO_8859_1),
            "GIF89a".toByteArray(StandardCharsets.ISO_8859_1),
            byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte()),
            byteArrayOf(0x1f, 0x8b.toByte()),
            "Rar!\u001a\u0007".toByteArray(StandardCharsets.ISO_8859_1),
            byteArrayOf(0x37, 0x7a, 0xbc.toByte(), 0xaf.toByte(), 0x27, 0x1c),
            byteArrayOf(0x7f, 0x45, 0x4c, 0x46),
            byteArrayOf(0x4d, 0x5a),
        )
        private val UNSUPPORTED_SIGNATURES = UNSUPPORTED_SIGNATURE_BYTES.map { String(it, StandardCharsets.ISO_8859_1) }
        private val OLE_MAGIC = byteArrayOf(0xd0.toByte(), 0xcf.toByte(), 0x11, 0xe0.toByte(), 0xa1.toByte(), 0xb1.toByte(), 0x1a, 0xe1.toByte())
        private val OOXML_EXTENSIONS = setOf("docx", "xlsx", "pptx")

        private fun ByteArray.startsWith(prefix: ByteArray): Boolean = size >= prefix.size && prefix.indices.all { this[it] == prefix[it] }
        private fun ByteArray.isZipMagic(): Boolean = startsWith(ZIP_MAGIC) || startsWith(ZIP_END_MAGIC)
        private fun ByteArray.hasUnsupportedMagic(): Boolean = UNSUPPORTED_SIGNATURE_BYTES.any { startsWith(it) }
        private fun ByteArray.takeLastBytes(count: Int): ByteArray = copyOfRange(maxOf(0, size - count), size)
        private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
    }
}
