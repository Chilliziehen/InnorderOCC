# Evidence, Risk, And Resource Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the authorized evidence/review, deterministic risk/intervention, and conflict-safe resource/reservation Core vertical slice with real PostgreSQL, MinIO, OPA, and concurrency verification.

**Architecture:** Add one forward-only V014 migration, then implement three focused Kotlin packages that reuse `CommandExecutor`. Evidence isolates hostile content and private object storage behind ports; risk evaluates immutable facts against package-versioned rules; resources serialize all schedule writes on the managed-resource row. Shared Zod/OpenAPI contracts and strict full-suite registration are committed separately.

**Tech Stack:** Kotlin 2.0/JDK 21, Spring Boot 3.3, Spring JDBC, PostgreSQL 16, Flyway, Testcontainers 1.21, MinIO Java SDK 8.5.17, OPA 1.5.1, TypeScript, Zod 4, OpenAPI 3, Node test, Vitest.

---

## File Map

- `database/migrations/V014__evidence_risk_resource.sql`: forward-only tables, columns, constraints, triggers, and bounded functions.
- `database/tests/evidence-risk-resource-static.test.mjs`: V014 structural/security contract.
- `database/tests/postgresql-reservation-race.test.mjs`: process-level reservation races.
- `services/core/src/main/kotlin/com/innorder/occ/evidence/*`: upload, inspection, scanner/object-store ports, evidence commands, reads, and workflow/notification ports.
- `services/core/src/main/kotlin/com/innorder/occ/risk/*`: strict rules, deterministic evaluator, lifecycle commands, intervention queries, and adjudication.
- `services/core/src/main/kotlin/com/innorder/occ/resource/*`: resource availability, reservations, redaction, and schedule queries.
- `services/core/src/main/kotlin/com/innorder/occ/api/CursorCodec.kt`: context-bound authenticated cursor codec shared by domain queries.
- `packages/contracts/src/evidence-risk-resource.ts`: strict public request/response schemas.
- `packages/contracts/test/evidence-risk-resource.test.ts`: boundary and unknown-field contract tests.
- `packages/contracts/openapi/occ-core.yaml`: paths, schemas, headers, and Problem Details.
- `scripts/verify.mjs`: mandatory result registration for new real-infrastructure suites.

### Task 1: V014 Static Contract

**Files:**
- Create: `database/tests/evidence-risk-resource-static.test.mjs`
- Modify: `database/tests/schema-static.test.mjs`
- Modify: `database/innorder_occ_full_schema.sql`
- Create: `database/migrations/V014__evidence_risk_resource.sql`

- [ ] **Step 1: Write the failing migration contract**

Create a Node test that reads V014 and asserts `upload_session` lease/provenance columns, `evidence_object_disposition`, `risk_action`, `risk_adjudication`, `resource_availability`, fixed `search_path`, `REVOKE ... FROM PUBLIC`, reservation parent locks, canonical `[)` ranges, legacy preflight checks, and immutable-row triggers.

```js
test('V014 hardens evidence risk and resource state', () => {
  assert.match(sql, /CREATE TABLE occ\.evidence_object_disposition/i);
  assert.match(sql, /CREATE TABLE occ\.risk_action/i);
  assert.match(sql, /CREATE TABLE occ\.resource_availability/i);
  assert.match(sql, /FOR UPDATE/i);
  assert.match(sql, /lower_inc\(NEW\.time_range\).*NOT upper_inc/si);
  assert.match(sql, /SET search_path = pg_catalog, occ/i);
  assert.match(sql, /REVOKE EXECUTE .* FROM PUBLIC/i);
});
```

- [ ] **Step 2: Prove red**

Run: `node --test database/tests/evidence-risk-resource-static.test.mjs`

Expected: FAIL because `V014__evidence_risk_resource.sql` does not exist.

- [ ] **Step 3: Add the migration and ordered entrypoints**

Implement additive legacy-compatible columns, new history/disposition tables, state-transition triggers, evidence review segregation, one-future-review enforcement, risk occurrence/action/adjudication invariants, resource availability, and reservation conflict/capacity functions. Lock V005 tables during preflight; abort on historical conflicts without rewriting immutable data. Add V014 to the static list and full-schema `\ir` order. Rewrite PGlite's final-three slice assumption to filter unsupported migrations by filename.

- [ ] **Step 4: Prove green**

Run: `npm run test:database`

Expected: all schema-static and V014 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add database
git commit -m "feat(database): add evidence risk resource migration"
```

### Task 2: Real PostgreSQL Migration And Concurrency

**Files:**
- Create: `services/core/src/test/kotlin/com/innorder/occ/EvidenceRiskResourcePostgreSqlIntegrationTest.kt`
- Create: `database/tests/postgresql-reservation-race.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing PostgreSQL tests**

Add Testcontainers assertions for Flyway version 14, immutable version/review/action rows, reviewer/submitter inequality, invalid lifecycle transitions, runtime privileges, canonical ranges, exclusive-versus-capacity conflict, capacity peak, and legal-hold cleanup denial. Add a Node race launching two `psql` workers against one resource and asserting exactly one overbooking contender commits.

```kotlin
assertThatThrownBy {
    jdbc.update("INSERT INTO occ.evidence_review (...) VALUES (...)")
}.hasRootCauseInstanceOf(PSQLException::class.java)
```

- [ ] **Step 2: Prove red**

Run: `gradlew.bat :services:core:test --tests "*EvidenceRiskResourcePostgreSqlIntegrationTest" --dependency-verification strict`

Expected: FAIL on missing or incomplete V014 behavior.

- [ ] **Step 3: Correct only migration defects found by the real engine**

Keep all repairs in V014. Make reservation checks compute peak load at range boundaries under a resource row lock. Make direct runtime DML preserve parent immutability and fail with SQLSTATE `23P01` for schedule conflicts.

- [ ] **Step 4: Prove green including the process race**

Run: `gradlew.bat :services:core:test --tests "*EvidenceRiskResourcePostgreSqlIntegrationTest" --dependency-verification strict`

Run: `$env:INNORDER_STRICT_DATABASE_TESTS='1'; npm run test:database:postgresql-reservation-race`

Expected: both commands PASS with no skipped tests.

- [ ] **Step 5: Commit**

```bash
git add database package.json services/core/src/test
git commit -m "test(database): prove domain invariants and reservation races"
```

### Task 3: Evidence Content Safety

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidencePolicy.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceContentInspector.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/MalwareScanner.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceContentInspectorTest.kt`
- Create: `services/core/src/test/resources/evidence-fixtures/*`

- [ ] **Step 1: Write failing hostile-fixture tests**

Define table-driven expectations for clean PDF/text/OOXML and infected, polyglot, macro-enabled, encrypted, oversized, wrong-hash, nested archive, traversal, malformed archive, high compression ratio, and expanded-size bomb fixtures.

```kotlin
@ParameterizedTest
@MethodSource("rejectedFixtures")
fun `unsafe content fails closed`(fixture: Fixture) {
    assertThatThrownBy { inspector.inspect(fixture.path, fixture.policy) }
        .isInstanceOf(EvidenceRejectedException::class.java)
        .extracting("code").isEqualTo(fixture.code)
}
```

- [ ] **Step 2: Prove red**

Run: `gradlew.bat :services:core:test --tests "*EvidenceContentInspectorTest" --dependency-verification strict`

Expected: compilation FAIL because the inspector does not exist.

- [ ] **Step 3: Implement bounded inspection and scanner protocol**

Use magic-byte detection, strict extension/media policy, incremental SHA-256, bounded ZIP entry streaming, OOXML relationship/content-type checks, PDF encryption/active-content markers, and deadline-aware reads. Define `MalwareScanner.scan(ScanRequest): ScanResult` with only `CLEAN`, `INFECTED`, and `ERROR`; make unknown/timeout fail closed. Keep the deterministic scanner in test source.

- [ ] **Step 4: Prove green**

Run: `gradlew.bat :services:core:test --tests "*EvidenceContentInspectorTest" --dependency-verification strict`

Expected: all clean fixtures PASS and every unsafe fixture returns its stable code.

- [ ] **Step 5: Commit**

```bash
git add services/core/src/main/kotlin/com/innorder/occ/evidence services/core/src/test
git commit -m "feat(core): validate quarantined evidence content"
```

### Task 4: Private MinIO Adapter

**Files:**
- Modify: `services/core/build.gradle.kts`
- Modify: `gradle/verification-metadata.xml`
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/ObjectStore.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/MinioObjectStore.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceStorageProperties.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/evidence/MinioObjectStoreIntegrationTest.kt`

- [ ] **Step 1: Write a failing real-MinIO test**

Start the exact Compose MinIO image in Testcontainers, create a private bucket/application user, stream a bounded object, promote it to a unique immutable key, read a range, delete quarantine, and prove anonymous HTTP GET is denied.

- [ ] **Step 2: Prove red**

Run: `gradlew.bat :services:core:test --tests "*MinioObjectStoreIntegrationTest" --dependency-verification strict`

Expected: compilation FAIL because `ObjectStore` is absent.

- [ ] **Step 3: Implement the adapter**

Add exact `io.minio:minio:8.5.17`, generate strict dependency verification metadata, and wrap MinIO calls behind `ObjectStore`. Enforce bucket/key prefixes, maximum 100 MiB streams, request deadlines, abort on failure, attachment reads, and sanitized exception mapping. Load credentials only from existing config-tree properties.

- [ ] **Step 4: Prove green**

Run: `gradlew.bat :services:core:test --tests "*MinioObjectStoreIntegrationTest" --dependency-verification strict`

Expected: PASS with a real container and zero skipped tests.

- [ ] **Step 5: Commit**

```bash
git add services/core/build.gradle.kts gradle/verification-metadata.xml services/core/src
git commit -m "feat(core): add private MinIO evidence storage"
```

### Task 5: Evidence Upload, Version, Submit, Review, And Cleanup

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceRepository.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceService.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceController.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceWorkflowPort.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/DomainNotificationPort.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidencePreviewService.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceCleanupJob.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceServiceIntegrationTest.kt`

- [ ] **Step 1: Write failing end-to-end service tests**

Test session creation, stream lease/replay, wrong hash, scanner error, version 1 submit/reject, version 2 resubmit/accept, conditional hard gate, `minimumCount=2`, segregation of duties, stale versions, duplicate commands, workflow rollback, immutable history, authorized attachment, and orphan cleanup race.

- [ ] **Step 2: Prove red**

Run: `gradlew.bat :services:core:test --tests "*EvidenceServiceIntegrationTest" --dependency-verification strict`

Expected: compilation FAIL because evidence application services are absent.

- [ ] **Step 3: Implement commands through `CommandExecutor`**

Use `AuthorizedCommand` for session creation, confirmation, submit, and review. Authorize upload creation against the target entity; updates lock evidence/session rows. Keep the byte-stream operation outside the command transaction under the persisted lease. Build every mutation with one bounded event and notification intent. Require production workflow/scanner/notification beans; test profiles supply deterministic adapters.

- [ ] **Step 4: Implement reads and cleanup**

Authorize metadata/history/download on every request. Stream originals as attachments with `nosniff`; never return keys or credentials. Generate a separate bounded UTF-8 `text/plain` preview only for structurally validated text/Markdown, normalize controls, store it under a distinct key, and authorize inline preview reads. PDF/OOXML and unsupported media expose no inline preview until a sandboxed renderer exists. Lease cleanup rows with `SKIP LOCKED`, honor legal hold/backup markers, recheck version references, and delete only eligible unique objects.

- [ ] **Step 5: Prove green and commit**

Run: `gradlew.bat :services:core:test --tests "*Evidence*" --dependency-verification strict`

Expected: all evidence unit/integration tests PASS.

```bash
git add services/core/src
git commit -m "feat(core): implement evidence and review lifecycle"
```

### Task 6: Deterministic Risk Rules

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskRule.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/risk/BusinessCalendar.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskEvaluator.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/risk/RiskEvaluatorTest.kt`

- [ ] **Step 1: Write failing rule tests**

Cover overdue critical work, two returns, seven elapsed inactive days, blocker over two business days, evidence failure/missing evidence, and conflict inside 24 hours. Include weekend, package holiday, DST, threshold-minus-one, and exact-threshold cases.

- [ ] **Step 2: Prove red**

Run: `gradlew.bat :services:core:test --tests "*RiskEvaluatorTest" --dependency-verification strict`

Expected: compilation FAIL because risk rules are absent.

- [ ] **Step 3: Implement pure deterministic evaluation**

Parse strict package JSON into sealed trigger types. Accept only supplied facts, evaluation `Instant`, IANA zone, and immutable calendar. Return canonical occurrence keys and decisions; never call the system clock or database inside a rule.

- [ ] **Step 4: Prove green and commit**

Run: `gradlew.bat :services:core:test --tests "*RiskEvaluatorTest" --dependency-verification strict`

Expected: all boundary cases PASS.

```bash
git add services/core/src/main/kotlin/com/innorder/occ/risk services/core/src/test/kotlin/com/innorder/occ/risk
git commit -m "feat(core): evaluate package-versioned risks"
```

### Task 7: Risk Lifecycle, Intervention Queue, And Adjudication

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskRepository.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskService.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskController.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/risk/RiskServiceIntegrationTest.kt`

- [ ] **Step 1: Write failing lifecycle tests**

Assert occurrence deduplication, owner/SLA creation, acknowledgement, assignment, mitigation, escalation level idempotency, resolution, dismissal, immutable action history, YELLOW/RED queue ordering/filtering, redaction, stale/replayed commands, adjudication supersession, severe misses, and false-positive metrics.

- [ ] **Step 2: Prove red**

Run: `gradlew.bat :services:core:test --tests "*RiskServiceIntegrationTest" --dependency-verification strict`

Expected: compilation FAIL because risk services are absent.

- [ ] **Step 3: Implement kernel-backed commands and cursor reads**

Persist one risk head plus immutable actions/adjudications. Use `FOR UPDATE SKIP LOCKED` for due escalation and uniqueness for occurrence/level replay. Emit bounded events and notification intents. Authorize each queue row before returning it.

- [ ] **Step 4: Prove green and commit**

Run: `gradlew.bat :services:core:test --tests "*Risk*" --dependency-verification strict`

Expected: all risk tests PASS.

```bash
git add services/core/src
git commit -m "feat(core): add risk intervention lifecycle"
```

### Task 8: Managed Resources And Reservations

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/resource/ResourceRepository.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/resource/ResourceService.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/resource/ResourceController.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/resource/ResourceServiceIntegrationTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/resource/ReservationConcurrencyIntegrationTest.kt`

- [ ] **Step 1: Write failing resource tests**

Cover inventory/availability, unavailable/maintenance/archive denial, exact-capacity success, peak-not-sum schedules, exclusive-versus-any conflicts, stale change/cancel, immutable parent links, redacted conflict responses, cursor schedules, capacity reduction, and availability mutation races.

- [ ] **Step 2: Prove red**

Run: `gradlew.bat :services:core:test --tests "*resource*" --dependency-verification strict`

Expected: compilation FAIL because resource services are absent.

- [ ] **Step 3: Implement lock-safe commands**

Every create/change/cancel/availability/capacity command locks the resource row first. Use half-open ranges and database conflict functions. Map SQLSTATE `23P01` to a bounded `409 OCC-RESERVATION-CONFLICT`, exposing identity only after separate authorization.

- [ ] **Step 4: Run real concurrent contenders**

Run: `gradlew.bat :services:core:test --tests "*Resource*" --tests "*ReservationConcurrency*" --dependency-verification strict`

Expected: all tests PASS repeatedly; committed overlap never exceeds exclusivity or peak capacity.

- [ ] **Step 5: Commit**

```bash
git add services/core/src
git commit -m "feat(core): add conflict-safe resource reservations"
```

### Task 9: Context-Bound Cursor Codec

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/api/CursorCodec.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/api/CursorCodecTest.kt`

- [ ] **Step 1: Write failing cursor tests**

Test valid round trip and rejection for tampering, expiry, wrong customer, endpoint, filters, sort version, and direction.

- [ ] **Step 2: Prove red**

Run: `gradlew.bat :services:core:test --tests "*CursorCodecTest" --dependency-verification strict`

Expected: compilation FAIL because the codec is absent.

- [ ] **Step 3: Implement HMAC-SHA-256 cursors**

Canonicalize context plus tuple, sign with a config-tree secret, compare signatures in constant time, and enforce a bounded payload and expiry. Return only opaque URL-safe Base64.

- [ ] **Step 4: Prove green and commit**

Run: `gradlew.bat :services:core:test --tests "*CursorCodecTest" --dependency-verification strict`

Expected: all cursor tests PASS.

```bash
git add services/core/src
git commit -m "feat(core): authenticate domain query cursors"
```

### Task 10: Shared Contracts And OpenAPI

**Files:**
- Create: `packages/contracts/src/evidence-risk-resource.ts`
- Create: `packages/contracts/test/evidence-risk-resource.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/openapi/occ-core.yaml`
- Modify: `packages/contracts/test/openapi-system-status.test.ts`

- [ ] **Step 1: Write failing strict Zod/OpenAPI tests**

Test request/response boundaries, UUIDs, SHA-256, 100 MiB limit, decisions, risk states/severity/actions, ISO offset instants, half-open intervals, positive capacity, cursor pages, unknown-field rejection, headers, paths, and schema parity.

- [ ] **Step 2: Prove red**

Run: `npm run test --workspace @innorder/contracts -- --run test/evidence-risk-resource.test.ts`

Expected: FAIL because schemas and OpenAPI paths are absent.

- [ ] **Step 3: Implement contracts**

Export strict Zod types for all public surfaces and add OpenAPI operations under `/api/v1/evidence`, `/api/v1/risks`, `/api/v1/resources`, and `/api/v1/reservations`. Reuse common Problem Details, idempotency, expected-version, correlation, replay, and cursor components.

- [ ] **Step 4: Prove green and commit separately**

Run: `npm run test --workspace @innorder/contracts`

Run: `npm run build --workspace @innorder/contracts`

Expected: all contract tests and build PASS.

```bash
git add packages/contracts
git commit -m "feat(contracts): define evidence risk resource APIs"
```

### Task 11: HTTP Authorization And OPA Journeys

**Files:**
- Create: `services/core/src/test/kotlin/com/innorder/occ/EvidenceRiskResourceApiIntegrationTest.kt`
- Modify: `policies/opa/occ/authz.rego`
- Modify: `policies/opa/occ/authz_test.rego`

- [ ] **Step 1: Write failing real-OPA HTTP tests**

Use OPA 1.5.1 plus PostgreSQL to prove participant upload/resubmit, teacher review, segregation denial, resource manager commands, risk-owner actions, cross-user download denial, reservation redaction, stale revision fail-closed, idempotent replay, and optimistic conflict Problem Details.

- [ ] **Step 2: Prove red**

Run: `$env:OPA_PATH='C:\Users\30367\AppData\Local\Temp\opencode\opa-1.5.1\opa_windows_amd64.exe'; gradlew.bat :services:core:test --tests "*EvidenceRiskResourceApiIntegrationTest" --dependency-verification strict`

Expected: FAIL on missing policy actions or controller wiring.

- [ ] **Step 3: Add least-privilege policy actions and controller mappings**

Extend existing layered authorization without bypasses. Keep resource/entity IDs opaque and enforce reviewer/submitter separation in both OPA input facts and database state.

- [ ] **Step 4: Prove green and commit**

Run the same command.

Expected: PASS with real OPA and no skipped tests.

```bash
git add policies services/core/src
git commit -m "feat(core): authorize domain API journeys"
```

### Task 12: Mandatory Verification Registration And Integration Notes

**Files:**
- Modify: `scripts/verify.mjs`
- Modify: `scripts/verify.test.mjs`
- Create: `Docs/AgentPrompts/integration/evidence-risk-resource.md`

- [ ] **Step 1: Write failing orchestrator tests**

Require full verification to name the PostgreSQL domain, MinIO, API/OPA, and reservation concurrency JUnit files plus the process-level reservation race. Assert missing or skipped files fail strict full verification.

- [ ] **Step 2: Prove red**

Run: `npm run test:verify`

Expected: FAIL because new mandatory suites are not registered.

- [ ] **Step 3: Register suites and write integration contract**

Document workflow review input/output, notification intents, scanner protocol/configuration, V013-before-V014 ordering, V015 scanner reuse, event types, migration reconciliation, and exact cherry-pick order. Add strict suite paths to `integrationResults` and exact Gradle selectors.

- [ ] **Step 4: Prove green and commit**

Run: `npm run test:verify`

Expected: PASS.

```bash
git add scripts Docs/AgentPrompts/integration
git commit -m "test: require domain infrastructure verification"
```

### Task 13: Full Verification And Review Repair

**Files:**
- Modify only files implicated by failing tests or Critical/Important reviews.

- [ ] **Step 1: Run focused suites**

Run: `npm test`

Run: `npm run test:database:pglite`

Expected: both PASS; baseline authorization parity may skip only outside strict full mode.

- [ ] **Step 2: Run strict full verification**

Run: `$env:OPA_PATH='C:\Users\30367\AppData\Local\Temp\opencode\opa-1.5.1\opa_windows_amd64.exe'; npm run verify:full`

Expected: PASS with Docker, real PostgreSQL, MinIO, Kafka, OPA, and zero required skips.

- [ ] **Step 3: Request parallel specification and quality reviews**

Give reviewers the design, plan, branch diff from `8ba677f`, and exact full output. One reviewer checks acceptance/security/concurrency; one checks maintainability/data minimization/contracts. Fix every Critical/Important issue with a reproducing test first.

- [ ] **Step 4: Re-run strict full verification after repairs**

Run the exact Step 2 command.

Expected: PASS after the final code change.

- [ ] **Step 5: Commit review repairs**

```bash
git add services/core database packages/contracts policies scripts Docs/AgentPrompts/integration
git commit -m "fix(core): address evidence risk resource review"
```

- [ ] **Step 6: Record handoff evidence**

Capture branch, ordered commit SHAs, migration, API/event contracts, scanner/MinIO assumptions, exact test counts/results, residual risks, and agent-06 integration instructions in the final response.
