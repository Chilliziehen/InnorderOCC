package com.innorder.occ.ai

import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import com.fasterxml.jackson.databind.node.ObjectNode
import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.RSASSASigner
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.core.io.Resource
import org.springframework.stereotype.Service
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.Base64
import java.util.Date
import java.util.TreeMap
import java.util.UUID
import java.text.Normalizer

data class AiGrantSigningKeyProperties(
    val keyId: String,
    val privateKeyFile: Resource,
    val publicKeyFile: Resource,
)

@ConfigurationProperties("occ.ai.grant")
data class AiGrantTokenProperties(
    val current: AiGrantSigningKeyProperties,
    val previousEnabled: Boolean = false,
    val previous: List<AiGrantSigningKeyProperties> = emptyList(),
    val ttl: Duration = Duration.ofMinutes(5),
    val clockSkew: Duration = Duration.ofSeconds(30),
) {
    fun validate() {
        require((!previousEnabled && previous.size <= 1) || (previousEnabled && previous.size == 1)) {
            "Exactly one previous AI grant signer is required when rotation is enabled"
        }
        val signers = listOf(current) + if (previousEnabled) previous else emptyList()
        require(signers.map { it.keyId }.toSet().size == signers.size && signers.all { KEY_ID.matches(it.keyId) }) {
            "AI grant key ID is invalid or duplicated"
        }
        require(!ttl.isNegative && !ttl.isZero && ttl <= MAX_TTL) { "AI grant TTL must be at most five minutes" }
        require(!clockSkew.isNegative && clockSkew <= MAX_SKEW) { "AI grant clock skew must be at most 30 seconds" }
    }

    companion object {
        const val ISSUER = "innorder-core"
        const val AUDIENCE = "innorder-ai"
        const val TYPE = "ai_authorization_grant"
        val MAX_TTL: Duration = Duration.ofMinutes(5)
        val MAX_SKEW: Duration = Duration.ofSeconds(30)
        private val KEY_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}${'$'}")
    }
}

data class AiGrantClaims(
    val jti: UUID,
    val eventId: UUID,
    val operationId: UUID,
    val principalId: UUID,
    val targetId: UUID,
    val purpose: String,
    val authorizationRevision: Long,
    val policyReleaseDigest: String,
    val authorizedSetDigest: String,
    val contextDigest: String,
    val classificationCeiling: String,
    val agentVersionId: UUID,
    val modelProfileId: UUID,
    val promptVersionId: UUID,
    val packageVersionId: UUID,
    val embeddingSpaceId: UUID,
    val issuedAt: Instant,
    val expiresAt: Instant,
) {
    fun validate() {
        val uuids = listOf(jti, eventId, operationId, principalId, targetId, agentVersionId, modelProfileId,
            promptVersionId, packageVersionId, embeddingSpaceId)
        require(uuids.all { it != UUID(0, 0) && it.variant() == 2 }) { "AI grant UUID is invalid" }
        require(purpose == "PARTICIPANT_GUIDANCE") { "AI grant purpose is invalid" }
        require(authorizationRevision in 0..MAX_SAFE_INTEGER) { "AI grant authorization revision is invalid" }
        require(listOf(policyReleaseDigest, authorizedSetDigest, contextDigest).all(SHA256::matches)) {
            "AI grant digest is invalid"
        }
        require(classificationCeiling in CLASSIFICATIONS) { "AI grant classification is invalid" }
        require(!expiresAt.isAfter(issuedAt.plus(AiGrantTokenProperties.MAX_TTL)) && expiresAt.isAfter(issuedAt)) {
            "AI grant lifetime is invalid"
        }
    }

    companion object {
        const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        val SHA256 = Regex("^[a-f0-9]{64}${'$'}")
        val CLASSIFICATIONS = setOf("PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED")
    }
}

class AiGrantBoundsException : RuntimeException("OCC-AI-GRANT-BOUNDS")

class AuthorizedAiGrantDocuments(documentVersionIds: List<UUID>) {
    val ids: List<UUID> = documentVersionIds.distinct().sortedBy(UUID::toString)

    init {
        if (documentVersionIds.size > 500 || ids.size != documentVersionIds.size || ids.any { it == UUID(0, 0) }) {
            throw AiGrantBoundsException()
        }
    }

    val digest: String = sha256(ids.joinToString("\n", transform = UUID::toString).toByteArray(StandardCharsets.US_ASCII))
}

class CanonicalTaskContext private constructor(val text: String, val digest: String) {
    companion object {
        private const val MAX_BYTES = 32 * 1024
        private val mapper = ObjectMapper().enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)

        fun parse(bytes: ByteArray): CanonicalTaskContext {
            if (bytes.isEmpty() || bytes.size > MAX_BYTES) throw AiGrantBoundsException()
            val root = try { mapper.readTree(bytes) } catch (_: Exception) { throw AiGrantBoundsException() }
            if (root !is ObjectNode) throw AiGrantBoundsException()
            if (!validTaskContext(root)) throw AiGrantBoundsException()
            val canonical = mapper.writeValueAsBytes(sort(root))
            if (canonical.size > MAX_BYTES) throw AiGrantBoundsException()
            return CanonicalTaskContext(canonical.toString(StandardCharsets.UTF_8), sha256(canonical))
        }

        private fun validTaskContext(root: ObjectNode): Boolean {
            if (!root.fieldNames().asSequence().all { it in ALLOWED_FIELDS }) return false
            val taskId = root.path("taskId")
            if (!taskId.isTextual || runCatching { UUID.fromString(taskId.textValue()) }.isFailure) return false
            for (name in listOf("title", "state")) {
                val value = root.get(name) ?: continue
                if (!value.isTextual || value.textValue().length !in 1..1024 || !canonical(value.textValue())) return false
            }
            root.get("packageVersion")?.let {
                if (!it.isTextual || runCatching { UUID.fromString(it.textValue()) }.isFailure) return false
            }
            for (name in listOf("blockerCodes", "evidenceRequirementLabels")) {
                val values = root.get(name) ?: continue
                if (!values.isArray || values.size() > 128 || values.any { !it.isTextual || it.textValue().length !in 1..256 || !canonical(it.textValue()) }) return false
            }
            return true
        }

        private fun canonical(value: String): Boolean = Normalizer.isNormalized(value, Normalizer.Form.NFC) &&
            value.codePoints().allMatch { it !in 0xD800..0xDFFF && it != 0xFEFF && it !in 0..8 && it !in 11..12 && it !in 14..31 }

        private fun sort(node: JsonNode): JsonNode = when (node) {
            is ObjectNode -> mapper.createObjectNode().also { target ->
                TreeMap<String, JsonNode>().apply { node.fields().forEachRemaining { put(it.key, it.value) } }
                    .forEach { (key, value) -> target.set<JsonNode>(key, sort(value)) }
            }
            is ArrayNode -> mapper.createArrayNode().also { target -> node.forEach { target.add(sort(it)) } }
            else -> node.deepCopy()
        }

        private val ALLOWED_FIELDS = setOf("taskId", "title", "state", "blockerCodes", "evidenceRequirementLabels", "packageVersion")
    }
}

@Service
@ConditionalOnProperty(prefix = "occ.ai.grant", name = ["enabled"], havingValue = "true")
class AiGrantTokenService(private val properties: AiGrantTokenProperties, private val clock: Clock) {
    private val privateKeys: Map<String, RSAPrivateKey>
    val currentKeyId: String = properties.current.keyId

    init {
        properties.validate()
        val configuredSigners = listOf(properties.current) + if (properties.previousEnabled) properties.previous else emptyList()
        privateKeys = configuredSigners.associate { signer ->
            val privateKey = loadPrivate(signer.privateKeyFile)
            val publicKey = loadPublic(signer.publicKeyFile)
            require(publicKey.modulus.bitLength() >= 3072 && privateKey.modulus.bitLength() >= 3072) {
                "AI grant RSA key must be at least 3072 bits"
            }
            require(privateKey.modulus == publicKey.modulus && keyPairMatches(privateKey, publicKey)) {
                "AI grant key pair does not match"
            }
            signer.keyId to privateKey
        }
    }

    fun issue(claims: AiGrantClaims): String = issue(claims, currentKeyId)

    fun issue(claims: AiGrantClaims, signerKid: String): String {
        claims.validate()
        require(claims.expiresAt == claims.issuedAt.plus(properties.ttl)) { "AI grant lifetime does not match configuration" }
        require(!claims.issuedAt.isAfter(clock.instant().plus(properties.clockSkew))) { "AI grant issue time is invalid" }
        val body = JWTClaimsSet.Builder()
            .issuer(AiGrantTokenProperties.ISSUER)
            .audience(AiGrantTokenProperties.AUDIENCE)
            .claim("typ", AiGrantTokenProperties.TYPE)
            .jwtID(claims.jti.toString())
            .claim("eventId", claims.eventId.toString())
            .claim("operationId", claims.operationId.toString())
            .claim("principalId", claims.principalId.toString())
            .claim("targetId", claims.targetId.toString())
            .claim("purpose", claims.purpose)
            .claim("authorizationRevision", claims.authorizationRevision)
            .claim("policyReleaseDigest", claims.policyReleaseDigest)
            .claim("authorizedSetDigest", claims.authorizedSetDigest)
            .claim("contextDigest", claims.contextDigest)
            .claim("classificationCeiling", claims.classificationCeiling)
            .claim("agentVersionId", claims.agentVersionId.toString())
            .claim("modelProfileId", claims.modelProfileId.toString())
            .claim("promptVersionId", claims.promptVersionId.toString())
            .claim("packageVersionId", claims.packageVersionId.toString())
            .claim("embeddingSpaceId", claims.embeddingSpaceId.toString())
            .issueTime(Date.from(claims.issuedAt)).notBeforeTime(Date.from(claims.issuedAt))
            .expirationTime(Date.from(claims.expiresAt)).build()
        val privateKey = privateKeys[signerKid] ?: throw AiGrantSigningKeyUnavailableException()
        return SignedJWT(JWSHeader.Builder(JWSAlgorithm.RS256).keyID(signerKid).build(), body).apply {
            sign(RSASSASigner(privateKey))
        }.serialize()
    }

    fun issueAt(jti: UUID, template: AiGrantClaims): String {
        val now = clock.instant().truncatedTo(java.time.temporal.ChronoUnit.SECONDS)
        return issue(template.copy(jti = jti, issuedAt = now, expiresAt = now.plus(properties.ttl)))
    }

    fun expiration(issuedAt: Instant): Instant = issuedAt.plus(properties.ttl)

    fun sha256(token: String): String = sha256(token.toByteArray(StandardCharsets.US_ASCII))

    private fun loadPrivate(resource: Resource): RSAPrivateKey = try {
        KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(readPem(resource, "PRIVATE KEY"))) as RSAPrivateKey
    } catch (_: Exception) { throw IllegalArgumentException("AI grant key material is unavailable or invalid") }

    private fun loadPublic(resource: Resource): RSAPublicKey = try {
        KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(readPem(resource, "PUBLIC KEY"))) as RSAPublicKey
    } catch (_: Exception) { throw IllegalArgumentException("AI grant key material is unavailable or invalid") }

    private fun readPem(resource: Resource, type: String): ByteArray {
        val bytes = resource.inputStream.use { it.readNBytes(MAX_KEY_FILE_BYTES + 1) }
        require(bytes.size <= MAX_KEY_FILE_BYTES && bytes.none { it == 0.toByte() }) { "Invalid key material" }
        val text = bytes.toString(StandardCharsets.US_ASCII)
        val begin = "-----BEGIN $type-----"
        val end = "-----END $type-----"
        require(text.contains(begin) && text.contains(end)) { "Invalid key material" }
        return Base64.getDecoder().decode(text.substringAfter(begin).substringBefore(end).replace(Regex("\\s"), ""))
    }

    private fun keyPairMatches(privateKey: RSAPrivateKey, publicKey: RSAPublicKey): Boolean {
        val challenge = ByteArray(32) { it.toByte() }
        val signer = Signature.getInstance("SHA256withRSA").apply { initSign(privateKey); update(challenge) }
        val signature = signer.sign()
        return Signature.getInstance("SHA256withRSA").run { initVerify(publicKey); update(challenge); verify(signature) }
    }

    private companion object { const val MAX_KEY_FILE_BYTES = 64 * 1024 }
}

class AiGrantSigningKeyUnavailableException : RuntimeException("OCC-AI-GRANT-SIGNER-UNAVAILABLE")

private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
    .joinToString("") { "%02x".format(it) }
