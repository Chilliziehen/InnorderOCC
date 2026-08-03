package com.innorder.occ.iam

import com.innorder.occ.authz.WorkflowAuthorizationRoles
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import java.sql.ResultSet
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID

data class LockedAccount(
    val principalId: UUID,
    val username: String,
    val displayName: String,
    val principalStatus: String,
    val entityState: String,
    val passwordHash: String?,
    val tokenVersion: Int,
    val failedAttempts: Int,
    val failedWindowStartedAt: Instant?,
    val lockedUntil: Instant?,
)

data class AccountCredentialSnapshot(
    val principalId: UUID,
    val username: String,
    val passwordHash: String?,
    val tokenVersion: Int,
)

data class CurrentUser(
    val id: UUID,
    val username: String,
    val displayName: String,
    val status: String,
    val capabilities: List<String>,
)

@Repository
class PrincipalRepository(private val jdbc: JdbcTemplate) {
    fun credentialSnapshot(username: String): AccountCredentialSnapshot? = jdbc.query(
        """SELECT ua.principal_id, ua.username, ua.password_hash, ua.password_version
           FROM iam.user_account ua
           WHERE ua.username = ?""",
        { rs, _ -> AccountCredentialSnapshot(
            rs.getObject("principal_id", UUID::class.java),
            rs.getString("username"),
            rs.getString("password_hash"),
            rs.getInt("password_version"),
        ) },
        username,
    ).singleOrNull()

    fun lockAccount(principalId: UUID): LockedAccount? {
        if (!lock("SELECT id FROM iam.principal WHERE id = ? FOR UPDATE", principalId)) return null
        if (!lock("SELECT id FROM authz.entity WHERE id = ? FOR UPDATE", principalId)) return null
        return jdbc.query(
            """SELECT ua.principal_id, ua.username, ua.password_hash, ua.password_version,
                      ua.failed_attempts, ua.failed_window_started_at, ua.locked_until,
                      p.display_name, p.status, e.state
               FROM iam.user_account ua
               JOIN iam.principal p ON p.id = ua.principal_id
               JOIN authz.entity e ON e.id = ua.principal_id
               WHERE ua.principal_id = ? FOR UPDATE OF ua""",
            { rs, _ -> account(rs) },
            principalId,
        ).singleOrNull()
    }

    fun recordFailure(account: LockedAccount, now: Instant) {
        val withinWindow = account.failedWindowStartedAt?.let { now < it.plus(FAILURE_WINDOW) } == true
        val attempts = if (withinWindow) account.failedAttempts + 1 else 1
        val windowStart = if (withinWindow) account.failedWindowStartedAt!! else now
        val lockedUntil = if (attempts >= MAX_FAILURES) now.plus(LOCK_DURATION) else null
        jdbc.update(
            """UPDATE iam.user_account
               SET failed_attempts = ?, failed_window_started_at = ?, locked_until = ?
               WHERE principal_id = ?""",
            attempts,
            windowStart.sql(),
            lockedUntil?.sql(),
            account.principalId,
        )
    }

    fun recordSuccess(account: LockedAccount, passwordHash: String?, now: Instant) {
        if (passwordHash == null) {
            jdbc.update(
                """UPDATE iam.user_account
                   SET failed_attempts = 0, failed_window_started_at = NULL, locked_until = NULL,
                       last_login_at = ?
                   WHERE principal_id = ?""",
                now.sql(),
                account.principalId,
            )
        } else {
            jdbc.update(
                """UPDATE iam.user_account
                   SET failed_attempts = 0, failed_window_started_at = NULL, locked_until = NULL,
                       last_login_at = ?, password_hash = ?, password_version = password_version + 1
                   WHERE principal_id = ?""",
                now.sql(),
                passwordHash,
                account.principalId,
            )
        }
    }

    fun currentUser(principalId: UUID): CurrentUser? {
        val base = jdbc.query(
            """SELECT p.id, ua.username, p.display_name, p.status
               FROM iam.principal p
               JOIN iam.user_account ua ON ua.principal_id = p.id
               JOIN authz.entity e ON e.id = p.id
               WHERE p.id = ? AND p.principal_kind = 'USER' AND p.status = 'ACTIVE' AND e.state = 'ACTIVE'""",
            { rs, _ -> CurrentUser(
                rs.getObject("id", UUID::class.java),
                rs.getString("username"),
                rs.getString("display_name"),
                rs.getString("status"),
                emptyList(),
            ) },
            principalId,
        ).singleOrNull() ?: return null
        return base.copy(capabilities = capabilities(principalId))
    }

    fun lockCurrentUser(principalId: UUID): CurrentUser? {
        if (!lock("SELECT id FROM iam.principal WHERE id = ? FOR UPDATE", principalId)) return null
        if (!lock("SELECT id FROM authz.entity WHERE id = ? FOR UPDATE", principalId)) return null
        val accountLocked = jdbc.query(
            "SELECT principal_id FROM iam.user_account WHERE principal_id = ? FOR UPDATE",
            { rs, _ -> rs.getObject("principal_id", UUID::class.java) },
            principalId,
        ).singleOrNull() == principalId
        return if (accountLocked) currentUser(principalId) else null
    }

    fun customerInstanceId(): UUID = jdbc.queryForObject(
        "SELECT id FROM platform.customer_instance WHERE singleton",
        UUID::class.java,
    )!!

    private fun capabilities(principalId: UUID): List<String> = jdbc.queryForList(
        """SELECT DISTINCT role_entity.entity_key
           FROM authz.relationship r
           JOIN catalog.relation_definition rd ON rd.id = r.relation_definition_id
             AND rd.auth_relevant AND rd.id = ?
           JOIN authz.entity subject_entity ON subject_entity.id = r.subject_entity_id
             AND subject_entity.state = 'ACTIVE' AND subject_entity.entity_type_id = rd.subject_type_id
           JOIN authz.entity role_entity ON role_entity.id = r.object_entity_id AND role_entity.state = 'ACTIVE'
             AND role_entity.entity_type_id = rd.object_type_id
           JOIN iam.principal role_principal ON role_principal.id = role_entity.id
             AND role_principal.principal_kind = 'ROLE' AND role_principal.status = 'ACTIVE'
           WHERE r.subject_entity_id = ?
             AND r.revoked_at IS NULL
             AND r.valid_from <= transaction_timestamp()
             AND (r.valid_until IS NULL OR r.valid_until > transaction_timestamp())""",
        String::class.java,
        PLATFORM_ROLE_ASSIGNMENT_RELATION_DEFINITION_ID,
        principalId,
    ).flatMap { ROLE_CAPABILITIES[it].orEmpty() }.distinct().sorted()

    private fun lock(sql: String, id: UUID): Boolean = jdbc.query(
        sql,
        { rs, _ -> rs.getObject("id", UUID::class.java) },
        id,
    ).singleOrNull() == id

    private fun account(rs: ResultSet): LockedAccount = LockedAccount(
        rs.getObject("principal_id", UUID::class.java),
        rs.getString("username"),
        rs.getString("display_name"),
        rs.getString("status"),
        rs.getString("state"),
        rs.getString("password_hash"),
        rs.getInt("password_version"),
        rs.getInt("failed_attempts"),
        rs.instant("failed_window_started_at"),
        rs.instant("locked_until"),
    )

    private fun ResultSet.instant(column: String): Instant? =
        getObject(column, OffsetDateTime::class.java)?.toInstant()

    private fun Instant.sql(): OffsetDateTime = OffsetDateTime.ofInstant(this, ZoneOffset.UTC)

    companion object {
        private const val MAX_FAILURES = 5
        private val FAILURE_WINDOW = java.time.Duration.ofMinutes(15)
        private val LOCK_DURATION = java.time.Duration.ofMinutes(15)
        // Stable platform catalog identity reserved for the Task 7 role-assignment bootstrap.
        val PLATFORM_ROLE_ASSIGNMENT_RELATION_DEFINITION_ID: UUID =
            UUID.fromString("00000000-0000-7000-8000-000000000002")
        private val ROLE_CAPABILITIES: Map<String, Collection<String>> = mapOf(
            "role:viewer" to listOf("occ.read"),
            "role:operator" to listOf("occ.execute", "occ.read"),
            "role:administrator" to listOf("occ.admin", "occ.execute", "occ.read"),
        ) + WorkflowAuthorizationRoles.capabilitiesByRoleKey
    }
}
