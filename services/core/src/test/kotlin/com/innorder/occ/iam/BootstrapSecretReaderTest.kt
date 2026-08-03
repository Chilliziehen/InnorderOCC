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
    fun `validates bound parent owner type POSIX metadata and supported modes`() {
        listOf(
            parentMetadata(kind = SecretFileKind.REGULAR),
            parentMetadata(owner = "other-service"),
            parentMetadata(permissions = null),
            parentMetadata(permissions = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE, PosixFilePermission.GROUP_WRITE)),
            parentMetadata(permissions = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OTHERS_WRITE)),
        ).forEach { rejectedParent ->
            val directory = FakeSecureDirectory(
                mutableListOf(metadata(), metadata()),
                parent = rejectedParent,
            )
            assertThatThrownBy { BootstrapSecretReader(factory(directory)).open(SECRET, OWNER) }
                .isInstanceOf(BootstrapConfigurationException::class.java)
            assertThat(directory.channelOpened).isFalse()
        }

        listOf(DIRECTORY_0500, DIRECTORY_0700, DIRECTORY_0750).forEach { acceptedMode ->
            val directory = FakeSecureDirectory(
                mutableListOf(metadata(), metadata()),
                parent = parentMetadata(permissions = acceptedMode),
            )
            BootstrapSecretReader(factory(directory)).open(SECRET, OWNER).close()
            assertThat(directory.channelOpened).isTrue()
        }
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
        val directory = FakeSecureDirectory(mutableListOf(metadata(), metadata(), metadata(), metadata()))
        val factory = ReplacingPathFactory(directory)
        val material = BootstrapSecretReader(factory).open(SECRET, OWNER)
        factory.replacePathWithDifferentDirectory()

        assertThat(material.characters.toString()).isEqualTo(PASSWORD)
        material.delete()
        material.close()

        assertThat(directory.movedFrom).isEqualTo(SECRET.fileName)
        assertThat(directory.deletedRelativeName).startsWith(".occ-bootstrap-quarantine-")
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
    fun `channel bound read cannot be redirected by interleaving name replacement`() {
        val directory = FakeSecureDirectory(
            mutableListOf(metadata(fileKey = "replacement"), metadata(fileKey = "replacement")),
            onChannelOpen = { it.pathBytes = "attacker-replacement-secret".toByteArray() },
        )

        BootstrapSecretReader(factory(directory)).open(SECRET, OWNER).use { material ->
            assertThat(material.characters.toString()).isEqualTo(PASSWORD)
            assertThat(material.characters.toString()).doesNotContain("attacker-replacement")
        }
    }

    @Test
    fun `deletion refuses replacement before move and wrong moved identity`() {
        val replacementBeforeMove = FakeSecureDirectory(mutableListOf(
            metadata(), metadata(), metadata(fileKey = "replacement-before-move"),
        ))
        val first = BootstrapSecretReader(factory(replacementBeforeMove)).open(SECRET, OWNER)
        assertThatThrownBy { first.delete() }.isInstanceOf(BootstrapSecretCleanupException::class.java)
        first.close()
        assertThat(replacementBeforeMove.movedFrom).isNull()
        assertThat(replacementBeforeMove.deletedRelativeName).isNull()

        val wrongMovedIdentity = FakeSecureDirectory(
            mutableListOf(metadata(), metadata(), metadata(), metadata(fileKey = "wrong-moved-identity")),
        )
        val second = BootstrapSecretReader(factory(wrongMovedIdentity)).open(SECRET, OWNER)
        assertThatThrownBy { second.delete() }.isInstanceOf(BootstrapSecretCleanupException::class.java)
        second.close()
        assertThat(wrongMovedIdentity.movedFrom).isEqualTo(SECRET.fileName)
        assertThat(wrongMovedIdentity.deletedRelativeName).isNull()
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
        private val parent: SecretFileMetadata = parentMetadata(),
        private val onChannelOpen: ((FakeSecureDirectory) -> Unit)? = null,
    ) : SecureSecretDirectory {
        var closed = false
        var deletedRelativeName: String? = null
        var movedFrom: Path? = null
        var channelOpened = false
        var pathBytes = PASSWORD.toByteArray()

        override fun inspectParent(): SecretFileMetadata = parent
        override fun inspect(relativeName: Path): SecretFileMetadata = metadata.removeFirst()
        override fun openChannel(relativeName: Path, maximumBytes: Int): SecureSecretChannel {
            channelOpened = true
            val boundBytes = pathBytes.copyOf()
            onChannelOpen?.invoke(this)
            return object : SecureSecretChannel {
                override fun read(): ByteArray {
                    if (failRead) error("read failed")
                    return boundBytes
                }
                override fun close() = Unit
            }
        }
        override fun move(source: Path, target: Path) {
            movedFrom = source
        }
        override fun delete(relativeName: Path) {
            deletedRelativeName = relativeName.toString()
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
        private val DIRECTORY_0500 = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_EXECUTE)
        private val DIRECTORY_0700 = DIRECTORY_0500 + PosixFilePermission.OWNER_WRITE
        private val DIRECTORY_0750 = DIRECTORY_0700 + PosixFilePermission.GROUP_READ + PosixFilePermission.GROUP_EXECUTE

        private fun parentMetadata(
            kind: SecretFileKind = SecretFileKind.DIRECTORY,
            owner: String = OWNER,
            permissions: Set<PosixFilePermission>? = DIRECTORY_0700,
        ) = SecretFileMetadata(
            kind, 0, "parent-key", Instant.EPOCH, Instant.EPOCH, permissions, owner,
        )

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
