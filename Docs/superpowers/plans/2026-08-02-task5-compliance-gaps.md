# Task 5 Compliance Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the in-scope Task 5 grant idempotency, bounded database access, Core/AI mTLS, internal trigger, and migration verification gaps without implementing Task 8, Task 9, or Task 10 work.

**Architecture:** Keep grant creation/claiming in Core, persist only hashes, and serialize claim/consume decisions under PostgreSQL row locks. Keep AI grant verification and consumption reusable for the future Kafka consumer while exposing only Core-authenticated status/cancel HTTP routes. Enforce service identity at real TLS listeners and database access through security-definer functions and the dedicated AI LOGIN.

**Tech Stack:** Kotlin 2/Spring Boot 3/Spring Security/JDBC/JUnit 5, TypeScript/Node 22/Fastify/Vitest, PostgreSQL 16/PLpgSQL, Docker, TLS 1.3/X.509.

---

### Task 1: PostgreSQL Grant Replay And Status Boundary

**Files:**
- Modify: `database/migrations/V015__governed_ai_runtime.sql`
- Modify: `database/tests/schema-static.test.mjs`
- Modify: `database/tests/postgresql-governed-ai.test.mjs`

- [x] Add static and real PostgreSQL tests for exact concurrent replay, one grant/run linkage, differing binding rejection, dedicated AI LOGIN access, direct `ai_run` denial, and bounded status success/failure.
- [x] Run the tests and confirm they fail for the missing contracts.
- [x] Implement atomic exact replay and the status security-definer function with narrow grants.
- [x] Run static and real PostgreSQL tests and confirm they pass.

### Task 2: AI Repository And Internal Trigger Boundary

**Files:**
- Modify: `services/ai/src/persistence/postgres.ts`
- Create: `services/ai/src/core/grant-consumer.ts`
- Modify: `services/ai/src/composition-root.ts`
- Modify: `services/ai/src/app.ts`
- Modify: `services/ai/test/service-security.test.ts`

- [x] Add tests for replay mapping, status-function use, reusable verification/consumption, and absence of the HTTP start route.
- [x] Run focused AI tests and confirm the expected failures.
- [x] Map replay as success, use only bounded SQL functions, and internalize grant consumption for Task 9.
- [x] Run focused and full AI tests, build, and typecheck.

### Task 3: Core Claim Idempotency

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/ai/AiGrantService.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/ai/AiServiceController.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/ai/AiGrantIntegrationTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/ai/AiServiceControllerTest.kt`

- [x] Add service concurrency and controller Problem Details tests for valid, missing, malformed, same, and conflicting idempotency keys, including no plaintext persistence.
- [x] Run focused Core tests and confirm the expected failures.
- [x] Validate the existing key constraints, hash keys, bind under the grant row lock, and use existing stable exception handlers.
- [x] Run focused Core tests and confirm they pass.

### Task 4: Real Core And AI TLS Listeners

**Files:**
- Modify: `services/core/src/main/resources/application.yml`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/ai/AiServiceSecurityConfiguration.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/OccCoreApplicationTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/ai/CoreServiceTlsIntegrationTest.kt`
- Create: `services/ai/test/service-https.test.ts`
- Create: `test-fixtures/service-tls/*`

- [x] Add live listener tests covering exact SPIFFE identities, current/next CA overlap, wrong SAN/EKU/issuer, revocation, expiry, missing certificates, bearer rejection, real servlet certificate attributes, and secret-free output.
- [x] Run focused listener tests and confirm the expected failures.
- [x] Configure opt-in file-backed Core TLS 1.3 with WANT client auth and retain strict route-level identity filtering; configure equivalent AI listener verification.
- [x] Run both live listener suites and confirm they pass.

### Task 5: Migration Integrity And Final Verification

**Files:**
- Modify: `services/core/src/test/kotlin/com/innorder/occ/PostgreSqlFlowableIntegrationTest.kt`

- [x] Update the exact ordered Flyway assertion to `V001` through `V012`, reserved `V013`/`V014` gaps, and `V015`.
- [x] Run focused Core/AI/database/contracts tests, full AI and Core tests where feasible, provenance/audit, quick verification, and `git diff --check` (quick verification reaches the explicitly deferred Task 10 deployment-documentation mismatch; strict Core requires unavailable OPA 1.5.1).
- [x] Review status/diff/log, stage only Task 5 files, and commit as `fix: complete AI grant service boundary`.
