package com.innorder.occ.evidence

import org.springframework.stereotype.Component
import org.springframework.context.annotation.Profile
import org.slf4j.LoggerFactory
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.beans.factory.annotation.Value
import org.springframework.scheduling.annotation.Scheduled
import java.time.Clock
import java.time.Duration
import java.util.UUID

@Component
@Profile("!test & !flowable-init")
class EvidenceCleanupJob(
    private val evidence: EvidenceRepository,
    private val objects: ObjectStore,
    transactionManager: PlatformTransactionManager,
    private val clock: Clock,
    @Value("\${occ.evidence.cleanup.enabled:false}") private val enabled: Boolean = false,
    @Value("\${occ.evidence.cleanup.batch-size:50}") private val batchSize: Int = 50,
) {
    private val transactions = TransactionTemplate(transactionManager).apply {
        propagationBehavior = TransactionDefinition.PROPAGATION_REQUIRES_NEW
    }

    fun runBatch(owner: UUID, limit: Int): Int {
        require(limit in 1..100)
        val now = clock.instant()
        val leases = transactions.execute { evidence.claimCleanup(owner, now, now.plus(LEASE), limit) }!!
        var deleted = 0
        leases.forEach { lease ->
            try {
                val removed = transactions.execute {
                    if (!evidence.lockCleanupEligibility(lease, clock.instant())) return@execute false
                    objects.delete(lease.objectKey)
                    evidence.cleanupDeleted(lease, clock.instant())
                    true
                } == true
                if (removed) deleted++
            } catch (failure: Exception) {
                try {
                    transactions.executeWithoutResult { evidence.cleanupFailed(lease, failure.javaClass.simpleName) }
                } catch (stateFailure: Exception) {
                    LOG.warn(
                        "Evidence cleanup disposition update deferred id={} deleteFailure={} stateFailure={}",
                        lease.id, failure.javaClass.name, stateFailure.javaClass.name,
                    )
                }
            }
        }
        return deleted
    }

    @Scheduled(fixedDelayString = "\${occ.evidence.cleanup.poll-interval:5m}")
    fun scheduled() {
        if (!enabled) return
        val owner = UUID.randomUUID()
        runBatch(owner, batchSize)
        sweepOrphans(batchSize)
    }

    fun sweepOrphans(limit: Int): Int {
        require(limit in 1..ObjectStore.DEFAULT_LIST_LIMIT)
        val cutoff = clock.instant().minus(ORPHAN_GRACE)
        var removed = 0
        for (prefix in listOf(ObjectStore.QUARANTINE_PREFIX, ObjectStore.IMMUTABLE_PREFIX, ObjectStore.PREVIEW_PREFIX)) {
            if (removed >= limit) break
            var cursor: String? = null
            var scanned = 0
            while (removed < limit && scanned < MAX_SWEEP_SCAN) {
                val pageLimit = minOf(ObjectStore.DEFAULT_LIST_LIMIT, MAX_SWEEP_SCAN - scanned)
                val page = objects.list(prefix, cursor, pageLimit)
                if (page.isEmpty()) break
                page.filter { !it.lastModified.isAfter(cutoff) }.forEach { candidate ->
                    val deleted = transactions.execute {
                        if (!evidence.lockUnreferencedObject(candidate.key)) return@execute false
                        objects.delete(candidate.key)
                        true
                    } == true
                    if (deleted) removed++
                }
                scanned += page.size
                cursor = page.last().key
                if (page.size < pageLimit) break
            }
        }
        return removed
    }

    private companion object {
        val LEASE: Duration = Duration.ofMinutes(2)
        val ORPHAN_GRACE: Duration = Duration.ofHours(24)
        const val MAX_SWEEP_SCAN = 10_000
        val LOG = LoggerFactory.getLogger(EvidenceCleanupJob::class.java)
    }
}
