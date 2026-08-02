package com.innorder.occ.evidence

import java.io.Closeable
import java.io.InputStream
import java.time.Instant

interface ObjectStore : AutoCloseable {
    fun putQuarantine(request: ObjectPut): StoredObject

    fun putPreview(request: ObjectPut): StoredObject

    fun promote(
        quarantineKey: String,
        immutableKey: String,
        expectedSize: Long,
        expectedSha256: String,
    ): PromotionResult

    fun get(key: String, range: ObjectRange? = null): ObjectRead

    fun stat(key: String): StoredObject

    fun delete(key: String)

    fun list(prefix: String, startAfter: String? = null, limit: Int = DEFAULT_LIST_LIMIT): List<StoredObject>

    companion object {
        const val QUARANTINE_PREFIX = "quarantine/"
        const val IMMUTABLE_PREFIX = "evidence/"
        const val PREVIEW_PREFIX = "previews/"
        const val MAX_OBJECT_SIZE = 100L * 1024 * 1024
        const val DEFAULT_LIST_LIMIT = 1_000
    }
}

data class ObjectPut(
    val key: String,
    val source: InputStream,
    val size: Long,
    val sha256: String,
    val contentType: String,
)

data class ObjectRange(
    val offset: Long,
    val length: Long,
)

data class StoredObject(
    val key: String,
    val size: Long,
    val sha256: String?,
    val etag: String,
    val contentType: String?,
    val lastModified: Instant,
)

data class PromotionResult(
    val `object`: StoredObject,
    val sourceCleanupDisposition: SourceCleanupDisposition,
)

enum class SourceCleanupDisposition {
    REMOVED,
    SWEEP_REQUIRED,
}

class ObjectRead(
    val stream: InputStream,
    val length: Long,
    val contentType: String?,
    val contentDisposition: String = "attachment",
) : Closeable {
    override fun close() = stream.close()
}

open class ObjectStoreException internal constructor(message: String) : RuntimeException(message)

class ObjectNotFoundException internal constructor() : ObjectStoreException("Object not found")

class ObjectAlreadyExistsException internal constructor() : ObjectStoreException("Object already exists")

class ObjectIntegrityException internal constructor() :
    ObjectStoreException("Object content did not match declared size or hash")
