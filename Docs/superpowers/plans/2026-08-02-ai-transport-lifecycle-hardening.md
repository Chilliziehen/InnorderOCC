# AI Transport Lifecycle Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject wrong AI peers during TLS negotiation, preserve deterministic grant signing across bounded key rotation, and make PostgreSQL grant consumption promptly abortable without leaving a consumed grant or hanging pool.

**Architecture:** Core delegates normal PKIX and endpoint trust to the platform trust manager and layers exact AI SPIFFE, server EKU, validity, and revocation checks inside `checkServerTrusted`, before HTTP is available. Grants persist the signer key identifier and reconstruct tokens from current or retained previous file-backed signers. AI checks out a dedicated PostgreSQL client for consumption and destroys that connection on abort, relying on PostgreSQL connection termination to roll back the single-statement implicit transaction.

**Tech Stack:** Kotlin/Spring Boot/JDK `HttpClient` and JSSE, Nimbus JOSE JWT, PostgreSQL 16, TypeScript/Node 22, `pg` 8.16, JUnit 5, Vitest, Docker.

---

### Task 1: Outbound Core TLS Identity During Handshake

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/ai/AiServiceClient.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/ai/AiServiceClientHandshakeTest.kt`
- Create: `test-fixtures/service-tls/ai-server-next.cert.pem`
- Create: `test-fixtures/service-tls/ai-server-next.key.pem`
- Create: `test-fixtures/service-tls/next-server-ca.cert.pem`

- [x] Write a live HTTPS test whose wrong-service server increments an HTTP handler counter, and assert `AiServiceClientException` with counter zero; assert current-CA and next-CA AI servers return status successfully.
- [x] Run `./gradlew.bat :services:core:test --tests com.innorder.occ.ai.AiServiceClientHandshakeTest --rerun-tasks` and verify failure because the wrong-service server receives one HTTP request.
- [x] Add an `X509ExtendedTrustManager` that delegates all PKIX/hostname checks and rejects invalid, revoked, wrong-EKU, or non-exact AI URI SAN server certificates from every `checkServerTrusted` overload.
- [x] Remove post-response peer identity validation and rerun the focused test to green.

### Task 2: Deterministic Grant Signer Rotation

**Files:**
- Modify: `database/migrations/V016__governed_ai_runtime.sql`
- Modify: `database/tests/schema-static.test.mjs`
- Modify: `database/tests/postgresql-governed-ai.test.mjs`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/ai/AiGrantTokenService.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/ai/AiGrantService.kt`
- Modify: `services/core/src/main/resources/application.yml`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/ai/AiGrantIntegrationTest.kt`
- Create: `services/core/src/test/resources/test-only-ai-grant-next-private.pem`
- Create: `services/core/src/test/resources/test-only-ai-grant-next-public.pem`

- [x] Add failing migration tests for bounded immutable `signer_kid`, and Core tests that create with the old current signer, rotate it to previous, claim the exact old token before expiry, create with the new signer, and reject unknown signer/hash bindings.
- [x] Run focused database static and Core grant tests and verify failures for the absent column and signer-aware API.
- [x] Persist/map `signer_kid`; bind current and up to one previous file-backed 3072-bit RSA key pair; issue new grants with current and reconstruct claims with the stored signer.
- [x] Rerun focused tests to green, including removal of the old signer only after the old grant has expired.

### Task 3: Abortable PostgreSQL Grant Consumption

**Files:**
- Modify: `services/ai/src/persistence/postgres.ts`
- Modify: `services/ai/src/composition-root.ts`
- Modify: `services/ai/test/service-security.test.ts`
- Create: `services/ai/test/postgres-real.test.ts`

- [x] Add a unit test requiring a query configuration and stable cancellation mapping, plus a Docker PostgreSQL test that locks the grant row in session A, aborts repository consume in session B, verifies bounded settlement and an unconsumed grant, then closes the pool within a deadline.
- [x] Run the focused AI tests and verify cancellation currently hangs until the lock is released or timeout occurs.
- [x] Configure bounded `statement_timeout`, `lock_timeout`, `query_timeout`, `application_name`, and idle transaction timeout; acquire a dedicated pool client and destroy it on abort so the implicit transaction rolls back.
- [x] Rerun focused unit and real PostgreSQL tests to green and assert no raw database error escapes.

### Task 4: Verification And Commit

**Files:**
- Modify: `Docs/superpowers/plans/2026-08-02-ai-transport-lifecycle-hardening.md`

- [x] Run focused and full Core, AI, database static/real, builds/typechecks, provenance, registry audits, and `git diff --check`.
- [x] Inspect status/diff/log, stage only this hardening work, and commit `fix: harden AI service transport lifecycle`.
