package com.innorder.occ.iam

import com.innorder.occ.auth.PasswordService
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.SecureDirectoryStream
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributeView
import java.nio.file.attribute.PosixFileAttributeView
import java.nio.file.attribute.PosixFilePermission
import java.security.SecureRandom
import java.time.Instant
import java.util.HexFormat

internal enum class SecretFileKind { REGULAR, SYMLINK, REPARSE, DIRECTORY }

internal data class SecretFileMetadata(
    val kind: SecretFileKind,
    val size: Long,
    val fileKey: Any?,
    val creationTime: Instant,
    val modifiedTime: Instant,
    val posixPermissions: Set<PosixFilePermission>?,
    val owner: String = "",
)

class SecretCharacters internal constructor(private val value: CharArray) : CharSequence {
    override val length: Int get() = value.size
    override fun get(index: Int): Char = value[index]
    override fun subSequence(startIndex: Int, endIndex: Int): CharSequence = value.concatToString(startIndex, endIndex)
    override fun toString(): String = value.concatToString()
    fun clearSecret() = value.fill('\u0000')
}

internal fun interface SecureSecretDirectoryFactory {
    fun open(parent: Path): SecureSecretDirectory?
}

internal interface SecureSecretDirectory : AutoCloseable {
    fun inspectParent(): SecretFileMetadata
    fun inspect(relativeName: Path): SecretFileMetadata
    fun openChannel(relativeName: Path, maximumBytes: Int): SecureSecretChannel
    fun move(source: Path, target: Path)
    fun delete(relativeName: Path)
}

internal interface SecureSecretChannel : AutoCloseable {
    fun read(): ByteArray
}

internal open class BootstrapSecretReader(
    private val directories: SecureSecretDirectoryFactory = NioSecureSecretDirectoryFactory,
) {
    open fun open(path: Path, expectedOwner: String): BootstrapSecretMaterial {
        val absolute = path.toAbsolutePath().normalize()
        val parent = absolute.parent ?: throw BootstrapConfigurationException()
        val relativeName = absolute.fileName ?: throw BootstrapConfigurationException()
        val directory = try {
            directories.open(parent)
        } catch (_: Exception) {
            null
        } ?: throw BootstrapConfigurationException()
        try {
            validateParent(directory.inspectParent(), expectedOwner)
            val channel = directory.openChannel(relativeName, MAX_BYTES)
            try {
                val before = directory.inspect(relativeName)
                validate(before, expectedOwner)
                val bytes = channel.read()
                try {
                    val after = directory.inspect(relativeName)
                    validate(after, expectedOwner)
                    if (!same(before, after)) throw BootstrapConfigurationException()
                    val characters = decode(bytes)
                    if (!PasswordService().isAllowed(characters)) {
                        characters.clearSecret()
                        throw BootstrapConfigurationException()
                    }
                    return BootstrapSecretMaterial(directory, relativeName, after, expectedOwner, characters)
                } finally {
                    bytes.fill(0)
                }
            } finally {
                channel.close()
            }
        } catch (failure: Exception) {
            try {
                directory.close()
            } catch (_: Exception) {
                // The close was attempted; preserve the bounded bootstrap failure.
            }
            if (failure is BootstrapConfigurationException) throw failure
            throw BootstrapConfigurationException()
        }
    }

    private fun decode(bytes: ByteArray): SecretCharacters {
        val length = when {
            bytes.size >= 2 && bytes[bytes.lastIndex - 1] == '\r'.code.toByte() && bytes.last() == '\n'.code.toByte() -> bytes.size - 2
            bytes.isNotEmpty() && bytes.last() == '\n'.code.toByte() -> bytes.size - 1
            else -> bytes.size
        }
        val decoded = try {
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes, 0, length))
        } catch (_: Exception) {
            throw BootstrapConfigurationException()
        }
        val chars = CharArray(decoded.remaining())
        decoded.get(chars)
        decoded.clear()
        while (decoded.hasRemaining()) decoded.put('\u0000')
        if (chars.any { it == '\u0000' }) {
            chars.fill('\u0000')
            throw BootstrapConfigurationException()
        }
        return SecretCharacters(chars)
    }

    private fun validate(metadata: SecretFileMetadata, expectedOwner: String) {
        if (metadata.kind != SecretFileKind.REGULAR || metadata.size > MAX_BYTES || metadata.fileKey == null ||
            metadata.owner != expectedOwner || metadata.posixPermissions == null ||
            metadata.posixPermissions !in OWNER_ONLY_MODES
        ) throw BootstrapConfigurationException()
    }

    private fun validateParent(metadata: SecretFileMetadata, expectedOwner: String) {
        // Supported Ubuntu deployment modes: 0500, 0700, or 0750. No group/other write is trusted.
        // The expected service identity owns this boundary; compromise of that identity is outside permission isolation.
        if (metadata.kind != SecretFileKind.DIRECTORY || metadata.fileKey == null ||
            metadata.owner != expectedOwner || metadata.posixPermissions !in TRUSTED_DIRECTORY_MODES
        ) throw BootstrapConfigurationException()
    }

    private fun same(first: SecretFileMetadata, second: SecretFileMetadata): Boolean =
        first.fileKey == second.fileKey && first.size == second.size &&
            first.creationTime == second.creationTime && first.modifiedTime == second.modifiedTime &&
            first.owner == second.owner && first.posixPermissions == second.posixPermissions

    private companion object {
        const val MAX_BYTES = 1024
        val OWNER_ONLY_MODES = setOf(
            setOf(PosixFilePermission.OWNER_READ),
            setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE),
        )
        val TRUSTED_DIRECTORY_MODES = setOf(
            setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_EXECUTE),
            setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE),
            setOf(
                PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE,
                PosixFilePermission.GROUP_READ, PosixFilePermission.GROUP_EXECUTE,
            ),
        )
    }
}

internal class BootstrapSecretMaterial(
    private val directory: SecureSecretDirectory,
    private val relativeName: Path,
    private val identity: SecretFileMetadata,
    private val expectedOwner: String,
    val characters: SecretCharacters,
) : AutoCloseable {
    private var closed = false

    fun delete() {
        try {
            val current = directory.inspect(relativeName)
            requireIdentity(current)
            val quarantine = Path.of(".occ-bootstrap-quarantine-${randomName()}")
            directory.move(relativeName, quarantine)
            val moved = directory.inspect(quarantine)
            requireIdentity(moved)
            directory.delete(quarantine)
        } catch (_: BootstrapSecretCleanupException) {
            throw BootstrapSecretCleanupException()
        } catch (_: Exception) {
            throw BootstrapSecretCleanupException()
        }
    }

    private fun requireIdentity(current: SecretFileMetadata) {
        val validMode = current.posixPermissions == setOf(PosixFilePermission.OWNER_READ) ||
            current.posixPermissions == setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)
        if (current.kind != SecretFileKind.REGULAR || current.fileKey == null ||
            current.fileKey != identity.fileKey || current.size != identity.size ||
            current.creationTime != identity.creationTime || current.modifiedTime != identity.modifiedTime ||
            current.owner != expectedOwner || current.owner != identity.owner || !validMode
        ) throw BootstrapSecretCleanupException()
    }

    private fun randomName(): String = ByteArray(16).also(RANDOM::nextBytes).let(HexFormat.of()::formatHex)

    override fun close() {
        if (closed) return
        closed = true
        characters.clearSecret()
        try {
            directory.close()
        } catch (_: Exception) {
            // Closing is always attempted; no provider detail may escape startup.
        }
    }

    private companion object {
        val RANDOM = SecureRandom()
    }
}

internal object NioSecureSecretDirectoryFactory : SecureSecretDirectoryFactory {
    override fun open(parent: Path): SecureSecretDirectory? {
        val stream = Files.newDirectoryStream(parent)
        if (stream !is SecureDirectoryStream<*>) {
            stream.close()
            return null
        }
        @Suppress("UNCHECKED_CAST")
        return NioSecureSecretDirectory(stream as SecureDirectoryStream<Path>)
    }
}

private class NioSecureSecretDirectory(
    private val directory: SecureDirectoryStream<Path>,
) : SecureSecretDirectory {
    override fun inspectParent(): SecretFileMetadata = inspect(Path.of("."))

    override fun inspect(relativeName: Path): SecretFileMetadata {
        val basicView = directory.getFileAttributeView(
            relativeName,
            BasicFileAttributeView::class.java,
            LinkOption.NOFOLLOW_LINKS,
        ) ?: throw BootstrapConfigurationException()
        val posixView = directory.getFileAttributeView(
            relativeName,
            PosixFileAttributeView::class.java,
            LinkOption.NOFOLLOW_LINKS,
        ) ?: throw BootstrapConfigurationException()
        val basic = basicView.readAttributes()
        val posix = posixView.readAttributes()
        val kind = when {
            basic.isSymbolicLink -> SecretFileKind.SYMLINK
            basic.isRegularFile -> SecretFileKind.REGULAR
            basic.isDirectory -> SecretFileKind.DIRECTORY
            else -> SecretFileKind.REPARSE
        }
        return SecretFileMetadata(
            kind,
            basic.size(),
            basic.fileKey(),
            basic.creationTime().toInstant(),
            basic.lastModifiedTime().toInstant(),
            posix.permissions(),
            posix.owner().name,
        )
    }

    override fun openChannel(relativeName: Path, maximumBytes: Int): SecureSecretChannel {
        val channel = directory.newByteChannel(
            relativeName,
            setOf(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS),
        )
        return object : SecureSecretChannel {
            override fun read(): ByteArray {
                val buffer = ByteBuffer.allocate(maximumBytes + 1)
                while (buffer.hasRemaining() && channel.read(buffer) >= 0) Unit
                if (buffer.position() > maximumBytes || channel.read(ByteBuffer.allocate(1)) >= 0) {
                    throw BootstrapConfigurationException()
                }
                buffer.flip()
                return ByteArray(buffer.remaining()).also(buffer::get)
            }
            override fun close() = channel.close()
        }
    }

    override fun move(source: Path, target: Path) = directory.move(source, directory, target)
    override fun delete(relativeName: Path) = directory.deleteFile(relativeName)
    override fun close() = directory.close()
}
