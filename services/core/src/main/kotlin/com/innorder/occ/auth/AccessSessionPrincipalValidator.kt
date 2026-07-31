package com.innorder.occ.auth

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.security.authentication.BadCredentialsException
import org.springframework.security.authentication.AbstractAuthenticationToken
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.stereotype.Component
import org.springframework.core.convert.converter.Converter

@Component
class AccessSessionPrincipalValidator(private val jdbc: JdbcTemplate) {
    fun validate(candidate: AccessTokenPrincipal): AccessTokenPrincipal? = try {
        val active = jdbc.query(
            """SELECT s.id
               FROM iam.auth_session s
               JOIN iam.principal p ON p.id = s.principal_id
               JOIN iam.user_account ua ON ua.principal_id = p.id
               JOIN authz.entity e ON e.id = p.id
               CROSS JOIN platform.customer_instance ci
               WHERE s.id = ?
                 AND s.principal_id = ?
                  AND s.token_version = ?
                  AND ua.password_version = s.token_version
                 AND s.revoked_at IS NULL
                 AND s.expires_at > statement_timestamp()
                 AND p.status = 'ACTIVE'
                 AND e.state = 'ACTIVE'
                 AND ci.singleton
                 AND ci.id = ?""",
            { rs, _ -> rs.getObject("id") },
            candidate.sessionId,
            candidate.principalId,
            candidate.tokenVersion,
            candidate.customerInstanceId,
        ).singleOrNull() != null
        candidate.takeIf { active }
    } catch (_: RuntimeException) {
        null
    }
}

@Component
class AccessTokenAuthenticationConverter(
    private val stateValidator: AccessSessionPrincipalValidator,
) : Converter<Jwt, AbstractAuthenticationToken> {
    override fun convert(jwt: Jwt): AbstractAuthenticationToken {
        val principal = runCatching { AccessTokenPrincipal.from(jwt) }.getOrNull()
            ?.let(stateValidator::validate)
            ?: throw BadCredentialsException("Access token authentication failed")
        return UsernamePasswordAuthenticationToken.authenticated(principal, null, emptyList())
    }
}
