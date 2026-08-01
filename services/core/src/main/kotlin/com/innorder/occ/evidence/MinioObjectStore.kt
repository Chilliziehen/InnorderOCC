package com.innorder.occ.evidence

import io.minio.CopyObjectArgs
import io.minio.CopySource
import io.minio.GetObjectArgs
import io.minio.ListObjectsArgs
import io.minio.MinioClient
import io.minio.PutObjectArgs
import io.minio.RemoveObjectArgs
import io.minio.StatObjectArgs
import io.minio.StatObjectResponse
import io.minio.errors.ErrorResponseException
import okhttp3.OkHttpClient
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.time.Duration
import java.util.concurrent.TimeUnit

class MinioObjectStore(
    properties: EvidenceStorageProperties,
    private val client: MinioClient = client(properties.validate()),
) : ObjectStore {
    private val bucket = properties.bucket
    private val cleanupBudget = minOf(properties.requestTimeout, Duration.ofSeconds(2))
    private val cleanupClient = client(properties, minOf(properties.requestTimeout, Duration.ofMillis(500)))

    override fun putQuarantine(request: ObjectPut): StoredObject {
        validateKey(request.key, ObjectStore.QUARANTINE_PREFIX)
        require(request.size in 0..ObjectStore.MAX_OBJECT_SIZE) { "Invalid object size" }
        validateHash(request.sha256)
        require(request.contentType.length in 1..255 && request.contentType.none { it.isISOControl() }) {
            "Invalid content type"
        }

        val guarded = ExactHashingInputStream(request.source, request.size)
        try {
            client.putObject(
                PutObjectArgs.builder()
                    .bucket(bucket)
                    .`object`(request.key)
                    .stream(guarded, request.size, MULTIPART_PART_SIZE)
                    .contentType(request.contentType)
                    .headers(mapOf("If-None-Match" to "*"))
                    .userMetadata(mapOf(SHA256_METADATA to request.sha256))
                    .build(),
            )
            if (!guarded.complete(request.sha256)) {
                removeQuietly(request.key)
                throw ObjectIntegrityException()
            }
            return stat(request.key).also {
                if (it.size != request.size || it.sha256 != request.sha256) {
                    removeQuietly(request.key)
                    throw ObjectIntegrityException()
                }
            }
        } catch (exception: ObjectStoreException) {
            cleanupAmbiguousPut(request.key)
            throw exception
        } catch (exception: ErrorResponseException) {
            if (exception.errorResponse().code() in ALREADY_EXISTS_CODES) throw ObjectAlreadyExistsException()
            cleanupAmbiguousPut(request.key)
            throw ObjectStoreException("Object storage operation failed")
        } catch (_: Exception) {
            cleanupAmbiguousPut(request.key)
            throw ObjectStoreException("Object storage operation failed")
        }
    }

    override fun promote(
        quarantineKey: String,
        immutableKey: String,
        expectedSize: Long,
        expectedSha256: String,
    ): StoredObject {
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
            try {
                remove(quarantineKey)
            } catch (_: Exception) {
                removeQuietly(immutableKey)
                throw ObjectStoreException("Object storage operation failed")
            }
            return copied
        } catch (exception: ObjectStoreException) {
            throw exception
        } catch (exception: ErrorResponseException) {
            if (exception.errorResponse().code() in ALREADY_EXISTS_CODES) throw ObjectAlreadyExistsException()
            throw ObjectStoreException("Object storage operation failed")
        } catch (_: Exception) {
            throw ObjectStoreException("Object storage operation failed")
        }
    }

    override fun get(key: String, range: ObjectRange?): ObjectRead {
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

    override fun stat(key: String): StoredObject {
        validateKey(key)
        try {
            return stored(key, client.statObject(StatObjectArgs.builder().bucket(bucket).`object`(key).build()))
        } catch (exception: ErrorResponseException) {
            throw mapped(exception)
        } catch (_: Exception) {
            throw ObjectStoreException("Object storage operation failed")
        }
    }

    override fun delete(key: String) {
        validateKey(key)
        try {
            remove(key)
        } catch (exception: ErrorResponseException) {
            throw mapped(exception)
        } catch (_: Exception) {
            throw ObjectStoreException("Object storage operation failed")
        }
    }

    override fun list(prefix: String, startAfter: String?, limit: Int): List<StoredObject> {
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

    private fun remove(key: String) {
        client.removeObject(RemoveObjectArgs.builder().bucket(bucket).`object`(key).build())
    }

    private fun removeQuietly(key: String) {
        try {
            remove(key)
        } catch (_: Exception) {
            // The original operation remains the caller-visible failure.
        }
    }

    private fun cleanupAmbiguousPut(key: String) {
        val deadline = System.nanoTime() + cleanupBudget.toNanos()
        do {
            try {
                cleanupClient.removeObject(RemoveObjectArgs.builder().bucket(bucket).`object`(key).build())
                return
            } catch (_: Exception) {
                val remaining = deadline - System.nanoTime()
                if (remaining <= 0) return
                try {
                    TimeUnit.NANOSECONDS.sleep(minOf(remaining, CLEANUP_RETRY_DELAY.toNanos()))
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return
                }
            }
        } while (System.nanoTime() < deadline)
    }

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

    private class ExactHashingInputStream(
        source: InputStream,
        private val expectedSize: Long,
    ) : FilterInputStream(source) {
        private val digest = MessageDigest.getInstance("SHA-256")
        private var count = 0L

        override fun read(): Int {
            if (count == expectedSize) return -1
            val value = super.read()
            if (value >= 0) {
                digest.update(value.toByte())
                count++
            }
            return value
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (count == expectedSize) return -1
            val allowed = minOf(length.toLong(), expectedSize - count).toInt()
            val read = super.read(buffer, offset, allowed)
            if (read > 0) {
                digest.update(buffer, offset, read)
                count += read
            }
            return read
        }

        fun complete(expectedHash: String): Boolean {
            if (count != expectedSize || `in`.read() != -1) return false
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            return MessageDigest.isEqual(actual.toByteArray(), expectedHash.toByteArray())
        }
    }

    private companion object {
        const val MULTIPART_PART_SIZE = 5L * 1024 * 1024
        const val MAX_KEY_LENGTH = 1_024
        const val SHA256_METADATA = "sha256"
        val CLEANUP_RETRY_DELAY: Duration = Duration.ofMillis(50)
        val KEY_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._/-]*$")
        val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
        val NOT_FOUND_CODES = setOf("NoSuchKey", "NoSuchObject", "NotFound")
        val ALREADY_EXISTS_CODES = setOf("PreconditionFailed", "ConditionalRequestConflict")

        fun metadataHash(metadata: Map<String, String>): String? =
            metadata.entries.firstOrNull { it.key.equals(SHA256_METADATA, ignoreCase = true) }?.value

        fun client(
            properties: EvidenceStorageProperties,
            timeout: Duration = properties.requestTimeout,
        ): MinioClient {
            val timeoutMillis = timeout.toMillis()
            val httpClient = OkHttpClient.Builder()
                .connectTimeout(minOf(timeoutMillis, Duration.ofSeconds(2).toMillis()), TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
                .writeTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
                .callTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
                .build()
            return MinioClient.builder()
                .endpoint(properties.endpoint)
                .credentials(properties.accessKey, properties.secretKey)
                .httpClient(httpClient, true)
                .build()
        }
    }
}
