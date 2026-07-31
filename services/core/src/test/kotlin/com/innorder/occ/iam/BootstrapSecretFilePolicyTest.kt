package com.innorder.occ.iam

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermission
import java.time.Instant

class BootstrapSecretFilePolicyTest {
    @Test
    fun `rejects symlink and reparse metadata deterministically`() {
        listOf(SecretFileKind.SYMLINK, SecretFileKind.REPARSE).forEach { kind ->
            val files = FakeSecretFileMetadataAccess(mutableListOf(metadata(kind = kind)))

            assertThatThrownBy { BootstrapSecretFile(files).readValidated(PATH) }
                .isInstanceOf(BootstrapConfigurationException::class.java)
            assertThat(files.readCount).isZero()
        }
    }

    @Test
    fun `accepts exactly owner read and owner read write permissions`() {
        listOf(
            setOf(PosixFilePermission.OWNER_READ),
            setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE),
        ).forEach { permissions ->
            val stable = metadata(permissions = permissions)
            val files = FakeSecretFileMetadataAccess(mutableListOf(stable, stable))
            BootstrapSecretFile(files).readValidated(PATH).characters.clearSecret()
            assertThat(files.readCount).isEqualTo(1)
        }
    }

    @Test
    fun `rejects group and other permissions`() {
        listOf(
            setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.GROUP_READ),
            setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OTHERS_READ),
        ).forEach { permissions ->
            val files = FakeSecretFileMetadataAccess(mutableListOf(metadata(permissions = permissions)))
            assertThatThrownBy { BootstrapSecretFile(files).readValidated(PATH) }
                .isInstanceOf(BootstrapConfigurationException::class.java)
            assertThat(files.readCount).isZero()
        }
    }

    @Test
    fun `rejects permission transition after reading`() {
        val files = FakeSecretFileMetadataAccess(mutableListOf(
            metadata(permissions = setOf(PosixFilePermission.OWNER_READ)),
            metadata(permissions = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.GROUP_READ)),
        ))

        assertThatThrownBy { BootstrapSecretFile(files).readValidated(PATH) }
            .isInstanceOf(BootstrapConfigurationException::class.java)
        assertThat(files.readCount).isEqualTo(1)
    }

    @Test
    fun `rejects stable identity replacement during reading`() {
        val files = FakeSecretFileMetadataAccess(mutableListOf(
            metadata(fileKey = "first-key"),
            metadata(fileKey = "replacement-key"),
        ))

        assertThatThrownBy { BootstrapSecretFile(files).readValidated(PATH) }
            .isInstanceOf(BootstrapConfigurationException::class.java)
    }

    @Test
    fun `rejects in place file modification during reading`() {
        val files = FakeSecretFileMetadataAccess(mutableListOf(
            metadata(),
            metadata(modifiedTime = Instant.EPOCH.plusSeconds(1)),
        ))

        assertThatThrownBy { BootstrapSecretFile(files).readValidated(PATH) }
            .isInstanceOf(BootstrapConfigurationException::class.java)
    }

    @Test
    fun `deletion fails closed without a stable file key`() {
        val stable = metadata(fileKey = null)
        val files = FakeSecretFileMetadataAccess(mutableListOf(stable, stable, stable))
        val secret = BootstrapSecretFile(files).readValidated(PATH)
        secret.characters.clearSecret()

        assertThatThrownBy { BootstrapSecretFile(files).deleteValidated(secret.identity) }
            .isInstanceOf(BootstrapSecretCleanupException::class.java)
        assertThat(files.deleted).isFalse()
    }

    @Test
    fun `deletion rejects identity replacement and permission changes`() {
        listOf(
            metadata(fileKey = "replacement-key"),
            metadata(permissions = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.GROUP_READ)),
        ).forEach { changed ->
            val stable = metadata()
            val files = FakeSecretFileMetadataAccess(mutableListOf(stable, stable, changed))
            val secret = BootstrapSecretFile(files).readValidated(PATH)
            secret.characters.clearSecret()

            assertThatThrownBy { BootstrapSecretFile(files).deleteValidated(secret.identity) }
                .isInstanceOf(BootstrapSecretCleanupException::class.java)
            assertThat(files.deleted).isFalse()
        }
    }

    @Test
    fun `deletion accepts unchanged stable identity with owner only permissions`() {
        val stable = metadata()
        val files = FakeSecretFileMetadataAccess(mutableListOf(stable, stable, stable))
        val secret = BootstrapSecretFile(files).readValidated(PATH)
        secret.characters.clearSecret()

        BootstrapSecretFile(files).deleteValidated(secret.identity)

        assertThat(files.deleted).isTrue()
    }

    private class FakeSecretFileMetadataAccess(
        private val metadata: MutableList<SecretFileMetadata>,
    ) : SecretFileMetadataAccess {
        var readCount = 0
        var deleted = false

        override fun inspect(path: Path): SecretFileMetadata = metadata.removeFirst()

        override fun read(path: Path, maximumBytes: Int): ByteArray {
            readCount++
            assertThat(maximumBytes).isEqualTo(1024)
            return "bootstrap-test-only-secret".toByteArray()
        }

        override fun delete(path: Path) {
            deleted = true
        }
    }

    companion object {
        private val PATH = Path.of("deterministic-secret")
        private val OWNER_ONLY = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)

        private fun metadata(
            kind: SecretFileKind = SecretFileKind.REGULAR,
            fileKey: Any? = "stable-key",
            permissions: Set<PosixFilePermission>? = OWNER_ONLY,
            modifiedTime: Instant = Instant.EPOCH,
        ) = SecretFileMetadata(
            kind = kind,
            size = 26,
            fileKey = fileKey,
            creationTime = Instant.EPOCH,
            modifiedTime = modifiedTime,
            posixPermissions = permissions,
        )
    }
}
