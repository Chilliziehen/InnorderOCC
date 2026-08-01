package com.innorder.occ.evidence

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStreamReader
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
import javax.xml.stream.XMLInputFactory
import javax.xml.stream.XMLStreamConstants
import javax.xml.stream.XMLStreamException

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
            observation.magic.startsWith(PDF_MAGIC) -> inspectPdf(request)
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
        when (scanResult.status) {
            ScanStatus.CLEAN -> Unit
            ScanStatus.INFECTED -> reject(EvidenceRejectionCode.MALWARE_DETECTED)
            ScanStatus.ERROR -> reject(EvidenceRejectionCode.SCANNER_ERROR)
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
        )
    }

    private fun inspectPdf(request: InspectionRequest): String {
        runWithDeadline(request.deadline, EvidenceRejectionCode.DEADLINE_EXCEEDED) {
            PdfContentValidator(request.policy) { checkDeadline(request.deadline) }.validate(request.path)
        }
        return "application/pdf"
    }

    private fun inspectArchive(request: InspectionRequest): String {
        if (observeArchiveFlags(request.path, request.deadline)) {
            reject(if (request.fileName.substringAfterLast('.', "") in OOXML_EXTENSIONS) EvidenceRejectionCode.OOXML_ENCRYPTED else EvidenceRejectionCode.ARCHIVE_ENCRYPTED)
        }
        validateZipStructure(request.path, request.deadline, request.policy.archiveLimits)
        val names = HashSet<String>()
        var expandedBytes = 0L
        var compressedBytes = 0L
        val xmlParts = HashMap<String, ByteArray>()
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
                    val captureXml = entry.name == CONTENT_TYPES || entry.name.endsWith(".rels") || entry.name in OOXML_MAIN_PART_BY_ROOT.values
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
                            if (firstBytes.size < ARCHIVE_MAGIC_BYTES) {
                                val needed = minOf(ARCHIVE_MAGIC_BYTES - firstBytes.size, count)
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
                        xmlParts[entry.name] = xml
                    }
                }
            }
            xmlParts[CONTENT_TYPES]?.let { officeRoot = inspectContentTypes(it, request.deadline) }
            officeRoot?.let { root ->
                val requiredPart = OOXML_MAIN_PART_BY_ROOT.getValue(root)
                if (requiredPart !in names) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                validateXml(xmlParts[requiredPart] ?: reject(EvidenceRejectionCode.MALFORMED_ARCHIVE), request.deadline)
                val rootRelationships = xmlParts[ROOT_RELATIONSHIPS]
                    ?: reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                val relationships = inspectRelationships(rootRelationships, request.deadline)
                val officeRelationships = relationships.filter { it.type.endsWith("/officeDocument") }
                if (officeRelationships.size != 1 || normalizeRelationshipTarget(officeRelationships.single().target) != requiredPart) {
                    reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                }
                xmlParts.filterKeys { it.endsWith(".rels") && it != ROOT_RELATIONSHIPS }
                    .values.forEach { inspectRelationships(it, request.deadline) }
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

    private fun inspectContentTypes(xml: ByteArray, deadline: Instant): String? {
        var root: String? = null
        val rootElement = parseXml(xml, deadline) { name, attributes ->
            if (name == "Override") {
                val type = attributes["ContentType"] ?: reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                if (type.contains("macroEnabled", ignoreCase = true) || type.contains("vbaProject", ignoreCase = true)) {
                    reject(EvidenceRejectionCode.OOXML_MACRO)
                }
                OOXML_MAIN_TYPES[type]?.let { detected ->
                    val partName = attributes["PartName"]?.removePrefix("/")
                    if (partName != OOXML_MAIN_PART_BY_ROOT.getValue(detected)) {
                        reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                    }
                    if (root != null && root != detected) reject(EvidenceRejectionCode.POLYGLOT)
                    root = detected
                }
            }
        }
        if (rootElement != "Types" || root == null) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
        return root
    }

    private fun inspectRelationships(xml: ByteArray, deadline: Instant): List<PackageRelationship> {
        val relationships = mutableListOf<PackageRelationship>()
        val rootElement = parseXml(xml, deadline) { name, attributes ->
            if (name == "Relationship") {
                val target = attributes["Target"] ?: reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                if (attributes["TargetMode"].equals("External", ignoreCase = true) || isExternalRelationshipTarget(target)) {
                    reject(EvidenceRejectionCode.OOXML_ACTIVE_CONTENT)
                }
                relationships += PackageRelationship(
                    type = attributes["Type"] ?: reject(EvidenceRejectionCode.MALFORMED_ARCHIVE),
                    target = target,
                )
            }
        }
        if (rootElement != "Relationships") reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
        return relationships
    }

    private fun validateXml(xml: ByteArray, deadline: Instant) {
        parseXml(xml, deadline) { _, _ -> }
    }

    private fun parseXml(
        xml: ByteArray,
        deadline: Instant,
        onStartElement: (String, Map<String, String>) -> Unit,
    ): String {
        try {
            checkDeadline(deadline)
            val factory = XMLInputFactory.newFactory().apply {
                setProperty(XMLInputFactory.SUPPORT_DTD, false)
                setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false)
                setProperty(XMLInputFactory.IS_REPLACING_ENTITY_REFERENCES, false)
                setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "")
                setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "")
            }
            val reader = factory.createXMLStreamReader(xml.inputStream(), StandardCharsets.UTF_8.name())
            var depth = 0
            var events = 0
            var textCharacters = 0L
            var rootElement: String? = null
            try {
                while (reader.hasNext()) {
                    checkDeadline(deadline)
                    events++
                    if (events > MAXIMUM_XML_EVENTS) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                    when (reader.next()) {
                        XMLStreamConstants.START_ELEMENT -> {
                            depth++
                            if (depth > MAXIMUM_XML_DEPTH || reader.attributeCount > MAXIMUM_XML_ATTRIBUTES) {
                                reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                            }
                            if (rootElement == null) rootElement = reader.localName
                            val attributes = buildMap {
                                for (index in 0 until reader.attributeCount) put(reader.getAttributeLocalName(index), reader.getAttributeValue(index))
                            }
                            onStartElement(reader.localName, attributes)
                        }
                        XMLStreamConstants.END_ELEMENT -> depth--
                        XMLStreamConstants.CHARACTERS, XMLStreamConstants.CDATA -> {
                            textCharacters += reader.textLength
                            if (textCharacters > MAXIMUM_XML_TEXT_CHARACTERS) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                        }
                        XMLStreamConstants.DTD, XMLStreamConstants.ENTITY_REFERENCE -> reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                    }
                }
            } finally {
                reader.close()
            }
            checkDeadline(deadline)
            return rootElement ?: reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
        } catch (rejected: EvidenceRejectedException) {
            throw rejected
        } catch (failure: XMLStreamException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.MALFORMED_ARCHIVE, failure)
        } catch (failure: IllegalArgumentException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.MALFORMED_ARCHIVE, failure)
        }
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
        return runWithDeadline(request.deadline, EvidenceRejectionCode.SCANNER_ERROR, propagateRejection = false) {
            malwareScanner.scan(request)
        }
    }

    private fun <T> runWithDeadline(
        deadline: Instant,
        timeoutCode: EvidenceRejectionCode,
        propagateRejection: Boolean = true,
        action: () -> T,
    ): T {
        checkDeadline(deadline)
        val remaining = Duration.between(clock.instant(), deadline).toMillis()
        if (remaining <= 0) reject(EvidenceRejectionCode.DEADLINE_EXCEEDED)
        val executor = Executors.newSingleThreadExecutor { work -> Thread(work, "evidence-hostile-parser").apply { isDaemon = true } }
        return try {
            executor.submit<T> { action() }.get(remaining, TimeUnit.MILLISECONDS) ?: reject(timeoutCode)
        } catch (failure: ExecutionException) {
            val cause = failure.cause
            if (propagateRejection && cause is EvidenceRejectedException) throw cause
            reject(timeoutCode)
        } catch (_: TimeoutException) {
            reject(timeoutCode)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            reject(timeoutCode)
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
            NESTED_ARCHIVE_MAGICS.any { firstBytes.startsWith(it) } || firstBytes.isTarArchive()

    private fun normalizeRelationshipTarget(target: String): String {
        val normalized = target.replace('\\', '/').removePrefix("/")
        if (normalized.isBlank() || ':' in normalized || normalized.split('/').any { it == ".." || it == "." || it.isEmpty() }) {
            reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
        }
        return normalized
    }

    private fun isExternalRelationshipTarget(target: String): Boolean = try {
        target.startsWith("//") || java.net.URI(target).isAbsolute
    } catch (failure: java.net.URISyntaxException) {
        throw EvidenceRejectedException(EvidenceRejectionCode.MALFORMED_ARCHIVE, failure)
    }

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

    private fun validateZipStructure(path: Path, deadline: Instant, limits: ArchiveLimits) {
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
                if (entryCount > limits.maximumEntries) reject(EvidenceRejectionCode.ARCHIVE_ENTRY_LIMIT)
                val commentLength = (bytes[endIndex + 20].toInt() and 0xff) or ((bytes[endIndex + 21].toInt() and 0xff) shl 8)
                val absoluteEndIndex = fileSize - tailSize + endIndex
                val absoluteEnd = absoluteEndIndex + ZIP_END_MINIMUM_BYTES + commentLength
                if (absoluteEnd != fileSize) reject(EvidenceRejectionCode.POLYGLOT)
                val centralSize = unsignedInt(bytes, endIndex + 12)
                val centralOffset = unsignedInt(bytes, endIndex + 16)
                if (centralOffset > absoluteEndIndex || centralSize > absoluteEndIndex - centralOffset ||
                    centralOffset + centralSize != absoluteEndIndex
                ) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                inspectCentralDirectory(channel, centralOffset, centralSize, entryCount, limits, deadline)
            }
        } catch (rejected: EvidenceRejectedException) {
            throw rejected
        } catch (failure: IOException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.MALFORMED_ARCHIVE, failure)
        }
    }

    private fun inspectCentralDirectory(
        channel: java.nio.channels.SeekableByteChannel,
        offset: Long,
        size: Long,
        expectedEntries: Int,
        limits: ArchiveLimits,
        deadline: Instant,
    ) {
        channel.position(offset)
        var remaining = size
        var entries = 0
        var expandedBytes = 0L
        var compressedBytes = 0L
        while (remaining > 0) {
            checkDeadline(deadline)
            if (remaining < ZIP_CENTRAL_HEADER_BYTES) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
            val fixed = readExactly(channel, ZIP_CENTRAL_HEADER_BYTES, deadline)
            remaining -= ZIP_CENTRAL_HEADER_BYTES
            if (!fixed.matchesAt(0, ZIP_CENTRAL_MAGIC)) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
            val flags = unsignedShort(fixed, 8)
            if (flags and 1 != 0) reject(EvidenceRejectionCode.ARCHIVE_ENCRYPTED)
            val compressed = unsignedInt(fixed, 20)
            val expanded = unsignedInt(fixed, 24)
            if (compressed == ZIP64_SENTINEL || expanded == ZIP64_SENTINEL) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
            val nameLength = unsignedShort(fixed, 28)
            val extraLength = unsignedShort(fixed, 30)
            val commentLength = unsignedShort(fixed, 32)
            val variableLength = nameLength.toLong() + extraLength + commentLength
            if (variableLength > remaining) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
            val nameBytes = readExactly(channel, nameLength, deadline)
            val charset = if (flags and UTF8_ZIP_FLAG != 0) StandardCharsets.UTF_8 else ZIP_LEGACY_CHARSET
            validateEntryName(String(nameBytes, charset))
            channel.position(channel.position() + extraLength + commentLength)
            remaining -= variableLength
            entries++
            if (entries > limits.maximumEntries) reject(EvidenceRejectionCode.ARCHIVE_ENTRY_LIMIT)
            expandedBytes = addBounded(expandedBytes, expanded, EvidenceRejectionCode.ARCHIVE_EXPANDED_SIZE_LIMIT)
            compressedBytes = addBounded(compressedBytes, compressed, EvidenceRejectionCode.ARCHIVE_COMPRESSION_RATIO_LIMIT)
            if (expandedBytes > limits.maximumExpandedBytes) reject(EvidenceRejectionCode.ARCHIVE_EXPANDED_SIZE_LIMIT)
            if (ratio(expanded, compressed) > limits.maximumCompressionRatio ||
                ratio(expandedBytes, compressedBytes) > limits.maximumCompressionRatio
            ) reject(EvidenceRejectionCode.ARCHIVE_COMPRESSION_RATIO_LIMIT)
        }
        if (entries != expectedEntries) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
    }

    private fun readExactly(
        channel: java.nio.channels.SeekableByteChannel,
        count: Int,
        deadline: Instant,
    ): ByteArray {
        val buffer = ByteBuffer.allocate(count)
        while (buffer.hasRemaining()) {
            checkDeadline(deadline)
            if (channel.read(buffer) < 0) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
        }
        return buffer.array()
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

    private fun unsignedInt(bytes: ByteArray, offset: Int): Long =
        (bytes[offset].toLong() and 0xff) or
            ((bytes[offset + 1].toLong() and 0xff) shl 8) or
            ((bytes[offset + 2].toLong() and 0xff) shl 16) or
            ((bytes[offset + 3].toLong() and 0xff) shl 24)

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

    private data class PackageRelationship(val type: String, val target: String)

    companion object {
        private const val BUFFER_SIZE = 8 * 1024
        private const val MAGIC_BYTES = 16
        private const val ARCHIVE_MAGIC_BYTES = 512
        private const val SCAN_OVERLAP = 64
        private const val MAXIMUM_XML_BYTES = 1024 * 1024
        private const val MAXIMUM_XML_EVENTS = 20_000
        private const val MAXIMUM_XML_DEPTH = 64
        private const val MAXIMUM_XML_ATTRIBUTES = 32
        private const val MAXIMUM_XML_TEXT_CHARACTERS = 1_048_576L
        private const val ZIP_END_MINIMUM_BYTES = 22
        private const val MAXIMUM_ZIP_END_BYTES = ZIP_END_MINIMUM_BYTES + 65_535
        private const val ZIP_CENTRAL_HEADER_BYTES = 46
        private const val UTF8_ZIP_FLAG = 1 shl 11
        private const val ZIP64_SENTINEL = 0xffff_ffffL
        private const val CONTENT_TYPES = "[Content_Types].xml"
        private const val ROOT_RELATIONSHIPS = "_rels/.rels"
        private val PDF_MAGIC = "%PDF-".toByteArray(StandardCharsets.ISO_8859_1)
        private const val PDF_SIGNATURE = "%PDF-"
        private val ZIP_MAGIC = byteArrayOf(0x50, 0x4b, 0x03, 0x04)
        private val ZIP_END_MAGIC = byteArrayOf(0x50, 0x4b, 0x05, 0x06)
        private val ZIP_CENTRAL_MAGIC = byteArrayOf(0x50, 0x4b, 0x01, 0x02)
        private val ZIP_LEGACY_CHARSET = java.nio.charset.Charset.forName("IBM437")
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
        private val NESTED_ARCHIVE_MAGICS = listOf(
            ZIP_MAGIC,
            OLE_MAGIC,
            byteArrayOf(0x1f, 0x8b.toByte()),
            byteArrayOf(0x37, 0x7a, 0xbc.toByte(), 0xaf.toByte(), 0x27, 0x1c),
            "Rar!\u001a\u0007".toByteArray(StandardCharsets.ISO_8859_1),
            byteArrayOf(0xfd.toByte(), 0x37, 0x7a, 0x58, 0x5a, 0x00),
            "BZh".toByteArray(StandardCharsets.ISO_8859_1),
            byteArrayOf(0x28, 0xb5.toByte(), 0x2f, 0xfd.toByte()),
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

        private fun ByteArray.isTarArchive(): Boolean = size >= 262 &&
            copyOfRange(257, 262).contentEquals("ustar".toByteArray(StandardCharsets.ISO_8859_1))

        private fun ByteArray.matchesAt(offset: Int, expected: ByteArray): Boolean =
            offset >= 0 && size - offset >= expected.size && expected.indices.all { this[offset + it] == expected[it] }

        private fun ByteArray.takeLastBytes(count: Int): ByteArray =
            copyOfRange(maxOf(0, size - count), size)

        private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
    }
}
