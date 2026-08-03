package com.innorder.occ.evidence

import org.assertj.core.api.Assertions.assertThatCode
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class EvidenceProductionBindingVerifierTest {
    @Test
    fun `production mode rejects intent-only integration`() {
        assertThatThrownBy {
            EvidenceProductionBindingVerifier(true, emptyList(), emptyList()).verify()
        }.isInstanceOf(IllegalStateException::class.java)
            .hasMessageContaining("EvidenceWorkflowPort")
    }

    @Test
    fun `production mode accepts explicit transactional agent bindings`() {
        assertThatCode {
            EvidenceProductionBindingVerifier(
                true,
                listOf(object : Agent01TransactionalEvidenceWorkflowPort {
                    override fun priorAssignee(evidenceId: java.util.UUID) = null
                    override fun dispatch(intent: EvidenceWorkflowIntent) = Unit
                }),
                listOf(object : TransactionalDomainNotificationPort {
                    override fun dispatch(intent: DomainNotificationIntent) = Unit
                }),
            ).verify()
        }.doesNotThrowAnyException()
    }

    @Test
    fun `non-production mode permits transactional intents without delivery bindings`() {
        assertThatCode {
            EvidenceProductionBindingVerifier(false, emptyList(), emptyList()).verify()
        }.doesNotThrowAnyException()
    }
}
