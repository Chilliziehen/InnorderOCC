package com.innorder.occ.authz

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import org.springframework.transaction.support.TransactionSynchronizationManager

@Repository
class AuthorizationRevisionLockRepository(private val jdbc: JdbcTemplate) {
    fun acquireForChange(): Long {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) throw AuthorizationAvailabilityException()
        val revision = jdbc.queryForObject(
            "SELECT authz.lock_authorization_state_for_change()",
            Long::class.java,
        ) ?: throw AuthorizationAvailabilityException()
        if (revision !in 0..AuthorizationDecisionValidator.MAX_SAFE_INTEGER) throw AuthorizationAvailabilityException()
        return revision
    }
}
