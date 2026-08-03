package com.innorder.occ.evidence

import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.time.Instant

fun interface ScannerSandbox {
    fun scan(request: ScanRequest): ScanResult
}

data class ScanRequest(
    val path: Path,
    val sizeBytes: Long,
    val sha256: String,
    val detectedMediaType: String,
    val deadline: Instant,
) {
    init {
        require(sizeBytes >= 0)
        require(SHA256.matches(sha256))
        require(MEDIA_TYPE.matches(detectedMediaType))
    }

    companion object {
        private val SHA256 = Regex("^[0-9a-f]{64}$")
        private val MEDIA_TYPE = Regex("^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$")
    }
}

enum class ScanStatus {
    CLEAN,
    INFECTED,
    ERROR,
}

data class ScanResult(
    val status: ScanStatus,
    val engine: String,
    val engineVersion: String,
    val reference: String,
) {
    init {
        require(IDENTIFIER.matches(engine))
        require(IDENTIFIER.matches(engineVersion))
        require(reference.length in 1..256 && reference.all { it.code in 0x20..0x7e })
    }

    companion object {
        private val IDENTIFIER = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
    }
}

internal object ScannerSandboxProtocol {
    private const val REQUEST_MAGIC = 0x4f435351
    private const val RESULT_MAGIC = 0x4f435352
    private const val VERSION = 1
    private const val MAXIMUM_STRING_BYTES = 4096

    fun writeRequest(output: OutputStream, request: ScanRequest) {
        DataOutputStream(output).use { data ->
            data.writeInt(REQUEST_MAGIC)
            data.writeInt(VERSION)
            data.writeString(request.path.toAbsolutePath().normalize().toString())
            data.writeLong(request.sizeBytes)
            data.writeString(request.sha256)
            data.writeString(request.detectedMediaType)
            data.writeLong(request.deadline.epochSecond)
            data.writeInt(request.deadline.nano)
        }
    }

    fun readRequest(input: InputStream): ScanRequest = DataInputStream(input).use { data ->
        require(data.readInt() == REQUEST_MAGIC && data.readInt() == VERSION)
        val request = ScanRequest(
            Path.of(data.readString()),
            data.readLong(),
            data.readString(),
            data.readString(),
            Instant.ofEpochSecond(data.readLong(), data.readInt().toLong()),
        )
        require(data.read() < 0)
        request
    }

    fun writeResult(output: OutputStream, result: ScanResult) {
        DataOutputStream(output).use { data ->
            data.writeInt(RESULT_MAGIC)
            data.writeInt(VERSION)
            data.writeByte(result.status.ordinal)
            data.writeString(result.engine)
            data.writeString(result.engineVersion)
            data.writeString(result.reference)
        }
    }

    fun readResult(bytes: ByteArray): ScanResult {
        val input = ByteArrayInputStream(bytes)
        val result = DataInputStream(input).use { data ->
            require(data.readInt() == RESULT_MAGIC && data.readInt() == VERSION)
            ScanResult(
                ScanStatus.entries.getOrNull(data.readUnsignedByte()) ?: error("unsupported scan status"),
                data.readString(),
                data.readString(),
                data.readString(),
            )
        }
        require(input.available() == 0)
        return result
    }

    private fun DataOutputStream.writeString(value: String) {
        val bytes = value.toByteArray(StandardCharsets.UTF_8)
        require(bytes.size <= MAXIMUM_STRING_BYTES)
        writeInt(bytes.size)
        write(bytes)
    }

    private fun DataInputStream.readString(): String {
        val length = readInt()
        require(length in 0..MAXIMUM_STRING_BYTES)
        return readNBytes(length).also { require(it.size == length) }.toString(StandardCharsets.UTF_8)
    }
}
