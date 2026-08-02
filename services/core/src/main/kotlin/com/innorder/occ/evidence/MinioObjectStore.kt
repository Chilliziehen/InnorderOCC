package com.innorder.occ.evidence

import io.minio.CopyObjectArgs
import io.minio.CopySource
import io.minio.GetObjectArgs
import io.minio.GetPresignedObjectUrlArgs
import io.minio.ListObjectsArgs
import io.minio.MinioClient
import io.minio.RemoveObjectArgs
import io.minio.Signer
import io.minio.StatObjectArgs
import io.minio.StatObjectResponse
import io.minio.errors.ErrorResponseException
import io.minio.http.Method
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Duration
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class MinioObjectStore internal constructor(
    private val properties: EvidenceStorageProperties,
    primaryInterceptor: Interceptor?,
    cleanupInterceptor: Interceptor?,
) : ObjectStore {
    constructor(properties: EvidenceStorageProperties) : this(properties, null, null)

    internal constructor(properties: EvidenceStorageProperties, cleanupInterceptor: Interceptor?) :
        this(properties, null, cleanupInterceptor)

    private val validatedProperties = properties.validate()
    private val bucket = properties.bucket
    private val deadlineContext = DeadlineContext()
    private val primaryHttpClient = httpClient(properties.requestTimeout, deadlineContext, primaryInterceptor)
    private val cleanupHttpClient = httpClient(
        minOf(properties.requestTimeout, Duration.ofMillis(500)),
        deadlineContext,
        cleanupInterceptor,
    )
    private val client = client(validatedProperties, primaryHttpClient)
    private val cleanupClient = client(validatedProperties, cleanupHttpClient)
    private val uploadHttpClient = primaryHttpClient
    private val deadlineScheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "minio-object-store-deadline").apply { isDaemon = true }
    }
    private val activeSources = ConcurrentHashMap.newKeySet<InputStream>()
    private val closed = AtomicBoolean()

    override fun putQuarantine(request: ObjectPut): StoredObject =
        withinOperation { deadline -> putQuarantineInternal(request, deadline) }

    private fun putQuarantineInternal(request: ObjectPut, deadline: OperationDeadline): StoredObject {
        validateKey(request.key, ObjectStore.QUARANTINE_PREFIX)
        require(request.size in 0..ObjectStore.MAX_OBJECT_SIZE) { "Invalid object size" }
        validateHash(request.sha256)
        require(request.contentType.length in 1..255 && request.contentType.none { it.isISOControl() }) {
            "Invalid content type"
        }

        val nonce = attemptNonce()
        val body = BoundedUploadBody(request)
        activeSources.add(request.source)
        if (closed.get()) runCatching { request.source.close() }
        var sourceCloser: ScheduledFuture<*>? = null
        try {
            if (closed.get()) throw ObjectStoreException("Object storage operation failed")
            sourceCloser = deadlineScheduler.schedule(
                { runCatching { request.source.close() } },
                deadline.remainingNanos(),
                TimeUnit.NANOSECONDS,
            )
            val expirySeconds = maxOf(1, properties.requestTimeout.seconds.toInt() + 1)
            val generatedUrl = client.getPresignedObjectUrl(
                GetPresignedObjectUrlArgs.builder()
                    .method(Method.PUT)
                    .bucket(bucket)
                    .`object`(request.key)
                    .expiry(expirySeconds)
                    .build(),
            )
            val objectUrl = generatedUrl.toHttpUrl().newBuilder().query(null).build()
            val unsignedRequest = Request.Builder()
                .url(objectUrl)
                .header("Host", objectUrl.toUrl().authority)
                .header("X-Amz-Date", ZonedDateTime.now(ZoneOffset.UTC).format(AMZ_DATE_FORMAT))
                .header("If-None-Match", "*")
                .header("X-Amz-Meta-$SHA256_METADATA", request.sha256)
                .header("X-Amz-Meta-$UPLOAD_NONCE_METADATA", nonce)
                .put(body)
                .build()
            val presignedUrl = Signer.presignV4(
                unsignedRequest,
                DEFAULT_REGION,
                properties.accessKey,
                properties.secretKey,
                expirySeconds,
            )
            val signedRequest = unsignedRequest.newBuilder()
                .url(presignedUrl)
                .removeHeader("X-Amz-Date")
                .build()
            uploadHttpClient.newCall(signedRequest).execute().use { response ->
                if (response.code == 412) throw ObjectAlreadyExistsException()
                if (!response.isSuccessful) throw IOException("Object upload failed")
            }
            if (!body.complete()) throw ObjectIntegrityException()
            val response = statResponse(client, request.key)
            val stored = stored(request.key, response)
            if (
                stored.size != request.size ||
                stored.sha256 != request.sha256 ||
                metadataValue(response.userMetadata(), UPLOAD_NONCE_METADATA) != nonce
            ) {
                removeQuietly(request.key)
                throw ObjectIntegrityException()
            }
            return stored
        } catch (exception: ObjectAlreadyExistsException) {
            throw exception
        } catch (exception: ObjectStoreException) {
            cleanupAmbiguousPut(request.key, nonce)
            throw exception
        } catch (exception: Exception) {
            if (cleanupAmbiguousPut(request.key, nonce) == PutCleanupOutcome.FOREIGN_OBJECT) {
                throw ObjectAlreadyExistsException()
            }
            throw ObjectStoreException("Object storage operation failed")
        } finally {
            sourceCloser?.cancel(false)
            activeSources.remove(request.source)
        }
    }

    override fun promote(
        quarantineKey: String,
        immutableKey: String,
        expectedSize: Long,
        expectedSha256: String,
    ): PromotionResult = withinOperation {
        promoteInternal(quarantineKey, immutableKey, expectedSize, expectedSha256)
    }

    private fun promoteInternal(
        quarantineKey: String,
        immutableKey: String,
        expectedSize: Long,
        expectedSha256: String,
    ): PromotionResult {
        validateKey(quarantineKey, ObjectStore.QUARANTINE_PREFIX)
        validateKey(immutableKey, ObjectStore.IMMUTABLE_PREFIX)
        require(expectedSize in 0..ObjectStore.MAX_OBJECT_SIZE) { "Invalid object size" }
        validateHash(expectedSha256)

        val source = stat(quarantineKey)
        if (source.size != expectedSize || source.sha256 != expectedSha256) throw ObjectIntegrityException()
        if (exists(immutableKey)) throw ObjectAlreadyExistsException()

        try {
            client.copyObject(
                CopyObjectArgs.builder()
                    .bucket(bucket)
                    .`object`(immutableKey)
                    .headers(mapOf("If-None-Match" to "*"))
                    .source(
                        CopySource.builder()
                            .bucket(bucket)
                            .`object`(quarantineKey)
                            .matchETag(source.etag)
                            .build(),
                    )
                    .build(),
            )
            val copied = stat(immutableKey)
            if (copied.size != expectedSize || copied.sha256 != expectedSha256) {
                removeQuietly(immutableKey)
                throw ObjectIntegrityException()
            }
            return PromotionResult(copied, removePromotedSource(quarantineKey))
        } catch (exception: ObjectStoreException) {
            throw exception
        } catch (exception: ErrorResponseException) {
            if (exception.errorResponse().code() in ALREADY_EXISTS_CODES) throw ObjectAlreadyExistsException()
            throw ObjectStoreException("Object storage operation failed")
        } catch (_: Exception) {
            throw ObjectStoreException("Object storage operation failed")
        }
    }

    override fun get(key: String, range: ObjectRange?): ObjectRead = withinOperation { getInternal(key, range) }

    private fun getInternal(key: String, range: ObjectRange?): ObjectRead {
        validateKey(key)
        val offset = range?.offset ?: 0L
        require(offset >= 0 && (range == null || range.length in 1..ObjectStore.MAX_OBJECT_SIZE)) {
            "Invalid object range"
        }
        val metadata = stat(key)
        val length = range?.length ?: metadata.size
        require(length in 0..ObjectStore.MAX_OBJECT_SIZE) { "Invalid object range" }
        require(offset <= metadata.size && length <= metadata.size - offset) { "Invalid object range" }
        try {
            val builder = GetObjectArgs.builder().bucket(bucket).`object`(key)
            if (range != null) builder.offset(offset).length(length)
            return ObjectRead(client.getObject(builder.build()), length, metadata.contentType)
        } catch (exception: ErrorResponseException) {
            throw mapped(exception)
        } catch (_: Exception) {
            throw ObjectStoreException("Object storage operation failed")
        }
    }

    override fun stat(key: String): StoredObject = withinOperation { statInternal(key) }

    private fun statInternal(key: String): StoredObject {
        validateKey(key)
        try {
            return stored(key, client.statObject(StatObjectArgs.builder().bucket(bucket).`object`(key).build()))
        } catch (exception: ErrorResponseException) {
            throw mapped(exception)
        } catch (_: Exception) {
            throw ObjectStoreException("Object storage operation failed")
        }
    }

    override fun delete(key: String): Unit = withinOperation { deleteInternal(key) }

    private fun deleteInternal(key: String) {
        validateKey(key)
        try {
            remove(key)
        } catch (exception: ErrorResponseException) {
            throw mapped(exception)
        } catch (_: Exception) {
            throw ObjectStoreException("Object storage operation failed")
        }
    }

    override fun list(prefix: String, startAfter: String?, limit: Int): List<StoredObject> =
        withinOperation { listInternal(prefix, startAfter, limit) }

    private fun listInternal(prefix: String, startAfter: String?, limit: Int): List<StoredObject> {
        validatePrefix(prefix)
        startAfter?.let {
            validateKey(it)
            require(it.startsWith(prefix)) { "Invalid object listing cursor" }
        }
        require(limit in 1..ObjectStore.DEFAULT_LIST_LIMIT) { "Invalid object listing limit" }
        try {
            val builder = ListObjectsArgs.builder()
                .bucket(bucket)
                .prefix(prefix)
                .recursive(true)
                .includeUserMetadata(true)
                .maxKeys(limit)
            if (startAfter != null) builder.startAfter(startAfter)
            return client.listObjects(builder.build()).take(limit).map { result ->
                val item = result.get()
                StoredObject(
                    key = item.objectName(),
                    size = item.size(),
                    sha256 = metadataHash(item.userMetadata()),
                    etag = item.etag(),
                    contentType = null,
                    lastModified = item.lastModified().toInstant(),
                )
            }
        } catch (exception: ErrorResponseException) {
            throw mapped(exception)
        } catch (_: Exception) {
            throw ObjectStoreException("Object storage operation failed")
        }
    }

    private fun exists(key: String): Boolean = try {
        stat(key)
        true
    } catch (_: ObjectNotFoundException) {
        false
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        activeSources.forEach { source -> runCatching { source.close() } }
        deadlineScheduler.shutdownNow()
        primaryHttpClient.dispatcher.cancelAll()
        cleanupHttpClient.dispatcher.cancelAll()
        runCatching { client.close() }
        runCatching { cleanupClient.close() }
        close(primaryHttpClient)
        close(cleanupHttpClient)
    }

    private fun ensureOpen() {
        if (closed.get()) throw ObjectStoreException("Object storage operation failed")
    }

    private fun <T> withinOperation(block: (OperationDeadline) -> T): T {
        ensureOpen()
        val existing = deadlineContext.current()
        if (existing != null) return block(existing)
        return deadlineContext.withDeadline(OperationDeadline.after(properties.requestTimeout), block)
    }

    private fun remove(key: String) {
        client.removeObject(RemoveObjectArgs.builder().bucket(bucket).`object`(key).build())
    }

    private fun removePromotedSource(key: String): SourceCleanupDisposition = try {
        cleanupClient.removeObject(RemoveObjectArgs.builder().bucket(bucket).`object`(key).build())
        SourceCleanupDisposition.REMOVED
    } catch (_: Exception) {
        try {
            statResponse(cleanupClient, key)
            SourceCleanupDisposition.SWEEP_REQUIRED
        } catch (exception: ErrorResponseException) {
            if (exception.errorResponse().code() in NOT_FOUND_CODES) {
                SourceCleanupDisposition.REMOVED
            } else {
                SourceCleanupDisposition.SWEEP_REQUIRED
            }
        } catch (_: Exception) {
            SourceCleanupDisposition.SWEEP_REQUIRED
        }
    }

    private fun removeQuietly(key: String) {
        try {
            remove(key)
        } catch (_: Exception) {
            // The original operation remains the caller-visible failure.
        }
    }

    private fun cleanupAmbiguousPut(key: String, nonce: String): PutCleanupOutcome {
        if (closed.get()) return PutCleanupOutcome.UNKNOWN
        val deadline = deadlineContext.current()
            ?: OperationDeadline.after(minOf(properties.requestTimeout, Duration.ofSeconds(2)))
        do {
            if (closed.get()) return PutCleanupOutcome.UNKNOWN
            try {
                val response = statResponse(cleanupClient, key)
                if (metadataValue(response.userMetadata(), UPLOAD_NONCE_METADATA) != nonce) {
                    return PutCleanupOutcome.FOREIGN_OBJECT
                }
                cleanupClient.removeObject(RemoveObjectArgs.builder().bucket(bucket).`object`(key).build())
                return PutCleanupOutcome.REMOVED
            } catch (exception: ErrorResponseException) {
                if (exception.errorResponse().code() in NOT_FOUND_CODES) return PutCleanupOutcome.NOT_FOUND
            } catch (_: Exception) {
            }
            val remaining = runCatching { deadline.remainingNanos() }.getOrElse { return PutCleanupOutcome.UNKNOWN }
            try {
                TimeUnit.NANOSECONDS.sleep(minOf(remaining, CLEANUP_RETRY_DELAY.toNanos()))
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return PutCleanupOutcome.UNKNOWN
            }
        } while (!deadline.expired())
        return PutCleanupOutcome.UNKNOWN
    }

    private fun statResponse(target: MinioClient, key: String): StatObjectResponse =
        target.statObject(StatObjectArgs.builder().bucket(bucket).`object`(key).build())

    private fun stored(key: String, response: StatObjectResponse): StoredObject = StoredObject(
        key = key,
        size = response.size(),
        sha256 = metadataHash(response.userMetadata()),
        etag = response.etag(),
        contentType = response.contentType(),
        lastModified = response.lastModified().toInstant(),
    )

    private fun mapped(exception: ErrorResponseException): ObjectStoreException =
        if (exception.errorResponse().code() in NOT_FOUND_CODES) {
            ObjectNotFoundException()
        } else {
            ObjectStoreException("Object storage operation failed")
        }

    private fun validatePrefix(prefix: String) {
        require(prefix.startsWith(ObjectStore.QUARANTINE_PREFIX) || prefix.startsWith(ObjectStore.IMMUTABLE_PREFIX)) {
            "Invalid object prefix"
        }
        require(prefix.length <= MAX_KEY_LENGTH && validPath(prefix)) { "Invalid object prefix" }
    }

    private fun validateKey(key: String, requiredPrefix: String? = null) {
        require(key.length in 1..MAX_KEY_LENGTH && validPath(key) && !key.endsWith('/')) { "Invalid object key" }
        require(
            key.startsWith(ObjectStore.QUARANTINE_PREFIX) || key.startsWith(ObjectStore.IMMUTABLE_PREFIX),
        ) { "Invalid object key" }
        require(requiredPrefix == null || key.startsWith(requiredPrefix)) { "Invalid object key" }
    }

    private fun validPath(value: String): Boolean =
        KEY_PATTERN.matches(value) && !value.contains("//") && value.split('/').none { it == "." || it == ".." }

    private fun validateHash(hash: String) {
        require(SHA256_PATTERN.matches(hash)) { "Invalid SHA-256" }
    }

    private class OperationDeadline private constructor(private val expiresAtNanos: Long) {
        fun remainingNanos(): Long {
            val remaining = expiresAtNanos - System.nanoTime()
            if (remaining <= 0) throw InterruptedIOException("Object storage deadline exceeded")
            return remaining
        }

        fun expired(): Boolean = System.nanoTime() >= expiresAtNanos

        companion object {
            fun after(timeout: Duration): OperationDeadline = OperationDeadline(System.nanoTime() + timeout.toNanos())
        }
    }

    private class DeadlineContext : Interceptor {
        private val current = ThreadLocal<OperationDeadline>()

        fun current(): OperationDeadline? = current.get()

        fun <T> withDeadline(deadline: OperationDeadline, block: (OperationDeadline) -> T): T {
            current.set(deadline)
            return try {
                block(deadline)
            } finally {
                current.remove()
            }
        }

        override fun intercept(chain: Interceptor.Chain): okhttp3.Response {
            current.get()?.let { deadline ->
                chain.call().timeout().timeout(deadline.remainingNanos(), TimeUnit.NANOSECONDS)
            }
            return chain.proceed(chain.request())
        }
    }

    private class BoundedUploadBody(
        private val request: ObjectPut,
    ) : RequestBody() {
        private val digest = MessageDigest.getInstance("SHA-256")
        private var count = 0L

        override fun contentType() = request.contentType.toMediaType()

        override fun contentLength(): Long = request.size

        override fun isOneShot(): Boolean = true

        override fun writeTo(sink: BufferedSink) {
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (count < request.size) {
                val read = request.source.read(buffer, 0, minOf(buffer.size.toLong(), request.size - count).toInt())
                if (read < 0) throw IOException("Source ended before declared size")
                if (read == 0) continue
                digest.update(buffer, 0, read)
                sink.write(buffer, 0, read)
                count += read
            }
        }

        fun complete(): Boolean {
            if (count != request.size || request.source.read() != -1) return false
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            return MessageDigest.isEqual(actual.toByteArray(), request.sha256.toByteArray())
        }
    }

    private enum class PutCleanupOutcome {
        REMOVED,
        FOREIGN_OBJECT,
        NOT_FOUND,
        UNKNOWN,
    }

    private companion object {
        const val MAX_KEY_LENGTH = 1_024
        const val SHA256_METADATA = "sha256"
        const val UPLOAD_NONCE_METADATA = "occ-upload-nonce"
        const val DEFAULT_REGION = "us-east-1"
        val AMZ_DATE_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'")
        val CLEANUP_RETRY_DELAY: Duration = Duration.ofMillis(50)
        val KEY_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._/-]*$")
        val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
        val NOT_FOUND_CODES = setOf("NoSuchKey", "NoSuchObject", "NotFound")
        val ALREADY_EXISTS_CODES = setOf("PreconditionFailed", "ConditionalRequestConflict")

        fun metadataHash(metadata: Map<String, String>): String? =
            metadataValue(metadata, SHA256_METADATA)

        fun metadataValue(metadata: Map<String, String>, name: String): String? =
            metadata.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

        fun attemptNonce(): String {
            val bytes = ByteArray(32)
            SecureRandomHolder.random.nextBytes(bytes)
            return bytes.joinToString("") { "%02x".format(it) }
        }

        fun client(properties: EvidenceStorageProperties, httpClient: OkHttpClient): MinioClient =
            MinioClient.builder()
                .endpoint(properties.endpoint)
                .region(DEFAULT_REGION)
                .credentials(properties.accessKey, properties.secretKey)
                .httpClient(httpClient, false)
                .build()

        fun httpClient(
            timeout: Duration,
            deadlineContext: DeadlineContext,
            additionalInterceptor: Interceptor? = null,
        ): OkHttpClient {
            val timeoutMillis = timeout.toMillis()
            val builder = OkHttpClient.Builder()
                .addInterceptor(deadlineContext)
                .connectTimeout(minOf(timeoutMillis, Duration.ofSeconds(2).toMillis()), TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
                .writeTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
                .callTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
            if (additionalInterceptor != null) builder.addInterceptor(additionalInterceptor)
            return builder.build()
        }

        fun close(httpClient: OkHttpClient) {
            httpClient.dispatcher.cancelAll()
            httpClient.dispatcher.executorService.shutdownNow()
            httpClient.connectionPool.evictAll()
            runCatching { httpClient.cache?.close() }
        }

        private object SecureRandomHolder {
            val random = SecureRandom()
        }
    }
}
