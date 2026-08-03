package com.innorder.occ.evidence

import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.stereotype.Component

@Component
class EvidenceProductionBindingVerifier(
    @Value("\${occ.evidence.production-enabled:false}") private val productionEnabled: Boolean,
    private val workflowBindings: List<EvidenceWorkflowPort>,
    private val notificationBindings: List<DomainNotificationPort>,
) : ApplicationRunner {
    override fun run(args: ApplicationArguments) = verify()

    fun verify() {
        if (!productionEnabled) return
        check(workflowBindings.any { it is Agent01TransactionalEvidenceWorkflowPort }) {
            "occ.evidence.production-enabled requires an agent01-compatible transactional EvidenceWorkflowPort"
        }
        check(notificationBindings.any { it is TransactionalDomainNotificationPort }) {
            "occ.evidence.production-enabled requires a transactional DomainNotificationPort"
        }
    }
}
