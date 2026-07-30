package com.innorder.occ.auth

import com.nimbusds.jose.jwk.JWKSet
import com.nimbusds.jose.jwk.RSAKey
import com.nimbusds.jose.jwk.source.ImmutableJWKSet
import com.nimbusds.jose.proc.SecurityContext
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.io.Resource
import org.springframework.security.oauth2.core.OAuth2Error
import org.springframework.security.oauth2.core.OAuth2TokenValidator
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.security.oauth2.jwt.JwtEncoder
import org.springframework.security.oauth2.jwt.JwtTimestampValidator
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm
import java.net.URI
import java.security.KeyFactory
import java.security.KeyPair
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.time.Clock
import java.time.Duration
import java.util.Base64
import java.util.UUID

@ConfigurationProperties("occ.jwt")
data class JwtProperties(
    val issuer: URI,
    val privateKeyFile: Resource,
    val publicKeyFile: Resource,
    val ttl: Duration = Duration.ofMinutes(15),
    val clockSkew: Duration = Duration.ofSeconds(30),
) {
    fun validate() {
        require(issuer.scheme == "https" && issuer.host != null && issuer.userInfo == null && issuer.fragment == null) {
            "JWT issuer must be an explicit HTTPS URI"
        }
        require(!ttl.isZero && !ttl.isNegative && ttl <= MAX_TTL) { "JWT TTL must be positive and at most 15 minutes" }
        require(!clockSkew.isNegative && clockSkew <= MAX_SKEW) { "JWT clock skew must be at most 30 seconds" }
    }

    companion object {
        const val AUDIENCE = "occ-core"
        val MAX_TTL: Duration = Duration.ofMinutes(15)
        val MAX_SKEW: Duration = Duration.ofSeconds(30)
    }
}

@Configuration
@EnableConfigurationProperties(JwtProperties::class)
class JwtConfiguration {
    @Bean
    fun jwtKeyPair(properties: JwtProperties): KeyPair = loadKeyPair(properties)

    @Bean
    fun jwtEncoder(properties: JwtProperties, keyPair: KeyPair = loadKeyPair(properties)): JwtEncoder {
        properties.validate()
        val jwk = RSAKey.Builder(keyPair.public as RSAPublicKey).privateKey(keyPair.private as RSAPrivateKey).build()
        return NimbusJwtEncoder(ImmutableJWKSet<SecurityContext>(JWKSet(jwk)))
    }

    @Bean
    fun jwtDecoder(
        properties: JwtProperties,
        clock: Clock,
        keyPair: KeyPair = loadKeyPair(properties),
    ): JwtDecoder {
        properties.validate()
        val decoder = NimbusJwtDecoder.withPublicKey(keyPair.public as RSAPublicKey)
            .signatureAlgorithm(SignatureAlgorithm.RS256)
            .build()
        val timestamp = JwtTimestampValidator(properties.clockSkew).also { it.setClock(clock) }
        decoder.setJwtValidator(OAuth2TokenValidator { jwt ->
            val results = listOf(timestamp.validate(jwt), validateClaims(jwt, properties, clock))
            val errors = results.flatMap { it.errors }
            if (errors.isEmpty()) OAuth2TokenValidatorResult.success() else OAuth2TokenValidatorResult.failure(errors)
        })
        return decoder
    }

    fun loadKeyPair(properties: JwtProperties): KeyPair {
        properties.validate()
        try {
            val factory = KeyFactory.getInstance("RSA")
            val privateKey = factory.generatePrivate(PKCS8EncodedKeySpec(readPem(properties.privateKeyFile, "PRIVATE KEY")))
            val publicKey = factory.generatePublic(X509EncodedKeySpec(readPem(properties.publicKeyFile, "PUBLIC KEY")))
            require(privateKey is RSAPrivateKey && publicKey is RSAPublicKey) { "JWT keys must be RSA" }
            require(publicKey.modulus.bitLength() >= 3072) { "JWT RSA key must be at least 3072 bits" }
            require(privateKey.modulus == publicKey.modulus) { "JWT key pair does not match" }
            require(verifyKeyPair(privateKey, publicKey)) { "JWT key pair does not match" }
            return KeyPair(publicKey, privateKey)
        } catch (_: Exception) {
            throw IllegalArgumentException("JWT key material is unavailable or invalid")
        }
    }

    private fun verifyKeyPair(privateKey: RSAPrivateKey, publicKey: RSAPublicKey): Boolean {
        val challenge = ByteArray(KEY_CHALLENGE_BYTES)
        val random = SecureRandom()
        random.nextBytes(challenge)
        var signature = ByteArray(0)
        return try {
            val signer = Signature.getInstance(KEY_SIGNATURE_ALGORITHM)
            signer.initSign(privateKey, random)
            signer.update(challenge)
            signature = signer.sign()
            val verifier = Signature.getInstance(KEY_SIGNATURE_ALGORITHM)
            verifier.initVerify(publicKey)
            verifier.update(challenge)
            verifier.verify(signature)
        } finally {
            challenge.fill(0)
            signature.fill(0)
        }
    }

    private fun readPem(resource: Resource, type: String): ByteArray {
        val text = resource.inputStream.bufferedReader(Charsets.US_ASCII).use { it.readText() }
        val begin = "-----BEGIN $type-----"
        val end = "-----END $type-----"
        require(text.count { it == '\u0000' } == 0 && text.contains(begin) && text.contains(end)) { "Invalid PEM" }
        val encoded = text.substringAfter(begin).substringBefore(end).replace(Regex("\\s"), "")
        require(encoded.isNotEmpty()) { "Invalid PEM" }
        return Base64.getDecoder().decode(encoded)
    }

    private fun validateClaims(jwt: Jwt, properties: JwtProperties, clock: Clock): OAuth2TokenValidatorResult {
        val validation = runCatching {
            require(jwt.claims.keys == ALLOWED_CLAIMS)
            require(jwt.issuer.toString() == properties.issuer.toString())
            require(jwt.audience == listOf(JwtProperties.AUDIENCE))
            UUID.fromString(jwt.subject)
            UUID.fromString(requiredString(jwt, "instance_id"))
            UUID.fromString(requiredString(jwt, "session_id"))
            UUID.fromString(jwt.id)
            val version = jwt.claims["token_version"]
            require(version is Byte || version is Short || version is Int || version is Long)
            require((version as Number).toLong() in 0..Int.MAX_VALUE.toLong())
            val issuedAt = requireNotNull(jwt.issuedAt)
            val notBefore = requireNotNull(jwt.notBefore)
            val expiresAt = requireNotNull(jwt.expiresAt)
            require(!notBefore.isAfter(issuedAt))
            require(expiresAt.isAfter(issuedAt) && Duration.between(issuedAt, expiresAt) <= properties.ttl)
            require(!issuedAt.isAfter(clock.instant().plus(properties.clockSkew)))
        }
        return if (validation.isSuccess) OAuth2TokenValidatorResult.success() else OAuth2TokenValidatorResult.failure(
            OAuth2Error("invalid_token", "Access token is invalid", null),
        )
    }

    private fun requiredString(jwt: Jwt, name: String): String {
        val value = jwt.claims[name]
        require(value is String && value.isNotBlank())
        return value
    }

    private companion object {
        const val KEY_CHALLENGE_BYTES = 32
        const val KEY_SIGNATURE_ALGORITHM = "SHA256withRSA"
        val ALLOWED_CLAIMS = setOf(
            "iss", "sub", "aud", "exp", "nbf", "iat", "jti",
            "instance_id", "session_id", "token_version",
        )
    }
}
