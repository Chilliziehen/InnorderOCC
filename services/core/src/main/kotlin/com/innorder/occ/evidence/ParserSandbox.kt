package com.innorder.occ.evidence

import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.time.Instant

fun interface ParserSandbox {
    fun inspect(request: ParserSandboxRequest): ParserSandboxResult
}

enum class ParserFormat {
    PDF,
    ZIP,
}

data class ParserSandboxRequest(
    val path: Path,
    val fileName: String,
    val format: ParserFormat,
    val policy: EvidencePolicy,
    val deadline: Instant,
)

sealed interface ParserSandboxResult {
    data class Accepted(val detectedMediaType: String) : ParserSandboxResult {
        init {
            require(MEDIA_TYPE.matches(detectedMediaType))
        }
    }

    data class Rejected(val code: EvidenceRejectionCode) : ParserSandboxResult

    companion object {
        private val MEDIA_TYPE = Regex("^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$")
    }
}

internal object ParserSandboxProtocol {
    private const val REQUEST_MAGIC = 0x4f435051
    private const val RESULT_MAGIC = 0x4f435052
    private const val VERSION = 1
    private const val MAXIMUM_STRING_BYTES = 4096
    private const val MAXIMUM_POLICY_VALUES = 32

    fun writeRequest(output: OutputStream, request: ParserSandboxRequest) {
        DataOutputStream(output).use { data ->
            data.writeInt(REQUEST_MAGIC)
            data.writeInt(VERSION)
            data.writeByte(request.format.ordinal)
            data.writeString(request.path.toAbsolutePath().normalize().toString())
            data.writeString(request.fileName)
            data.writeInt(request.policy.allowedExtensions.size)
            request.policy.allowedExtensions.forEach { data.writeString(it) }
            data.writeInt(request.policy.allowedMediaTypes.size)
            request.policy.allowedMediaTypes.forEach { data.writeString(it) }
            data.writeLong(request.policy.maximumBytes)
            data.writeInt(request.policy.archiveLimits.maximumEntries)
            data.writeLong(request.policy.archiveLimits.maximumExpandedBytes)
            data.writeDouble(request.policy.archiveLimits.maximumCompressionRatio)
            data.writeLong(request.deadline.epochSecond)
            data.writeInt(request.deadline.nano)
        }
    }

    fun readRequest(input: InputStream): ParserSandboxRequest = DataInputStream(input).use { data ->
        require(data.readInt() == REQUEST_MAGIC && data.readInt() == VERSION)
        val format = ParserFormat.entries.getOrNull(data.readUnsignedByte()) ?: error("unsupported parser format")
        val path = Path.of(data.readString())
        val fileName = data.readString()
        val extensions = data.readStringSet()
        val mediaTypes = data.readStringSet()
        val policy = EvidencePolicy(
            extensions,
            mediaTypes,
            data.readLong(),
            ArchiveLimits(data.readInt(), data.readLong(), data.readDouble()),
        )
        val deadline = Instant.ofEpochSecond(data.readLong(), data.readInt().toLong())
        require(data.read() < 0)
        ParserSandboxRequest(path, fileName, format, policy, deadline)
    }

    fun writeResult(output: OutputStream, result: ParserSandboxResult) {
        DataOutputStream(output).use { data ->
            data.writeInt(RESULT_MAGIC)
            data.writeInt(VERSION)
            when (result) {
                is ParserSandboxResult.Accepted -> {
                    data.writeByte(0)
                    data.writeString(result.detectedMediaType)
                }
                is ParserSandboxResult.Rejected -> {
                    data.writeByte(1)
                    data.writeString(result.code.name)
                }
            }
        }
    }

    fun readResult(bytes: ByteArray): ParserSandboxResult {
        val input = ByteArrayInputStream(bytes)
        val result = DataInputStream(input).use { data ->
            require(data.readInt() == RESULT_MAGIC && data.readInt() == VERSION)
            when (data.readUnsignedByte()) {
                0 -> ParserSandboxResult.Accepted(data.readString())
                1 -> ParserSandboxResult.Rejected(EvidenceRejectionCode.valueOf(data.readString()))
                else -> error("unsupported parser result")
            }
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
        val bytes = readNBytes(length)
        require(bytes.size == length)
        return String(bytes, StandardCharsets.UTF_8)
    }

    private fun DataInputStream.readStringSet(): Set<String> {
        val count = readInt()
        require(count in 1..MAXIMUM_POLICY_VALUES)
        return List(count) { readString() }.toSet().also { require(it.size == count) }
    }
}
