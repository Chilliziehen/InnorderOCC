package com.innorder.occ.evidence

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.stream.Stream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class EvidenceContentInspectorTest {
    @TempDir
    lateinit var tempDirectory: Path

    private val deadline = Instant.parse("2030-01-01T00:01:00Z")
    private val clock = Clock.fixed(Instant.parse("2030-01-01T00:00:00Z"), ZoneOffset.UTC)

    @Test
    fun `policy copies caller collections and validates strict normalized limits`() {
        val extensions = linkedSetOf("pdf")
        val mediaTypes = linkedSetOf("application/pdf")
        val policy = EvidencePolicy(extensions, mediaTypes, 1024, ArchiveLimits(10, 2048, 20.0))

        extensions += "exe"
        mediaTypes += "application/x-msdownload"

        assertThat(policy.allowedExtensions).containsExactly("pdf")
        assertThat(policy.allowedMediaTypes).containsExactly("application/pdf")
        assertThatThrownBy { EvidencePolicy(setOf(".PDF"), setOf("application/pdf"), 1, ArchiveLimits(1, 1, 1.0)) }
            .isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { EvidencePolicy(setOf("pdf"), setOf("text/plain"), 1, ArchiveLimits(1, 1, 1.0)) }
            .isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { EvidencePolicy(setOf("pdf"), setOf("application/pdf", "text/plain"), 1, ArchiveLimits(1, 1, 1.0)) }
            .isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { EvidencePolicy(setOf("pdf"), setOf("application/pdf"), EvidencePolicy.ABSOLUTE_MAXIMUM_BYTES + 1, ArchiveLimits(1, 1, 1.0)) }
            .isInstanceOf(IllegalArgumentException::class.java)
    }

    @ParameterizedTest(name = "accepts {0}")
    @MethodSource("cleanFixtures")
    fun `clean supported content is accepted`(name: String, bytes: ByteArray, expectedMediaType: String) {
        val path = write(name, bytes)

        val inspected = inspector().inspect(request(path, name, bytes, permissivePolicy()))

        assertThat(inspected.detectedMediaType).isEqualTo(expectedMediaType)
        assertThat(inspected.sizeBytes).isEqualTo(bytes.size.toLong())
        assertThat(inspected.sha256).isEqualTo(sha256(bytes))
        assertThat(inspected.scannerResult).isEqualTo(ScanResult.CLEAN)
    }

    @ParameterizedTest(name = "rejects {0} as {2}")
    @MethodSource("structuralRejections")
    fun `unsafe content fails closed`(name: String, bytes: ByteArray, code: EvidenceRejectionCode) {
        val path = write(name, bytes)

        assertRejected(code) {
            inspector().inspect(request(path, name, bytes, permissivePolicy()))
        }
    }

    @Test
    fun `wrong hash size and byte limit are rejected incrementally`() {
        val bytes = "bounded evidence".toByteArray()
        val path = write("evidence.txt", bytes)
        val cases = listOf(
            EvidenceRejectionCode.HASH_MISMATCH to request(path, "evidence.txt", bytes, permissivePolicy()).copy(expectedSha256 = "0".repeat(64)),
            EvidenceRejectionCode.SIZE_MISMATCH to request(path, "evidence.txt", bytes, permissivePolicy()).copy(expectedSizeBytes = bytes.size + 1L),
            EvidenceRejectionCode.FILE_TOO_LARGE to request(path, "evidence.txt", bytes, permissivePolicy(maximumBytes = 4)),
        )

        cases.forEach { (code, request) -> assertRejected(code) { inspector().inspect(request) } }
    }

    @Test
    fun `extension media policy and detected content must agree`() {
        val pdf = minimalPdf()
        val path = write("claim.txt", pdf)

        assertRejected(EvidenceRejectionCode.EXTENSION_MEDIA_MISMATCH) {
            inspector().inspect(request(path, "claim.txt", pdf, permissivePolicy()))
        }
        assertRejected(EvidenceRejectionCode.EXTENSION_NOT_ALLOWED) {
            inspector().inspect(request(path, "claim.pdf", pdf, textPolicy()))
        }
    }

    @Test
    fun `archive budgets reject entry expanded-size and compression-ratio bombs`() {
        val cases = listOf(
            EvidenceRejectionCode.ARCHIVE_ENTRY_LIMIT to zip("one.txt" to "1".toByteArray(), "two.txt" to "2".toByteArray()),
            EvidenceRejectionCode.ARCHIVE_EXPANDED_SIZE_LIMIT to zip("large.txt" to ByteArray(128) { 1 }),
            EvidenceRejectionCode.ARCHIVE_COMPRESSION_RATIO_LIMIT to zip("ratio.txt" to ByteArray(16 * 1024)),
        )
        val limits = listOf(
            ArchiveLimits(1, 1024, 100.0),
            ArchiveLimits(10, 64, 100.0),
            ArchiveLimits(10, 64 * 1024, 2.0),
        )

        cases.zip(limits).forEachIndexed { index, (fixture, archiveLimits) ->
            val name = "bomb-$index.zip"
            val path = write(name, fixture.second)
            assertRejected(fixture.first) {
                inspector().inspect(request(path, name, fixture.second, zipPolicy(archiveLimits)))
            }
        }
    }

    @Test
    fun `scanner infected error exception and expired deadline fail closed`() {
        listOf(
            "EICAR-STANDARD-ANTIVIRUS-TEST-FILE" to EvidenceRejectionCode.MALWARE_DETECTED,
            "SCANNER-ERROR-FIXTURE" to EvidenceRejectionCode.SCANNER_ERROR,
        ).forEachIndexed { index, (content, code) ->
            val bytes = content.toByteArray()
            val name = "scanner-$index.txt"
            val path = write(name, bytes)
            assertRejected(code) { inspector().inspect(request(path, name, bytes, textPolicy())) }
        }

        val clean = "clean".toByteArray()
        val cleanPath = write("clean.txt", clean)
        val crashing = EvidenceContentInspector(MalwareScanner { throw IllegalStateException("adapter output") }, clock)
        assertRejected(EvidenceRejectionCode.SCANNER_ERROR) {
            crashing.inspect(request(cleanPath, "clean.txt", clean, textPolicy()))
        }
        assertRejected(EvidenceRejectionCode.DEADLINE_EXCEEDED) {
            inspector().inspect(request(cleanPath, "clean.txt", clean, textPolicy()).copy(deadline = clock.instant()))
        }
    }

    @Test
    fun `scanner protocol has no permissive unknown state`() {
        assertThat(ScanResult.entries).containsExactly(ScanResult.CLEAN, ScanResult.INFECTED, ScanResult.ERROR)
    }

    private fun inspector() = EvidenceContentInspector(DeterministicMalwareScanner(), clock)

    private fun request(path: Path, name: String, bytes: ByteArray, policy: EvidencePolicy) = InspectionRequest(
        path = path,
        fileName = name,
        expectedSha256 = sha256(bytes),
        expectedSizeBytes = bytes.size.toLong(),
        policy = policy,
        deadline = deadline,
    )

    private fun permissivePolicy(maximumBytes: Long = 1024 * 1024) = EvidencePolicy(
        allowedExtensions = setOf("txt", "md", "pdf", "zip", "docx", "xlsx", "pptx"),
        allowedMediaTypes = setOf(
            "text/plain",
            "text/markdown",
            "application/pdf",
            "application/zip",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
        maximumBytes = maximumBytes,
        archiveLimits = ArchiveLimits(100, 2 * 1024 * 1024, 100.0),
    )

    private fun textPolicy() = EvidencePolicy(
        setOf("txt"),
        setOf("text/plain"),
        1024,
        ArchiveLimits(10, 1024, 20.0),
    )

    private fun zipPolicy(limits: ArchiveLimits) = EvidencePolicy(
        setOf("zip"),
        setOf("application/zip"),
        1024 * 1024,
        limits,
    )

    private fun write(name: String, bytes: ByteArray): Path = Files.write(tempDirectory.resolve(name), bytes)

    private fun assertRejected(code: EvidenceRejectionCode, action: () -> Unit) {
        assertThatThrownBy(action)
            .isInstanceOf(EvidenceRejectedException::class.java)
            .extracting("code")
            .isEqualTo(code)
    }

    companion object {
        @JvmStatic
        fun cleanFixtures(): Stream<Arguments> = Stream.of(
            Arguments.of("note.txt", "plain UTF-8 evidence\n".toByteArray(), "text/plain"),
            Arguments.of("note.md", "# Evidence\n".toByteArray(), "text/markdown"),
            Arguments.of("claim.pdf", minimalPdf(), "application/pdf"),
            Arguments.of("claim.docx", ooxml("word"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            Arguments.of("sheet.xlsx", ooxml("xl"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            Arguments.of("slides.pptx", ooxml("ppt"), "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
            Arguments.of("bundle.zip", zip("evidence.txt" to "safe".toByteArray()), "application/zip"),
            Arguments.of("pdf-bundle.zip", zip("folder/" to byteArrayOf(), "folder/claim.pdf" to minimalPdf()), "application/zip"),
            Arguments.of("utf8-boundary.txt", ("a".repeat(8191) + "\u20ac").toByteArray(), "text/plain"),
        )

        @JvmStatic
        fun structuralRejections(): Stream<Arguments> {
            val nested = zip("inside.txt" to "nested".toByteArray())
            return Stream.of(
                Arguments.of("image.png", byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), EvidenceRejectionCode.UNSUPPORTED_SIGNATURE),
                Arguments.of("image.gif", "GIF89a".toByteArray(), EvidenceRejectionCode.UNSUPPORTED_SIGNATURE),
                Arguments.of("polyglot.pdf", minimalPdf() + zip("payload.txt" to "x".toByteArray()), EvidenceRejectionCode.POLYGLOT),
                Arguments.of("image-polyglot.pdf", minimalPdf() + byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), EvidenceRejectionCode.POLYGLOT),
                Arguments.of("polyglot.zip", zip("payload.txt" to "x".toByteArray()) + minimalPdf(), EvidenceRejectionCode.POLYGLOT),
                Arguments.of("macro.docx", ooxml("word", "word/vbaProject.bin" to byteArrayOf(1)), EvidenceRejectionCode.OOXML_MACRO),
                Arguments.of("encrypted.docx", byteArrayOf(0xd0.toByte(), 0xcf.toByte(), 0x11, 0xe0.toByte(), 0xa1.toByte(), 0xb1.toByte(), 0x1a, 0xe1.toByte()) + "EncryptedPackage".toByteArray(), EvidenceRejectionCode.OOXML_ENCRYPTED),
                Arguments.of("encrypted.pdf", minimalPdf("/Encrypt 7 0 R"), EvidenceRejectionCode.PDF_ENCRYPTED),
                Arguments.of("active.pdf", minimalPdf("/OpenAction 7 0 R /JavaScript"), EvidenceRejectionCode.PDF_ACTIVE_CONTENT),
                Arguments.of("embedded.pdf", minimalPdf("/Type /EmbeddedFile"), EvidenceRejectionCode.PDF_ACTIVE_CONTENT),
                Arguments.of("traversal.zip", zip("../escape.txt" to "x".toByteArray()), EvidenceRejectionCode.ARCHIVE_TRAVERSAL),
                Arguments.of("nested.zip", zip("nested.zip" to nested), EvidenceRejectionCode.NESTED_ARCHIVE),
                Arguments.of("malformed.zip", byteArrayOf(0x50, 0x4b, 0x03, 0x04, 1, 2, 3), EvidenceRejectionCode.MALFORMED_ARCHIVE),
                Arguments.of("encrypted.zip", encryptedEmptyZip(), EvidenceRejectionCode.ARCHIVE_ENCRYPTED),
                Arguments.of("external.docx", ooxml("word", "word/_rels/document.xml.rels" to externalRelationship()), EvidenceRejectionCode.OOXML_ACTIVE_CONTENT),
            )
        }

        private fun minimalPdf(extra: String = ""): ByteArray = (
            "%PDF-1.4\n1 0 obj << /Type /Catalog $extra >> endobj\n" +
                "trailer << /Root 1 0 R >>\n%%EOF\n"
            ).toByteArray()

        private fun ooxml(root: String, vararg extraEntries: Pair<String, ByteArray>): ByteArray {
            val (extension, contentType, mainPart) = when (root) {
                "word" -> Triple("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", "word/document.xml")
                "xl" -> Triple("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", "xl/workbook.xml")
                else -> Triple("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml", "ppt/presentation.xml")
            }
            @Suppress("UNUSED_VARIABLE") val expectedExtension = extension
            val types = """<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/$mainPart" ContentType="$contentType"/></Types>""".toByteArray()
            val relationships = """<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>""".toByteArray()
            return zip(
                "[Content_Types].xml" to types,
                "_rels/.rels" to relationships,
                mainPart to "<root/>".toByteArray(),
                *extraEntries,
            )
        }

        private fun externalRelationship() = """<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="https://example.invalid" TargetMode="External" Type="x"/></Relationships>""".toByteArray()

        private fun zip(vararg entries: Pair<String, ByteArray>): ByteArray {
            val output = ByteArrayOutputStream()
            ZipOutputStream(output).use { zip ->
                entries.forEach { (name, bytes) ->
                    zip.putNextEntry(ZipEntry(name))
                    zip.write(bytes)
                    zip.closeEntry()
                }
            }
            return output.toByteArray()
        }

        private fun encryptedEmptyZip(): ByteArray = byteArrayOf(
            0x50, 0x4b, 0x03, 0x04, 20, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        )

        private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
    }
}
