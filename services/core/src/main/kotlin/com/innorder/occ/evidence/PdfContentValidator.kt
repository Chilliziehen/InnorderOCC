package com.innorder.occ.evidence

import org.apache.pdfbox.cos.COSArray
import org.apache.pdfbox.cos.COSBase
import org.apache.pdfbox.cos.COSDictionary
import org.apache.pdfbox.cos.COSDocument
import org.apache.pdfbox.cos.COSName
import org.apache.pdfbox.cos.COSObject
import org.apache.pdfbox.cos.COSStream
import org.apache.pdfbox.io.IOUtils
import org.apache.pdfbox.io.RandomAccessRead
import org.apache.pdfbox.io.RandomAccessReadBufferedFile
import org.apache.pdfbox.pdfparser.PDFParser
import org.apache.pdfbox.pdmodel.encryption.InvalidPasswordException
import java.io.IOException
import java.nio.file.Path
import java.nio.file.Files
import java.nio.charset.StandardCharsets
import java.util.Collections
import java.util.IdentityHashMap

internal class PdfContentValidator(
    private val policy: EvidencePolicy,
    private val checkDeadline: () -> Unit,
) {
    private var objectCount = 0
    private var expandedBytes = 0L
    private var compressedBytes = 0L
    private val visited: MutableSet<COSBase> = Collections.newSetFromMap(IdentityHashMap())

    fun validate(path: Path) {
        try {
            RandomAccessReadBufferedFile(path).use { source ->
                StrictPdfParser(source).parse().use { document ->
                    checkDeadline()
                    if (document.isEncrypted || document.document.encryptionDictionary != null) {
                        reject(EvidenceRejectionCode.PDF_ENCRYPTED)
                    }
                    inspectDocument(document.document)
                    validateTerminalBoundary(path)
                }
            }
        } catch (rejected: EvidenceRejectedException) {
            throw rejected
        } catch (failure: InvalidPasswordException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.PDF_ENCRYPTED, failure)
        } catch (failure: IOException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.MALFORMED_PDF, failure)
        } catch (failure: RuntimeException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.MALFORMED_PDF, failure)
        }
    }

    private fun validateTerminalBoundary(path: Path) {
        val size = Files.size(path)
        val tailSize = minOf(size, MAXIMUM_PDF_TAIL_BYTES.toLong()).toInt()
        val tail = Files.newByteChannel(path).use { channel ->
            channel.position(size - tailSize)
            val buffer = java.nio.ByteBuffer.allocate(tailSize)
            while (buffer.hasRemaining()) {
                checkDeadline()
                if (channel.read(buffer) < 0) break
            }
            buffer.array()
        }
        val terminal = PDF_TERMINAL.find(String(tail, StandardCharsets.ISO_8859_1))
            ?: reject(EvidenceRejectionCode.POLYGLOT)
        val xrefOffset = terminal.groupValues[1].toLongOrNull() ?: reject(EvidenceRejectionCode.MALFORMED_PDF)
        if (xrefOffset !in 0 until size) reject(EvidenceRejectionCode.MALFORMED_PDF)
    }

    private fun inspectDocument(document: COSDocument) {
        val entries = document.xrefTable.entries
        if (entries.size > MAXIMUM_PDF_OBJECTS) reject(EvidenceRejectionCode.MALFORMED_PDF)
        inspect(document.trailer, 0)
        // Positive xref offsets are physical objects. Validate their streams before dereferencing compressed objects.
        entries.sortedBy { if (it.value >= 0) 0 else 1 }.forEach { (key, _) ->
            checkDeadline()
            inspect(document.getObjectFromPool(key), 0)
        }
    }

    private fun inspect(value: COSBase?, depth: Int) {
        if (value == null || !visited.add(value)) return
        checkDeadline()
        if (depth > MAXIMUM_PDF_DEPTH) reject(EvidenceRejectionCode.MALFORMED_PDF)
        when (value) {
            is COSObject -> inspect(value.`object`, depth + 1)
            is COSStream -> {
                countObject()
                inspectStream(value)
                inspectDictionary(value, depth)
            }
            is COSDictionary -> {
                countObject()
                inspectDictionary(value, depth)
            }
            is COSArray -> {
                countObject()
                value.forEach { inspect(it, depth + 1) }
            }
        }
    }

    private fun inspectDictionary(dictionary: COSDictionary, depth: Int) {
        dictionary.entrySet().forEach { (key, value) ->
            checkDeadline()
            when {
                key.name in ENCRYPTION_KEYS -> reject(EvidenceRejectionCode.PDF_ENCRYPTED)
                key.name in ACTIVE_KEYS -> reject(EvidenceRejectionCode.PDF_ACTIVE_CONTENT)
                value is COSName && value.name in ACTIVE_NAME_VALUES -> reject(EvidenceRejectionCode.PDF_ACTIVE_CONTENT)
            }
            inspect(value, depth + 1)
        }
    }

    private fun inspectStream(stream: COSStream) {
        val compressed = stream.length
        if (compressed < 0) reject(EvidenceRejectionCode.MALFORMED_PDF)
        compressedBytes = addBounded(compressedBytes, compressed)
        var streamBytes = 0L
        try {
            stream.createInputStream().buffered().use { input ->
                val buffer = ByteArray(BUFFER_SIZE)
                while (true) {
                    checkDeadline()
                    val count = input.read(buffer)
                    if (count < 0) break
                    streamBytes += count
                    expandedBytes += count
                    if (expandedBytes > policy.archiveLimits.maximumExpandedBytes) {
                        reject(EvidenceRejectionCode.ARCHIVE_EXPANDED_SIZE_LIMIT)
                    }
                    if (ratio(streamBytes, compressed) > policy.archiveLimits.maximumCompressionRatio ||
                        ratio(expandedBytes, compressedBytes) > policy.archiveLimits.maximumCompressionRatio
                    ) reject(EvidenceRejectionCode.ARCHIVE_COMPRESSION_RATIO_LIMIT)
                }
            }
        } catch (rejected: EvidenceRejectedException) {
            throw rejected
        } catch (failure: IOException) {
            throw EvidenceRejectedException(EvidenceRejectionCode.MALFORMED_PDF, failure)
        }
    }

    private fun countObject() {
        objectCount++
        if (objectCount > MAXIMUM_PDF_OBJECTS) reject(EvidenceRejectionCode.MALFORMED_PDF)
    }

    private fun addBounded(current: Long, value: Long): Long {
        if (value > Long.MAX_VALUE - current) reject(EvidenceRejectionCode.ARCHIVE_COMPRESSION_RATIO_LIMIT)
        return current + value
    }

    private fun ratio(expanded: Long, compressed: Long): Double = when {
        expanded == 0L -> 0.0
        compressed <= 0L -> Double.POSITIVE_INFINITY
        else -> expanded.toDouble() / compressed.toDouble()
    }

    private fun reject(code: EvidenceRejectionCode): Nothing = throw EvidenceRejectedException(code)

    private class StrictPdfParser(source: RandomAccessRead) : PDFParser(
        source,
        "",
        null,
        null,
        IOUtils.createTempFileOnlyStreamCache(),
    ) {
        init {
            setLenient(false)
        }
    }

    companion object {
        private const val BUFFER_SIZE = 8 * 1024
        private const val MAXIMUM_PDF_OBJECTS = 10_000
        private const val MAXIMUM_PDF_DEPTH = 64
        private const val MAXIMUM_PDF_TAIL_BYTES = 65_536
        private val PDF_TERMINAL = Regex("startxref[\\x00\\x09\\x0a\\x0c\\x0d\\x20]+([0-9]+)[\\x00\\x09\\x0a\\x0c\\x0d\\x20]+%%EOF[\\x00\\x09\\x0a\\x0c\\x0d\\x20]*\\z")
        private val ENCRYPTION_KEYS = setOf("Encrypt", "EncryptedPayload")
        private val ACTIVE_KEYS = setOf(
            "A", "AA", "OpenAction", "JS", "JavaScript", "EmbeddedFiles", "EmbeddedFDFs", "EF", "Filespec",
            "Launch", "RichMedia", "AcroForm", "XFA", "URI", "SubmitForm", "ImportData", "GoToR", "Sound", "Movie", "AF",
        )
        private val ACTIVE_NAME_VALUES = setOf(
            "JavaScript", "EmbeddedFile", "Filespec", "Launch", "RichMedia", "SubmitForm", "ImportData", "GoToR", "Sound", "Movie",
        )
    }
}
