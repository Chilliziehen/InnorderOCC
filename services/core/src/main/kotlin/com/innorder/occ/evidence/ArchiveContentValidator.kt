package com.innorder.occ.evidence

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardOpenOption
import java.time.Clock
import java.time.Instant
import java.util.zip.ZipException
import java.util.zip.ZipFile
import javax.xml.XMLConstants
import javax.xml.stream.XMLInputFactory
import javax.xml.stream.XMLStreamConstants
import javax.xml.stream.XMLStreamException

internal class ArchiveContentValidator(private val clock: Clock) {
    fun validate(request: ParserSandboxRequest): String {
        if (observeEncryptedLocalHeader(request.path, request.deadline)) {
            reject(if (request.fileName.substringAfterLast('.', "") in OOXML_EXTENSIONS) EvidenceRejectionCode.OOXML_ENCRYPTED else EvidenceRejectionCode.ARCHIVE_ENCRYPTED)
        }
        validateCentralDirectory(request)
        val names = HashSet<String>()
        val xmlParts = HashMap<String, ByteArray>()
        var expandedBytes = 0L
        var compressedBytes = 0L
        var officeRoot: String? = null
        try {
            ZipFile(request.path.toFile(), ZipFile.OPEN_READ, StandardCharsets.UTF_8).use { archive ->
                val entries = archive.entries()
                var entryCount = 0
                while (entries.hasMoreElements()) {
                    val entry = entries.nextElement()
                    checkDeadline(request.deadline)
                    entryCount++
                    if (entryCount > request.policy.archiveLimits.maximumEntries) reject(EvidenceRejectionCode.ARCHIVE_ENTRY_LIMIT)
                    validateEntryName(entry.name)
                    if (!names.add(entry.name)) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                    if (entry.isDirectory) continue
                    val compressed = entry.compressedSize
                    if (compressed < 0) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                    compressedBytes = addBounded(compressedBytes, compressed, EvidenceRejectionCode.ARCHIVE_COMPRESSION_RATIO_LIMIT)
                    val captureXml = entry.name == CONTENT_TYPES || entry.name.endsWith(".rels") || entry.name in OOXML_MAIN_PART_BY_ROOT.values
                    val captured = if (captureXml) ByteArrayOutputStream() else null
                    var entryBytes = 0L
                    var prefix = ByteArray(0)
                    archive.getInputStream(entry).buffered().use { input ->
                        val buffer = ByteArray(BUFFER_SIZE)
                        while (true) {
                            checkDeadline(request.deadline)
                            val count = input.read(buffer)
                            if (count < 0) break
                            entryBytes += count
                            expandedBytes += count
                            if (expandedBytes > request.policy.archiveLimits.maximumExpandedBytes) reject(EvidenceRejectionCode.ARCHIVE_EXPANDED_SIZE_LIMIT)
                            if (ratio(entryBytes, compressed) > request.policy.archiveLimits.maximumCompressionRatio ||
                                ratio(expandedBytes, compressedBytes) > request.policy.archiveLimits.maximumCompressionRatio
                            ) reject(EvidenceRejectionCode.ARCHIVE_COMPRESSION_RATIO_LIMIT)
                            if (prefix.size < ARCHIVE_PREFIX_BYTES) {
                                val needed = minOf(ARCHIVE_PREFIX_BYTES - prefix.size, count)
                                prefix += buffer.copyOfRange(0, needed)
                            }
                            captured?.let {
                                if (it.size() + count > MAXIMUM_XML_BYTES) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                                it.write(buffer, 0, count)
                            }
                        }
                    }
                    if (isNestedArchive(entry.name, prefix)) reject(EvidenceRejectionCode.NESTED_ARCHIVE)
                    inspectPartName(entry.name)
                    captured?.toByteArray()?.let { xmlParts[entry.name] = it }
                }
            }
            xmlParts[CONTENT_TYPES]?.let { officeRoot = inspectContentTypes(it, request.deadline) }
            officeRoot?.let { root ->
                val requiredPart = OOXML_MAIN_PART_BY_ROOT.getValue(root)
                if (requiredPart !in names) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                validateXml(xmlParts[requiredPart] ?: reject(EvidenceRejectionCode.MALFORMED_ARCHIVE), request.deadline)
                val rootRelationships = xmlParts[ROOT_RELATIONSHIPS] ?: reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
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
        return officeRoot?.let(OOXML_MEDIA_BY_ROOT::getValue) ?: "application/zip"
    }

    private fun inspectPartName(name: String) {
        val lower = name.lowercase()
        if (lower.endsWith("vbaproject.bin")) reject(EvidenceRejectionCode.OOXML_MACRO)
        if (lower.endsWith("encryptedpackage") || lower.endsWith("encryptioninfo")) reject(EvidenceRejectionCode.OOXML_ENCRYPTED)
        if (OOXML_ACTIVE_DECLARATIONS.any { "/$it/" in lower }) reject(EvidenceRejectionCode.OOXML_ACTIVE_CONTENT)
    }

    private fun inspectContentTypes(xml: ByteArray, deadline: Instant): String? {
        var root: String? = null
        val rootElement = parseXml(xml, deadline) { name, attributes ->
            if (name == "Default" || name == "Override") {
                rejectActiveDeclaration(attributes["ContentType"] ?: reject(EvidenceRejectionCode.MALFORMED_ARCHIVE), null)
            }
            if (name == "Override") {
                val type = attributes.getValue("ContentType")
                OOXML_MAIN_TYPES[type]?.let { detected ->
                    if (attributes["PartName"]?.removePrefix("/") != OOXML_MAIN_PART_BY_ROOT.getValue(detected)) {
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
                if (attributes["TargetMode"].equals("External", ignoreCase = true) || isExternalTarget(target)) {
                    reject(EvidenceRejectionCode.OOXML_ACTIVE_CONTENT)
                }
                val type = attributes["Type"] ?: reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                rejectActiveDeclaration(type, target)
                relationships += PackageRelationship(type, target)
            }
        }
        if (rootElement != "Relationships") reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
        return relationships
    }

    private fun rejectActiveDeclaration(type: String, target: String?) {
        val normalizedType = type.lowercase()
        val normalizedTarget = target?.replace('\\', '/')?.lowercase().orEmpty()
        if ("vbaproject" in normalizedType || "vbaproject" in normalizedTarget) reject(EvidenceRejectionCode.OOXML_MACRO)
        if (OOXML_ACTIVE_DECLARATIONS.any { it in normalizedType || it in normalizedTarget }) reject(EvidenceRejectionCode.OOXML_ACTIVE_CONTENT)
    }

    private fun validateXml(xml: ByteArray, deadline: Instant) {
        parseXml(xml, deadline) { _, _ -> }
    }

    private fun parseXml(xml: ByteArray, deadline: Instant, onStart: (String, Map<String, String>) -> Unit): String {
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
            var root: String? = null
            try {
                while (reader.hasNext()) {
                    checkDeadline(deadline)
                    if (++events > MAXIMUM_XML_EVENTS) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                    when (reader.next()) {
                        XMLStreamConstants.START_ELEMENT -> {
                            depth++
                            if (depth > MAXIMUM_XML_DEPTH || reader.attributeCount > MAXIMUM_XML_ATTRIBUTES) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                            if (root == null) root = reader.localName
                            val attributes = buildMap {
                                for (index in 0 until reader.attributeCount) put(reader.getAttributeLocalName(index), reader.getAttributeValue(index))
                            }
                            onStart(reader.localName, attributes)
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
            return root ?: reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
        } catch (rejected: EvidenceRejectedException) {
            throw rejected
        } catch (failure: XMLStreamException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.MALFORMED_ARCHIVE, failure)
        } catch (failure: IllegalArgumentException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.MALFORMED_ARCHIVE, failure)
        }
    }

    private fun validateCentralDirectory(request: ParserSandboxRequest) {
        try {
            Files.newByteChannel(request.path, StandardOpenOption.READ).use { channel ->
                val fileSize = channel.size()
                val tailSize = minOf(fileSize, MAXIMUM_ZIP_END_BYTES.toLong()).toInt()
                val tail = readExactly(channel.apply { position(fileSize - tailSize) }, tailSize, request.deadline)
                val endIndex = (tail.size - ZIP_END_BYTES downTo 0).firstOrNull { tail.matchesAt(it, ZIP_END_MAGIC) }
                    ?: reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                val entries = unsignedShort(tail, endIndex + 10)
                if (unsignedShort(tail, endIndex + 4) != 0 || unsignedShort(tail, endIndex + 6) != 0 ||
                    unsignedShort(tail, endIndex + 8) != entries
                ) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                if (entries > request.policy.archiveLimits.maximumEntries) reject(EvidenceRejectionCode.ARCHIVE_ENTRY_LIMIT)
                val absoluteEndIndex = fileSize - tailSize + endIndex
                val commentLength = unsignedShort(tail, endIndex + 20)
                if (absoluteEndIndex + ZIP_END_BYTES + commentLength != fileSize) reject(EvidenceRejectionCode.POLYGLOT)
                val centralSize = unsignedInt(tail, endIndex + 12)
                val centralOffset = unsignedInt(tail, endIndex + 16)
                if (centralOffset > absoluteEndIndex || centralSize > absoluteEndIndex - centralOffset || centralOffset + centralSize != absoluteEndIndex) {
                    reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                }
                channel.position(centralOffset)
                inspectCentralEntries(channel, centralSize, entries, request.policy.archiveLimits, request.deadline)
            }
        } catch (rejected: EvidenceRejectedException) {
            throw rejected
        } catch (failure: IOException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.MALFORMED_ARCHIVE, failure)
        }
    }

    private fun inspectCentralEntries(
        channel: java.nio.channels.SeekableByteChannel,
        size: Long,
        expectedEntries: Int,
        limits: ArchiveLimits,
        deadline: Instant,
    ) {
        var remaining = size
        var entries = 0
        var expandedTotal = 0L
        var compressedTotal = 0L
        while (remaining > 0) {
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
            val name = String(readExactly(channel, nameLength, deadline), if (flags and UTF8_FLAG != 0) StandardCharsets.UTF_8 else ZIP_LEGACY_CHARSET)
            validateEntryName(name)
            channel.position(channel.position() + extraLength + commentLength)
            remaining -= variableLength
            entries++
            if (entries > limits.maximumEntries) reject(EvidenceRejectionCode.ARCHIVE_ENTRY_LIMIT)
            expandedTotal = addBounded(expandedTotal, expanded, EvidenceRejectionCode.ARCHIVE_EXPANDED_SIZE_LIMIT)
            compressedTotal = addBounded(compressedTotal, compressed, EvidenceRejectionCode.ARCHIVE_COMPRESSION_RATIO_LIMIT)
            if (expandedTotal > limits.maximumExpandedBytes) reject(EvidenceRejectionCode.ARCHIVE_EXPANDED_SIZE_LIMIT)
            if (ratio(expanded, compressed) > limits.maximumCompressionRatio || ratio(expandedTotal, compressedTotal) > limits.maximumCompressionRatio) {
                reject(EvidenceRejectionCode.ARCHIVE_COMPRESSION_RATIO_LIMIT)
            }
        }
        if (entries != expectedEntries) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
    }

    private fun observeEncryptedLocalHeader(path: java.nio.file.Path, deadline: Instant): Boolean {
        try {
            var tail = ByteArray(0)
            Files.newInputStream(path).buffered().use { input ->
                val buffer = ByteArray(BUFFER_SIZE)
                while (true) {
                    checkDeadline(deadline)
                    val count = input.read(buffer)
                    if (count < 0) return false
                    val window = tail + buffer.copyOfRange(0, count)
                    for (index in 0..window.size - 8) {
                        if (window.matchesAt(index, ZIP_LOCAL_MAGIC) && unsignedShort(window, index + 6) and 1 != 0) return true
                    }
                    tail = window.copyOfRange(maxOf(0, window.size - 8), window.size)
                }
            }
        } catch (rejected: EvidenceRejectedException) {
            throw rejected
        } catch (failure: IOException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.CONTENT_READ_ERROR, failure)
        }
    }

    private fun isNestedArchive(name: String, prefix: ByteArray): Boolean =
        name.substringAfterLast('.', "").lowercase() in ARCHIVE_EXTENSIONS ||
            ARCHIVE_MAGICS.any { prefix.containsBytes(it) } || prefix.indexOfBytes(USTAR_MAGIC) >= 257

    private fun validateEntryName(name: String) {
        val normalized = name.replace('\\', '/')
        val withoutSuffix = normalized.removeSuffix("/")
        if (withoutSuffix.isBlank() || normalized.startsWith('/') || DRIVE_PATH.matches(normalized) ||
            withoutSuffix.split('/').any { it == ".." || it == "." || it.isEmpty() }
        ) reject(EvidenceRejectionCode.ARCHIVE_TRAVERSAL)
    }

    private fun normalizeRelationshipTarget(target: String): String {
        val normalized = target.replace('\\', '/').removePrefix("/")
        if (normalized.isBlank() || ':' in normalized || normalized.split('/').any { it == ".." || it == "." || it.isEmpty() }) {
            reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
        }
        return normalized
    }

    private fun isExternalTarget(target: String): Boolean = try {
        target.startsWith("//") || java.net.URI(target).isAbsolute
    } catch (failure: java.net.URISyntaxException) {
        throw EvidenceRejectedException(EvidenceRejectionCode.MALFORMED_ARCHIVE, failure)
    }

    private fun readExactly(channel: java.nio.channels.SeekableByteChannel, count: Int, deadline: Instant): ByteArray {
        val buffer = ByteBuffer.allocate(count)
        while (buffer.hasRemaining()) {
            checkDeadline(deadline)
            if (channel.read(buffer) < 0) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
        }
        return buffer.array()
    }

    private fun checkDeadline(deadline: Instant) {
        if (!clock.instant().isBefore(deadline)) reject(EvidenceRejectionCode.DEADLINE_EXCEEDED)
    }

    private fun ratio(expanded: Long, compressed: Long) = if (expanded == 0L) 0.0 else if (compressed <= 0L) Double.POSITIVE_INFINITY else expanded.toDouble() / compressed
    private fun addBounded(current: Long, value: Long, code: EvidenceRejectionCode): Long {
        if (value > Long.MAX_VALUE - current) reject(code)
        return current + value
    }
    private fun unsignedShort(bytes: ByteArray, offset: Int) = (bytes[offset].toInt() and 0xff) or ((bytes[offset + 1].toInt() and 0xff) shl 8)
    private fun unsignedInt(bytes: ByteArray, offset: Int) = (bytes[offset].toLong() and 0xff) or ((bytes[offset + 1].toLong() and 0xff) shl 8) or ((bytes[offset + 2].toLong() and 0xff) shl 16) or ((bytes[offset + 3].toLong() and 0xff) shl 24)
    private fun ByteArray.matchesAt(offset: Int, expected: ByteArray) = offset >= 0 && size - offset >= expected.size && expected.indices.all { this[offset + it] == expected[it] }
    private fun ByteArray.containsBytes(expected: ByteArray) = indexOfBytes(expected) >= 0
    private fun ByteArray.indexOfBytes(expected: ByteArray): Int {
        if (expected.isEmpty() || expected.size > size) return -1
        for (offset in 0..size - expected.size) if (expected.indices.all { this[offset + it] == expected[it] }) return offset
        return -1
    }
    private fun reject(code: EvidenceRejectionCode): Nothing = throw EvidenceRejectedException(code)

    private data class PackageRelationship(val type: String, val target: String)

    companion object {
        private const val BUFFER_SIZE = 8192
        private const val ARCHIVE_PREFIX_BYTES = 512
        private const val MAXIMUM_XML_BYTES = 1024 * 1024
        private const val MAXIMUM_XML_EVENTS = 20_000
        private const val MAXIMUM_XML_DEPTH = 64
        private const val MAXIMUM_XML_ATTRIBUTES = 32
        private const val MAXIMUM_XML_TEXT_CHARACTERS = 1_048_576L
        private const val ZIP_END_BYTES = 22
        private const val MAXIMUM_ZIP_END_BYTES = ZIP_END_BYTES + 65_535
        private const val ZIP_CENTRAL_HEADER_BYTES = 46
        private const val UTF8_FLAG = 1 shl 11
        private const val ZIP64_SENTINEL = 0xffff_ffffL
        private const val CONTENT_TYPES = "[Content_Types].xml"
        private const val ROOT_RELATIONSHIPS = "_rels/.rels"
        private val ZIP_LOCAL_MAGIC = byteArrayOf(0x50, 0x4b, 0x03, 0x04)
        private val ZIP_END_MAGIC = byteArrayOf(0x50, 0x4b, 0x05, 0x06)
        private val ZIP_CENTRAL_MAGIC = byteArrayOf(0x50, 0x4b, 0x01, 0x02)
        private val OLE_MAGIC = byteArrayOf(0xd0.toByte(), 0xcf.toByte(), 0x11, 0xe0.toByte(), 0xa1.toByte(), 0xb1.toByte(), 0x1a, 0xe1.toByte())
        private val ARCHIVE_MAGICS = listOf(
            ZIP_LOCAL_MAGIC, OLE_MAGIC, byteArrayOf(0x1f, 0x8b.toByte()),
            byteArrayOf(0x37, 0x7a, 0xbc.toByte(), 0xaf.toByte(), 0x27, 0x1c),
            "Rar!\u001a\u0007".toByteArray(StandardCharsets.ISO_8859_1),
            byteArrayOf(0xfd.toByte(), 0x37, 0x7a, 0x58, 0x5a, 0x00),
            "BZh".toByteArray(StandardCharsets.ISO_8859_1), byteArrayOf(0x28, 0xb5.toByte(), 0x2f, 0xfd.toByte()),
        )
        private val USTAR_MAGIC = "ustar".toByteArray(StandardCharsets.ISO_8859_1)
        private val ZIP_LEGACY_CHARSET = Charset.forName("IBM437")
        private val ARCHIVE_EXTENSIONS = setOf("zip", "jar", "docx", "xlsx", "pptx", "odt", "ods", "odp", "7z", "rar", "gz", "tar")
        private val OOXML_EXTENSIONS = setOf("docx", "xlsx", "pptx")
        private val OOXML_ACTIVE_DECLARATIONS = setOf("oleobject", "activex", "embeddings", "embeddedpackage", "package")
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
        private val OOXML_MAIN_PART_BY_ROOT = mapOf("word" to "word/document.xml", "xl" to "xl/workbook.xml", "ppt" to "ppt/presentation.xml")
    }
}
