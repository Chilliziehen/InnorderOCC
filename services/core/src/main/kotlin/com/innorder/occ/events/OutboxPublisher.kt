package com.innorder.occ.events

import jakarta.annotation.PreDestroy
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.Scheduled
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

data class PublishBatchResult(
    val claimed: Int,
    val published: Int,
    val failed: Int,
    val casLost: Int,
)

class OutboxPublisher(
    private val repository: OutboxPublishingRepository,
    private val sender: OutboxEventSender,
    private val properties: OutboxProperties,
) {
    private val polling = AtomicBoolean()
    private val stopping = AtomicBoolean()
    private val lifecycleMonitor = Object()
    private val outstanding = linkedMapOf<UUID, ClaimedOutboxEvent>()
    private var activeEventId: UUID? = null

    /**
     * Delivery is at-least-once: a broker acknowledgement followed by a process crash before the
     * success CAS can cause stale recovery to publish the same event ID again. Consumers deduplicate by event ID.
     */
    fun publishBatch(): PublishBatchResult {
        if (!properties.enabled || stopping.get() || !polling.compareAndSet(false, true)) return PublishBatchResult(0, 0, 0, 0)
        var published = 0
        var failed = 0
        var casLost = 0
        var interrupted = false
        var claimed = emptyList<ClaimedOutboxEvent>()
        try {
            claimed = repository.claim()
            synchronized(lifecycleMonitor) {
                claimed.forEach { outstanding[it.id] = it }
            }
            for (event in claimed) {
                if (!beginSend(event)) break
                val renewed = repository.renew(event)
                if (renewed == null) {
                    casLost++
                    completeSend(event)
                    continue
                }
                updateClaimToken(renewed)
                var deliverySucceeded = false
                val finalization = try {
                    try {
                        sender.publish(renewed.envelope())
                        deliverySucceeded = true
                        repository.succeed(renewed)
                    } catch (_: InvalidEventEnvelopeException) {
                        failed++
                        repository.fail(renewed, FailureCategory.INVALID_EVENT)
                    } catch (_: InterruptedException) {
                        interrupted = true
                        failed++
                        repository.fail(renewed, FailureCategory.DELIVERY_FAILED)
                    } catch (_: Exception) {
                        failed++
                        repository.fail(renewed, FailureCategory.DELIVERY_FAILED)
                    }
                } finally {
                    completeSend(event)
                }
                if (finalization == FinalizeResult.CAS_LOST) casLost++
                else if (deliverySucceeded) published++
                if (interrupted) break
            }
        } finally {
            try {
                if (stopping.get()) releaseUnvisitedClaims()
            } finally {
                polling.set(false)
                synchronized(lifecycleMonitor) { lifecycleMonitor.notifyAll() }
                if (interrupted) Thread.currentThread().interrupt()
            }
        }
        return PublishBatchResult(claimed.size, published, failed, casLost)
    }

    @Scheduled(fixedDelayString = "#{@'occ.outbox-com.innorder.occ.events.OutboxProperties'.pollInterval.toMillis()}")
    fun poll() {
        try {
            publishBatch()
        } catch (error: Exception) {
            LOG.warn("Outbox polling batch failed", error)
        }
    }

    @PreDestroy
    fun shutdown() {
        stopping.set(true)
        releaseUnvisitedClaims()
        val deadline = System.nanoTime() + properties.ackTimeout.toNanos()
        var interrupted = false
        try {
            synchronized(lifecycleMonitor) {
                while (polling.get() && System.nanoTime() < deadline) {
                    val remainingMillis = (deadline - System.nanoTime()) / 1_000_000
                    if (remainingMillis <= 0) break
                    lifecycleMonitor.wait(remainingMillis)
                }
            }
        } catch (_: InterruptedException) {
            interrupted = true
        } finally {
            releaseUnvisitedClaims()
            if (interrupted) Thread.currentThread().interrupt()
        }
    }

    private fun beginSend(event: ClaimedOutboxEvent): Boolean = synchronized(lifecycleMonitor) {
        if (stopping.get()) false else {
            activeEventId = event.id
            true
        }
    }

    private fun completeSend(event: ClaimedOutboxEvent) {
        synchronized(lifecycleMonitor) {
            outstanding.remove(event.id)
            if (activeEventId == event.id) activeEventId = null
            lifecycleMonitor.notifyAll()
        }
    }

    private fun updateClaimToken(event: ClaimedOutboxEvent) {
        synchronized(lifecycleMonitor) {
            if (outstanding.containsKey(event.id)) outstanding[event.id] = event
        }
    }

    private fun releaseUnvisitedClaims() {
        val claims = synchronized(lifecycleMonitor) {
            outstanding.values.filter { it.id != activeEventId }.also { releasable ->
                releasable.forEach { outstanding.remove(it.id) }
            }
        }
        claims.forEach(repository::release)
    }

    companion object {
        private val LOG = LoggerFactory.getLogger(OutboxPublisher::class.java)
    }
}
