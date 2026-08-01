package com.innorder.occ.ai

import com.nimbusds.jwt.SignedJWT
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.core.io.ClassPathResource
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import com.innorder.occ.command.IdempotencyConflictException
import com.innorder.occ.command.InvalidIdempotencyKeyException

class AiGrantIntegrationTest {
    private val now = Instant.parse("2026-08-02T12:00:00Z")
    private val properties = AiGrantTokenProperties(
        privateKeyFile = ClassPathResource("test-only-jwt-private.pem"),
        publicKeyFile = ClassPathResource("test-only-jwt-public.pem"),
        keyId = "ai-grant-2026-08",
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

    private class InMemoryGrantStore(
        private val revision: Long,
        private val releaseDigest: String,
    ) : AiGrantStore {
        val records = mutableListOf<StoredAiGrant>()
        val documents = mutableListOf<List<UUID>>()
        val claimKeyHashes = mutableListOf<String>()
        private val byOperation = ConcurrentHashMap<UUID, StoredAiGrant>()

        override fun lockAuthorizationSnapshot(policyReleaseId: UUID) = AuthorizationSnapshotBinding(revision, releaseDigest)
        override fun insert(record: StoredAiGrant, documentVersionIds: List<UUID>) {
            records += record
            documents += documentVersionIds
            byOperation[record.claims.operationId] = record
        }
        override fun findByOperationId(operationId: UUID): StoredAiGrant? = byOperation[operationId]
        override fun bindClaimIdempotency(grantId: UUID, keyHash: String) {
            synchronized(claimKeyHashes) {
                val existing = claimKeyHashes.singleOrNull()
                if (existing != null && existing != keyHash) throw IdempotencyConflictException()
                if (existing == null) claimKeyHashes += keyHash
            }
        }

        override fun toString(): String = "InMemoryGrantStore(records=${records.size},claimKeyHashes=$claimKeyHashes)"
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
