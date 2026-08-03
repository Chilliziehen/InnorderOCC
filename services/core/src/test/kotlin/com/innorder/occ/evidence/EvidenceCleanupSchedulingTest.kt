package com.innorder.occ.evidence

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.scheduling.annotation.Scheduled

class EvidenceCleanupSchedulingTest {
    @Test
    fun `cleanup has a production configurable scheduled entrypoint`() {
        val scheduled = EvidenceCleanupJob::class.java.declaredMethods
            .mapNotNull { it.getAnnotation(Scheduled::class.java) }
        assertThat(scheduled).hasSize(1)
        assertThat(scheduled.single().fixedDelayString).contains("occ.evidence.cleanup.poll-interval")
    }
}
