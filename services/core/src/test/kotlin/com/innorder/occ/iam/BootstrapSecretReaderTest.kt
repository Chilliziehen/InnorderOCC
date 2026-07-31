package com.innorder.occ.iam

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermission
import java.time.Instant

class BootstrapSecretReaderTest {
    @Test
    fun `rejects providers without a secure directory handle`() {
        val factory = SecureSecretDirectoryFactory { null }

        assertThatThrownBy { BootstrapSecretReader(factory).open(SECRET, OWNER) }
            .isInstanceOf(BootstrapConfigurationException::class.java)
    }

    @Test
    fun `validates regular owner identity and exact owner-only modes`() {
        listOf(
            metadata(kind = SecretFileKind.SYMLINK),
            metadata(kind = SecretFileKind.REPARSE),
            metadata(owner = "other-service"),
            metadata(permissions = null),
            metadata(permissions = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.GROUP_READ)),
        ).forEach { rejected ->
            val directory = FakeSecureDirectory(mutableListOf(rejected))
            assertThatThrownBy { BootstrapSecretReader(factory(directory)).open(SECRET, OWNER) }
                .isInstanceOf(BootstrapConfigurationException::class.java)
            assertThat(directory.closed).isTrue()
        }

        listOf(READ_ONLY, READ_WRITE).forEach { accepted ->
            val stable = metadata(permissions = accepted)
            val directory = FakeSecureDirectory(mutableListOf(stable, stable))
            BootstrapSecretReader(factory(directory)).open(SECRET, OWNER).use { material ->
                assertThat(material.characters.toString()).isEqualTo(PASSWORD)
            }
            assertThat(directory.closed).isTrue()
        }
    }

    @Test
    fun `rejects identity owner and permission changes across read`() {
        listOf(
            metadata(fileKey = "replacement"),
            metadata(owner = "other-service"),
            metadata(permissions = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OTHERS_READ)),
            metadata(modified = Instant.EPOCH.plusSeconds(1)),
        ).forEach { changed ->
            val directory = FakeSecureDirectory(mutableListOf(metadata(), changed))
            assertThatThrownBy { BootstrapSecretReader(factory(directory)).open(SECRET, OWNER) }
                .isInstanceOf(BootstrapConfigurationException::class.java)
            assertThat(directory.closed).isTrue()
        }
    }

    @Test
    fun `pathname replacement outside bound directory cannot redirect read or delete`() {
        val directory = FakeSecureDirectory(mutableListOf(metadata(), metadata(), metadata()))
        val factory = ReplacingPathFactory(directory)
        val material = BootstrapSecretReader(factory).open(SECRET, OWNER)
        factory.replacePathWithDifferentDirectory()

        assertThat(material.characters.toString()).isEqualTo(PASSWORD)
        material.delete()
        material.close()

        assertThat(directory.deletedRelativeName).isEqualTo(SECRET.fileName)
        assertThat(factory.replacementDeleted).isFalse()
        assertThat(directory.closed).isTrue()
    }

    @Test
    fun `inspect delete replacement is refused without deleting`() {
        val directory = FakeSecureDirectory(mutableListOf(
            metadata(),
            metadata(),
            metadata(fileKey = "replacement"),
        ))
        val material = BootstrapSecretReader(factory(directory)).open(SECRET, OWNER)

        assertThatThrownBy { material.delete() }
            .isInstanceOf(BootstrapSecretCleanupException::class.java)
        material.close()

        assertThat(directory.deletedRelativeName).isNull()
        assertThat(directory.closed).isTrue()
    }

    @Test
    fun `read failure closes secure directory handle`() {
        val directory = FakeSecureDirectory(mutableListOf(metadata()), failRead = true)

        assertThatThrownBy { BootstrapSecretReader(factory(directory)).open(SECRET, OWNER) }
            .isInstanceOf(BootstrapConfigurationException::class.java)
        assertThat(directory.closed).isTrue()
    }

    private fun factory(directory: FakeSecureDirectory) = SecureSecretDirectoryFactory { directory }

    private class ReplacingPathFactory(private val bound: FakeSecureDirectory) : SecureSecretDirectoryFactory {
        private val replacement = FakeSecureDirectory(mutableListOf(metadata(), metadata(), metadata()))
        private var current: SecureSecretDirectory = bound
        val replacementDeleted: Boolean get() = replacement.deletedRelativeName != null
        override fun open(parent: Path): SecureSecretDirectory = current
        fun replacePathWithDifferentDirectory() {
            current = replacement
        }
    }

    private class FakeSecureDirectory(
        private val metadata: MutableList<SecretFileMetadata>,
        private val failRead: Boolean = false,
    ) : SecureSecretDirectory {
        var closed = false
        var deletedRelativeName: Path? = null

        override fun inspect(relativeName: Path): SecretFileMetadata = metadata.removeFirst()
        override fun read(relativeName: Path, maximumBytes: Int): ByteArray {
            if (failRead) error("read failed")
            return PASSWORD.toByteArray()
        }
        override fun delete(relativeName: Path) {
            deletedRelativeName = relativeName
        }
        override fun close() {
            closed = true
        }
    }

    companion object {
        private val SECRET = Path.of("secure-parent", "administrator-password")
        private const val OWNER = "occ-service"
        private const val PASSWORD = "bound-secret-test-only"
        private val READ_ONLY = setOf(PosixFilePermission.OWNER_READ)
        private val READ_WRITE = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)

        private fun metadata(
            kind: SecretFileKind = SecretFileKind.REGULAR,
            fileKey: Any? = "stable-key",
            owner: String = OWNER,
            permissions: Set<PosixFilePermission>? = READ_WRITE,
            modified: Instant = Instant.EPOCH,
        ) = SecretFileMetadata(
            kind,
            PASSWORD.length.toLong(),
            fileKey,
            Instant.EPOCH,
            modified,
            permissions,
            owner,
        )
    }
}
