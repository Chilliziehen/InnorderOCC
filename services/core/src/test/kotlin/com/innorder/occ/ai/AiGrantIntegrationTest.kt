package com.innorder.occ.ai

import com.nimbusds.jwt.SignedJWT
import com.nimbusds.jose.crypto.RSASSAVerifier
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.core.io.ClassPathResource
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.security.KeyFactory
import java.security.interfaces.RSAPublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import com.innorder.occ.command.IdempotencyConflictException
import com.innorder.occ.command.InvalidIdempotencyKeyException

class AiGrantIntegrationTest {
    private val now = Instant.parse("2026-08-02T12:00:00Z")
    private val oldSigner = AiGrantSigningKeyProperties(
        keyId = "ai-grant-2026-08",
        privateKeyFile = ClassPathResource("test-only-jwt-private.pem"),
        publicKeyFile = ClassPathResource("test-only-jwt-public.pem"),
    )
    private val nextSigner = AiGrantSigningKeyProperties(
        keyId = "ai-grant-2026-09",
        privateKeyFile = ClassPathResource("test-only-ai-grant-next-private.pem"),
        publicKeyFile = ClassPathResource("test-only-ai-grant-next-public.pem"),
    )
    private val properties = AiGrantTokenProperties(
        current = oldSigner,
        ttl = Duration.ofMinutes(5),
        clockSkew = Duration.ofSeconds(20),
    )
    private val service = AiGrantTokenService(properties, Clock.fixed(now, ZoneOffset.UTC))

    @Test
    fun `issues reproducible dedicated RS256 grant with exact bound claims`() {
        val claims = claims()

        val first = service.issue(claims)
        val retry = service.issue(claims)
        val jwt = SignedJWT.parse(first)

        assertThat(retry).isEqualTo(first)
        assertThat(jwt.header.algorithm.name).isEqualTo("RS256")
        assertThat(jwt.header.keyID).isEqualTo("ai-grant-2026-08")
        assertThat(jwt.jwtClaimsSet.claims).containsOnlyKeys(
            "iss", "aud", "typ", "jti", "eventId", "operationId", "principalId", "targetId",
            "purpose", "authorizationRevision", "policyReleaseDigest", "authorizedSetDigest",
            "contextDigest", "classificationCeiling", "agentVersionId", "modelProfileId",
            "promptVersionId", "packageVersionId", "embeddingSpaceId", "iat", "nbf", "exp",
        )
        assertThat(jwt.jwtClaimsSet.issuer).isEqualTo("innorder-core")
        assertThat(jwt.jwtClaimsSet.audience).containsExactly("innorder-ai")
        assertThat(jwt.jwtClaimsSet.getStringClaim("typ")).isEqualTo("ai_authorization_grant")
        assertThat(jwt.jwtClaimsSet.issueTime.toInstant()).isEqualTo(now)
        assertThat(jwt.jwtClaimsSet.notBeforeTime.toInstant()).isEqualTo(now)
        assertThat(jwt.jwtClaimsSet.expirationTime.toInstant()).isEqualTo(now.plusSeconds(300))
        assertThat(service.sha256(first)).matches("^[a-f0-9]{64}$")
    }

    @Test
    fun `rejects invalid lifetime key settings claims and bounded grant bodies`() {
        assertThatThrownBy { AiGrantTokenService(properties.copy(ttl = Duration.ofSeconds(301)), Clock.systemUTC()) }
            .isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { AiGrantTokenService(properties.copy(clockSkew = Duration.ofSeconds(31)), Clock.systemUTC()) }
            .isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { service.issue(claims().copy(policyReleaseDigest = "A".repeat(64))) }
            .isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { AuthorizedAiGrantDocuments(List(501) { UUID.randomUUID() }) }
            .isInstanceOf(AiGrantBoundsException::class.java)
        assertThatThrownBy { CanonicalTaskContext.parse("{\"value\":\"${"x".repeat(32 * 1024)}\"}".toByteArray()) }
            .isInstanceOf(AiGrantBoundsException::class.java)
        assertThatThrownBy { CanonicalTaskContext.parse("{\"taskId\":\"11000000-0000-7000-8000-000000000013\",\"secret\":\"no\"}".toByteArray()) }
            .isInstanceOf(AiGrantBoundsException::class.java)
        val shorter = AiGrantTokenService(properties.copy(ttl = Duration.ofMinutes(4)), Clock.fixed(now, ZoneOffset.UTC))
        assertThat(shorter.expiration(now)).isEqualTo(now.plusSeconds(240))
        val keyFailure = runCatching {
            AiGrantTokenService(properties.copy(current = oldSigner.copy(
                privateKeyFile = ClassPathResource("test-only-malformed-private.pem"),
            )), Clock.systemUTC())
        }.exceptionOrNull()
        assertThat(keyFailure).isInstanceOf(IllegalArgumentException::class.java)
        assertThat(keyFailure?.message).isEqualTo("AI grant key material is unavailable or invalid")
            .doesNotContain("malformed", "PRIVATE KEY")
    }

    @Test
    fun `creation stores hash only and concurrent claims reproduce one exact token`() {
        val store = InMemoryGrantStore(12, "1".repeat(64))
        val grants = AiGrantService(store, service, Clock.fixed(now, ZoneOffset.UTC))
        val request = AiGrantCreationRequest(
            eventId = claims().eventId,
            operationId = claims().operationId,
            principalId = claims().principalId,
            targetId = claims().targetId,
            authorizationRevision = 12,
            policyReleaseId = UUID.fromString("11000000-0000-7000-8000-000000000011"),
            policyReleaseDigest = "1".repeat(64),
            classificationCeiling = "CONFIDENTIAL",
            agentVersionId = claims().agentVersionId,
            modelProfileId = claims().modelProfileId,
            promptVersionId = claims().promptVersionId,
            packageVersionId = claims().packageVersionId,
            embeddingSpaceId = claims().embeddingSpaceId,
            documentVersionIds = listOf(UUID.fromString("11000000-0000-7000-8000-000000000012")),
            taskContext = "{\"state\":\"ACTIVE\",\"taskId\":\"11000000-0000-7000-8000-000000000013\"}".toByteArray(),
        )
        grants.create(request)

        val executor = Executors.newFixedThreadPool(4)
        val tokens = try {
            (1..8).map { executor.submit<String> { grants.claim(request.operationId, "claim-key") .grantToken } }.map { it.get() }
        } finally {
            executor.shutdownNow()
        }

        assertThat(tokens.toSet()).hasSize(1)
        assertThat(store.records).hasSize(1)
        assertThat(store.records.single().signerKid).isEqualTo(oldSigner.keyId)
        assertThat(store.records.single().tokenHash).isEqualTo(service.sha256(tokens.first()))
        assertThat(store.records.single().toString()).doesNotContain(tokens.first())
        assertThat(store.claimKeyHashes.single()).matches("^[a-f0-9]{64}$").isNotEqualTo("claim-key")
        assertThat(store.toString()).doesNotContain("claim-key")
        assertThat(store.documents.single()).containsExactlyElementsOf(request.documentVersionIds)
        assertThatThrownBy { grants.claim(request.operationId, "other-key") }
            .isInstanceOf(IdempotencyConflictException::class.java)
        listOf("", "contains space", "x".repeat(129), "non-ascii-\u00e9").forEach { key ->
            assertThatThrownBy { grants.claim(request.operationId, key) }
                .isInstanceOf(InvalidIdempotencyKeyException::class.java)
        }
    }

    @Test
    fun `retains deterministic signer binding across bounded key rotation`() {
        val store = InMemoryGrantStore(12, "1".repeat(64))
        val oldGrants = AiGrantService(store, service, Clock.fixed(now, ZoneOffset.UTC))
        val oldRequest = request(claims().operationId)
        oldGrants.create(oldRequest)

        val nearExpiry = now.plusSeconds(299)
        val rotatedTokens = AiGrantTokenService(
            properties.copy(current = nextSigner, previousEnabled = true, previous = listOf(oldSigner)),
            Clock.fixed(nearExpiry, ZoneOffset.UTC),
        )
        val rotatedGrants = AiGrantService(store, rotatedTokens, Clock.fixed(nearExpiry, ZoneOffset.UTC))
        val oldToken = rotatedGrants.claim(oldRequest.operationId, "old-claim").grantToken
        assertThat(SignedJWT.parse(oldToken).header.keyID).isEqualTo(oldSigner.keyId)
        assertThat(verify(oldToken, oldSigner.publicKeyFile)).isTrue()

        val newOperation = UUID.fromString("11000000-0000-7000-8000-000000000014")
        rotatedGrants.create(request(newOperation))
        val newToken = rotatedGrants.claim(newOperation, "new-claim").grantToken
        assertThat(SignedJWT.parse(newToken).header.keyID).isEqualTo(nextSigner.keyId)
        assertThat(verify(newToken, nextSigner.publicKeyFile)).isTrue()

        val retiredTokens = AiGrantTokenService(
            properties.copy(current = nextSigner, previous = emptyList()),
            Clock.fixed(now, ZoneOffset.UTC),
        )
        assertThatThrownBy {
            AiGrantService(store, retiredTokens, Clock.fixed(now, ZoneOffset.UTC))
                .claim(oldRequest.operationId, "old-claim")
        }.isInstanceOf(AiGrantSigningKeyUnavailableException::class.java)
        assertThatThrownBy {
            AiGrantService(store, retiredTokens, Clock.fixed(now.plusSeconds(301), ZoneOffset.UTC))
                .claim(oldRequest.operationId, "old-claim")
        }.isInstanceOf(AiGrantExpiredException::class.java)

        store.replace(oldRequest.operationId, store.record(oldRequest.operationId).copy(signerKid = "retired-unknown"))
        assertThatThrownBy { rotatedGrants.claim(oldRequest.operationId, "old-claim") }
            .isInstanceOf(AiGrantSigningKeyUnavailableException::class.java)
        store.replace(oldRequest.operationId, store.record(oldRequest.operationId).copy(
            signerKid = oldSigner.keyId,
            tokenHash = "0".repeat(64),
        ))
        assertThatThrownBy { rotatedGrants.claim(oldRequest.operationId, "old-claim") }
            .isInstanceOf(AiGrantIntegrityException::class.java)
    }

    private class InMemoryGrantStore(
        private val revision: Long,
        private val releaseDigest: String,
    ) : AiGrantStore {
        val records = mutableListOf<StoredAiGrant>()
        val documents = mutableListOf<List<UUID>>()
        val claimKeyHashes = mutableListOf<String>()
        private val byOperation = ConcurrentHashMap<UUID, StoredAiGrant>()
        private val claimHashByGrant = ConcurrentHashMap<UUID, String>()

        override fun lockAuthorizationSnapshot(policyReleaseId: UUID) = AuthorizationSnapshotBinding(revision, releaseDigest)
        override fun insert(record: StoredAiGrant, documentVersionIds: List<UUID>) {
            records += record
            documents += documentVersionIds
            byOperation[record.claims.operationId] = record
        }
        override fun findByOperationId(operationId: UUID): StoredAiGrant? = byOperation[operationId]
        override fun bindClaimIdempotency(grantId: UUID, keyHash: String) {
            synchronized(claimHashByGrant) {
                val existing = claimHashByGrant[grantId]
                if (existing != null && existing != keyHash) throw IdempotencyConflictException()
                if (existing == null) {
                    claimHashByGrant[grantId] = keyHash
                    claimKeyHashes += keyHash
                }
            }
        }

        fun record(operationId: UUID): StoredAiGrant = byOperation.getValue(operationId)
        fun replace(operationId: UUID, record: StoredAiGrant) {
            records[records.indexOfFirst { it.claims.operationId == operationId }] = record
            byOperation[operationId] = record
        }

        override fun toString(): String = "InMemoryGrantStore(records=${records.size},claimKeyHashes=$claimKeyHashes)"
    }

    private fun request(operationId: UUID) = AiGrantCreationRequest(
        eventId = claims().eventId,
        operationId = operationId,
        principalId = claims().principalId,
        targetId = claims().targetId,
        authorizationRevision = 12,
        policyReleaseId = UUID.fromString("11000000-0000-7000-8000-000000000011"),
        policyReleaseDigest = "1".repeat(64),
        classificationCeiling = "CONFIDENTIAL",
        agentVersionId = claims().agentVersionId,
        modelProfileId = claims().modelProfileId,
        promptVersionId = claims().promptVersionId,
        packageVersionId = claims().packageVersionId,
        embeddingSpaceId = claims().embeddingSpaceId,
        documentVersionIds = listOf(UUID.fromString("11000000-0000-7000-8000-000000000012")),
        taskContext = "{\"state\":\"ACTIVE\",\"taskId\":\"11000000-0000-7000-8000-000000000013\"}".toByteArray(),
    )

    private fun verify(token: String, resource: org.springframework.core.io.Resource): Boolean {
        val text = resource.inputStream.use { it.readBytes().toString(Charsets.US_ASCII) }
        val bytes = Base64.getDecoder().decode(text.substringAfter("-----BEGIN PUBLIC KEY-----")
            .substringBefore("-----END PUBLIC KEY-----").replace(Regex("\\s"), ""))
        val key = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(bytes)) as RSAPublicKey
        return SignedJWT.parse(token).verify(RSASSAVerifier(key))
    }

    private fun claims() = AiGrantClaims(
        jti = UUID.fromString("11000000-0000-7000-8000-000000000001"),
        eventId = UUID.fromString("11000000-0000-7000-8000-000000000002"),
        operationId = UUID.fromString("11000000-0000-7000-8000-000000000003"),
        principalId = UUID.fromString("11000000-0000-7000-8000-000000000004"),
        targetId = UUID.fromString("11000000-0000-7000-8000-000000000005"),
        purpose = "PARTICIPANT_GUIDANCE",
        authorizationRevision = 12,
        policyReleaseDigest = "1".repeat(64),
        authorizedSetDigest = "2".repeat(64),
        contextDigest = "3".repeat(64),
        classificationCeiling = "CONFIDENTIAL",
        agentVersionId = UUID.fromString("11000000-0000-7000-8000-000000000006"),
        modelProfileId = UUID.fromString("11000000-0000-7000-8000-000000000007"),
        promptVersionId = UUID.fromString("11000000-0000-7000-8000-000000000008"),
        packageVersionId = UUID.fromString("11000000-0000-7000-8000-000000000009"),
        embeddingSpaceId = UUID.fromString("11000000-0000-7000-8000-000000000010"),
        issuedAt = now,
        expiresAt = now.plusSeconds(300),
    )
}
