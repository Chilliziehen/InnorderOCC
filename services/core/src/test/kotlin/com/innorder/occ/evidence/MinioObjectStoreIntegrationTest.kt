package com.innorder.occ.evidence

import eu.rekawek.toxiproxy.model.ToxicDirection
import okhttp3.Interceptor
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
import org.testcontainers.containers.startupcheck.OneShotStartupCheckStrategy
import org.testcontainers.images.builder.Transferable
import org.testcontainers.utility.DockerImageName
import java.io.ByteArrayInputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Duration
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

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

        val promotion = store.promote(quarantineKey, immutableKey, bytes.size.toLong(), hash)

        assertThat(promotion.`object`.key).isEqualTo(immutableKey)
        assertThat(promotion.`object`.sha256).isEqualTo(hash)
        assertThat(promotion.sourceCleanupDisposition).isEqualTo(SourceCleanupDisposition.REMOVED)
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
        val original = ByteArray(6 * 1024 * 1024) { 1 }
        val replacement = ByteArray(6 * 1024 * 1024) { 2 }
        try {
            store.putQuarantine(
                ObjectPut(key, ByteArrayInputStream(original), original.size.toLong(), sha256(original), "application/octet-stream"),
            )

            assertThatThrownBy {
                store.putQuarantine(
                    ObjectPut(
                        key,
                        ByteArrayInputStream(replacement),
                        replacement.size.toLong(),
                        sha256(replacement),
                        "application/octet-stream",
                    ),
                )
            }.isInstanceOf(ObjectAlreadyExistsException::class.java)
            assertThat(store.stat(key).sha256).isEqualTo(sha256(original))
            assertThat(runMc("mc ls --incomplete app/$BUCKET/$key").trim()).isEmpty()
        } finally {
            store.delete(key)
        }
    }

    @Test
    fun `lost 412 response preserves original object by nonce reconciliation`() {
        val key = "quarantine/lost-conflict-${UUID.randomUUID()}"
        val original = "original".toByteArray()
        val replacement = "replacement".toByteArray()
        store.putQuarantine(ObjectPut(key, ByteArrayInputStream(original), original.size.toLong(), sha256(original), "text/plain"))

        val discardedConflict = AtomicBoolean()
        val primaryFault = Interceptor { chain ->
            val response = chain.proceed(chain.request())
            if (chain.request().method == "PUT" && response.code == 412) {
                discardedConflict.set(true)
                response.close()
                throw IOException("conditional response lost")
            }
            response
        }
        val faultStore = MinioObjectStore(
            EvidenceStorageProperties(endpoint, BUCKET, APP_USER, APP_PASSWORD, Duration.ofSeconds(3)),
            primaryFault,
            null,
        )
        try {
            assertThatThrownBy {
                faultStore.putQuarantine(
                    ObjectPut(
                        key,
                        ByteArrayInputStream(replacement),
                        replacement.size.toLong(),
                        sha256(replacement),
                        "text/plain",
                    ),
                )
            }.isInstanceOf(ObjectAlreadyExistsException::class.java)
            assertThat(discardedConflict).isTrue()
            assertThat(rootStore.stat(key).sha256).isEqualTo(sha256(original))
        } finally {
            faultStore.close()
            store.delete(key)
        }
    }

    @Test
    fun `concurrent large quarantine attempts have exactly one winner`() {
        val key = "quarantine/concurrent-${UUID.randomUUID()}"
        val first = ByteArray(6 * 1024 * 1024) { 3 }
        val second = ByteArray(6 * 1024 * 1024) { 4 }
        val barrier = CyclicBarrier(2)
        val executor = Executors.newFixedThreadPool(2)
        try {
            val attempts = listOf(first, second).map { bytes ->
                executor.submit<Result<StoredObject>> {
                    runCatching {
                        store.putQuarantine(
                            ObjectPut(
                                key,
                                BarrierInputStream(bytes, barrier),
                                bytes.size.toLong(),
                                sha256(bytes),
                                "application/octet-stream",
                            ),
                        )
                    }
                }
            }.map { it.get(15, TimeUnit.SECONDS) }

            assertThat(attempts.count { it.isSuccess }).isEqualTo(1)
            assertThat(attempts.mapNotNull { it.exceptionOrNull() })
                .singleElement()
                .isInstanceOf(ObjectAlreadyExistsException::class.java)
            assertThat(store.stat(key).sha256).isIn(sha256(first), sha256(second))
            assertThat(runMc("mc ls --incomplete app/$BUCKET/$key").trim()).isEmpty()
        } finally {
            executor.shutdownNow()
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
        val discardedSuccess = AtomicBoolean()
        val primaryFault = Interceptor { chain ->
            val response = chain.proceed(chain.request())
            if (chain.request().method == "PUT" && response.isSuccessful) {
                discardedSuccess.set(true)
                response.close()
                throw IOException("success response lost")
            }
            response
        }
        val faultStore = MinioObjectStore(
            EvidenceStorageProperties(endpoint, BUCKET, APP_USER, APP_PASSWORD, Duration.ofSeconds(3)),
            primaryFault,
            null,
        )
        try {
            assertThatThrownBy {
                faultStore.putQuarantine(
                    ObjectPut(key, ByteArrayInputStream(bytes), bytes.size.toLong(), sha256(bytes), "application/octet-stream"),
                )
            }.isInstanceOf(ObjectStoreException::class.java)
                .hasMessage("Object storage operation failed")
            assertThat(discardedSuccess).isTrue()
            assertThat(rootObjectExists(key)).isFalse()
        } finally {
            faultStore.close()
            if (rootObjectExists(key)) rootStore.delete(key)
        }
    }

    @Test
    fun `promotion preserves validated target and signals sweep when delete response and reconciliation are lost`() {
        val sourceKey = "quarantine/promotion-deadline-${UUID.randomUUID()}"
        val targetKey = "evidence/promotion-deadline-${UUID.randomUUID()}"
        val bytes = "validated-promotion".toByteArray()
        val hash = sha256(bytes)
        store.putQuarantine(ObjectPut(sourceKey, ByteArrayInputStream(bytes), bytes.size.toLong(), hash, "text/plain"))

        val deleteWasSent = AtomicBoolean()
        val cleanupFault = Interceptor { chain ->
            if (deleteWasSent.get()) throw IOException("cleanup reconciliation unavailable")
            if (chain.request().method == "DELETE") {
                chain.proceed(chain.request()).close()
                deleteWasSent.set(true)
                throw IOException("delete response lost")
            }
            chain.proceed(chain.request())
        }
        val faultStore = MinioObjectStore(
            EvidenceStorageProperties(
                endpoint,
                BUCKET,
                APP_USER,
                APP_PASSWORD,
                Duration.ofSeconds(3),
            ),
            cleanupFault,
        )
        try {
            val result = faultStore.promote(sourceKey, targetKey, bytes.size.toLong(), hash)

            assertThat(result.sourceCleanupDisposition).isEqualTo(SourceCleanupDisposition.SWEEP_REQUIRED)
            assertThat(result.`object`.key).isEqualTo(targetKey)
            assertThat(deleteWasSent).isTrue()
            assertThat(rootStore.stat(targetKey).sha256).isEqualTo(hash)
        } finally {
            faultStore.close()
            if (rootObjectExists(sourceKey)) rootStore.delete(sourceKey)
            if (rootObjectExists(targetKey)) rootStore.delete(targetKey)
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
        val faultStore = MinioObjectStore(faultProperties)
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
            faultStore.close()
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
        try {
            assertThatThrownBy { invalidStore.list("quarantine/") }
                .isInstanceOf(ObjectStoreException::class.java)
                .hasMessage("Object storage operation failed")
                .message().doesNotContain(secret)
        } finally {
            invalidStore.close()
        }
    }

    @Test
    fun `sub millisecond request timeout is rejected before client construction`() {
        val properties = EvidenceStorageProperties(
            endpoint = endpoint,
            bucket = BUCKET,
            accessKey = APP_USER,
            secretKey = APP_PASSWORD,
            requestTimeout = Duration.ofNanos(999_999),
        )

        assertThatThrownBy { properties.validate() }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessage("Invalid object storage configuration")
    }

    @Test
    fun `closed store rejects new operations`() {
        val ownedStore = MinioObjectStore(
            EvidenceStorageProperties(endpoint, BUCKET, APP_USER, APP_PASSWORD, Duration.ofSeconds(2)),
        )

        ownedStore.close()

        assertThatThrownBy { ownedStore.list("quarantine/") }
            .isInstanceOf(ObjectStoreException::class.java)
            .hasMessage("Object storage operation failed")
    }

    @Test
    fun `closing store cancels a stalled upload and releases its source`() {
        val key = "quarantine/shutdown-${UUID.randomUUID()}"
        val stalled = StalledInputStream()
        val ownedStore = MinioObjectStore(
            EvidenceStorageProperties(endpoint, BUCKET, APP_USER, APP_PASSWORD, Duration.ofSeconds(30)),
        )
        val executor = Executors.newSingleThreadExecutor()
        try {
            val upload = executor.submit<StoredObject> {
                ownedStore.putQuarantine(
                    ObjectPut(key, stalled, 1, "0".repeat(64), "application/octet-stream"),
                )
            }
            assertThat(stalled.started.await(3, TimeUnit.SECONDS)).isTrue()

            ownedStore.close()

            assertThatThrownBy { upload.get(2, TimeUnit.SECONDS) }
                .hasCauseInstanceOf(ObjectStoreException::class.java)
            assertThat(stalled.closed).isTrue()
        } finally {
            stalled.close()
            ownedStore.close()
            executor.shutdownNow()
            if (rootObjectExists(key)) rootStore.delete(key)
        }
    }

    @Test
    fun `operation deadline cancels a stalled upload and closes its source`() {
        val key = "quarantine/deadline-${UUID.randomUUID()}"
        val stalled = StalledInputStream()
        val ownedStore = MinioObjectStore(
            EvidenceStorageProperties(endpoint, BUCKET, APP_USER, APP_PASSWORD, Duration.ofMillis(400)),
        )
        val executor = Executors.newSingleThreadExecutor()
        try {
            val startedAt = System.nanoTime()
            val upload = executor.submit<StoredObject> {
                ownedStore.putQuarantine(
                    ObjectPut(key, stalled, 1, "0".repeat(64), "application/octet-stream"),
                )
            }
            assertThat(stalled.started.await(3, TimeUnit.SECONDS)).isTrue()

            assertThatThrownBy { upload.get(2, TimeUnit.SECONDS) }
                .hasCauseInstanceOf(ObjectStoreException::class.java)
            assertThat(Duration.ofNanos(System.nanoTime() - startedAt)).isLessThan(Duration.ofSeconds(2))
            assertThat(stalled.closed).isTrue()
        } finally {
            stalled.close()
            ownedStore.close()
            executor.shutdownNow()
            if (rootObjectExists(key)) rootStore.delete(key)
        }
    }

    @Test
    fun `request bound deadline stops stalled stat after dispatcher timeout replacement`() {
        val key = "quarantine/stalled-stat-${UUID.randomUUID()}"
        val bytes = "stalled-stat".toByteArray()
        store.putQuarantine(ObjectPut(key, ByteArrayInputStream(bytes), bytes.size.toLong(), sha256(bytes), "text/plain"))
        val latency = faultProxy.toxics().latency(
            "stalled-stat-${UUID.randomUUID()}",
            ToxicDirection.DOWNSTREAM,
            1_500,
        )
        val deadlineObserved = AtomicBoolean()
        val faultStore = MinioObjectStore(
            EvidenceStorageProperties(
                "http://${faultProxy.containerIpAddress}:${faultProxy.proxyPort}",
                BUCKET,
                APP_USER,
                APP_PASSWORD,
                Duration.ofMillis(350),
            ),
            dispatcherTimeoutReplacement(deadlineObserved),
            null,
        )
        try {
            val started = System.nanoTime()
            assertThatThrownBy { faultStore.stat(key) }
                .isInstanceOf(ObjectStoreException::class.java)
            assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(1))
            assertThat(deadlineObserved).isTrue()
        } finally {
            faultStore.close()
            latency.remove()
            store.delete(key)
        }
    }

    @Test
    fun `request bound deadline stops promotion when a later SDK request stalls`() {
        val sourceKey = "quarantine/stalled-promotion-${UUID.randomUUID()}"
        val targetKey = "evidence/stalled-promotion-${UUID.randomUUID()}"
        val bytes = "stalled-promotion".toByteArray()
        val hash = sha256(bytes)
        store.putQuarantine(ObjectPut(sourceKey, ByteArrayInputStream(bytes), bytes.size.toLong(), hash, "text/plain"))
        val latency = AtomicReference<eu.rekawek.toxiproxy.model.toxic.Latency>()
        val requests = AtomicInteger()
        val deadlineObserved = AtomicBoolean()
        val observedDeadlines = ConcurrentHashMap.newKeySet<String>()
        val boundary = Interceptor { chain ->
            chain.request().header("X-Innorder-Internal-Deadline-Nanos")?.let(observedDeadlines::add)
            if (requests.incrementAndGet() == 2) {
                latency.set(
                    faultProxy.toxics().latency(
                        "stalled-promotion-${UUID.randomUUID()}",
                        ToxicDirection.DOWNSTREAM,
                        1_500,
                    ),
                )
            }
            dispatcherTimeoutReplacement(deadlineObserved).intercept(chain)
        }
        val faultStore = MinioObjectStore(
            EvidenceStorageProperties(
                "http://${faultProxy.containerIpAddress}:${faultProxy.proxyPort}",
                BUCKET,
                APP_USER,
                APP_PASSWORD,
                Duration.ofMillis(500),
            ),
            boundary,
            null,
        )
        try {
            val started = System.nanoTime()
            assertThatThrownBy { faultStore.promote(sourceKey, targetKey, bytes.size.toLong(), hash) }
                .isInstanceOf(ObjectStoreException::class.java)
            assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(1))
            assertThat(deadlineObserved).isTrue()
            assertThat(observedDeadlines).hasSize(1)
            assertThat(rootObjectExists(targetKey)).isFalse()
        } finally {
            faultStore.close()
            latency.get()?.remove()
            if (rootObjectExists(sourceKey)) rootStore.delete(sourceKey)
            if (rootObjectExists(targetKey)) rootStore.delete(targetKey)
        }
    }

    @Test
    fun `download body is forcibly closed at the request bound deadline`() {
        val key = "quarantine/slow-download-${UUID.randomUUID()}"
        val bytes = ByteArray(256 * 1024) { index -> (index % 251).toByte() }
        store.putQuarantine(
            ObjectPut(key, ByteArrayInputStream(bytes), bytes.size.toLong(), sha256(bytes), "application/octet-stream"),
        )
        val bandwidth = faultProxy.toxics().bandwidth(
            "slow-download-${UUID.randomUUID()}",
            ToxicDirection.DOWNSTREAM,
            128,
        )
        val deadlineObserved = AtomicBoolean()
        val faultStore = MinioObjectStore(
            EvidenceStorageProperties(
                "http://${faultProxy.containerIpAddress}:${faultProxy.proxyPort}",
                BUCKET,
                APP_USER,
                APP_PASSWORD,
                Duration.ofMillis(400),
            ),
            dispatcherTimeoutReplacement(deadlineObserved),
            null,
        )
        var bandwidthRemoved = false
        try {
            val started = System.nanoTime()
            faultStore.get(key).use { read ->
                assertThatThrownBy { read.stream.readBytes() }
                    .isInstanceOf(IOException::class.java)
            }
            assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(1))
            assertThat(deadlineObserved).isTrue()
            bandwidth.remove()
            bandwidthRemoved = true
            assertThat(faultStore.stat(key).sha256).isEqualTo(sha256(bytes))
            repeat(5) {
                faultStore.get(key, ObjectRange(0, 1)).use { read ->
                    assertThat(read.stream.read()).isEqualTo(bytes[0].toInt() and 0xff)
                    assertThat(read.stream.read()).isEqualTo(-1)
                }
            }
        } finally {
            faultStore.close()
            if (!bandwidthRemoved) runCatching { bandwidth.remove() }
            store.delete(key)
        }
    }

    @Test
    fun `closing store closes an unread download stream`() {
        val key = "quarantine/close-download-${UUID.randomUUID()}"
        val bytes = "close-download".toByteArray()
        store.putQuarantine(ObjectPut(key, ByteArrayInputStream(bytes), bytes.size.toLong(), sha256(bytes), "text/plain"))
        val ownedStore = MinioObjectStore(
            EvidenceStorageProperties(endpoint, BUCKET, APP_USER, APP_PASSWORD, Duration.ofSeconds(10)),
        )
        val read = ownedStore.get(key)
        try {
            ownedStore.close()

            assertThatThrownBy { read.stream.read() }
                .isInstanceOf(IOException::class.java)
        } finally {
            read.close()
            ownedStore.close()
            store.delete(key)
        }
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

    private class BarrierInputStream(
        bytes: ByteArray,
        private val barrier: CyclicBarrier,
    ) : FilterInputStream(ByteArrayInputStream(bytes)) {
        private var started = false

        private fun awaitPeer() {
            if (!started) {
                started = true
                barrier.await(5, TimeUnit.SECONDS)
            }
        }

        override fun read(): Int {
            awaitPeer()
            return super.read()
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            awaitPeer()
            return super.read(buffer, offset, length)
        }
    }

    private class StalledInputStream : InputStream() {
        val started = CountDownLatch(1)
        private val released = CountDownLatch(1)
        @Volatile var closed = false
            private set

        override fun read(): Int {
            started.countDown()
            released.await()
            if (closed) throw IOException("source closed")
            return -1
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int = read()

        override fun close() {
            closed = true
            released.countDown()
        }
    }

    private fun dispatcherTimeoutReplacement(deadlineObserved: AtomicBoolean): Interceptor = Interceptor { chain ->
        deadlineObserved.set(chain.request().header("X-Innorder-Internal-Deadline-Nanos") != null)
        chain.call().timeout().clearTimeout()
        chain
            .withConnectTimeout(5, TimeUnit.SECONDS)
            .withReadTimeout(5, TimeUnit.SECONDS)
            .withWriteTimeout(5, TimeUnit.SECONDS)
            .proceed(chain.request())
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
            store.close()
            rootStore.close()
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
