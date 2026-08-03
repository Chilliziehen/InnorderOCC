package com.innorder.occ.cohort

import com.innorder.occ.api.cursor.CursorBinding
import com.innorder.occ.api.cursor.CursorCodec
import com.innorder.occ.api.cursor.CursorFilterDigest
import com.innorder.occ.api.cursor.CursorKeyRing
import com.innorder.occ.api.cursor.CursorPayload
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.Instant
import java.util.UUID

data class CohortListFilter(
    val status: CohortStatus? = null,
    val packageVersionId: UUID? = null,
    val updatedBefore: Instant? = null,
)

@Service
@ConditionalOnBean(CursorCodec::class)
class CohortQueryService(
    private val cohorts: CohortRepository,
    transactionManager: PlatformTransactionManager,
    private val cursors: CursorCodec,
    private val filterDigests: CursorFilterDigest,
    private val cursorKeys: CursorKeyRing,
    private val clock: Clock,
) {
    private val transactions = TransactionTemplate(transactionManager).apply { isReadOnly = true }

    fun get(principalId: UUID, correlationId: UUID, cohortId: UUID): CohortDetail = transactions.execute {
        cohorts.findAuthorized(cohortId, principalId) ?: throw CohortNotFoundException()
    }!!

    fun list(
        principalId: UUID,
        correlationId: UUID,
        filter: CohortListFilter,
        pageSize: Int,
        cursor: String?,
    ): CohortPage {
        require(pageSize in 1..100)
        val digest = filterDigests.fromJson(filterJson(filter))
        val binding = CursorBinding(principalId, ENDPOINT, digest)
        val seek = cursor?.let { cursors.decode(it, binding) }
        return transactions.execute {
            val window = cohorts.listAuthorized(principalId, filter, seek, pageSize + 1)
            val items = window.take(pageSize)
            val next = if (window.size > pageSize) items.last().let { last ->
                cursors.encode(
                    CursorPayload(
                        1, principalId, ENDPOINT, digest, last.updatedAt, last.id, clock.instant(), cursorKeys.currentKeyId,
                    ),
                )
            } else null
            CohortPage(items, CursorPageInfo(next))
        }!!
    }

    private fun filterJson(filter: CohortListFilter): String =
        """{"packageVersionId":${filter.packageVersionId?.let { "\"$it\"" } ?: "null"},"status":${filter.status?.let { "\"${it.name}\"" } ?: "null"},"updatedBefore":${filter.updatedBefore?.let { "\"$it\"" } ?: "null"}}"""

    private companion object {
        const val ENDPOINT = "/api/v1/cohorts"
    }
}
