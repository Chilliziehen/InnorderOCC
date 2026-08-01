package com.innorder.occ.evidence

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.BeanCreationException
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.testcontainers.containers.GenericContainer
import org.testcontainers.containers.Network
import org.testcontainers.containers.wait.strategy.Wait
import org.testcontainers.images.builder.Transferable
import org.testcontainers.containers.startupcheck.OneShotStartupCheckStrategy
import org.testcontainers.utility.DockerImageName
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.time.Duration
import java.util.UUID

class MinioObjectStoreIntegrationTest {
    @Test
    fun `private storage uploads promotes ranges lists and deletes bounded evidence`() {
        val bytes = ByteArray(6 * 1024 * 1024) { index -> (index % 251).toByte() }
        val hash = sha256(bytes)
        val quarantineKey = "quarantine/${UUID.randomUUID()}"
        val immutableKey = "evidence/${UUID.randomUUID()}"

        val stored = store.putQuarantine(
            ObjectPut(
                key = quarantineKey,
                source = ByteArrayInputStream(bytes),
                size = bytes.size.toLong(),
                sha256 = hash,
                contentType = "application/octet-stream",
            ),
        )

        assertThat(stored.key).isEqualTo(quarantineKey)
        assertThat(stored.size).isEqualTo(bytes.size.toLong())
        assertThat(stored.sha256).isEqualTo(hash)
        assertThat(store.list("quarantine/").map { it.key }).contains(quarantineKey)
        assertThat(anonymousGet(quarantineKey)).isIn(401, 403, 404)

        val promoted = store.promote(quarantineKey, immutableKey, bytes.size.toLong(), hash)

        assertThat(promoted.key).isEqualTo(immutableKey)
        assertThat(promoted.sha256).isEqualTo(hash)
        assertThatThrownBy { store.stat(quarantineKey) }
            .isInstanceOf(ObjectNotFoundException::class.java)

        val duplicateSource = "quarantine/${UUID.randomUUID()}"
        store.putQuarantine(
            ObjectPut(duplicateSource, ByteArrayInputStream(bytes), bytes.size.toLong(), hash, "application/octet-stream"),
        )
        assertThatThrownBy { store.promote(duplicateSource, immutableKey, bytes.size.toLong(), hash) }
            .isInstanceOf(ObjectAlreadyExistsException::class.java)
        assertThat(store.stat(duplicateSource).key).isEqualTo(duplicateSource)
        store.delete(duplicateSource)

        store.get(immutableKey, ObjectRange(offset = 1024, length = 4096)).use { result ->
            assertThat(result.length).isEqualTo(4096)
            assertThat(result.stream.readAllBytes()).isEqualTo(bytes.copyOfRange(1024, 1024 + 4096))
        }

        store.delete(immutableKey)
        assertThatThrownBy { store.stat(immutableKey) }
            .isInstanceOf(ObjectNotFoundException::class.java)
    }

    @Test
    fun `failed multipart upload is aborted and leaves quarantine inaccessible`() {
        val key = "quarantine/${UUID.randomUUID()}"
        val size = 6L * 1024 * 1024

        assertThatThrownBy {
            store.putQuarantine(
                ObjectPut(
                    key = key,
                    source = FailingInputStream(size, 5L * 1024 * 1024 + 1024),
                    size = size,
                    sha256 = "0".repeat(64),
                    contentType = "application/octet-stream",
                ),
            )
        }.isInstanceOf(ObjectStoreException::class.java)
            .hasMessage("Object storage operation failed")

        assertThat(store.list("quarantine/").map { it.key }).doesNotContain(key)
        assertThat(runMc("mc ls --incomplete app/$BUCKET/quarantine/").trim()).isEmpty()
        assertThat(anonymousGet(key)).isIn(401, 403, 404)

        val trailingFailureKey = "quarantine/${UUID.randomUUID()}"
        assertThatThrownBy {
            store.putQuarantine(
                ObjectPut(
                    trailingFailureKey,
                    FailingInputStream(size, size),
                    size,
                    "0".repeat(64),
                    "application/octet-stream",
                ),
            )
        }.isInstanceOf(ObjectStoreException::class.java)
        assertThat(store.list("quarantine/").map { it.key }).doesNotContain(trailingFailureKey)
    }

    @Test
    fun `invalid keys sizes hashes and credentials fail without leaking secrets`() {
        assertThatThrownBy {
            store.putQuarantine(
                ObjectPut("evidence/not-quarantine", ByteArrayInputStream(byteArrayOf(1)), 1, sha256(byteArrayOf(1)), "text/plain"),
            )
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            store.putQuarantine(
                ObjectPut(
                    "quarantine/oversized",
                    ByteArrayInputStream(byteArrayOf()),
                    ObjectStore.MAX_OBJECT_SIZE + 1,
                    "0".repeat(64),
                    "application/octet-stream",
                ),
            )
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            store.get("quarantine/../secret")
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            store.get("evidence/key", ObjectRange(0, ObjectStore.MAX_OBJECT_SIZE + 1))
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            store.get("evidence/key", ObjectRange(0, 0))
        }.isInstanceOf(IllegalArgumentException::class.java)

        val blankSecret = EvidenceStorageProperties(accessKey = "", secretKey = "")
        assertThatThrownBy { blankSecret.validate() }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessage("Invalid object storage configuration")
        assertThat(blankSecret.toString()).doesNotContain("accessKey", "secretKey")

        val secret = "must-not-appear-${UUID.randomUUID()}"
        val invalidStore = MinioObjectStore(
            EvidenceStorageProperties(
                endpoint = endpoint,
                bucket = BUCKET,
                accessKey = APP_USER,
                secretKey = secret,
                requestTimeout = Duration.ofSeconds(2),
            ),
        )
        assertThatThrownBy { invalidStore.list("quarantine/") }
            .isInstanceOf(ObjectStoreException::class.java)
            .hasMessage("Object storage operation failed")
            .message().doesNotContain(secret)
    }

    @Test
    fun `production storage wiring requires injected config tree values`() {
        ApplicationContextRunner()
            .withUserConfiguration(EvidenceStorageConfiguration::class.java)
            .run { context ->
                assertThat(context.startupFailure)
                    .isInstanceOf(BeanCreationException::class.java)
                    .hasRootCauseInstanceOf(IllegalArgumentException::class.java)
                    .hasRootCauseMessage("Invalid object storage configuration")
            }

        ApplicationContextRunner()
            .withUserConfiguration(EvidenceStorageConfiguration::class.java)
            .withPropertyValues(
                "occ.object-storage.endpoint=$endpoint",
                "occ.object-storage.bucket=$BUCKET",
                "occ.object-storage.access-key=$APP_USER",
                "occ.object-storage.secret-key=$APP_PASSWORD",
                "occ.object-storage.request-timeout=10s",
            )
            .run { context ->
                assertThat(context.startupFailure).isNull()
                assertThat(context.getBean(ObjectStore::class.java)).isInstanceOf(MinioObjectStore::class.java)
            }
    }

    private fun anonymousGet(key: String): Int {
        val connection = URI("$endpoint/$BUCKET/$key").toURL().openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 2_000
        connection.readTimeout = 2_000
        return try {
            connection.responseCode
        } finally {
            connection.disconnect()
        }
    }

    private class FailingInputStream(
        private val size: Long,
        private val failAfter: Long,
    ) : InputStream() {
        private var position = 0L

        override fun read(): Int {
            if (position >= failAfter) throw IOException("synthetic source failure")
            if (position >= size) return -1
            position++
            return (position % 251).toInt()
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (position >= failAfter) throw IOException("synthetic source failure")
            if (position >= size) return -1
            val count = minOf(length.toLong(), size - position, failAfter - position).toInt()
            repeat(count) { buffer[offset + it] = ((position + it) % 251).toByte() }
            position += count
            return count
        }
    }

    companion object {
        private const val MINIO_IMAGE = "minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e"
        private const val MC_IMAGE = "minio/mc:RELEASE.2025-04-16T18-13-26Z@sha256:aead63c77f9db9107f1696fb08ecb0faeda23729cde94b0f663edf4fe09728e3"
        private const val ROOT_USER = "testrootadministrator"
        private const val ROOT_PASSWORD = "testrootpassword0123456789"
        private const val APP_USER = "testevidenceappuser"
        private const val APP_PASSWORD = "testevidenceapppassword0123456789"
        private const val BUCKET = "innorder-occ-test"
        private val network = Network.newNetwork()
        private val minio = GenericContainer(DockerImageName.parse(MINIO_IMAGE))
            .withNetwork(network)
            .withNetworkAliases("minio")
            .withExposedPorts(9000)
            .withEnv("MINIO_ROOT_USER", ROOT_USER)
            .withEnv("MINIO_ROOT_PASSWORD", ROOT_PASSWORD)
            .withCommand("server", "/data")
            .waitingFor(Wait.forHttp("/minio/health/ready").forPort(9000).withStartupTimeout(Duration.ofMinutes(2)))
        private lateinit var endpoint: String
        private lateinit var store: ObjectStore

        @JvmStatic
        @BeforeAll
        fun startMinio() {
            minio.start()
            endpoint = "http://${minio.host}:${minio.getMappedPort(9000)}"
            runMc(
                "mc mb --ignore-existing admin/$BUCKET && " +
                    "mc admin user add admin \"\$APP_USER\" \"\$APP_PASSWORD\" && " +
                    "mc admin policy create admin innorder-occ-test /tmp/policy.json && " +
                    "mc admin policy attach admin innorder-occ-test --user \"\$APP_USER\"",
                admin = true,
            )
            store = MinioObjectStore(
                EvidenceStorageProperties(
                    endpoint = endpoint,
                    bucket = BUCKET,
                    accessKey = APP_USER,
                    secretKey = APP_PASSWORD,
                    requestTimeout = Duration.ofSeconds(10),
                ),
            )
            check(runMc("mc ls app/$BUCKET").isBlank()) { "Application policy probe returned unexpected output" }
        }

        @JvmStatic
        @AfterAll
        fun stopMinio() {
            minio.stop()
            network.close()
        }

        private fun runMc(command: String, admin: Boolean = false): String {
            val alias = if (admin) {
                "http://$ROOT_USER:$ROOT_PASSWORD@minio:9000"
            } else {
                "http://$APP_USER:$APP_PASSWORD@minio:9000"
            }
            val result = GenericContainer(DockerImageName.parse(MC_IMAGE))
                .withNetwork(network)
                .withEnv(if (admin) "MC_HOST_admin" else "MC_HOST_app", alias)
                .withEnv("APP_USER", APP_USER)
                .withEnv("APP_PASSWORD", APP_PASSWORD)
                .withCopyToContainer(Transferable.of(policy()), "/tmp/policy.json")
                .withCreateContainerCmdModifier { it.withEntrypoint("/bin/sh") }
                .withCommand("-ec", command)
                .withStartupCheckStrategy(OneShotStartupCheckStrategy().withTimeout(Duration.ofSeconds(30)))
                .apply { start() }
            return try {
                val output = result.logs
                check(result.currentContainerInfo.state.exitCodeLong == 0L) { "MinIO setup command failed" }
                output
            } finally {
                result.stop()
            }
        }

        private fun policy(): ByteArray = """
            {
              "Version": "2012-10-17",
              "Statement": [
                {
                  "Effect": "Allow",
                  "Action": ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"],
                  "Resource": ["arn:aws:s3:::$BUCKET"]
                },
                {
                  "Effect": "Allow",
                  "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
                  "Resource": ["arn:aws:s3:::$BUCKET/quarantine/*", "arn:aws:s3:::$BUCKET/evidence/*"]
                }
              ]
            }
        """.trimIndent().toByteArray()

        private fun sha256(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
