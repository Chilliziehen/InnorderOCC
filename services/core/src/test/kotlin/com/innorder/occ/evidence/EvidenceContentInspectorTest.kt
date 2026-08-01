package com.innorder.occ.evidence

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.apache.pdfbox.pdmodel.PDDocument
import org.apache.pdfbox.pdmodel.PDPage
import org.apache.pdfbox.pdmodel.PDPageContentStream
import org.apache.pdfbox.pdmodel.encryption.AccessPermission
import org.apache.pdfbox.pdmodel.encryption.StandardProtectionPolicy
import org.apache.pdfbox.pdmodel.graphics.image.JPEGFactory
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import java.io.ByteArrayOutputStream
import java.awt.image.BufferedImage
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import java.util.stream.Stream
import java.util.zip.DeflaterOutputStream
import java.util.zip.GZIPOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
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
        assertThat(inspected.scannerResult.status).isEqualTo(ScanStatus.CLEAN)
        assertThat(inspected.scannerResult.engine).isEqualTo("deterministic-test-scanner")
        assertThat(inspected.scannerResult.engineVersion).isEqualTo("1.0")
        assertThat(inspected.scannerResult.reference).isEqualTo("fixture-clean")
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
        val crashing = EvidenceContentInspector(ScannerSandbox { throw IllegalStateException("adapter output") }, DeterministicParserSandbox(clock), clock)
        assertRejected(EvidenceRejectionCode.SCANNER_ERROR) {
            crashing.inspect(request(cleanPath, "clean.txt", clean, textPolicy()))
        }
        val codeInjecting = EvidenceContentInspector(
            ScannerSandbox { throw EvidenceRejectedException(EvidenceRejectionCode.PDF_ACTIVE_CONTENT) },
            DeterministicParserSandbox(clock),
            clock,
        )
        assertRejected(EvidenceRejectionCode.SCANNER_ERROR) {
            codeInjecting.inspect(request(cleanPath, "clean.txt", clean, textPolicy()))
        }
        assertRejected(EvidenceRejectionCode.DEADLINE_EXCEEDED) {
            inspector().inspect(request(cleanPath, "clean.txt", clean, textPolicy()).copy(deadline = clock.instant()))
        }
    }

    @Test
    fun `scanner protocol has only bounded provenance-bearing states`() {
        assertThat(ScanStatus.entries).containsExactly(ScanStatus.CLEAN, ScanStatus.INFECTED, ScanStatus.ERROR)
        assertThatThrownBy { ScanResult(ScanStatus.CLEAN, "", "1", "clean") }
            .isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { ScanResult(ScanStatus.CLEAN, "engine", "1", "x".repeat(257)) }
            .isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { ScanResult(ScanStatus.ERROR, "engine", "1", "unsafe\nreference") }
            .isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `deadline expiration during UTF-8 classification is not converted to unsupported content`() {
        val bytes = "plain text".toByteArray()
        val path = write("deadline.txt", bytes)
        val expiringClock = StepClock(clock.instant(), expireAfterCalls = 3)

        assertRejected(EvidenceRejectionCode.DEADLINE_EXCEEDED) {
            EvidenceContentInspector(DeterministicMalwareScanner(), DeterministicParserSandbox(expiringClock), expiringClock).inspect(
                request(path, "deadline.txt", bytes, textPolicy()),
            )
        }
    }

    @ParameterizedTest(name = "rejects nested {0} magic without archive filename")
    @MethodSource("nestedArchiveMagic")
    fun `nested archives are detected by content signature`(type: String, nestedBytes: ByteArray) {
        val bytes = zip("payload.bin" to nestedBytes)
        val path = write("nested-$type.zip", bytes)

        assertRejected(EvidenceRejectionCode.NESTED_ARCHIVE) {
            inspector().inspect(request(path, "nested-$type.zip", bytes, zipPolicy(ArchiveLimits(10, 1024 * 1024, 100.0))))
        }
    }

    @ParameterizedTest(name = "rejects structurally valid nested ZIP with {0}")
    @MethodSource("nestedZipStructuralVariants")
    fun `nested ZIP detection does not require supported decompression`(type: String, nestedBytes: ByteArray) {
        val bytes = zip("neutral/payload.bin" to nestedBytes)
        val path = write("nested-structural-$type.zip", bytes)

        assertRejected(EvidenceRejectionCode.NESTED_ARCHIVE) {
            inspector().inspect(
                request(path, "nested-structural-$type.zip", bytes, zipPolicy(ArchiveLimits(10, 1024 * 1024, 100.0))),
            )
        }
    }

    @Test
    fun `inconsistent ZIP local record is ordinary binary rather than a nested archive`() {
        val malformed = zip("inside.bin" to "payload".toByteArray()).copyOf().also {
            it[18] = (it[18].toInt() + 1).toByte()
        }
        val bytes = zip("neutral/payload.bin" to malformed)
        val path = write("malformed-nested-record.zip", bytes)

        val result = inspector().inspect(
            request(path, "malformed-nested-record.zip", bytes, zipPolicy(ArchiveLimits(10, 1024 * 1024, 100.0))),
        )

        assertThat(result.detectedMediaType).isEqualTo("application/zip")
    }

    @Test
    fun `valid neutral-name ZIP64 entry is detected structurally`() {
        val nested = zip64("inside.bin", "payload".toByteArray())
        val nestedPath = write("valid-small.zip", nested)
        ZipFile(nestedPath.toFile()).use { archive ->
            assertThat(archive.getInputStream(archive.getEntry("inside.bin")).readAllBytes()).isEqualTo("payload".toByteArray())
        }
        val bytes = zip("neutral/payload.bin" to nested)
        val path = write("nested-zip64.zip", bytes)

        assertRejected(EvidenceRejectionCode.NESTED_ARCHIVE) {
            inspector().inspect(request(path, "nested-zip64.zip", bytes, zipPolicy(ArchiveLimits(10, 1024 * 1024, 100.0))))
        }
    }

    @Test
    fun `uncorroborated ZIP64 sentinels are ordinary binary`() {
        val valid = zip64("inside.bin", "payload".toByteArray())
        val malformed = listOf(
            valid.copyOf().also { it.writeLittleEndianLong(it.size - 34, 1_000_000L) },
            "PK\u0003\u0004 random \uffff\uffff PK\u0006\u0006 PK\u0006\u0007".toByteArray(Charsets.ISO_8859_1),
        )

        malformed.forEachIndexed { index, nested ->
            val bytes = zip("neutral/payload.bin" to nested)
            val path = write("malformed-zip64-$index.zip", bytes)
            val result = inspector().inspect(
                request(path, "malformed-zip64-$index.zip", bytes, zipPolicy(ArchiveLimits(10, 1024 * 1024, 100.0))),
            )
            assertThat(result.detectedMediaType).isEqualTo("application/zip")
        }
    }

    @Test
    fun `ordinary binary entries containing short archive magic are accepted`() {
        val incidental = byteArrayOf(0x01, 0x02, 0x1f, 0x8b.toByte(), 0x08, 0x00, 0x03, 0x04) +
            "BZh Rar!\u001a\u0007 PK\u0003\u0004".toByteArray(Charsets.ISO_8859_1)
        val bytes = zip("image-data.bin" to incidental)
        val path = write("incidental.zip", bytes)

        val result = inspector().inspect(request(path, "incidental.zip", bytes, zipPolicy(ArchiveLimits(10, 1024 * 1024, 100.0))))

        assertThat(result.detectedMediaType).isEqualTo("application/zip")
    }

    @Test
    fun `OOXML metadata and main parts require exact namespaces and unqualified attributes`() {
        val contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
        val validOverride = "<Override PartName=\"/word/document.xml\" ContentType=\"$contentType\"/>"
        val attacks = listOf(
            "<Types xmlns=\"urn:wrong\">$validOverride</Types>" to rootRelationships("word/document.xml"),
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><x:Override xmlns:x=\"urn:wrong\" PartName=\"/word/document.xml\" ContentType=\"$contentType\"/></Types>" to rootRelationships("word/document.xml"),
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override xmlns:x=\"urn:shadow\" PartName=\"/word/document.xml\" x:ContentType=\"$contentType\"/></Types>" to rootRelationships("word/document.xml"),
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override xmlns:x=\"urn:shadow\" PartName=\"/word/document.xml\" ContentType=\"$contentType\" x:ContentType=\"$contentType\"/></Types>" to rootRelationships("word/document.xml"),
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">$validOverride</Types>" to "<Relationships xmlns=\"urn:wrong\"><Relationship Id=\"r\" Target=\"word/document.xml\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\"/></Relationships>".toByteArray(),
        )

        attacks.forEachIndexed { index, (types, relationships) ->
            val bytes = zip(
                "[Content_Types].xml" to types.toByteArray(),
                "_rels/.rels" to relationships,
                "word/document.xml" to mainXml("word"),
            )
            val path = write("namespace-$index.docx", bytes)
            assertRejected(EvidenceRejectionCode.MALFORMED_ARCHIVE) {
                inspector().inspect(request(path, "namespace-$index.docx", bytes, permissivePolicy()))
            }
        }

        val wrongMain = ooxmlPackage("word", rootRelationships("word/document.xml"), "<document xmlns=\"urn:wrong\"/>".toByteArray())
        val wrongMainPath = write("wrong-main-namespace.docx", wrongMain)
        assertRejected(EvidenceRejectionCode.MALFORMED_ARCHIVE) {
            inspector().inspect(request(wrongMainPath, "wrong-main-namespace.docx", wrongMain, permissivePolicy()))
        }
    }

    @ParameterizedTest(name = "rejects OOXML bypass {0}")
    @MethodSource("ooxmlActiveContentBypasses")
    fun `OOXML active content declarations and internal relationships fail closed`(
        name: String,
        bytes: ByteArray,
        code: EvidenceRejectionCode,
    ) {
        val path = write("$name.docx", bytes)

        assertRejected(code) {
            inspector().inspect(request(path, "$name.docx", bytes, permissivePolicy()))
        }
    }

    @ParameterizedTest(name = "rejects prefixed {0}")
    @MethodSource("prefixedArchiveMagic")
    fun `nested archive signatures are detected after bounded executable prefixes`(type: String, nestedBytes: ByteArray) {
        val bytes = zip("neutral/payload.bin" to nestedBytes)
        val path = write("prefixed-$type.zip", bytes)

        assertRejected(EvidenceRejectionCode.NESTED_ARCHIVE) {
            inspector().inspect(request(path, "prefixed-$type.zip", bytes, zipPolicy(ArchiveLimits(10, 1024 * 1024, 100.0))))
        }
    }

    @Test
    fun `deadline is enforced during bounded OOXML parsing before scanning`() {
        val mainXml = ("<root>" + "<node/>".repeat(200) + "</root>").toByteArray()
        val bytes = ooxmlPackage("word", rootRelationships("word/document.xml"), mainXml)
        val path = write("deadline.docx", bytes)
        val scannerCalled = AtomicBoolean()
        val expiringClock = StepClock(clock.instant(), expireAfterCalls = 40)
        val deadlineInspector = EvidenceContentInspector(
            ScannerSandbox {
                scannerCalled.set(true)
                ScanResult(ScanStatus.CLEAN, "test", "1", "clean")
            },
            DeterministicParserSandbox(expiringClock),
            expiringClock,
        )

        assertRejected(EvidenceRejectionCode.DEADLINE_EXCEEDED) {
            deadlineInspector.inspect(request(path, "deadline.docx", bytes, permissivePolicy()))
        }
        assertThat(scannerCalled).isFalse()
    }

    @Test
    fun `inspector delegates hostile formats without direct parsing`() {
        val malformedPdf = "%PDF-1.7\nnot structurally valid".toByteArray()
        val path = write("delegated.pdf", malformedPdf)
        val requests = mutableListOf<ParserSandboxRequest>()
        val acceptingSandbox = ParserSandbox { request ->
            requests += request
            ParserSandboxResult.Accepted("application/pdf")
        }

        val result = EvidenceContentInspector(DeterministicMalwareScanner(), acceptingSandbox, clock)
            .inspect(request(path, "delegated.pdf", malformedPdf, permissivePolicy()))

        assertThat(result.detectedMediaType).isEqualTo("application/pdf")
        assertThat(requests).hasSize(1)
    }

    private fun inspector() = EvidenceContentInspector(DeterministicMalwareScanner(), DeterministicParserSandbox(clock), clock)

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

    private class StepClock(
        private val base: Instant,
        private val expireAfterCalls: Int,
    ) : Clock() {
        private val calls = AtomicInteger()

        override fun getZone() = ZoneOffset.UTC
        override fun withZone(zone: java.time.ZoneId): Clock = this
        override fun instant(): Instant = if (calls.incrementAndGet() > expireAfterCalls) base.plus(Duration.ofHours(1)) else base
    }

    companion object {
        @JvmStatic
        fun cleanFixtures(): Stream<Arguments> = Stream.of(
            Arguments.of("note.txt", "plain UTF-8 evidence\n".toByteArray(), "text/plain"),
            Arguments.of("note.md", "# Evidence\n".toByteArray(), "text/markdown"),
            Arguments.of("claim.pdf", minimalPdf(), "application/pdf"),
            Arguments.of("jpeg-image.pdf", jpegPdf(), "application/pdf"),
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
                Arguments.of("encrypted.pdf", encryptedPdf(), EvidenceRejectionCode.PDF_ENCRYPTED),
                Arguments.of("active.pdf", minimalPdf("/OpenAction << /S /JavaScript /JS (alert) >>"), EvidenceRejectionCode.PDF_ACTIVE_CONTENT),
                Arguments.of("escaped-action.pdf", minimalPdf("/Open#41ction << /S /Java#53cript /J#53 (alert) >>"), EvidenceRejectionCode.PDF_ACTIVE_CONTENT),
                Arguments.of("compressed-action.pdf", compressedActionPdf(), EvidenceRejectionCode.PDF_ACTIVE_CONTENT),
                Arguments.of("embedded.pdf", minimalPdf("/Names << /EmbeddedFiles << /Names [] >> >>"), EvidenceRejectionCode.PDF_ACTIVE_CONTENT),
                Arguments.of("malformed.pdf", "%PDF-1.7\n1 0 obj << /Type /Catalog >>".toByteArray(), EvidenceRejectionCode.MALFORMED_PDF),
                Arguments.of("flate-bomb.pdf", pdfWithStream(ByteArray(64 * 1024)), EvidenceRejectionCode.ARCHIVE_COMPRESSION_RATIO_LIMIT),
                Arguments.of("traversal.zip", zip("../escape.txt" to "x".toByteArray()), EvidenceRejectionCode.ARCHIVE_TRAVERSAL),
                Arguments.of("nested.zip", zip("nested.zip" to nested), EvidenceRejectionCode.NESTED_ARCHIVE),
                Arguments.of("malformed.zip", byteArrayOf(0x50, 0x4b, 0x03, 0x04, 1, 2, 3), EvidenceRejectionCode.MALFORMED_ARCHIVE),
                Arguments.of("encrypted.zip", encryptedEmptyZip(), EvidenceRejectionCode.ARCHIVE_ENCRYPTED),
                Arguments.of("external.docx", ooxml("word", "word/_rels/document.xml.rels" to externalRelationship()), EvidenceRejectionCode.OOXML_ACTIVE_CONTENT),
                Arguments.of("implicit-external.docx", ooxml("word", "word/_rels/document.xml.rels" to implicitExternalRelationship()), EvidenceRejectionCode.OOXML_ACTIVE_CONTENT),
                Arguments.of("missing-root-rels.docx", ooxmlPackage("word", rootRelationships = null), EvidenceRejectionCode.MALFORMED_ARCHIVE),
                Arguments.of("wrong-root-target.docx", ooxmlPackage("word", rootRelationships = rootRelationships("wrong/document.xml")), EvidenceRejectionCode.MALFORMED_ARCHIVE),
                Arguments.of("wrong-content-part.docx", ooxmlPackage("word", rootRelationships("word/document.xml"), contentPart = "wrong/document.xml"), EvidenceRejectionCode.MALFORMED_ARCHIVE),
                Arguments.of("malformed-root-rels.docx", ooxmlPackage("word", rootRelationships = "<Relationships><Relationship".toByteArray()), EvidenceRejectionCode.MALFORMED_ARCHIVE),
                Arguments.of("malformed-main.docx", ooxmlPackage("word", rootRelationships("word/document.xml"), "<document>".toByteArray()), EvidenceRejectionCode.MALFORMED_ARCHIVE),
                Arguments.of("doctype-main.docx", ooxmlPackage("word", rootRelationships("word/document.xml"), "<!DOCTYPE root [<!ENTITY x 'x'>]><root>&x;</root>".toByteArray()), EvidenceRejectionCode.MALFORMED_ARCHIVE),
                Arguments.of("deep-main.docx", ooxmlPackage("word", rootRelationships("word/document.xml"), ("<a>".repeat(65) + "</a>".repeat(65)).toByteArray()), EvidenceRejectionCode.MALFORMED_ARCHIVE),
            )
        }

        @JvmStatic
        fun nestedArchiveMagic(): Stream<Arguments> = Stream.of(
            Arguments.of("zip", zip("inside.txt" to "nested".toByteArray())),
            Arguments.of("empty-zip", zip()),
            Arguments.of("gzip", gzip("nested".toByteArray())),
            Arguments.of("7z", sevenZipHeader()),
            Arguments.of("rar", rarHeader()),
            Arguments.of("tar", tar("inside.txt", "nested".toByteArray())),
            Arguments.of("xz", xzHeader()),
            Arguments.of("bzip2", bzipHeader()),
        )

        @JvmStatic
        fun nestedZipStructuralVariants(): Stream<Arguments> {
            val ordinary = zip("inside.bin" to "payload".toByteArray())
            return Stream.of(
                Arguments.of("encrypted flag", patchZipHeaders(ordinary, flags = 1, method = null)),
                Arguments.of("unsupported method", patchZipHeaders(ordinary, flags = null, method = 99)),
            )
        }

        @JvmStatic
        fun prefixedArchiveMagic(): Stream<Arguments> {
            val prefix = "MZ".toByteArray() + ByteArray(2048) { ((it * 31) xor (it ushr 3)).toByte() }
            return Stream.of(
                Arguments.of("self-extracting-zip", prefix + zip("inside.txt" to "x".toByteArray())),
                Arguments.of("empty-zip", prefix + zip()),
            )
        }

        @JvmStatic
        fun ooxmlActiveContentBypasses(): Stream<Arguments> = Stream.of(
            Arguments.of(
                "default-vba",
                ooxmlBypass(defaultContentType = "application/vnd.ms-office.vbaProject"),
                EvidenceRejectionCode.OOXML_MACRO,
            ),
            Arguments.of(
                "default-ole",
                ooxmlBypass(defaultContentType = "application/vnd.openxmlformats-officedocument.oleObject"),
                EvidenceRejectionCode.OOXML_ACTIVE_CONTENT,
            ),
            Arguments.of(
                "default-active-x",
                ooxmlBypass(defaultContentType = "application/vnd.ms-office.activeX+xml"),
                EvidenceRejectionCode.OOXML_ACTIVE_CONTENT,
            ),
            Arguments.of(
                "default-package",
                ooxmlBypass(defaultContentType = "application/vnd.openxmlformats-officedocument.package"),
                EvidenceRejectionCode.OOXML_ACTIVE_CONTENT,
            ),
            Arguments.of(
                "relationship-vba",
                ooxmlBypass(relationshipType = "http://schemas.microsoft.com/office/2006/relationships/vbaProject"),
                EvidenceRejectionCode.OOXML_MACRO,
            ),
            Arguments.of(
                "relationship-ole",
                ooxmlBypass(relationshipType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject"),
                EvidenceRejectionCode.OOXML_ACTIVE_CONTENT,
            ),
            Arguments.of(
                "relationship-active-x",
                ooxmlBypass(relationshipType = "http://schemas.microsoft.com/office/2006/relationships/activeXControl"),
                EvidenceRejectionCode.OOXML_ACTIVE_CONTENT,
            ),
            Arguments.of(
                "relationship-package",
                ooxmlBypass(relationshipType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/package"),
                EvidenceRejectionCode.OOXML_ACTIVE_CONTENT,
            ),
            Arguments.of(
                "relationship-target",
                ooxmlBypass(relationshipTarget = "hidden/embeddings/payload.dat"),
                EvidenceRejectionCode.OOXML_ACTIVE_CONTENT,
            ),
        )

        private fun minimalPdf(extra: String = ""): ByteArray = traditionalPdf(
            linkedMapOf(
                1 to "<< /Type /Catalog /Pages 2 0 R $extra >>".toByteArray(),
                2 to "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".toByteArray(),
                3 to "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>".toByteArray(),
                4 to "<< /Length 0 >>\nstream\n\nendstream".toByteArray(),
            ),
        )

        private fun pdfWithStream(expanded: ByteArray): ByteArray {
            val compressed = deflate(expanded)
            return traditionalPdf(
                linkedMapOf(
                    1 to "<< /Type /Catalog /Pages 2 0 R >>".toByteArray(),
                    2 to "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".toByteArray(),
                    3 to "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>".toByteArray(),
                    4 to streamObject("/Filter /FlateDecode", compressed),
                ),
            )
        }

        private fun traditionalPdf(objects: LinkedHashMap<Int, ByteArray>): ByteArray {
            val output = ByteArrayOutputStream()
            output.write("%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n".toByteArray(Charsets.ISO_8859_1))
            val offsets = mutableMapOf<Int, Int>()
            objects.forEach { (number, body) ->
                offsets[number] = output.size()
                output.write("$number 0 obj\n".toByteArray())
                output.write(body)
                output.write("\nendobj\n".toByteArray())
            }
            val xrefOffset = output.size()
            val size = (objects.keys.maxOrNull() ?: 0) + 1
            output.write("xref\n0 $size\n".toByteArray())
            output.write("0000000000 65535 f \n".toByteArray())
            for (number in 1 until size) {
                val offset = offsets[number]
                output.write(if (offset == null) "0000000000 00000 f \n".toByteArray() else "%010d 00000 n \n".format(offset).toByteArray())
            }
            output.write("trailer\n<< /Size $size /Root 1 0 R >>\nstartxref\n$xrefOffset\n%%EOF\n".toByteArray())
            return output.toByteArray()
        }

        private fun compressedActionPdf(): ByteArray {
            val output = ByteArrayOutputStream()
            output.write("%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n".toByteArray(Charsets.ISO_8859_1))
            val offsets = mutableMapOf<Int, Int>()
            fun writeObject(number: Int, body: ByteArray) {
                offsets[number] = output.size()
                output.write("$number 0 obj\n".toByteArray())
                output.write(body)
                output.write("\nendobj\n".toByteArray())
            }
            writeObject(1, "<< /Type /Catalog /Pages 2 0 R >>".toByteArray())
            writeObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".toByteArray())
            writeObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Annots [5 0 R] >>".toByteArray())
            writeObject(4, "<< /Length 0 >>\nstream\n\nendstream".toByteArray())
            val objectBody = "5 0 << /Type /Annot /Subtype /Link /A << /S /Java#53cript /J#53 (alert) >> >>".toByteArray()
            writeObject(6, streamObject("/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", deflate(objectBody)))
            val xrefOffset = output.size()
            val xref = ByteArrayOutputStream()
            writeXrefEntry(xref, 0, 0, 65_535)
            for (number in 1..4) writeXrefEntry(xref, 1, offsets.getValue(number), 0)
            writeXrefEntry(xref, 2, 6, 0)
            writeXrefEntry(xref, 1, offsets.getValue(6), 0)
            writeXrefEntry(xref, 1, xrefOffset, 0)
            val xrefBytes = xref.toByteArray()
            writeObject(7, streamObject("/Type /XRef /Size 8 /Root 1 0 R /W [1 4 2] /Index [0 8]", xrefBytes))
            output.write("startxref\n$xrefOffset\n%%EOF\n".toByteArray())
            return output.toByteArray()
        }

        private fun writeXrefEntry(output: ByteArrayOutputStream, type: Int, field2: Int, field3: Int) {
            output.write(type)
            output.write(byteArrayOf((field2 ushr 24).toByte(), (field2 ushr 16).toByte(), (field2 ushr 8).toByte(), field2.toByte()))
            output.write(byteArrayOf((field3 ushr 8).toByte(), field3.toByte()))
        }

        private fun streamObject(dictionary: String, bytes: ByteArray): ByteArray =
            "<< $dictionary /Length ${bytes.size} >>\nstream\n".toByteArray() + bytes + "\nendstream".toByteArray()

        private fun deflate(bytes: ByteArray): ByteArray {
            val output = ByteArrayOutputStream()
            DeflaterOutputStream(output).use { it.write(bytes) }
            return output.toByteArray()
        }

        private fun gzip(bytes: ByteArray): ByteArray = ByteArrayOutputStream().also { output ->
            GZIPOutputStream(output).use { it.write(bytes) }
        }.toByteArray()

        private fun tar(name: String, bytes: ByteArray): ByteArray {
            val header = ByteArray(512)
            name.toByteArray().copyInto(header, endIndex = minOf(name.length, 100))
            "0000777\u0000".toByteArray().copyInto(header, 100)
            "0000000\u0000".toByteArray().copyInto(header, 108)
            "0000000\u0000".toByteArray().copyInto(header, 116)
            "%011o\u0000".format(bytes.size).toByteArray().copyInto(header, 124)
            "00000000000\u0000".toByteArray().copyInto(header, 136)
            repeat(8) { header[148 + it] = 0x20 }
            header[156] = '0'.code.toByte()
            "ustar\u0000".toByteArray().copyInto(header, 257)
            "00".toByteArray().copyInto(header, 263)
            val checksum = header.sumOf { (it.toInt() and 0xff) }
            "%06o\u0000 ".format(checksum).toByteArray().copyInto(header, 148)
            return header + bytes + ByteArray((512 - bytes.size % 512) % 512) + ByteArray(1024)
        }

        private fun sevenZipHeader(): ByteArray = ByteArray(32).apply {
            byteArrayOf(0x37, 0x7a, 0xbc.toByte(), 0xaf.toByte(), 0x27, 0x1c, 0, 4).copyInto(this)
            val crc = java.util.zip.CRC32().also { it.update(this, 12, 20) }.value
            writeLittleEndian(crc, this, 8)
        }

        private fun xzHeader(): ByteArray = ByteArray(12).apply {
            byteArrayOf(0xfd.toByte(), 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x01).copyInto(this)
            val crc = java.util.zip.CRC32().also { it.update(this, 6, 2) }.value
            writeLittleEndian(crc, this, 8)
        }

        private fun rarHeader(): ByteArray = (
            "Rar!\u001a\u0007\u0000".toByteArray(Charsets.ISO_8859_1) + byteArrayOf(0, 0, 0x73, 0, 0, 7, 0)
        ).apply {
            val crc = java.util.zip.CRC32().also { it.update(this, 9, 5) }.value.toInt()
            this[7] = crc.toByte()
            this[8] = (crc ushr 8).toByte()
        }

        private fun bzipHeader(): ByteArray = "BZh9".toByteArray() + byteArrayOf(0x31, 0x41, 0x59, 0x26, 0x53, 0x59)

        private fun writeLittleEndian(value: Long, target: ByteArray, offset: Int) {
            for (index in 0 until 4) target[offset + index] = (value ushr (index * 8)).toByte()
        }

        private fun encryptedPdf(): ByteArray {
            val output = ByteArrayOutputStream()
            PDDocument().use { document ->
                document.addPage(PDPage())
                document.protect(StandardProtectionPolicy("owner-secret", "user-secret", AccessPermission()))
                document.save(output)
            }
            return output.toByteArray()
        }

        private fun jpegPdf(): ByteArray {
            val output = ByteArrayOutputStream()
            PDDocument().use { document ->
                val page = PDPage()
                document.addPage(page)
                val image = BufferedImage(8, 8, BufferedImage.TYPE_INT_RGB).apply {
                    for (x in 0 until width) for (y in 0 until height) setRGB(x, y, (x * 31 shl 16) or (y * 31 shl 8))
                }
                val jpeg = JPEGFactory.createFromImage(document, image, 0.8f)
                PDPageContentStream(document, page).use { it.drawImage(jpeg, 10f, 10f, 50f, 50f) }
                document.save(output)
            }
            return output.toByteArray()
        }

        private fun ooxml(root: String, vararg extraEntries: Pair<String, ByteArray>): ByteArray {
            val (extension, contentType, mainPart) = when (root) {
                "word" -> Triple("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", "word/document.xml")
                "xl" -> Triple("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", "xl/workbook.xml")
                else -> Triple("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml", "ppt/presentation.xml")
            }
            @Suppress("UNUSED_VARIABLE") val expectedExtension = extension
            val types = """<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/$mainPart" ContentType="$contentType"/></Types>""".toByteArray()
            return zip(
                "[Content_Types].xml" to types,
                "_rels/.rels" to rootRelationships(mainPart),
                mainPart to mainXml(root),
                *extraEntries,
            )
        }

        private fun ooxmlPackage(
            root: String,
            rootRelationships: ByteArray?,
            mainXml: ByteArray = mainXml(root),
            contentPart: String? = null,
        ): ByteArray {
            val (contentType, mainPart) = when (root) {
                "word" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" to "word/document.xml"
                "xl" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" to "xl/workbook.xml"
                else -> "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml" to "ppt/presentation.xml"
            }
            val declaredPart = contentPart ?: mainPart
            val entries = mutableListOf(
                "[Content_Types].xml" to """<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/$declaredPart" ContentType="$contentType"/></Types>""".toByteArray(),
                mainPart to mainXml,
            )
            rootRelationships?.let { entries += "_rels/.rels" to it }
            return zip(*entries.toTypedArray())
        }

        private fun ooxmlBypass(
            defaultContentType: String? = null,
            relationshipType: String? = null,
            relationshipTarget: String = "neutral/payload.dat",
        ): ByteArray {
            val default = defaultContentType?.let { "<Default Extension=\"dat\" ContentType=\"$it\"/>" }.orEmpty()
            val types = """<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">$default<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>""".toByteArray()
            val maliciousRelationship = relationshipType?.let {
                """<Relationship Id="active" Target="$relationshipTarget" Type="$it"/>"""
            }.orEmpty()
            val relationships = """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Target="word/document.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/>$maliciousRelationship</Relationships>""".toByteArray()
            val partRelationships = if (relationshipType == null && relationshipTarget != "neutral/payload.dat") {
                """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="active" Target="$relationshipTarget" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/></Relationships>""".toByteArray()
            } else {
                """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>""".toByteArray()
            }
            return zip(
                "[Content_Types].xml" to types,
                "_rels/.rels" to relationships,
                "word/document.xml" to mainXml("word"),
                "word/_rels/document.xml.rels" to partRelationships,
                "neutral/payload.dat" to "payload".toByteArray(),
            )
        }

        private fun rootRelationships(target: String) = """<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="$target" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/></Relationships>""".toByteArray()

        private fun mainXml(root: String): ByteArray = when (root) {
            "word" -> "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"/>"
            "xl" -> "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"/>"
            else -> "<p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"/>"
        }.toByteArray()

        private fun externalRelationship() = """<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="https://example.invalid" TargetMode="External" Type="x"/></Relationships>""".toByteArray()

        private fun implicitExternalRelationship() = """<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="https://example.invalid" Type="x"/></Relationships>""".toByteArray()

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

        private fun patchZipHeaders(bytes: ByteArray, flags: Int?, method: Int?): ByteArray = bytes.copyOf().also { patched ->
            val central = patched.indexOfSignature(byteArrayOf(0x50, 0x4b, 0x01, 0x02))
            require(central >= 0)
            flags?.let {
                patched.writeLittleEndianShort(6, patched.readLittleEndianShort(6) or it)
                patched.writeLittleEndianShort(central + 8, patched.readLittleEndianShort(central + 8) or it)
            }
            method?.let {
                patched.writeLittleEndianShort(8, it)
                patched.writeLittleEndianShort(central + 10, it)
            }
        }

        private fun ByteArray.indexOfSignature(signature: ByteArray): Int =
            (0..size - signature.size).firstOrNull { offset -> signature.indices.all { this[offset + it] == signature[it] } } ?: -1

        private fun ByteArray.writeLittleEndianShort(offset: Int, value: Int) {
            this[offset] = value.toByte()
            this[offset + 1] = (value ushr 8).toByte()
        }

        private fun ByteArray.readLittleEndianShort(offset: Int): Int =
            (this[offset].toInt() and 0xff) or ((this[offset + 1].toInt() and 0xff) shl 8)

        private fun zip64(name: String, data: ByteArray): ByteArray {
            val output = ByteArrayOutputStream()
            val nameBytes = name.toByteArray()
            val crc = java.util.zip.CRC32().also { it.update(data) }.value
            fun short(value: Int) = output.write(byteArrayOf(value.toByte(), (value ushr 8).toByte()))
            fun int(value: Long) = output.write(ByteArray(4) { index -> (value ushr (index * 8)).toByte() })
            fun long(value: Long) = output.write(ByteArray(8) { index -> (value ushr (index * 8)).toByte() })

            int(0x04034b50)
            short(45); short(0); short(0); short(0); short(0)
            int(crc); int(0xffff_ffffL); int(0xffff_ffffL)
            short(nameBytes.size); short(20)
            output.write(nameBytes)
            short(0x0001); short(16); long(data.size.toLong()); long(data.size.toLong())
            output.write(data)

            val centralOffset = output.size().toLong()
            int(0x02014b50)
            short(45); short(45); short(0); short(0); short(0); short(0)
            int(crc); int(0xffff_ffffL); int(0xffff_ffffL)
            short(nameBytes.size); short(28); short(0); short(0); short(0); int(0); int(0xffff_ffffL)
            output.write(nameBytes)
            short(0x0001); short(24); long(data.size.toLong()); long(data.size.toLong()); long(0)
            val centralSize = output.size().toLong() - centralOffset

            val zip64EndOffset = output.size().toLong()
            int(0x06064b50); long(44); short(45); short(45); int(0); int(0)
            long(1); long(1); long(centralSize); long(centralOffset)
            int(0x07064b50); int(0); long(zip64EndOffset); int(1)
            int(0x06054b50); short(0); short(0); short(0xffff); short(0xffff)
            int(0xffff_ffffL); int(0xffff_ffffL); short(0)
            return output.toByteArray()
        }

        private fun ByteArray.writeLittleEndianLong(offset: Int, value: Long) {
            for (index in 0 until 8) this[offset + index] = (value ushr (index * 8)).toByte()
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
