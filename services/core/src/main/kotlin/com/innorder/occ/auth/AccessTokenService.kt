package com.innorder.occ.auth

import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm
import org.springframework.security.oauth2.jwt.JwtClaimsSet
import org.springframework.security.oauth2.jwt.JwtEncoder
import org.springframework.security.oauth2.jwt.JwtEncoderParameters
import org.springframework.security.oauth2.jwt.JwsHeader
import org.springframework.stereotype.Service
import java.time.Clock
import java.util.UUID

data class AccessTokenSubject(
    val principalId: UUID,
    val customerInstanceId: UUID,
    val sessionId: UUID,
    val tokenVersion: Int,
) {
    init {
        require(tokenVersion >= 0) { "Token version cannot be negative" }
    }
}

data class AccessTokenPrincipal(
    val principalId: UUID,
    val customerInstanceId: UUID,
    val sessionId: UUID,
    val tokenVersion: Int,
) {
    companion object {
        fun from(jwt: org.springframework.security.oauth2.jwt.Jwt): AccessTokenPrincipal = AccessTokenPrincipal(
            UUID.fromString(jwt.subject),
            UUID.fromString(jwt.getClaimAsString("instance_id")),
            UUID.fromString(jwt.getClaimAsString("session_id")),
            jwt.getClaim<Number>("token_version").toInt(),
        )
    }
}

@Service
class AccessTokenService(
    private val encoder: JwtEncoder,
    private val properties: JwtProperties,
    private val clock: Clock,
) {
    fun issue(subject: AccessTokenSubject): String {
        val now = clock.instant()
        val claims = JwtClaimsSet.builder()
            .issuer(properties.issuer.toString())
            .audience(listOf(JwtProperties.AUDIENCE))
            .subject(subject.principalId.toString())
            .claim("instance_id", subject.customerInstanceId.toString())
            .claim("session_id", subject.sessionId.toString())
            .claim("token_version", subject.tokenVersion)
            .id(UUID.randomUUID().toString())
            .issuedAt(now)
            .notBefore(now)
            .expiresAt(now.plus(properties.ttl))
            .build()
        val header = JwsHeader.with(SignatureAlgorithm.RS256).build()
        return encoder.encode(JwtEncoderParameters.from(header, claims)).tokenValue
    }
}
