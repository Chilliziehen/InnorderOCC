# Platform Contracts And Security Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the authenticated, default-deny, idempotent Core command foundation that every OCC business workflow can safely reuse.

**Architecture:** Core remains a Spring Boot modular monolith using one PostgreSQL/Spring transaction manager. Local authentication issues RSA-signed access tokens and rotating opaque refresh tokens; protected commands acquire an authorization revision lock, call OPA, and atomically write domain state, audit, idempotency, and Outbox records. Contracts are defined first in OpenAPI and TypeScript, then proven against real PostgreSQL and OPA.

**Tech Stack:** Kotlin 2, Java 21, Spring Boot Web/Security/JDBC/OAuth2 Resource Server, PostgreSQL/Flyway, OPA/Rego, TypeScript, Zod 4, Vitest, JUnit 5, Testcontainers

---

## File Structure

New Core packages have one responsibility each:

```text
services/core/src/main/kotlin/com/innorder/occ/
  api/            Correlation filter and RFC 9457 error translation
  auth/           Password verification, tokens, sessions, login endpoints
  authz/          Authorization snapshots, OPA client, decision recording
  command/        Idempotency, optimistic version checks, audit and Outbox kernel
  iam/            Current-principal and bootstrap administrator persistence
  events/         Outbox claim/publish state machine and event envelopes
```

Shared wire contracts live in `packages/contracts/src`; Core mirrors only server-side Kotlin DTOs. `V010` is the sole migration for this workstream. Later workstreams add forward-only migrations and consume the command interfaces without editing their semantics.

### Task 1: Define Common API And Event Contracts

**Files:**
- Create: `packages/contracts/src/problem-details.ts`
- Create: `packages/contracts/src/auth.ts`
- Create: `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/openapi/occ-core.yaml`
- Create: `packages/contracts/test/platform-contracts.test.ts`
- Modify: `packages/contracts/test/openapi-system-status.test.ts`

- [ ] **Step 1: Write failing strict-schema tests**

Add tests that parse valid values and reject unknown fields:

```ts
expect(problemDetailsSchema.parse({
  type: "https://innorder.local/problems/validation",
  title: "Validation failed",
  status: 400,
  code: "OCC-API-VALIDATION",
  correlationId: "018f30c0-7a86-7f8b-a6e0-3c5477bb7e1a",
})).toMatchObject({ status: 400 });

expect(() => eventEnvelopeSchema.parse({
  id: crypto.randomUUID(), customerInstanceId: crypto.randomUUID(),
  type: "iam.session.created", schemaVersion: 1,
  aggregateType: "session", aggregateId: crypto.randomUUID(), aggregateVersion: 0,
  occurredAt: "2026-07-30T12:00:00Z", correlationId: crypto.randomUUID(), payload: {}, extra: true,
})).toThrow();
```

- [ ] **Step 2: Run the contracts test and verify RED**

Run: `npm run test --workspace @innorder/contracts -- platform-contracts.test.ts`

Expected: FAIL because the new schemas are not exported.

- [ ] **Step 3: Implement strict Zod contracts**

Define `problemDetailsSchema`, `loginRequestSchema`, `tokenResponseSchema`, `refreshRequestSchema`, `currentUserSchema`, and `eventEnvelopeSchema`. Use UUID, ISO instant, positive schema version, non-empty stable code/type, and `.strict()` objects. Event payload is `z.record(z.string(), z.unknown())`; credentials are not part of any schema.

- [ ] **Step 4: Expand OpenAPI common components and auth paths**

Add bearer security and exact operations for `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, and `GET /api/v1/me`. Login and status are public; refresh uses the opaque refresh token body; logout and `me` require bearer auth. All non-2xx responses reference `ProblemDetails`.

- [ ] **Step 5: Run contract verification and commit**

Run: `npm run test --workspace @innorder/contracts; npm run typecheck --workspace @innorder/contracts`

Expected: all contract tests and typecheck PASS.

Commit: `feat(contracts): define platform security contracts`

### Task 2: Add Forward-Only Platform Security Migration

**Files:**
- Create: `database/migrations/V010__platform_security_kernel.sql`
- Modify: `database/innorder_occ_full_schema.sql`
- Modify: `database/tests/schema-static.test.mjs`
- Modify: `database/tests/001_schema_contract.sql`
- Modify: `database/tests/002_constraints.sql`
- Modify: `database/tests/run_all.sql`

- [ ] **Step 1: Write failing static and SQL assertions**

Require `platform.customer_instance`, `iam.auth_session`, idempotency lifecycle fields, full event metadata, active relationship indexing, and state constraints. Add a SQL race fixture proving a completed idempotency record cannot return to `IN_PROGRESS`.

```sql
SELECT test.assert_true(
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'iam' AND table_name = 'auth_session' AND column_name = 'refresh_token_hash'),
  'auth sessions store only refresh token hashes'
);
```

- [ ] **Step 2: Run database contracts and verify RED**

Run: `node --test database/tests/schema-static.test.mjs; npm run test:database:pglite`

Expected: FAIL because V010 and its tables/columns do not exist.

- [ ] **Step 3: Implement V010**

Create one singleton `platform.customer_instance` with immutable UUID and instance key. Add `iam.auth_session(id, principal_id, token_version, refresh_token_hash, created_at, last_used_at, expires_at, revoked_at, replaced_by_session_id, client_fingerprint)` with unique token hash and valid timestamp checks.

Extend `audit.idempotency_record` with `state IN ('IN_PROGRESS','COMPLETED','FAILED')`, bounded JSON response body, update timestamp, and consistency checks. Extend `audit.outbox_event` with customer instance, actor, causation, last error, next attempt, and claimed timestamp. Add indexes for active sessions, pending Outbox claims, and relationships active by validity window. Add triggers that bump authorization revision when principal status or active relationship authorization facts change.

- [ ] **Step 4: Prove migration and constraints GREEN**

Run: `node --test database/tests/schema-static.test.mjs; npm run test:database:pglite`

With PostgreSQL available run: `psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database/tests/run_all.sql`

Expected: all static, PGlite compatibility, and PostgreSQL constraint tests PASS.

- [ ] **Step 5: Commit**

Commit: `feat(database): add platform security state`

### Task 3: Establish Correlation IDs And Problem Details

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/api/CorrelationIdFilter.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/api/OccProblem.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/api/ApiExceptionHandler.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/api/ApiErrorHandlingTest.kt`

- [ ] **Step 1: Write controller tests for valid and invalid correlation IDs**

Test that a UUID `X-Correlation-ID` is echoed, an invalid value is replaced, validation errors return `application/problem+json`, and exception messages/secrets never appear.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `./gradlew.bat :services:core:test --tests com.innorder.occ.api.ApiErrorHandlingTest`

Expected: FAIL because the filter and advice do not exist.

- [ ] **Step 3: Implement the API boundary**

Use a `OncePerRequestFilter` that parses UUID input or creates UUIDv7-compatible random UUIDs, places the value in MDC/request attributes, and always sets the response header. Implement immutable `OccProblem(type, title, status, code, correlationId, detail?)`. Map validation, malformed JSON, authentication, access denial, optimistic conflict, and generic exceptions to stable codes; generic responses contain no exception detail.

- [ ] **Step 4: Run tests and commit**

Run: `./gradlew.bat :services:core:test --tests com.innorder.occ.api.ApiErrorHandlingTest`

Expected: PASS.

Commit: `feat(core): add bounded problem responses`

### Task 4: Implement Password And Session Persistence

**Files:**
- Modify: `services/core/build.gradle.kts`
- Create: `services/core/src/main/kotlin/com/innorder/occ/auth/PasswordService.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/auth/SessionRepository.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/auth/SessionModels.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/auth/PasswordServiceTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/auth/SessionRepositoryIntegrationTest.kt`

- [ ] **Step 1: Write password and rotating-session tests**

Assert Argon2id hashes never contain plaintext, correct passwords verify, malformed hashes fail safely, refresh tokens are 256-bit URL-safe random values, only SHA-256 hashes reach JDBC, rotation revokes the old session, and replay revokes the replacement chain.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `./gradlew.bat :services:core:test --tests 'com.innorder.occ.auth.*'`

Expected: FAIL because auth persistence is absent.

- [ ] **Step 3: Add crypto dependencies and implementation**

Add Spring OAuth2 resource server/JOSE and `org.bouncycastle:bcprov-jdk18on`. Configure `Argon2PasswordEncoder(16, 32, 1, 1 shl 16, 3)`. Generate refresh tokens with `SecureRandom`, hash UTF-8 token bytes with SHA-256, compare fixed-size hash bytes using `MessageDigest.isEqual`, and perform rotation in one JDBC transaction with `SELECT ... FOR UPDATE`.

- [ ] **Step 4: Run tests and commit**

Run: `./gradlew.bat :services:core:test --tests 'com.innorder.occ.auth.*'`

Expected: PASS, with PostgreSQL integration test executed when Docker is available and never silently skipped in full verification.

Commit: `feat(core): add password and session persistence`

### Task 5: Issue And Validate Access Tokens

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/auth/JwtConfiguration.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/auth/AccessTokenService.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/config/SecurityConfiguration.kt`
- Modify: `services/core/src/main/resources/application.yml`
- Create: `services/core/src/test/kotlin/com/innorder/occ/auth/AccessTokenSecurityTest.kt`

- [ ] **Step 1: Write token validation tests**

Generate a test RSA keypair and assert issuer, audience `occ-core`, subject, instance ID, session ID, token version, issued/expiry times, and 15-minute maximum TTL. Reject wrong audience/issuer/signature, expired tokens, disabled principals, revoked sessions, and stale token versions.

- [ ] **Step 2: Run and verify RED**

Run: `./gradlew.bat :services:core:test --tests com.innorder.occ.auth.AccessTokenSecurityTest`

Expected: FAIL because bearer-token support is absent.

- [ ] **Step 3: Implement RSA token service and security chain**

Load PKCS#8 private and X.509 public PEM files from `OCC_JWT_PRIVATE_KEY_FILE` and `OCC_JWT_PUBLIC_KEY_FILE`; reject missing/weak/non-RSA keys at startup. Configure `JwtEncoder`, `JwtDecoder`, issuer/audience validators, and a post-JWT session/principal validator. Keep only status and login public; refresh is authenticated by its opaque token body, not bearer state.

- [ ] **Step 4: Run tests and commit**

Run: `./gradlew.bat :services:core:test --tests com.innorder.occ.auth.AccessTokenSecurityTest`

Expected: PASS.

Commit: `feat(core): validate signed access tokens`

### Task 6: Implement Login, Refresh, Logout, And Current User

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/auth/AuthService.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/auth/AuthController.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/iam/CurrentUserController.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/iam/PrincipalRepository.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/auth/AuthControllerIntegrationTest.kt`

- [ ] **Step 1: Write the complete HTTP lifecycle test**

Seed one active user. Verify generic failure for unknown user and wrong password, five-failure lockout, successful login reset, refresh rotation, replay-chain revocation, logout, disabled-user rejection, and `/api/v1/me` returning no password/session secret.

- [ ] **Step 2: Run and verify RED**

Run: `./gradlew.bat :services:core:test --tests com.innorder.occ.auth.AuthControllerIntegrationTest`

Expected: FAIL because auth routes are absent.

- [ ] **Step 3: Implement transactional authentication**

Normalize usernames with `trim().lowercase(Locale.ROOT)`. Lock the account row before updating counters. Use one generic `OCC-AUTH-INVALID-CREDENTIALS` response and constant password verification work. Return access token, refresh token, `expiresIn: 900`, and sanitized current user. Apply the lockout values from the design and store all instants with `Clock` injection.

- [ ] **Step 4: Run tests and commit**

Run: `./gradlew.bat :services:core:test --tests com.innorder.occ.auth.AuthControllerIntegrationTest`

Expected: PASS.

Commit: `feat(core): add local authentication lifecycle`

### Task 7: Bootstrap The First Administrator Safely

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/iam/BootstrapAdministrator.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/iam/BootstrapAdministratorIntegrationTest.kt`
- Modify: `services/core/src/main/resources/application.yml`

- [ ] **Step 1: Write one-shot bootstrap tests**

Assert bootstrap creates the platform admin entity/principal/account/role relationships only when no user exists, reads the password from a file, rejects weak or world-readable secret files where POSIX permissions are available, does not log the password, and is idempotent on restart.

- [ ] **Step 2: Run and verify RED**

Run: `./gradlew.bat :services:core:test --tests com.innorder.occ.iam.BootstrapAdministratorIntegrationTest`

Expected: FAIL because bootstrap does not exist.

- [ ] **Step 3: Implement startup bootstrap**

Use an `ApplicationRunner` enabled only by `OCC_BOOTSTRAP_ADMIN_PASSWORD_FILE`. In one transaction, lock a bootstrap advisory key, check for existing users, create the required `authz.entity`, `iam.principal`, `iam.user_account`, and platform-admin relationship, bump authorization revision, then overwrite/delete the one-shot secret only when configured by the deployment script. Fail startup on partial or invalid bootstrap input.

- [ ] **Step 4: Run tests and commit**

Run: `./gradlew.bat :services:core:test --tests com.innorder.occ.iam.BootstrapAdministratorIntegrationTest`

Expected: PASS.

Commit: `feat(core): bootstrap initial administrator`

### Task 8: Define Layered OPA Decision Contract

**Files:**
- Modify: `policies/opa/platform/authz.rego`
- Modify: `policies/opa/platform/authz_test.rego`
- Create: `packages/contracts/src/authorization.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/platform-contracts.test.ts`

- [ ] **Step 1: Add failing Rego and Zod cases**

Cover valid revision/release input, PLATFORM/DENY precedence, one ALLOW plus ABSTAIN layers, all ABSTAIN denial, disabled principal, inactive resource, expired relationship exclusion, malformed input, opaque reason references, and unknown-field contract rejection.

- [ ] **Step 2: Run and verify RED**

Run: `$env:OPA_PATH = (Get-Command opa -ErrorAction Stop).Source; opa test policies/opa; npm run test --workspace @innorder/contracts`

Expected: new cases FAIL under the old grant-only contract.

- [ ] **Step 3: Implement the versioned input/output**

Require `request_id`, `authorization_revision`, three release layers, principal, action, resource, active relationships, and context. Compute layer outcomes as `ALLOW`, `DENY`, or `ABSTAIN`; deny any explicit deny, deny all-abstain, and allow at least one allow only when platform baseline constraints pass. Output `allow`, `authorization_revision`, release IDs, stable reason codes, and hashed matched-policy references.

- [ ] **Step 4: Run tests and commit**

Run: `opa check --strict policies/opa; opa test policies/opa; npm run test --workspace @innorder/contracts`

Expected: all checks PASS.

Commit: `feat(authz): define layered decision contract`

### Task 9: Implement Core Authorization Orchestration

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/authz/AuthorizationModels.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/authz/AuthorizationSnapshotRepository.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/authz/OpaClient.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/authz/DecisionLogRepository.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/authz/AuthorizationService.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/authz/AuthorizationServiceIntegrationTest.kt`

- [ ] **Step 1: Write integration tests around a fake OPA server**

Prove shared revision lock, active relationship filtering, three-layer release snapshot, allow, deny, malformed response, timeout, stale revision/release, allowed decision rollback, and separately committed DENY/ERROR logs. Verify no sensitive context is persisted.

- [ ] **Step 2: Run and verify RED**

Run: `./gradlew.bat :services:core:test --tests com.innorder.occ.authz.AuthorizationServiceIntegrationTest`

Expected: FAIL because orchestration does not exist.

- [ ] **Step 3: Implement bounded fail-closed authorization**

Use JDBC `SELECT ... FOR SHARE` on the singleton revision, query only active `valid_from/valid_until/revoked_at` relationships, and load one atomic active policy release. Use JDK `HttpClient` or Spring `RestClient` with 500 ms connect and 1 s request timeout, 256 KiB response cap, strict Jackson parsing, and no retry inside a command. Persist ALLOW in the caller transaction; use `REQUIRES_NEW` for DENY/ERROR logs.

- [ ] **Step 4: Run tests and commit**

Run: `./gradlew.bat :services:core:test --tests com.innorder.occ.authz.AuthorizationServiceIntegrationTest`

Expected: PASS.

Commit: `feat(core): enforce transactional OPA authorization`

### Task 10: Build The Reusable Command Kernel

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/command/AuthorizedCommand.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/command/CommandExecutor.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/command/IdempotencyRepository.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/command/AuditRepository.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/events/OutboxRepository.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/command/CommandExecutorIntegrationTest.kt`

- [ ] **Step 1: Write command semantics tests**

Use a test aggregate table to prove: missing idempotency key is rejected; same key/same canonical request replays the original status/body/resource; same key/different hash conflicts; concurrent duplicate executes once; stale `expectedVersion` conflicts; OPA deny changes nothing; handler exception rolls back aggregate/audit/idempotency/Outbox; success writes exactly one of each.

- [ ] **Step 2: Run and verify RED**

Run: `./gradlew.bat :services:core:test --tests com.innorder.occ.command.CommandExecutorIntegrationTest`

Expected: FAIL because the kernel is absent.

- [ ] **Step 3: Implement the command interfaces**

Define:

```kotlin
data class CommandMetadata(
    val principalId: UUID, val commandKey: String, val idempotencyKey: String,
    val requestHash: String, val expectedVersion: Long?, val correlationId: UUID,
)

interface AuthorizedCommand<R> {
    val action: String
    val resourceId: UUID?
    fun execute(context: CommandContext): CommandResult<R>
}
```

Canonicalize request JSON by recursively sorting object keys before SHA-256 hashing. Insert `IN_PROGRESS` idempotency state before execution under the command transaction and unique constraint. Execute authorization, version check, handler, audit, and Outbox in order; then store bounded replay JSON and mark `COMPLETED` before commit.

- [ ] **Step 4: Run tests and commit**

Run: `./gradlew.bat :services:core:test --tests com.innorder.occ.command.CommandExecutorIntegrationTest`

Expected: PASS including the concurrent duplicate case.

Commit: `feat(core): add authorized command kernel`

### Task 11: Implement Transactional Outbox Publishing

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/events/EventEnvelope.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/events/OutboxPublisher.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/events/OutboxProperties.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/events/OutboxPublisherIntegrationTest.kt`
- Modify: `services/core/src/main/resources/application.yml`

- [ ] **Step 1: Write publisher state-machine tests**

Prove `FOR UPDATE SKIP LOCKED` claiming, aggregate ID Kafka key, broker acknowledgement before `PUBLISHED`, exponential retry at 5/30/120/600 seconds, attempt limit 10, DEAD transition with bounded sanitized error, stale claim recovery after five minutes, and two publishers never publishing the same claimed row concurrently.

- [ ] **Step 2: Run and verify RED**

Run: `./gradlew.bat :services:core:test --tests com.innorder.occ.events.OutboxPublisherIntegrationTest`

Expected: FAIL because publisher logic is absent.

- [ ] **Step 3: Implement claim/publish/finalize boundaries**

Claim and commit a small batch, publish outside the database transaction using `KafkaTemplate`, then finalize each row in a new transaction. Set Kafka key to aggregate UUID and headers for event ID/type/schema/correlation. A broker timeout returns the row to `PENDING` with the next schedule; it never marks success optimistically.

- [ ] **Step 4: Run tests and commit**

Run: `./gradlew.bat :services:core:test --tests com.innorder.occ.events.OutboxPublisherIntegrationTest`

Expected: PASS.

Commit: `feat(core): publish transactional outbox events`

### Task 12: Prove End-To-End Security Kernel Behavior

**Files:**
- Create: `services/core/src/test/kotlin/com/innorder/occ/PlatformSecurityKernelIntegrationTest.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/PostgreSqlFlowableIntegrationTest.kt`
- Modify: `scripts/verify.mjs`
- Modify: `Docs/Development/verification.md`

- [ ] **Step 1: Write one full-stack test**

Start real PostgreSQL and a bounded fake OPA endpoint. Bootstrap admin, login, execute a test authorized command, retry it, attempt a stale version, revoke the role relationship, and retry a new command. Assert one successful transition/event, deterministic replay, one conflict, one denial, revision increment, retained denial log, and no credentials in logs/responses/events.

- [ ] **Step 2: Add Flowable transaction-manager assertion**

Assert Flowable uses the application datasource and Spring transaction manager. In a forced exception after a synchronous Flowable state change, verify both Flowable and OCC rows roll back. Fail application startup in a test profile configured with a separate Flowable datasource.

- [ ] **Step 3: Run focused integration tests and verify RED/GREEN**

Run: `./gradlew.bat :services:core:test --tests com.innorder.occ.PlatformSecurityKernelIntegrationTest --tests com.innorder.occ.PostgreSqlFlowableIntegrationTest`

Expected after implementation: PASS with no skipped PostgreSQL tests.

- [ ] **Step 4: Wire strict verification**

Update `scripts/verify.mjs` so strict full verification checks the structured JUnit results for the new integration classes and fails if any are skipped. Document the exact local and full commands and required OPA/Docker prerequisites.

- [ ] **Step 5: Run the complete workstream gate**

Run:

```powershell
npm run test --workspace @innorder/contracts
node --test database/tests/schema-static.test.mjs
npm run test:database:pglite
$env:OPA_PATH = (Get-Command opa -ErrorAction Stop).Source
opa check --strict policies/opa
opa test policies/opa
./gradlew.bat :services:core:test
npm run typecheck
npm run verify:full
```

Expected: every required test PASS and `verify:full` reports no skipped OPA/PostgreSQL security-kernel integration test.

- [ ] **Step 6: Commit**

Commit: `test: verify platform security kernel`

## Plan Self-Review

- Spec coverage: contracts, local authentication, access/refresh lifecycle, bootstrap, layered OPA, authorization revision locking, deny/error audit, idempotency, optimistic concurrency, audit, Outbox, event metadata, Flowable transaction sharing, fail-closed behavior, and strict verification all map to explicit tasks.
- Deferred by design: business CRUD, package publication UI, workflow APIs, evidence, risk, resource, AI/RAG, desktop integration, TLS ingress, and release installers belong to later workstream plans.
- Placeholder scan: the plan contains no undecided implementation markers; all limits, state names, commands, and expected outcomes are specified.
- Type consistency: contract, session, authorization, command metadata, event envelope, and persistence names remain consistent across tasks.
