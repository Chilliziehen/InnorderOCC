package com.innorder.occ.evidence

import eu.rekawek.toxiproxy.model.ToxicDirection
import io.minio.MinioClient
import okhttp3.OkHttpClient
import org.awaitility.Awaitility.await
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.beans.factory.BeanCreationException
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.boot.env.ConfigTreePropertySource
import org.springframework.core.env.SystemEnvironmentPropertySource
import org.testcontainers.containers.GenericContainer
import org.testcontainers.containers.Network
import org.testcontainers.containers.ToxiproxyContainer
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
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@Suppress("DEPRECATION")
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
    fun `prefix listing enforces its limit across MinIO pages`() {
        val prefix = "quarantine/list-limit-${UUID.randomUUID()}/"
        val bytes = byteArrayOf(1)
        val hash = sha256(bytes)
        val keys = (1..3).map { "$prefix$it" }
        try {
            keys.forEach { key ->
                store.putQuarantine(ObjectPut(key, ByteArrayInputStream(bytes), 1, hash, "application/octet-stream"))
            }

            assertThat(store.list(prefix, limit = 2).map { it.key })
                .containsExactly(keys[0], keys[1])
        } finally {
            keys.forEach { key -> store.delete(key) }
        }
    }

    @Test
    fun `quarantine upload cannot overwrite an existing unique key`() {
        val key = "quarantine/unique-${UUID.randomUUID()}"
        val original = byteArrayOf(1)
        val replacement = byteArrayOf(2)
        try {
            store.putQuarantine(
                ObjectPut(key, ByteArrayInputStream(original), 1, sha256(original), "application/octet-stream"),
            )

            assertThatThrownBy {
                store.putQuarantine(
                    ObjectPut(key, ByteArrayInputStream(replacement), 1, sha256(replacement), "application/octet-stream"),
                )
            }.isInstanceOf(ObjectAlreadyExistsException::class.java)
            assertThat(store.stat(key).sha256).isEqualTo(sha256(original))
        } finally {
            store.delete(key)
        }
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
    fun `persisted upload is deleted when its success response disconnects`() {
        val key = "quarantine/disconnected-${UUID.randomUUID()}"
        val bytes = ByteArray(1024 * 1024) { index -> (index % 251).toByte() }
        val latency = faultProxy.toxics().latency("hold-success-response", ToxicDirection.DOWNSTREAM, 5_000)
        val faultEndpoint = "http://${faultProxy.containerIpAddress}:${faultProxy.proxyPort}"
        val faultProperties = EvidenceStorageProperties(
            endpoint = faultEndpoint,
            bucket = BUCKET,
            accessKey = APP_USER,
            secretKey = APP_PASSWORD,
            requestTimeout = Duration.ofSeconds(3),
        )
        val faultClient = MinioClient.builder()
            .endpoint(faultEndpoint)
            .region("us-east-1")
            .credentials(APP_USER, APP_PASSWORD)
            .httpClient(OkHttpClient.Builder().callTimeout(2, TimeUnit.SECONDS).build(), true)
            .build()
        val faultStore = MinioObjectStore(
            faultProperties,
            faultClient,
        )
        val executor = Executors.newSingleThreadExecutor()
        val restoreExecutor = Executors.newSingleThreadScheduledExecutor()
        try {
            val upload = executor.submit<StoredObject> {
                faultStore.putQuarantine(
                    ObjectPut(key, ByteArrayInputStream(bytes), bytes.size.toLong(), sha256(bytes), "application/octet-stream"),
                )
            }
            await().atMost(Duration.ofSeconds(5)).pollInterval(Duration.ofMillis(20)).until { rootObjectExists(key) }

            faultProxy.setConnectionCut(true)
            latency.remove()
            restoreExecutor.schedule({ faultProxy.setConnectionCut(false) }, 2_500, TimeUnit.MILLISECONDS)

            assertThatThrownBy { upload.get(15, TimeUnit.SECONDS) }
                .hasCauseInstanceOf(ObjectStoreException::class.java)
                .rootCause()
                .hasMessage("Object storage operation failed")
            assertThat(rootObjectExists(key)).isFalse()
        } finally {
            faultProxy.setConnectionCut(false)
            runCatching { latency.remove() }
            executor.shutdownNow()
            restoreExecutor.shutdownNow()
            if (rootObjectExists(key)) rootStore.delete(key)
        }
    }

    @Test
    fun `unavailable cleanup stays sanitized and leaves quarantine discoverable to sweeper`() {
        val key = "quarantine/sweeper-${UUID.randomUUID()}"
        val bytes = ByteArray(1024 * 1024) { index -> (index % 251).toByte() }
        val latency = faultProxy.toxics().latency("hold-failed-cleanup-response", ToxicDirection.DOWNSTREAM, 5_000)
        val faultEndpoint = "http://${faultProxy.containerIpAddress}:${faultProxy.proxyPort}"
        val faultProperties = EvidenceStorageProperties(
            faultEndpoint,
            BUCKET,
            APP_USER,
            APP_PASSWORD,
            Duration.ofMillis(800),
        )
        val faultClient = MinioClient.builder()
            .endpoint(faultEndpoint)
            .region("us-east-1")
            .credentials(APP_USER, APP_PASSWORD)
            .httpClient(OkHttpClient.Builder().callTimeout(500, TimeUnit.MILLISECONDS).build(), true)
            .build()
        val faultStore = MinioObjectStore(faultProperties, faultClient)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val upload = executor.submit<StoredObject> {
                faultStore.putQuarantine(
                    ObjectPut(key, ByteArrayInputStream(bytes), bytes.size.toLong(), sha256(bytes), "application/octet-stream"),
                )
            }
            await().atMost(Duration.ofSeconds(5)).pollInterval(Duration.ofMillis(20)).until { rootObjectExists(key) }
            faultProxy.setConnectionCut(true)
            latency.remove()

            assertThatThrownBy { upload.get(5, TimeUnit.SECONDS) }
                .hasCauseInstanceOf(ObjectStoreException::class.java)
                .rootCause()
                .hasMessage("Object storage operation failed")
                .message()
                .doesNotContain(key, APP_USER, APP_PASSWORD)
            assertThat(rootStore.list(key).map { it.key }).containsExactly(key)
        } finally {
            faultProxy.setConnectionCut(false)
            runCatching { latency.remove() }
            executor.shutdownNow()
            if (rootObjectExists(key)) rootStore.delete(key)
        }
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
    fun `production storage wiring accepts only strong config tree credentials`(@TempDir tempDirectory: Path) {
        val validDirectory = Files.createDirectory(tempDirectory.resolve("valid"))
        Files.writeString(validDirectory.resolve(ACCESS_KEY_PROPERTY), APP_USER)
        Files.writeString(validDirectory.resolve(SECRET_KEY_PROPERTY), APP_PASSWORD)
        withConfigTree(validDirectory).run { context ->
            assertThat(context.startupFailure).isNull()
            assertThat(context.getBean(ObjectStore::class.java)).isInstanceOf(MinioObjectStore::class.java)
        }

        storageContext()
            .withPropertyValues(
                "$ACCESS_KEY_PROPERTY=$APP_USER",
                "$SECRET_KEY_PROPERTY=$APP_PASSWORD",
            )
            .run { context -> assertConfigurationFailure(context.startupFailure, APP_USER, APP_PASSWORD) }

        storageContext()
            .withInitializer { context ->
                context.environment.propertySources.addFirst(
                    SystemEnvironmentPropertySource(
                        "test environment",
                        mapOf(
                            "OCC_OBJECT_STORAGE_ACCESS_KEY" to APP_USER,
                            "OCC_OBJECT_STORAGE_SECRET_KEY" to APP_PASSWORD,
                        ),
                    ),
                )
            }
            .run { context -> assertConfigurationFailure(context.startupFailure, APP_USER, APP_PASSWORD) }

        val missingDirectory = Files.createDirectory(tempDirectory.resolve("missing"))
        Files.writeString(missingDirectory.resolve(ACCESS_KEY_PROPERTY), APP_USER)
        withConfigTree(missingDirectory).run { context -> assertConfigurationFailure(context.startupFailure) }

        val blankDirectory = Files.createDirectory(tempDirectory.resolve("blank"))
        Files.writeString(blankDirectory.resolve(ACCESS_KEY_PROPERTY), APP_USER)
        Files.writeString(blankDirectory.resolve(SECRET_KEY_PROPERTY), "")
        withConfigTree(blankDirectory).run { context -> assertConfigurationFailure(context.startupFailure) }

        val weakDirectory = Files.createDirectory(tempDirectory.resolve("weak"))
        Files.writeString(weakDirectory.resolve(ACCESS_KEY_PROPERTY), "short-user")
        Files.writeString(weakDirectory.resolve(SECRET_KEY_PROPERTY), "short-secret")
        withConfigTree(weakDirectory).run { context ->
            assertConfigurationFailure(context.startupFailure, "short-user", "short-secret")
        }
    }

    private fun storageContext(): ApplicationContextRunner = ApplicationContextRunner()
        .withUserConfiguration(EvidenceStorageConfiguration::class.java)
        .withPropertyValues(
            "occ.object-storage.endpoint=$endpoint",
            "occ.object-storage.bucket=$BUCKET",
            "occ.object-storage.request-timeout=10s",
        )

    private fun withConfigTree(directory: Path): ApplicationContextRunner = storageContext()
        .withInitializer { context ->
            context.environment.propertySources.addFirst(ConfigTreePropertySource("test config tree", directory))
        }

    private fun assertConfigurationFailure(failure: Throwable?, vararg forbiddenValues: String) {
        assertThat(failure)
            .isInstanceOf(BeanCreationException::class.java)
            .hasRootCauseInstanceOf(IllegalArgumentException::class.java)
            .hasRootCauseMessage("Invalid object storage configuration")
        forbiddenValues.forEach { value -> assertThat(failure!!.stackTraceToString()).doesNotContain(value) }
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
        private const val ACCESS_KEY_PROPERTY = "occ.object-storage.access-key"
        private const val SECRET_KEY_PROPERTY = "occ.object-storage.secret-key"
        private const val MINIO_IMAGE = "minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e"
        private const val MC_IMAGE = "minio/mc:RELEASE.2025-04-16T18-13-26Z@sha256:aead63c77f9db9107f1696fb08ecb0faeda23729cde94b0f663edf4fe09728e3"
        private const val ROOT_USER = "testrootadministrator"
        private const val ROOT_PASSWORD = "testrootpassword0123456789abcdef"
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
        private val toxiproxy = ToxiproxyContainer().withNetwork(network)
        private lateinit var endpoint: String
        private lateinit var store: ObjectStore
        private lateinit var rootStore: ObjectStore
        private lateinit var faultProxy: ToxiproxyContainer.ContainerProxy

        @JvmStatic
        @BeforeAll
        fun startMinio() {
            minio.start()
            toxiproxy.start()
            faultProxy = toxiproxy.getProxy(minio, 9000)
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
            rootStore = MinioObjectStore(
                EvidenceStorageProperties(endpoint, BUCKET, ROOT_USER, ROOT_PASSWORD, Duration.ofSeconds(10)),
            )
            check(runMc("mc ls app/$BUCKET").isBlank()) { "Application policy probe returned unexpected output" }
        }

        @JvmStatic
        @AfterAll
        fun stopMinio() {
            toxiproxy.stop()
            minio.stop()
            network.close()
        }

        private fun rootObjectExists(key: String): Boolean = try {
            rootStore.stat(key)
            true
        } catch (_: ObjectNotFoundException) {
            false
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
