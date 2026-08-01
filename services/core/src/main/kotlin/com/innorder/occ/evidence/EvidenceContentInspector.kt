package com.innorder.occ.evidence

import org.xml.sax.InputSource
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStreamReader
import java.io.StringReader
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.zip.ZipException
import java.util.zip.ZipFile
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory

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
    MALWARE_DETECTED,
    SCANNER_ERROR,
}

class EvidenceRejectedException(
    val code: EvidenceRejectionCode,
    cause: Throwable? = null,
) : RuntimeException(code.name, cause)

class EvidenceContentInspector(
    private val malwareScanner: MalwareScanner,
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
            observation.magic.startsWith(PDF_MAGIC) -> inspectPdf(observation)
            observation.magic.isZipMagic() -> inspectArchive(request)
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

        val scanRequest = ScanRequest(request.path, observation.sizeBytes, observation.sha256, mediaType, request.deadline)
        val scanResult = scanWithDeadline(scanRequest)
        when (scanResult) {
            ScanResult.CLEAN -> Unit
            ScanResult.INFECTED -> reject(EvidenceRejectionCode.MALWARE_DETECTED)
            ScanResult.ERROR -> reject(EvidenceRejectionCode.SCANNER_ERROR)
        }
        return InspectedEvidence(observation.sha256, observation.sizeBytes, mediaType, extension, scanResult)
    }

    private fun observe(request: InspectionRequest): Observation {
        val digest = MessageDigest.getInstance("SHA-256")
        var size = 0L
        var magic = ByteArray(0)
        var tail = ByteArray(0)
        var sawPdf = false
        var sawZip = false
        var sawUnsupportedSignature = false
        var pdfEncrypted = false
        var pdfActive = false
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
                    sawZip = sawZip || ZIP_SIGNATURES.any { text.contains(it) }
                    sawUnsupportedSignature = sawUnsupportedSignature || UNSUPPORTED_SIGNATURES.any { text.contains(it) }
                    pdfEncrypted = pdfEncrypted || PDF_ENCRYPTED_MARKERS.any(text::contains)
                    pdfActive = pdfActive || PDF_ACTIVE_MARKERS.any(text::contains)
                    tail = window.takeLastBytes(SCAN_OVERLAP)
                }
            }
        } catch (rejected: EvidenceRejectedException) {
            throw rejected
        } catch (failure: IOException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.CONTENT_READ_ERROR, failure)
        }
        return Observation(
            size,
            digest.digest().toHex(),
            magic,
            sawPdf,
            sawZip,
            sawUnsupportedSignature,
            pdfEncrypted,
            pdfActive,
        )
    }

    private fun inspectPdf(observation: Observation): String {
        if (observation.pdfEncrypted) reject(EvidenceRejectionCode.PDF_ENCRYPTED)
        if (observation.pdfActive) reject(EvidenceRejectionCode.PDF_ACTIVE_CONTENT)
        return "application/pdf"
    }

    private fun inspectArchive(request: InspectionRequest): String {
        if (observeArchiveFlags(request.path, request.deadline)) {
            reject(if (request.fileName.substringAfterLast('.', "") in OOXML_EXTENSIONS) EvidenceRejectionCode.OOXML_ENCRYPTED else EvidenceRejectionCode.ARCHIVE_ENCRYPTED)
        }
        validateZipEnd(request.path, request.deadline, request.policy.archiveLimits.maximumEntries)
        val names = HashSet<String>()
        var expandedBytes = 0L
        var compressedBytes = 0L
        var contentTypes: ByteArray? = null
        var officeRoot: String? = null
        try {
            ZipFile(request.path.toFile(), ZipFile.OPEN_READ, StandardCharsets.UTF_8).use { archive ->
                val entries = archive.entries()
                var entryCount = 0
                while (entries.hasMoreElements()) {
                    val entry = entries.nextElement()
                    entryCount++
                    if (entryCount > request.policy.archiveLimits.maximumEntries) reject(EvidenceRejectionCode.ARCHIVE_ENTRY_LIMIT)
                    checkDeadline(request.deadline)
                    validateEntryName(entry.name)
                    if (!names.add(entry.name)) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                    if (entry.isDirectory) continue
                    val compressed = entry.compressedSize
                    if (compressed < 0) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                    compressedBytes = addBounded(compressedBytes, compressed, EvidenceRejectionCode.ARCHIVE_COMPRESSION_RATIO_LIMIT)
                    val captureXml = entry.name == CONTENT_TYPES || entry.name.endsWith(".rels")
                    val captured = if (captureXml) ByteArrayOutputStream() else null
                    var entryBytes = 0L
                    var firstBytes = ByteArray(0)
                    archive.getInputStream(entry).buffered().use { input ->
                        val buffer = ByteArray(BUFFER_SIZE)
                        while (true) {
                            checkDeadline(request.deadline)
                            val count = input.read(buffer)
                            if (count < 0) break
                            entryBytes += count
                            expandedBytes += count
                            if (expandedBytes > request.policy.archiveLimits.maximumExpandedBytes) {
                                reject(EvidenceRejectionCode.ARCHIVE_EXPANDED_SIZE_LIMIT)
                            }
                            if (ratio(entryBytes, compressed) > request.policy.archiveLimits.maximumCompressionRatio ||
                                ratio(expandedBytes, compressedBytes) > request.policy.archiveLimits.maximumCompressionRatio
                            ) reject(EvidenceRejectionCode.ARCHIVE_COMPRESSION_RATIO_LIMIT)
                            if (firstBytes.size < MAGIC_BYTES) {
                                val needed = minOf(MAGIC_BYTES - firstBytes.size, count)
                                firstBytes += buffer.copyOfRange(0, needed)
                            }
                            if (captured != null) {
                                if (captured.size() + count > MAXIMUM_XML_BYTES) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                                captured.write(buffer, 0, count)
                            }
                        }
                    }
                    if (isNestedArchive(entry.name, firstBytes)) reject(EvidenceRejectionCode.NESTED_ARCHIVE)
                    if (entry.name.endsWith("vbaProject.bin", ignoreCase = true)) reject(EvidenceRejectionCode.OOXML_MACRO)
                    val lowerName = entry.name.lowercase()
                    if (lowerName.endsWith("encryptedpackage") || lowerName.endsWith("encryptioninfo")) {
                        reject(EvidenceRejectionCode.OOXML_ENCRYPTED)
                    }
                    if ("/activex/" in lowerName || "/embeddings/" in lowerName || "/externallinks/" in lowerName) {
                        reject(EvidenceRejectionCode.OOXML_ACTIVE_CONTENT)
                    }
                    captured?.toByteArray()?.let { xml ->
                        if (entry.name == CONTENT_TYPES) contentTypes = xml
                        if (entry.name.endsWith(".rels")) inspectRelationships(xml)
                    }
                }
            }
            contentTypes?.let { officeRoot = inspectContentTypes(it) }
            officeRoot?.let { root ->
                val requiredPart = OOXML_MAIN_PART_BY_ROOT.getValue(root)
                if (requiredPart !in names) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
            }
        } catch (rejected: EvidenceRejectedException) {
            throw rejected
        } catch (failure: ZipException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.MALFORMED_ARCHIVE, failure)
        } catch (failure: IOException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.MALFORMED_ARCHIVE, failure)
        }
        return when (officeRoot) {
            "word" -> OOXML_MEDIA_BY_ROOT.getValue("word")
            "xl" -> OOXML_MEDIA_BY_ROOT.getValue("xl")
            "ppt" -> OOXML_MEDIA_BY_ROOT.getValue("ppt")
            null -> "application/zip"
            else -> reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
        }
    }

    private fun inspectContentTypes(xml: ByteArray): String? {
        val document = parseXml(xml)
        val elements = document.getElementsByTagNameNS("*", "Override")
        var root: String? = null
        for (index in 0 until elements.length) {
            val element = elements.item(index)
            val type = element.attributes?.getNamedItem("ContentType")?.nodeValue ?: continue
            if (type.contains("macroEnabled", ignoreCase = true) || type.contains("vbaProject", ignoreCase = true)) {
                reject(EvidenceRejectionCode.OOXML_MACRO)
            }
            OOXML_MAIN_TYPES[type]?.let { detected ->
                if (root != null && root != detected) reject(EvidenceRejectionCode.POLYGLOT)
                root = detected
            }
        }
        if (root == null && document.documentElement.localName == "Types") reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
        return root
    }

    private fun inspectRelationships(xml: ByteArray) {
        val document = parseXml(xml)
        val relationships = document.getElementsByTagNameNS("*", "Relationship")
        for (index in 0 until relationships.length) {
            val attributes = relationships.item(index).attributes ?: continue
            if (attributes.getNamedItem("TargetMode")?.nodeValue.equals("External", ignoreCase = true)) {
                reject(EvidenceRejectionCode.OOXML_ACTIVE_CONTENT)
            }
        }
    }

    private fun parseXml(xml: ByteArray) = try {
        val factory = DocumentBuilderFactory.newInstance()
        factory.isNamespaceAware = true
        factory.isXIncludeAware = false
        factory.isExpandEntityReferences = false
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false)
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false)
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "")
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "")
        factory.newDocumentBuilder().apply { setEntityResolver { _, _ -> InputSource(StringReader("")) } }
            .parse(ByteArrayInputStream(xml))
    } catch (failure: Exception) {
        throw EvidenceRejectedException(EvidenceRejectionCode.MALFORMED_ARCHIVE, failure)
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
    } catch (_: Exception) {
        false
    }

    private fun scanWithDeadline(request: ScanRequest): ScanResult {
        checkDeadline(request.deadline)
        val remaining = Duration.between(clock.instant(), request.deadline).toMillis()
        if (remaining <= 0) reject(EvidenceRejectionCode.DEADLINE_EXCEEDED)
        val executor = Executors.newSingleThreadExecutor { work ->
            Thread(work, "evidence-malware-scan").apply { isDaemon = true }
        }
        return try {
            val result = executor.submit<ScanResult> { malwareScanner.scan(request) }.get(remaining, TimeUnit.MILLISECONDS)
            checkDeadline(request.deadline)
            result ?: reject(EvidenceRejectionCode.SCANNER_ERROR)
        } catch (_: TimeoutException) {
            reject(EvidenceRejectionCode.SCANNER_ERROR)
        } catch (_: ExecutionException) {
            reject(EvidenceRejectionCode.SCANNER_ERROR)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            reject(EvidenceRejectionCode.SCANNER_ERROR)
        } finally {
            executor.shutdownNow()
        }
    }

    private fun validateEntryName(name: String) {
        val normalized = name.replace('\\', '/')
        val withoutDirectorySuffix = normalized.removeSuffix("/")
        if (withoutDirectorySuffix.isBlank() || normalized.startsWith('/') || DRIVE_PATH.matches(normalized) ||
            withoutDirectorySuffix.split('/').any { it == ".." || it == "." || it.isEmpty() }
        ) reject(EvidenceRejectionCode.ARCHIVE_TRAVERSAL)
    }

    private fun isNestedArchive(name: String, firstBytes: ByteArray): Boolean =
        name.substringAfterLast('.', "").lowercase() in ARCHIVE_EXTENSIONS ||
            firstBytes.startsWith(ZIP_MAGIC) || firstBytes.startsWith(OLE_MAGIC)

    private fun observeArchiveFlags(path: Path, deadline: Instant): Boolean {
        try {
            var tail = ByteArray(0)
            Files.newInputStream(path).buffered().use { input ->
                val buffer = ByteArray(BUFFER_SIZE)
                while (true) {
                    checkDeadline(deadline)
                    val count = input.read(buffer)
                    if (count < 0) return false
                    val window = tail + buffer.copyOfRange(0, count)
                    if (hasEncryptedZipHeader(window)) return true
                    tail = window.takeLastBytes(8)
                }
            }
        } catch (rejected: EvidenceRejectedException) {
            throw rejected
        } catch (failure: IOException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.CONTENT_READ_ERROR, failure)
        }
    }

    private fun validateZipEnd(path: Path, deadline: Instant, maximumEntries: Int) {
        try {
            Files.newByteChannel(path, StandardOpenOption.READ).use { channel ->
                val fileSize = channel.size()
                val tailSize = minOf(fileSize, MAXIMUM_ZIP_END_BYTES.toLong()).toInt()
                val tail = ByteBuffer.allocate(tailSize)
                channel.position(fileSize - tailSize)
                while (tail.hasRemaining()) {
                    checkDeadline(deadline)
                    if (channel.read(tail) < 0) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                }
                val bytes = tail.array()
                var endIndex = -1
                for (index in bytes.size - ZIP_END_MINIMUM_BYTES downTo 0) {
                    if (bytes.matchesAt(index, ZIP_END_MAGIC)) {
                        endIndex = index
                        break
                    }
                }
                if (endIndex < 0) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                val diskNumber = unsignedShort(bytes, endIndex + 4)
                val centralDirectoryDisk = unsignedShort(bytes, endIndex + 6)
                val entriesOnDisk = unsignedShort(bytes, endIndex + 8)
                val entryCount = unsignedShort(bytes, endIndex + 10)
                if (diskNumber != 0 || centralDirectoryDisk != 0 || entriesOnDisk != entryCount) {
                    reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                }
                if (entryCount > maximumEntries) reject(EvidenceRejectionCode.ARCHIVE_ENTRY_LIMIT)
                val commentLength = (bytes[endIndex + 20].toInt() and 0xff) or ((bytes[endIndex + 21].toInt() and 0xff) shl 8)
                val absoluteEnd = fileSize - tailSize + endIndex + ZIP_END_MINIMUM_BYTES + commentLength
                if (absoluteEnd != fileSize) reject(EvidenceRejectionCode.POLYGLOT)
            }
        } catch (rejected: EvidenceRejectedException) {
            throw rejected
        } catch (failure: IOException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.MALFORMED_ARCHIVE, failure)
        }
    }

    private fun hasEncryptedZipHeader(bytes: ByteArray): Boolean {
        for (index in 0..bytes.size - 8) {
            if (bytes[index] == 0x50.toByte() && bytes[index + 1] == 0x4b.toByte() &&
                bytes[index + 2] == 0x03.toByte() && bytes[index + 3] == 0x04.toByte()
            ) {
                val flags = (bytes[index + 6].toInt() and 0xff) or ((bytes[index + 7].toInt() and 0xff) shl 8)
                if (flags and 1 != 0) return true
            }
        }
        return false
    }

    private fun ratio(expanded: Long, compressed: Long): Double = when {
        expanded == 0L -> 0.0
        compressed <= 0L -> Double.POSITIVE_INFINITY
        else -> expanded.toDouble() / compressed.toDouble()
    }

    private fun addBounded(current: Long, value: Long, code: EvidenceRejectionCode): Long {
        if (value > Long.MAX_VALUE - current) reject(code)
        return current + value
    }

    private fun unsignedShort(bytes: ByteArray, offset: Int): Int =
        (bytes[offset].toInt() and 0xff) or ((bytes[offset + 1].toInt() and 0xff) shl 8)

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
        val pdfEncrypted: Boolean,
        val pdfActive: Boolean,
    )

    companion object {
        private const val BUFFER_SIZE = 8 * 1024
        private const val MAGIC_BYTES = 16
        private const val SCAN_OVERLAP = 64
        private const val MAXIMUM_XML_BYTES = 1024 * 1024
        private const val ZIP_END_MINIMUM_BYTES = 22
        private const val MAXIMUM_ZIP_END_BYTES = ZIP_END_MINIMUM_BYTES + 65_535
        private const val CONTENT_TYPES = "[Content_Types].xml"
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
        private val PDF_ENCRYPTED_MARKERS = listOf("/Encrypt")
        private val PDF_ACTIVE_MARKERS = listOf(
            "/EmbeddedFile", "/Filespec", "/OpenAction", "/AA", "/JavaScript", "/JS", "/Launch",
            "/RichMedia", "/URI", "/AcroForm", "/SubmitForm", "/ImportData", "/GoToR", "/Sound", "/Movie",
        )
        private val OOXML_EXTENSIONS = setOf("docx", "xlsx", "pptx")
        private val ARCHIVE_EXTENSIONS = setOf("zip", "jar", "docx", "xlsx", "pptx", "odt", "ods", "odp", "7z", "rar", "gz", "tar")
        private val DRIVE_PATH = Regex("^[A-Za-z]:.*")
        private val OOXML_MAIN_TYPES = mapOf(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" to "word",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" to "xl",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml" to "ppt",
        )
        private val OOXML_MEDIA_BY_ROOT = mapOf(
            "word" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xl" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "ppt" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        )
        private val OOXML_MAIN_PART_BY_ROOT = mapOf(
            "word" to "word/document.xml",
            "xl" to "xl/workbook.xml",
            "ppt" to "ppt/presentation.xml",
        )

        private fun ByteArray.startsWith(prefix: ByteArray): Boolean =
            size >= prefix.size && prefix.indices.all { this[it] == prefix[it] }

        private fun ByteArray.isZipMagic(): Boolean = startsWith(ZIP_MAGIC) || startsWith(ZIP_END_MAGIC)

        private fun ByteArray.hasUnsupportedMagic(): Boolean = UNSUPPORTED_SIGNATURE_BYTES.any { startsWith(it) }

        private fun ByteArray.matchesAt(offset: Int, expected: ByteArray): Boolean =
            offset >= 0 && size - offset >= expected.size && expected.indices.all { this[offset + it] == expected[it] }

        private fun ByteArray.takeLastBytes(count: Int): ByteArray =
            copyOfRange(maxOf(0, size - count), size)

        private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
    }
}
