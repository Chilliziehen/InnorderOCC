package com.innorder.occ.evidence

import org.springframework.stereotype.Component
import org.springframework.context.annotation.Profile
import org.slf4j.LoggerFactory
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionTemplate
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

    private companion object {
        val LEASE: Duration = Duration.ofMinutes(2)
        val LOG = LoggerFactory.getLogger(EvidenceCleanupJob::class.java)
    }
}
