package com.innorder.occ.auth

import com.nimbusds.jwt.SignedJWT
import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.JWSObject
import com.nimbusds.jose.Payload
import com.nimbusds.jose.util.JSONObjectUtils
import com.nimbusds.jose.crypto.RSASSASigner
import com.nimbusds.jose.crypto.MACSigner
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.PlainJWT
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.core.io.ClassPathResource
import org.springframework.security.oauth2.jwt.JwtException
import java.net.URI
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.security.interfaces.RSAPrivateKey
import java.util.Date
import java.util.UUID

class AccessTokenSecurityTest {
    private val now = Instant.parse("2026-07-30T12:00:00Z")
    private val properties = JwtProperties(
        URI("https://innorder.test"),
        ClassPathResource("test-only-jwt-private.pem"),
        ClassPathResource("test-only-jwt-public.pem"),
        Duration.ofMinutes(15),
        Duration.ofSeconds(30),
    )
    private val configuration = JwtConfiguration()

    @Test
    fun `issues minimal RS256 access token with bounded timestamps and typed identity claims`() {
        val service = AccessTokenService(configuration.jwtEncoder(properties), properties, Clock.fixed(now, ZoneOffset.UTC))
        val subject = AccessTokenSubject(PRINCIPAL_ID, INSTANCE_ID, SESSION_ID, 7)

        val serialized = service.issue(subject)
        val token = SignedJWT.parse(serialized)
        val claims = token.jwtClaimsSet

        assertThat(token.header.algorithm.name).isEqualTo("RS256")
        assertThat(claims.issuer).isEqualTo("https://innorder.test")
        assertThat(claims.audience).containsExactly("occ-core")
        assertThat(claims.subject).isEqualTo(PRINCIPAL_ID.toString())
        assertThat(claims.getStringClaim("instance_id")).isEqualTo(INSTANCE_ID.toString())
        assertThat(claims.getStringClaim("session_id")).isEqualTo(SESSION_ID.toString())
        assertThat(claims.getIntegerClaim("token_version")).isEqualTo(7)
        assertThat(UUID.fromString(claims.jwtid)).isNotNull()
        assertThat(claims.issueTime.toInstant()).isEqualTo(now)
        assertThat(claims.notBeforeTime.toInstant()).isEqualTo(now)
        assertThat(claims.expirationTime.toInstant()).isEqualTo(now.plus(Duration.ofMinutes(15)))
        assertThat(claims.claims.keys).containsExactlyInAnyOrder(
            "iss", "aud", "sub", "instance_id", "session_id", "token_version", "jti", "iat", "nbf", "exp",
        )
        assertThat(serialized.lowercase()).doesNotContain("password", "capabilities", "profile", "secret")
        assertThat(subject.toString()).doesNotContain("password", "secret")
    }

    @Test
    fun `decoder validates issued token and exposes immutable UUID principal`() {
        val service = AccessTokenService(configuration.jwtEncoder(properties), properties, Clock.fixed(now, ZoneOffset.UTC))
        val decoder = configuration.jwtDecoder(properties, Clock.fixed(now.plusSeconds(1), ZoneOffset.UTC))

        val jwt = decoder.decode(service.issue(AccessTokenSubject(PRINCIPAL_ID, INSTANCE_ID, SESSION_ID, 0)))
        val principal = AccessTokenPrincipal.from(jwt)

        assertThat(principal.principalId).isEqualTo(PRINCIPAL_ID)
        assertThat(principal.customerInstanceId).isEqualTo(INSTANCE_ID)
        assertThat(principal.sessionId).isEqualTo(SESSION_ID)
        assertThat(principal.tokenVersion).isZero()
        assertThat(principal.toString()).isEqualTo("AccessTokenPrincipal(principalId=$PRINCIPAL_ID, customerInstanceId=$INSTANCE_ID, sessionId=$SESSION_ID, tokenVersion=0)")
    }

    @Test
    fun `decoder rejects missing wrong type negative and excessive lifetime claims`() {
        val decoder = configuration.jwtDecoder(properties, Clock.fixed(now.plusSeconds(1), ZoneOffset.UTC))
        val keyPair = configuration.loadKeyPair(properties)

        listOf(
            mapOf("session_id" to null),
            mapOf("instance_id" to 42),
            mapOf("token_version" to -1),
            mapOf("token_version" to 0.0),
            mapOf("sub" to "not-a-uuid"),
            mapOf("aud" to listOf("other")),
            mapOf("exp" to now.plus(Duration.ofMinutes(16))),
        ).forEach { changes ->
            val token = TestJwt.sign(keyPair.private as RSAPrivateKey, now, changes)
            assertThatThrownBy { decoder.decode(token) }.isInstanceOf(JwtException::class.java)
        }
    }

    @Test
    fun `decoder rejects none HS256 and alternate RSA algorithms`() {
        val decoder = configuration.jwtDecoder(properties, Clock.fixed(now.plusSeconds(1), ZoneOffset.UTC))
        val keyPair = configuration.loadKeyPair(properties)
        val claims = TestJwt.claims(now, emptyMap())
        val none = PlainJWT(claims).serialize()
        val hs256 = SignedJWT(JWSHeader(JWSAlgorithm.HS256), claims).apply { sign(MACSigner(ByteArray(32) { 7 })) }.serialize()
        val rs512 = SignedJWT(JWSHeader(JWSAlgorithm.RS512), claims).apply { sign(RSASSASigner(keyPair.private)) }.serialize()

        listOf(none, hs256, rs512).forEach {
            assertThatThrownBy { decoder.decode(it) }.isInstanceOf(JwtException::class.java)
        }
    }

    @Test
    fun `decoder rejects duplicate claim names`() {
        val decoder = configuration.jwtDecoder(properties, Clock.fixed(now.plusSeconds(1), ZoneOffset.UTC))
        val keyPair = configuration.loadKeyPair(properties)
        val json = JSONObjectUtils.toJSONString(TestJwt.claims(now, emptyMap()).toJSONObject())
            .replaceFirst("\"sub\":", "\"sub\":\"$PRINCIPAL_ID\",\"sub\":")
        val duplicate = JWSObject(JWSHeader(JWSAlgorithm.RS256), Payload(json)).apply {
            sign(RSASSASigner(keyPair.private))
        }.serialize()

        assertThatThrownBy { decoder.decode(duplicate) }.isInstanceOf(JwtException::class.java)
    }

    @Test
    fun `configuration rejects invalid settings and bad key resources`() {
        assertThatThrownBy { properties.copy(issuer = URI("http://innorder.test")).validate() }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { properties.copy(ttl = Duration.ofMinutes(16)).validate() }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { properties.copy(clockSkew = Duration.ofSeconds(31)).validate() }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            configuration.loadKeyPair(properties.copy(privateKeyFile = ClassPathResource("missing-private.pem")))
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            configuration.loadKeyPair(properties.copy(privateKeyFile = ClassPathResource("test-only-malformed-private.pem")))
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            configuration.loadKeyPair(properties.copy(
                privateKeyFile = ClassPathResource("test-only-weak-private.pem"),
                publicKeyFile = ClassPathResource("test-only-weak-public.pem"),
            ))
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            configuration.loadKeyPair(properties.copy(publicKeyFile = ClassPathResource("test-only-mismatched-public.pem")))
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            configuration.loadKeyPair(properties.copy(
                privateKeyFile = ClassPathResource("test-only-ec-private.pem"),
                publicKeyFile = ClassPathResource("test-only-ec-public.pem"),
            ))
        }.isInstanceOf(IllegalArgumentException::class.java)
    }

    companion object {
        val PRINCIPAL_ID: UUID = UUID.fromString("51000000-0000-7000-8000-000000000001")
        val INSTANCE_ID: UUID = UUID.fromString("00000000-0000-7000-8000-000000000001")
        val SESSION_ID: UUID = UUID.fromString("51000000-0000-7000-8000-000000000002")
    }
}

object TestJwt {
    fun sign(privateKey: RSAPrivateKey, now: Instant, changes: Map<String, Any?>): String {
        val claims = claims(now, changes)
        return SignedJWT(JWSHeader(JWSAlgorithm.RS256), claims).apply { sign(RSASSASigner(privateKey)) }.serialize()
    }

    fun claims(now: Instant, changes: Map<String, Any?>): JWTClaimsSet {
        val defaults = linkedMapOf<String, Any?>(
            "iss" to "https://innorder.test",
            "aud" to listOf("occ-core"),
            "sub" to AccessTokenSecurityTest.PRINCIPAL_ID.toString(),
            "instance_id" to AccessTokenSecurityTest.INSTANCE_ID.toString(),
            "session_id" to AccessTokenSecurityTest.SESSION_ID.toString(),
            "token_version" to 0,
            "jti" to UUID.randomUUID().toString(),
            "iat" to Date.from(now),
            "nbf" to Date.from(now),
            "exp" to Date.from(now.plusSeconds(900)),
        )
        changes.forEach { (name, value) -> if (value == null) defaults.remove(name) else defaults[name] = if (value is Instant) Date.from(value) else value }
        return JWTClaimsSet.Builder().apply { defaults.forEach { (name, value) -> claim(name, value) } }.build()
    }
}
