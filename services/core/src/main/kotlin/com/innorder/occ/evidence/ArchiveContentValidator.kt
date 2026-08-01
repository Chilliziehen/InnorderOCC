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
import java.util.zip.GZIPInputStream
import javax.xml.XMLConstants
import javax.xml.namespace.QName
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
                    if (entry.name.substringAfterLast('.', "").lowercase() in ARCHIVE_EXTENSIONS) {
                        reject(EvidenceRejectionCode.NESTED_ARCHIVE)
                    }
                    val probePath = Files.createTempFile("occ-evidence-nested-", ".bin")
                    try {
                        Files.newOutputStream(probePath).buffered().use { probeOutput ->
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
                                    probeOutput.write(buffer, 0, count)
                                    captured?.let {
                                        if (it.size() + count > MAXIMUM_XML_BYTES) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                                        it.write(buffer, 0, count)
                                    }
                                }
                            }
                        }
                        if (isValidNestedContainer(probePath, request.deadline)) reject(EvidenceRejectionCode.NESTED_ARCHIVE)
                    } finally {
                        Files.deleteIfExists(probePath)
                    }
                    inspectPartName(entry.name)
                    captured?.toByteArray()?.let { xmlParts[entry.name] = it }
                }
            }
            xmlParts[CONTENT_TYPES]?.let { officeRoot = inspectContentTypes(it, request.deadline) }
            officeRoot?.let { root ->
                val requiredPart = OOXML_MAIN_PART_BY_ROOT.getValue(root)
                if (requiredPart !in names) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                validateXml(
                    xmlParts[requiredPart] ?: reject(EvidenceRejectionCode.MALFORMED_ARCHIVE),
                    request.deadline,
                    OOXML_MAIN_ROOT_BY_ROOT.getValue(root),
                )
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
            if (name.namespaceURI != CONTENT_TYPES_NAMESPACE) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
            if (name.localPart !in CONTENT_TYPES_ELEMENTS) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
            if (name.localPart == "Default" || name.localPart == "Override") {
                rejectNamespacedAttributes(attributes)
                rejectActiveDeclaration(requiredUnqualified(attributes, "ContentType"), null)
            }
            if (name.localPart == "Default") requiredUnqualified(attributes, "Extension")
            if (name.localPart == "Override") requiredUnqualified(attributes, "PartName")
            if (name.localPart == "Override") {
                val type = requiredUnqualified(attributes, "ContentType")
                OOXML_MAIN_TYPES[type]?.let { detected ->
                    if (requiredUnqualified(attributes, "PartName").removePrefix("/") != OOXML_MAIN_PART_BY_ROOT.getValue(detected)) {
                        reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                    }
                    if (root != null && root != detected) reject(EvidenceRejectionCode.POLYGLOT)
                    root = detected
                }
            }
        }
        if (rootElement != QName(CONTENT_TYPES_NAMESPACE, "Types") || root == null) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
        return root
    }

    private fun inspectRelationships(xml: ByteArray, deadline: Instant): List<PackageRelationship> {
        val relationships = mutableListOf<PackageRelationship>()
        val rootElement = parseXml(xml, deadline) { name, attributes ->
            if (name.namespaceURI != RELATIONSHIPS_NAMESPACE) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
            if (name.localPart !in RELATIONSHIP_ELEMENTS) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
            if (name.localPart == "Relationship") {
                rejectNamespacedAttributes(attributes)
                requiredUnqualified(attributes, "Id")
                val target = requiredUnqualified(attributes, "Target")
                if (optionalUnqualified(attributes, "TargetMode").equals("External", ignoreCase = true) || isExternalTarget(target)) {
                    reject(EvidenceRejectionCode.OOXML_ACTIVE_CONTENT)
                }
                val type = requiredUnqualified(attributes, "Type")
                rejectActiveDeclaration(type, target)
                relationships += PackageRelationship(type, target)
            }
        }
        if (rootElement != QName(RELATIONSHIPS_NAMESPACE, "Relationships")) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
        return relationships
    }

    private fun rejectActiveDeclaration(type: String, target: String?) {
        val normalizedType = type.lowercase()
        val normalizedTarget = target?.replace('\\', '/')?.lowercase().orEmpty()
        if ("vbaproject" in normalizedType || "vbaproject" in normalizedTarget) reject(EvidenceRejectionCode.OOXML_MACRO)
        if (OOXML_ACTIVE_DECLARATIONS.any { it in normalizedType || it in normalizedTarget }) reject(EvidenceRejectionCode.OOXML_ACTIVE_CONTENT)
    }

    private fun validateXml(xml: ByteArray, deadline: Instant, expectedRoot: QName) {
        if (parseXml(xml, deadline) { _, _ -> } != expectedRoot) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
    }

    private fun parseXml(xml: ByteArray, deadline: Instant, onStart: (QName, List<XmlAttribute>) -> Unit): QName {
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
            var root: QName? = null
            try {
                while (reader.hasNext()) {
                    checkDeadline(deadline)
                    if (++events > MAXIMUM_XML_EVENTS) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                    when (reader.next()) {
                        XMLStreamConstants.START_ELEMENT -> {
                            depth++
                            if (depth > MAXIMUM_XML_DEPTH || reader.attributeCount > MAXIMUM_XML_ATTRIBUTES) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
                            if (root == null) root = reader.name
                            val attributes = buildList {
                                for (index in 0 until reader.attributeCount) add(
                                    XmlAttribute(reader.getAttributeName(index), reader.getAttributeValue(index)),
                                )
                            }
                            onStart(reader.name, attributes)
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

    private fun requiredUnqualified(attributes: List<XmlAttribute>, localName: String): String =
        attributes.filter { it.name.localPart == localName }.singleOrNull()
            ?.takeIf { it.name.namespaceURI.isEmpty() }
            ?.value
            ?: reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)

    private fun optionalUnqualified(attributes: List<XmlAttribute>, localName: String): String? {
        val matches = attributes.filter { it.name.localPart == localName }
        if (matches.isEmpty()) return null
        return matches.singleOrNull()?.takeIf { it.name.namespaceURI.isEmpty() }?.value
            ?: reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
    }

    private fun rejectNamespacedAttributes(attributes: List<XmlAttribute>) {
        if (attributes.any { it.name.namespaceURI.isNotEmpty() }) reject(EvidenceRejectionCode.MALFORMED_ARCHIVE)
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

    private fun isValidNestedContainer(path: java.nio.file.Path, deadline: Instant): Boolean {
        checkDeadline(deadline)
        val size = Files.size(path)
        if (size < 4) return false
        if (isValidZipStructure(path, deadline)) return true
        val prefix = Files.newInputStream(path).use { it.readNBytes(minOf(size, 512L).toInt()) }
        if (prefix.matchesAt(0, GZIP_MAGIC) && isValidGzip(path, deadline)) return true
        if (prefix.size >= 512 && isValidTar(path, deadline)) return true
        if (prefix.matchesAt(0, OLE_MAGIC) && prefix.size >= 512 &&
            prefix[28] == 0xfe.toByte() && prefix[29] == 0xff.toByte() &&
            unsignedShort(prefix, 30) in setOf(9, 12)
        ) return true
        if (prefix.matchesAt(0, SEVEN_Z_MAGIC) && prefix.size >= 32 && crc32(prefix, 12, 20) == unsignedInt(prefix, 8)) return true
        if (prefix.matchesAt(0, XZ_MAGIC) && prefix.size >= 12 && crc32(prefix, 6, 2) == unsignedInt(prefix, 8)) return true
        if (prefix.matchesAt(0, BZIP_MAGIC) && prefix.size >= 10 && prefix[3].toInt().toChar() in '1'..'9' &&
            (prefix.matchesAt(4, BZIP_BLOCK_MAGIC) || prefix.matchesAt(4, BZIP_END_MAGIC))
        ) return true
        if (prefix.matchesAt(0, RAR4_MAGIC) && prefix.size >= 14 && prefix[9] == 0x73.toByte() &&
            (crc32(prefix, 9, 5) and 0xffff) == unsignedShort(prefix, 7).toLong()
        ) return true
        return false
    }

    private fun isValidZipStructure(path: java.nio.file.Path, deadline: Instant): Boolean = try {
        Files.newByteChannel(path, StandardOpenOption.READ).use { channel ->
            val size = channel.size()
            val tailSize = minOf(size, MAXIMUM_ZIP_END_BYTES.toLong()).toInt()
            val tail = probeRead(channel, size - tailSize, tailSize, deadline) ?: return false
            val endIndex = (tail.size - ZIP_END_BYTES downTo 0).firstOrNull { index ->
                tail.matchesAt(index, ZIP_END_MAGIC) &&
                    size - tailSize + index + ZIP_END_BYTES + unsignedShort(tail, index + 20) == size
            } ?: return false
            val entries = unsignedShort(tail, endIndex + 10)
            if (unsignedShort(tail, endIndex + 4) != 0 || unsignedShort(tail, endIndex + 6) != 0 ||
                unsignedShort(tail, endIndex + 8) != entries
            ) return false
            val centralSize = unsignedInt(tail, endIndex + 12)
            val centralOffset = unsignedInt(tail, endIndex + 16)
            if (centralSize == ZIP64_SENTINEL || centralOffset == ZIP64_SENTINEL) return false
            val absoluteEnd = size - tailSize + endIndex
            val prefixBytes = absoluteEnd - centralSize - centralOffset
            if (prefixBytes < 0) return false
            val absoluteCentral = prefixBytes + centralOffset
            if (absoluteCentral < 0 || absoluteCentral + centralSize != absoluteEnd) return false

            var centralPosition = absoluteCentral
            var centralRemaining = centralSize
            val localOffsets = HashSet<Long>()
            repeat(entries) {
                checkDeadline(deadline)
                if (centralRemaining < ZIP_CENTRAL_HEADER_BYTES) return false
                val fixed = probeRead(channel, centralPosition, ZIP_CENTRAL_HEADER_BYTES, deadline) ?: return false
                if (!fixed.matchesAt(0, ZIP_CENTRAL_MAGIC)) return false
                val flags = unsignedShort(fixed, 8)
                val method = unsignedShort(fixed, 10)
                val crc = unsignedInt(fixed, 16)
                val compressedSize = unsignedInt(fixed, 20)
                val expandedSize = unsignedInt(fixed, 24)
                val nameLength = unsignedShort(fixed, 28)
                val extraLength = unsignedShort(fixed, 30)
                val commentLength = unsignedShort(fixed, 32)
                val localOffset = unsignedInt(fixed, 42)
                if (compressedSize == ZIP64_SENTINEL || expandedSize == ZIP64_SENTINEL || localOffset == ZIP64_SENTINEL ||
                    unsignedShort(fixed, 34) != 0
                ) return false
                val variableLength = nameLength.toLong() + extraLength + commentLength
                if (ZIP_CENTRAL_HEADER_BYTES + variableLength > centralRemaining) return false
                val centralName = probeRead(channel, centralPosition + ZIP_CENTRAL_HEADER_BYTES, nameLength, deadline) ?: return false

                val absoluteLocal = prefixBytes + localOffset
                if (!localOffsets.add(absoluteLocal)) return false
                val local = probeRead(channel, absoluteLocal, ZIP_LOCAL_HEADER_BYTES, deadline) ?: return false
                if (!local.matchesAt(0, ZIP_LOCAL_MAGIC) || unsignedShort(local, 6) != flags || unsignedShort(local, 8) != method) return false
                if (flags and ZIP_DATA_DESCRIPTOR_FLAG == 0 &&
                    (unsignedInt(local, 14) != crc || unsignedInt(local, 18) != compressedSize || unsignedInt(local, 22) != expandedSize)
                ) return false
                if (flags and ZIP_DATA_DESCRIPTOR_FLAG != 0 &&
                    (unsignedInt(local, 14) != 0L || unsignedInt(local, 18) != 0L || unsignedInt(local, 22) != 0L)
                ) return false
                val localNameLength = unsignedShort(local, 26)
                val localExtraLength = unsignedShort(local, 28)
                val localName = probeRead(channel, absoluteLocal + ZIP_LOCAL_HEADER_BYTES, localNameLength, deadline) ?: return false
                if (!centralName.contentEquals(localName)) return false
                val dataStart = absoluteLocal + ZIP_LOCAL_HEADER_BYTES + localNameLength + localExtraLength
                if (absoluteLocal < prefixBytes || dataStart < absoluteLocal || compressedSize > absoluteCentral - dataStart) return false

                val recordLength = ZIP_CENTRAL_HEADER_BYTES + variableLength
                centralPosition += recordLength
                centralRemaining -= recordLength
            }
            centralRemaining == 0L && centralPosition == absoluteEnd
        }
    } catch (rejected: EvidenceRejectedException) {
        throw rejected
    } catch (_: IOException) {
        false
    }

    private fun probeRead(
        channel: java.nio.channels.SeekableByteChannel,
        position: Long,
        count: Int,
        deadline: Instant,
    ): ByteArray? {
        if (position < 0 || count < 0 || position > channel.size() || count.toLong() > channel.size() - position) return null
        channel.position(position)
        val buffer = ByteBuffer.allocate(count)
        while (buffer.hasRemaining()) {
            checkDeadline(deadline)
            if (channel.read(buffer) < 0) return null
        }
        return buffer.array()
    }

    private fun isValidGzip(path: java.nio.file.Path, deadline: Instant): Boolean = try {
        GZIPInputStream(Files.newInputStream(path).buffered()).use { input ->
            val buffer = ByteArray(BUFFER_SIZE)
            var expanded = 0L
            while (true) {
                checkDeadline(deadline)
                val count = input.read(buffer)
                if (count < 0) break
                expanded += count
                if (expanded > MAXIMUM_NESTED_PROBE_EXPANDED_BYTES) return true
            }
        }
        true
    } catch (_: IOException) {
        false
    }

    private fun isValidTar(path: java.nio.file.Path, deadline: Instant): Boolean {
        return try {
            Files.newInputStream(path).buffered().use { input ->
                val header = ByteArray(512)
                var sawEntry = false
                while (true) {
                    checkDeadline(deadline)
                    val count = input.readNBytes(header, 0, header.size)
                    if (count == 0) return@use sawEntry
                    if (count != header.size) return@use false
                    if (header.all { it == 0.toByte() }) {
                        val second = input.readNBytes(512)
                        return@use sawEntry || (second.size == 512 && second.all { it == 0.toByte() } && input.read() < 0)
                    }
                    if (!header.matchesAt(257, USTAR_MAGIC) || tarChecksum(header) != tarStoredChecksum(header)) return@use false
                    sawEntry = true
                    val entrySize = String(header, 124, 12, StandardCharsets.US_ASCII).trim('\u0000', ' ').toLongOrNull(8) ?: return@use false
                    var remaining = ((entrySize + 511) / 512) * 512
                    while (remaining > 0) {
                        checkDeadline(deadline)
                        val skipped = input.skip(remaining)
                        if (skipped <= 0) return@use false
                        remaining -= skipped
                    }
                }
                @Suppress("UNREACHABLE_CODE")
                false
            }
        } catch (_: IOException) {
            false
        }
    }

    private fun tarChecksum(header: ByteArray): Long = header.indices.sumOf { index ->
        if (index in 148 until 156) 32L else (header[index].toInt() and 0xff).toLong()
    }

    private fun tarStoredChecksum(header: ByteArray): Long =
        String(header, 148, 8, StandardCharsets.US_ASCII).trim('\u0000', ' ').toLongOrNull(8) ?: -1

    private fun crc32(bytes: ByteArray, offset: Int, length: Int): Long = java.util.zip.CRC32().run {
        update(bytes, offset, length)
        value
    }

    private fun ratio(expanded: Long, compressed: Long) = if (expanded == 0L) 0.0 else if (compressed <= 0L) Double.POSITIVE_INFINITY else expanded.toDouble() / compressed
    private fun addBounded(current: Long, value: Long, code: EvidenceRejectionCode): Long {
        if (value > Long.MAX_VALUE - current) reject(code)
        return current + value
    }
    private fun unsignedShort(bytes: ByteArray, offset: Int) = (bytes[offset].toInt() and 0xff) or ((bytes[offset + 1].toInt() and 0xff) shl 8)
    private fun unsignedInt(bytes: ByteArray, offset: Int) = (bytes[offset].toLong() and 0xff) or ((bytes[offset + 1].toLong() and 0xff) shl 8) or ((bytes[offset + 2].toLong() and 0xff) shl 16) or ((bytes[offset + 3].toLong() and 0xff) shl 24)
    private fun ByteArray.matchesAt(offset: Int, expected: ByteArray) = offset >= 0 && size - offset >= expected.size && expected.indices.all { this[offset + it] == expected[it] }
    private fun reject(code: EvidenceRejectionCode): Nothing = throw EvidenceRejectedException(code)

    private data class PackageRelationship(val type: String, val target: String)
    private data class XmlAttribute(val name: QName, val value: String)

    companion object {
        private const val BUFFER_SIZE = 8192
        private const val MAXIMUM_NESTED_PROBE_EXPANDED_BYTES = 16L * 1024 * 1024
        private const val MAXIMUM_XML_BYTES = 1024 * 1024
        private const val MAXIMUM_XML_EVENTS = 20_000
        private const val MAXIMUM_XML_DEPTH = 64
        private const val MAXIMUM_XML_ATTRIBUTES = 32
        private const val MAXIMUM_XML_TEXT_CHARACTERS = 1_048_576L
        private const val ZIP_END_BYTES = 22
        private const val MAXIMUM_ZIP_END_BYTES = ZIP_END_BYTES + 65_535
        private const val ZIP_CENTRAL_HEADER_BYTES = 46
        private const val ZIP_LOCAL_HEADER_BYTES = 30
        private const val UTF8_FLAG = 1 shl 11
        private const val ZIP_DATA_DESCRIPTOR_FLAG = 1 shl 3
        private const val ZIP64_SENTINEL = 0xffff_ffffL
        private const val CONTENT_TYPES = "[Content_Types].xml"
        private const val ROOT_RELATIONSHIPS = "_rels/.rels"
        private const val CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types"
        private const val RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships"
        private val CONTENT_TYPES_ELEMENTS = setOf("Types", "Default", "Override")
        private val RELATIONSHIP_ELEMENTS = setOf("Relationships", "Relationship")
        private val ZIP_LOCAL_MAGIC = byteArrayOf(0x50, 0x4b, 0x03, 0x04)
        private val ZIP_END_MAGIC = byteArrayOf(0x50, 0x4b, 0x05, 0x06)
        private val ZIP_CENTRAL_MAGIC = byteArrayOf(0x50, 0x4b, 0x01, 0x02)
        private val OLE_MAGIC = byteArrayOf(0xd0.toByte(), 0xcf.toByte(), 0x11, 0xe0.toByte(), 0xa1.toByte(), 0xb1.toByte(), 0x1a, 0xe1.toByte())
        private val GZIP_MAGIC = byteArrayOf(0x1f, 0x8b.toByte())
        private val SEVEN_Z_MAGIC = byteArrayOf(0x37, 0x7a, 0xbc.toByte(), 0xaf.toByte(), 0x27, 0x1c)
        private val XZ_MAGIC = byteArrayOf(0xfd.toByte(), 0x37, 0x7a, 0x58, 0x5a, 0x00)
        private val BZIP_MAGIC = "BZh".toByteArray(StandardCharsets.ISO_8859_1)
        private val BZIP_BLOCK_MAGIC = byteArrayOf(0x31, 0x41, 0x59, 0x26, 0x53, 0x59)
        private val BZIP_END_MAGIC = byteArrayOf(0x17, 0x72, 0x45, 0x38, 0x50, 0x90.toByte())
        private val RAR4_MAGIC = "Rar!\u001a\u0007\u0000".toByteArray(StandardCharsets.ISO_8859_1)
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
        private val OOXML_MAIN_ROOT_BY_ROOT = mapOf(
            "word" to QName("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "document"),
            "xl" to QName("http://schemas.openxmlformats.org/spreadsheetml/2006/main", "workbook"),
            "ppt" to QName("http://schemas.openxmlformats.org/presentationml/2006/main", "presentation"),
        )
    }
}
