# Governed AI And RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify one authorization-first, cited participant-guidance path that fails closed and leaves deterministic Core workflows operational when AI is disabled or unavailable.

**Architecture:** Core creates every authoritative fact and emits operation IDs through the Outbox. AI consumes those IDs, claims a Core-signed single-use authorization grant over mTLS, performs provider calls and hybrid retrieval through narrowly bounded adapters, validates citations and injection boundaries, and submits only an informational recommendation to Core. V015 supplies a dedicated AI role, immutable grant sets, resumable jobs, traces, quality gates, and Kafka deduplication without changing prior migrations.

**Tech Stack:** Kotlin 2/Spring Boot 3/JdbcTemplate, TypeScript 5/Fastify 5/Zod 4, Node HTTPS/DNS/crypto, PostgreSQL 16/pgvector/Flyway, Kafka, MinIO quarantine, Vitest/Node test/JUnit/Testcontainers/OPA 1.5.1, Docker Compose.

---

## File Map

- `database/migrations/V016__governed_ai_runtime.sql`: governed-AI tables, functions, indexes, and grants.
- `database/bootstrap/001-create-runtime-role.sql`, `infra/compose/postgres/010-create-roles.sh`: pre-Flyway AI identity.
- `packages/contracts/src/governed-ai.ts`, `packages/contracts/src/events.ts`: strict wire/event schemas.
- `services/core/src/main/kotlin/com/innorder/occ/ai/*`: grant, administration, guidance, recommendation, and service-client boundary.
- `services/ai/src/security/*`: mTLS identity and grant validation.
- `services/ai/src/provider/*`: exact-origin transport, capability probe, limits, accounting.
- `services/ai/src/ingestion/*`: quarantine validation, deterministic extraction/chunking, resumable orchestration.
- `services/ai/src/retrieval/*`: authorization-filtered hybrid retrieval and trace validation.
- `services/ai/src/guidance/*`: immutable prompt rendering, structured output/citation validation, persistence workflow.
- `services/ai/src/events/*`: Kafka deduplication, retries, and DLQ state.
- `services/ai/src/persistence/*`, `services/ai/src/core/*`, `services/ai/src/object-store/*`: PostgreSQL, Core mTLS, and MinIO adapters plus the composition root.
- `infra/compose/provider-stub/*`: hostile and successful OpenAI-compatible test provider.
- `scripts/verify.mjs`: mandatory governed-AI full-suite result enforcement.

## Execution Waves

Wave 1 runs Tasks 1 and 3 in independent branches/worktrees. After both are reviewed and cherry-picked, Task 2 establishes shared contracts and exact npm dependencies, then Task 4 builds against them. Tasks 5-10 run in dependency order; their independent spec and code reviews may run in parallel.

### Task 1: Restore The Baseline Gate

**Files:**
- Modify: `services/core/build.gradle.kts`
- Modify: `scripts/verify.mjs`
- Modify: `scripts/verify.test.mjs`
- Test: `scripts/verify.test.mjs`

- [ ] **Step 1: Write the failing quick/full selection contract**

Add assertions that quick Gradle execution excludes `PlatformSecurityKernelIntegrationTest`, while strict full explicitly includes it. Add one dry-run line that prints only the strict environment key names, never values.

```js
assert.match(result.stdout, /-PexcludeStrictAuthz=true/u);
assert.match(full.stdout, /PlatformSecurityKernelIntegrationTest/u);
assert.match(full.stdout, /strict environment keys: OPA_PATH, INNORDER_STRICT_AUTHZ_TESTS/u);
```

- [ ] **Step 2: Prove the contract fails**

Run: `node --test scripts/verify.test.mjs`

Expected: FAIL because quick verification has no strict-test exclusion.

- [ ] **Step 3: Implement explicit Gradle selection**

Configure the normal `test` task to exclude only the strict class when `excludeStrictAuthz=true`, and pass that property on the ordinary build/test calls in `verify.mjs`. Keep the existing explicit full test invocation unchanged.

```kotlin
tasks.test {
    useJUnitPlatform()
    if (providers.gradleProperty("excludeStrictAuthz").orNull == "true") {
        exclude("**/PlatformSecurityKernelIntegrationTest.class")
    }
}
```

- [ ] **Step 4: Verify the baseline**

Run: `node --test scripts/verify.test.mjs`

Expected: all orchestrator tests pass.

Run: `npm run verify`

Expected: quick verification passes without requiring OPA.

- [ ] **Step 5: Commit**

```bash
git add services/core/build.gradle.kts scripts/verify.mjs scripts/verify.test.mjs
git commit -m "fix: isolate strict OPA integration gate"
```

### Task 2: Add Governed AI Contracts

**Files:**
- Create: `packages/contracts/src/governed-ai.ts`
- Modify: `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/openapi/occ-core.yaml`
- Modify: `services/ai/package.json`
- Modify: `package-lock.json`
- Create: `packages/contracts/test/governed-ai.test.ts`
- Create: `packages/contracts/test/openapi-governed-ai.test.ts`

- [ ] **Step 1: Write strict schema tests**

Cover exact fields, UUIDs, bounded strings/arrays, classification order, unknown-field rejection, `generatedContent: true`, one-or-more citations per guidance step, event payload versions, Problem Details, idempotency headers, expected versions, and cursor bounds.

```ts
expect(() => guidanceOutputSchema.parse({
  generatedContent: true,
  summary: "Inspect the evidence requirement.",
  steps: [{ text: "Compare the submitted trace.", citationRanks: [1] }],
  confidence: 0.8,
  citations: [{ rank: 1, retrievalHitId: UUID, excerptHash: HASH }],
})).not.toThrow();
expect(() => guidanceOutputSchema.parse({ generatedContent: true, summary: "x", steps: [], citations: [], extra: true })).toThrow();
```

- [ ] **Step 2: Prove schemas are absent**

Run: `npm test --workspace @innorder/contracts -- --run test/governed-ai.test.ts test/openapi-governed-ai.test.ts`

Expected: FAIL on missing module/OpenAPI paths.

- [ ] **Step 3: Implement the contracts**

Export strict Zod schemas for provider configuration/probe, knowledge upload/job/gate, guidance request/status, grant claims, recommendation output/review, and these event payloads: `knowledge.ingestion-requested.v1`, `ai.guidance-requested.v1`, `ai.recommendation-proposed.v1`, `ai.operation-dead-lettered.v1`.

Install and lock the runtime clients used by later tasks: `pg`, `kafkajs`, `jose`, `@aws-sdk/client-s3`, `pdfjs-dist`, `fflate`, and `saxes`, plus their required type packages. Run `npm install --cache C:\Users\30367\AppData\Local\Temp\opencode\npm-cache` so `package-lock.json` records exact official-registry artifacts.

```ts
export const dataClassificationSchema = z.enum(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]);
export const citationSchema = z.object({
  rank: z.number().int().min(1).max(50),
  retrievalHitId: uuidSchema,
  excerptHash: sha256Schema,
}).strict();
export const guidanceOutputSchema = z.object({
  generatedContent: z.literal(true),
  summary: z.string().min(1).max(2_000),
  steps: z.array(z.object({ text: z.string().min(1).max(2_000), citationRanks: z.array(z.number().int().min(1).max(50)).min(1).max(10) }).strict()).min(1).max(20),
  confidence: z.number().min(0).max(1),
  citations: z.array(citationSchema).min(1).max(50),
}).strict();
```

- [ ] **Step 4: Verify and commit**

Run: `npm test --workspace @innorder/contracts`

Expected: all contract tests pass.

```bash
git add packages/contracts services/ai/package.json package-lock.json
git commit -m "feat(contracts): define governed AI APIs and events"
```

### Task 3: Add V015 And The AI Runtime Identity

**Files:**
- Create: `database/migrations/V016__governed_ai_runtime.sql`
- Modify: `database/bootstrap/001-create-runtime-role.sql`
- Modify: `database/innorder_occ_full_schema.sql`
- Modify: `database/tests/schema-static.test.mjs`
- Modify: `database/tests/pglite-smoke.mjs`
- Create: `database/tests/postgresql-governed-ai.test.mjs`
- Modify: `infra/compose/postgres/010-create-roles.sh`
- Modify: `services/core/src/test/resources/postgres-test-init.sql`

- [ ] **Step 1: Write failing schema and real-role tests**

Assert migration ordering, required tables/indexes/checks, fixed-search-path security-definer functions, revoked PUBLIC execution, explicit AI grants, denied `iam/authz/occ/audit/outbox/recommendation` reads/writes, atomic grant replay rejection, authorization-filtered retrieval, worker lease reclaim, gate manifest checks, and event deduplication.

```js
await assert.rejects(ai.query("select * from iam.principal"), /permission denied/u);
await assert.rejects(ai.query("update ai.recommendation set status='ACCEPTED'"), /permission denied/u);
const first = await ai.query("select * from ai.consume_authorization_grant($1,$2,$3)", [tokenHash, eventId, runId]);
assert.equal(first.rowCount, 1);
await assert.rejects(ai.query("select * from ai.consume_authorization_grant($1,$2,$3)", [tokenHash, otherEventId, otherRunId]), /grant unavailable/u);
```

- [ ] **Step 2: Prove tests fail**

Run: `npm run test:database`

Expected: FAIL because V015 and the AI role are absent.

- [ ] **Step 3: Implement V015**

Create the grant/header/authorized-document, ingestion job/attempt, event consumption, model invocation, retrieval trace/hit, gate-result, retention-policy, and legal-hold tables from the design. Add deterministic claim/consume/retrieval/activation-evidence functions with `SECURITY DEFINER SET search_path = pg_catalog, authz, ai, platform`. Grant only named tables/sequences/functions to `innorder_ai_runtime`; revoke all function execution from PUBLIC first. PGlite applies the table/function subset through the same migration preprocessing used for pgvector, while real PostgreSQL remains mandatory for role, privilege, HNSW, and race behavior.

```sql
REVOKE ALL ON SCHEMA iam, authz, catalog, occ, audit, flowable FROM innorder_ai_runtime;
GRANT USAGE ON SCHEMA ai TO innorder_ai_runtime;
GRANT SELECT ON ai.model_provider, ai.model_profile, ai.prompt_template_version,
    ai.agent_definition_version, ai.knowledge_document_version, ai.knowledge_chunk,
    ai.embedding_space TO innorder_ai_runtime;
```

Create the idempotent `NOLOGIN` role only in `database/bootstrap/001-create-runtime-role.sql`. Compose converts/provisions it as `LOGIN` with a file-backed password in `infra/compose/postgres/010-create-roles.sh`. V015 assumes the role exists and never executes `CREATE ROLE` because Flyway has `NOCREATEROLE`.

- [ ] **Step 4: Verify static and real PostgreSQL behavior**

Run: `npm run test:database`

Expected: all static tests pass.

Run: `node --test database/tests/postgresql-governed-ai.test.mjs`

Expected: real pgvector suite passes with no skips when Docker is available.

- [ ] **Step 5: Commit**

```bash
git add database infra/compose/postgres/010-create-roles.sh services/core/src/test/resources/postgres-test-init.sql
git commit -m "feat(database): add governed AI runtime boundary"
```

### Task 4: Build The Secure OpenAI-Compatible Adapter

**Files:**
- Create: `services/ai/src/provider/provider-policy.ts`
- Create: `services/ai/src/provider/secure-transport.ts`
- Create: `services/ai/src/provider/openai-compatible.ts`
- Create: `services/ai/src/provider/rate-limiter.ts`
- Create: `services/ai/src/provider/retry-policy.ts`
- Create: `services/ai/src/provider/accounting.ts`
- Create: `services/ai/src/provider/credential-reader.ts`
- Create: `services/ai/test/provider-policy.test.ts`
- Create: `services/ai/test/provider-stub.test.ts`

- [ ] **Step 1: Write hostile transport tests**

Use injected DNS and socket factories plus local HTTPS fixtures to cover exact origin/prefix, all forbidden IPv4/IPv6 ranges, approved CIDRs, all-address validation, rebinding, TLS SNI, cross-origin and same-origin redirects, encoded traversal, credential forwarding, byte limits, malformed JSON, timeout, AbortSignal, capability mismatch, concurrency/token buckets, and sanitized telemetry. Retry only connection failures before request-body dispatch and explicit 429/502/503 responses with fully consumed bounded bodies, at most two retries with 100/500 ms backoff inside the original total deadline. Never retry timeout, cancellation, TLS failure, malformed output, or an ambiguous socket failure after body dispatch.

```ts
await expect(policy.resolve("https://provider.example/v1/chat/completions", dnsReturning("169.254.169.254"))).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-ADDRESS" });
expect(stub.receivedHeaders()).not.toHaveProperty("authorization");
await expect(adapter.chat(request, AbortSignal.timeout(10))).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-TIMEOUT" });
```

- [ ] **Step 2: Prove tests fail**

Run: `npm test --workspace @innorder/ai-service -- --run test/provider-policy.test.ts test/provider-stub.test.ts`

Expected: FAIL on missing provider modules.

- [ ] **Step 3: Implement the adapter**

Use `dns.promises.lookup({all:true, verbatim:true})`, `https.request` with a lookup callback pinned to one validated address and `servername` set to the configured hostname, `maxRedirects=0` behavior by rejecting every 3xx, bounded body collection, and one total AbortSignal. Read credentials only from a bounded regular file immediately before dispatch. Probe models plus minimal chat/embedding requests and persist normalized capability data through an injected repository.

```ts
export interface ProviderTransport {
  request(input: { origin: URL; path: string; method: "GET" | "POST"; headers: Readonly<Record<string,string>>; body?: Uint8Array; signal: AbortSignal }): Promise<{ status: number; headers: Readonly<Record<string,string>>; body: Uint8Array }>;
}
export interface OpenAiCompatibleProvider {
  probe(signal: AbortSignal): Promise<CapabilitySnapshot>;
  chat(input: ChatRequest, signal: AbortSignal): Promise<ChatResult>;
  embed(input: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResult>;
}
```

- [ ] **Step 4: Verify and commit**

Run: `npm test --workspace @innorder/ai-service -- --run test/provider-policy.test.ts test/provider-stub.test.ts`

Expected: all provider tests pass.

```bash
git add services/ai/src/provider services/ai/test/provider-policy.test.ts services/ai/test/provider-stub.test.ts
git commit -m "feat(ai): add constrained OpenAI-compatible provider"
```

### Task 5: Implement Core Grants And Service Identity

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/ai/AiGrantService.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/ai/AiGrantTokenService.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/ai/AiServiceSecurityConfiguration.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/ai/AiServiceController.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/ai/AiServiceClient.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/ai/AiGrantIntegrationTest.kt`
- Create: `services/ai/src/security/grant-verifier.ts`
- Create: `services/ai/src/security/service-identity.ts`
- Create: `services/ai/src/core/core-client.ts`
- Create: `services/ai/src/persistence/postgres.ts`
- Create: `services/ai/src/composition-root.ts`
- Modify: `services/ai/src/app.ts`
- Modify: `services/ai/src/config.ts`
- Modify: `services/ai/src/server.ts`
- Modify: `services/core/src/main/resources/application.yml`
- Create: `services/ai/test/service-security.test.ts`

- [ ] **Step 1: Write failing grant and identity tests**

Cover exact JWT claims, five-minute maximum, separate audience/type, token hash persistence, 500-ID rejection, context digest, stale revision, expiry, replay races, wrong certificate identity/EKU/SAN/issuer, end-user bearer rejection, rotation overlap, revocation, and secret-free logs.

- [ ] **Step 2: Prove tests fail**

Run: `gradlew.bat :services:core:test --tests "com.innorder.occ.ai.*" --dependency-verification strict`

Run: `npm test --workspace @innorder/ai-service -- --run test/service-security.test.ts`

Expected: both fail because grant/service identity components are absent.

- [ ] **Step 3: Implement the boundary**

Reuse RSA key-strength and strict JWT parsing patterns without reusing end-user token settings. Configure HTTPS listeners and outbound clients from bounded key/cert/trust files, require peer certificates on every service route, and map the verified URI SAN `spiffe://innorder/core` or `spiffe://innorder/ai` to one fixed service identity. AI business hooks reject `Authorization` headers before route handling. Core's client implements grant claim, AI status, and cancellation; AI's client implements recommendation and ingestion/probe outcome submission. The composition root owns PostgreSQL pools, clients, routes, and shutdown.

```kotlin
data class AiGrantClaims(val jti: UUID, val operationId: UUID, val principalId: UUID,
    val targetId: UUID, val purpose: String, val authorizationRevision: Long,
    val releaseDigest: String, val authorizedSetDigest: String, val contextDigest: String,
    val classificationCeiling: String, val expiresAt: Instant)
```

- [ ] **Step 4: Verify and commit**

Run both focused commands from Step 2.

Expected: all focused tests pass.

```bash
git add services/core/src/main/kotlin/com/innorder/occ/ai services/core/src/test/kotlin/com/innorder/occ/ai services/core/src/main/resources/application.yml services/ai/src/security services/ai/src/core services/ai/src/persistence services/ai/src/composition-root.ts services/ai/src/app.ts services/ai/src/config.ts services/ai/src/server.ts services/ai/test/service-security.test.ts
git commit -m "feat: enforce Core AI service grants"
```

### Task 6: Implement Quarantined Ingestion And Cutover

**Files:**
- Create: `services/ai/src/ingestion/document-policy.ts`
- Create: `services/ai/src/ingestion/malware-scanner.ts`
- Create: `services/ai/src/ingestion/parser.ts`
- Create: `services/ai/src/ingestion/parser-worker.ts`
- Create: `services/ai/src/ingestion/chunker.ts`
- Create: `services/ai/src/ingestion/ingestion-worker.ts`
- Create: `services/ai/src/object-store/minio-object-store.ts`
- Create: `services/ai/parser.Dockerfile`
- Create: `infra/compose/parser-seccomp.json`
- Create: `services/ai/test/fixtures/ingestion/*`
- Create: `services/ai/test/ingestion.test.ts`
- Create: `services/ai/src/evaluation/evaluation-runner.ts`
- Create: `services/ai/src/evaluation/evaluation-repository.ts`
- Create: `services/ai/test/evaluation.test.ts`
- Create: `services/core/src/main/kotlin/com/innorder/occ/ai/KnowledgeCommandService.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/ai/KnowledgeCommandIntegrationTest.kt`

- [ ] **Step 1: Write deterministic and hostile fixture tests**

Cover text/Markdown/PDF/DOCX/XLSX golden extraction, stable hashes/chunks, malware/polyglot/archive/active-content rejection, scanner-before-parser ordering, parser time/memory/entry bounds, checkpoints, lease reclaim, failed-build isolation, manifest races, and Core-owned activation/rollback. Evaluation tests use at least 20 versioned cases and verify coverage, zero leakage, per-case and micro citation precision, macro recall at 10, empty denominators, every threshold failure, adversarial expected outcomes, persisted numerator/denominator evidence, and manifest binding.

- [ ] **Step 2: Prove tests fail**

Run: `npm test --workspace @innorder/ai-service -- --run test/ingestion.test.ts`

Expected: FAIL on missing ingestion modules.

Run: `npm test --workspace @innorder/ai-service -- --run test/evaluation.test.ts`

Expected: FAIL on missing evaluation modules.

Run: `gradlew.bat :services:core:test --tests "com.innorder.occ.ai.KnowledgeCommandIntegrationTest" --dependency-verification strict`

Expected: FAIL because the activation command is absent.

- [ ] **Step 3: Implement the minimal supported parsers and worker**

Define one parser result and one versioned chunking algorithm. Treat extracted text as data, mark instruction-like spans, and checkpoint every durable stage. Quarantine objects are accessed through the S3 adapter; a clamd-compatible adapter scans before a job becomes parseable. The parser sidecar polls a shared request/result directory while attached to no network, running non-root with read-only input, disposable output, seccomp, no-new-privileges, one CPU, 512 MiB memory, and the documented timeout/entry/expanded-byte limits. Implement the evaluation runner with `coverage = embeddedEligible / eligible`, zero unauthorized hits, micro citation precision `sum(supported) / sum(total)`, and macro recall at 10 `sum(perCaseRecall) / caseCount`; reject every empty denominator and require `1.0`, `0`, `0.95`, and `0.85` respectively. Persist every numerator, denominator, case result, dataset/content hash, corpus manifest, expected ACTIVE space, and final decision before Core activation. Core activation locks candidate/current rows and compares the complete corpus manifest before changing heads.

```ts
export type ParsedDocument = Readonly<{ text: string; regions: readonly { start: number; end: number; source: string; injectionMarked: boolean }[]; parserVersion: string }>;
export type Chunk = Readonly<{ ordinal: number; content: string; contentHash: string; tokenCount: number; metadata: Readonly<Record<string, unknown>> }>;
```

- [ ] **Step 4: Verify and commit**

Run: `npm test --workspace @innorder/ai-service -- --run test/ingestion.test.ts test/evaluation.test.ts`

Run: `gradlew.bat :services:core:test --tests "com.innorder.occ.ai.KnowledgeCommandIntegrationTest" --dependency-verification strict`

Expected: all focused tests pass.

```bash
git add services/ai/src/ingestion services/ai/src/object-store services/ai/src/evaluation services/ai/parser.Dockerfile services/ai/test/ingestion.test.ts services/ai/test/evaluation.test.ts services/ai/test/fixtures/ingestion infra/compose/parser-seccomp.json services/core/src/main/kotlin/com/innorder/occ/ai/KnowledgeCommandService.kt services/core/src/test/kotlin/com/innorder/occ/ai/KnowledgeCommandIntegrationTest.kt
git commit -m "feat(ai): add governed knowledge ingestion"
```

### Task 7: Implement Authorization-First Retrieval And Guidance

**Files:**
- Create: `services/ai/src/retrieval/hybrid-retriever.ts`
- Create: `services/ai/src/retrieval/postgres-retrieval-repository.ts`
- Create: `services/ai/src/guidance/output-validator.ts`
- Create: `services/ai/src/guidance/guidance-runner.ts`
- Create: `services/ai/test/retrieval.test.ts`
- Create: `services/ai/test/guidance.test.ts`

- [ ] **Step 1: Write failing retrieval/guidance tests**

Use real pgvector for authorized lexical/vector/fused ranking and prove an unauthorized high-score chunk never enters candidates/traces. Cover classification ceiling/provider policy, empty sets, stale grants, prompt injection fixtures, immutable prompt/schema hashes, malformed/uncited/duplicate/foreign citations, excerpt hashes, generated-content label, accounting, cancellation, and persisted run/invocation/retrieval/artifact/evaluation trace.

- [ ] **Step 2: Prove tests fail**

Run: `npm test --workspace @innorder/ai-service -- --run test/retrieval.test.ts test/guidance.test.ts`

Expected: FAIL on missing modules.

- [ ] **Step 3: Implement retrieval and validation**

Call only the V015 retrieval function with the consumed grant's run ID; perform reciprocal-rank fusion with deterministic UUID tie-breaking. Render retrieved blocks inside fixed delimiters and validate every output citation against stored hits before persistence/submission.

```ts
export interface GuidanceRunner {
  run(input: Readonly<{ operationId: string; grantToken: string }>, signal: AbortSignal): Promise<Readonly<{ runId: string; recommendationId: string }>>;
}
```

- [ ] **Step 4: Verify and commit**

Run: `npm test --workspace @innorder/ai-service -- --run test/retrieval.test.ts test/guidance.test.ts`

Run: `node --test database/tests/postgresql-governed-ai.test.mjs`

Expected: all tests pass with zero skipped real-pgvector cases.

```bash
git add services/ai/src/retrieval services/ai/src/guidance services/ai/test/retrieval.test.ts services/ai/test/guidance.test.ts
git commit -m "feat(ai): produce authorized cited guidance"
```

### Task 8: Add Core Administration And Recommendation Commands

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/ai/AiAdministrationController.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/ai/GuidanceController.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/ai/RecommendationController.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/ai/RecommendationCommand.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/ai/RecommendationCommandRepository.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/ai/AiApiIntegrationTest.kt`

- [ ] **Step 1: Write failing API/command tests**

Cover provider/profile/probe, upload/status/activate/rollback, guidance request/status, recommendation list/detail/review, exact OpenAPI shapes, every mutation's idempotency key, update expected version, OPA deny/error, current read authorization/redaction, service-only submission, citation FKs, stale display, and acceptance as fresh `ReviewRecommendationCommand` without workflow mutation.

- [ ] **Step 2: Prove tests fail**

Run: `gradlew.bat :services:core:test --tests "com.innorder.occ.ai.AiApiIntegrationTest" --dependency-verification strict`

Expected: FAIL because routes/commands are absent.

- [ ] **Step 3: Implement through existing command boundary**

Each mutation implements `AuthorizedCommand`; `CommandExecutor` remains the only transaction path. Service submission validates mTLS identity and persisted run/citations. List/detail queries authorize each target under the current snapshot before returning content.

```kotlin
class ReviewRecommendationCommand(
    override val aggregateId: UUID,
    override val entityId: UUID,
    private val reviewStatus: String,
) : AuthorizedCommand {
    override val action = "ai.recommendation.review"
    override val resourceId = aggregateId
    override val aggregateType = "AI_RECOMMENDATION"
    override val expectedVersionRequired = true
    override val changesAuthorizationFacts = false
    override fun lockCurrentVersion(context: CommandContext): Long? = context.jdbc.queryForObject(
        "SELECT row_version FROM ai.recommendation WHERE id = ? FOR UPDATE", Long::class.java, aggregateId,
    )
    override fun execute(context: CommandContext): CommandMutation =
        RecommendationCommandRepository(context.jdbc).review(context, aggregateId, reviewStatus)
}
```

`RecommendationCommandRepository.review` performs the single versioned update, creates the response/audit canonical JSON, and returns a `CommandMutation` containing `ai.recommendation-reviewed.v1`; it never calls Flowable or updates an OCC aggregate.

- [ ] **Step 4: Verify and commit**

Run focused Core tests and contract OpenAPI tests.

Expected: all pass.

```bash
git add services/core/src/main/kotlin/com/innorder/occ/ai services/core/src/test/kotlin/com/innorder/occ/ai packages/contracts/openapi/occ-core.yaml
git commit -m "feat(core): govern AI administration and recommendations"
```

### Task 9: Add Kafka Idempotency, DLQ, And Deterministic Degradation

**Files:**
- Create: `services/ai/src/events/event-consumer.ts`
- Create: `services/ai/src/events/event-repository.ts`
- Create: `services/ai/src/events/retry-policy.ts`
- Create: `services/ai/test/event-consumer.test.ts`
- Create: `services/ai/src/retention/retention-worker.ts`
- Create: `services/ai/test/retention.test.ts`
- Modify: `services/ai/src/app.ts`
- Modify: `services/ai/src/config.ts`
- Create: `services/core/src/main/kotlin/com/innorder/occ/ai/AiAvailabilityService.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/ai/GuidanceController.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/ai/RecommendationController.kt`
- Modify: `services/core/src/main/resources/application.yml`
- Create: `services/core/src/test/kotlin/com/innorder/occ/ai/AiDisabledIntegrationTest.kt`

- [ ] **Step 1: Write failing replay/DLQ/degradation tests**

Cover stable event ID, aggregate ordering, duplicate delivery before/after acknowledgement, crash after grant consumption, bounded retry schedule, terminal DLQ, operator replay, disabled flag, AI/Kafka/provider outage, stale presentation, recovery without automatic resubmission, and unaffected deterministic Core commands. Retention tests keep traces/recommendations/citations/evaluations for one year, preserve every held record/object, delete successful quarantine objects immediately after activation, delete terminal-failure quarantine after 30 days, and never persist transient provider bodies.

- [ ] **Step 2: Prove tests fail**

Run: `npm test --workspace @innorder/ai-service -- --run test/event-consumer.test.ts test/retention.test.ts`

Run: `gradlew.bat :services:core:test --tests "com.innorder.occ.ai.AiDisabledIntegrationTest" --dependency-verification strict`

Expected: FAIL because consumer/degradation behavior is absent.

- [ ] **Step 3: Implement durable event state**

Claim using V015 leases, persist terminal failures before broker acknowledgement, and use operation/run IDs for idempotent resume. The retention worker selects only expired, non-held facts and invokes object deletion after committing a durable deletion claim. Core's `AiAvailabilityService` combines the enabled flag, bounded AI readiness, Kafka delivery, and provider capability state. Disabled or persistently unavailable AI produces no AI Outbox event, hides new recommendation actions, and marks existing recommendations stale; unrelated `CommandExecutor` workflows remain unchanged. `AI_ENABLED=false` does not initialize provider/Kafka workers and reports a typed `DISABLED` component state without changing `/health` liveness.

```ts
export const retryDelaysMs = [1_000, 5_000, 30_000, 120_000, 600_000] as const;
export type EventOutcome = "ACK_DUPLICATE" | "ACK_COMPLETED" | "RETRY" | "DEAD";
```

- [ ] **Step 4: Verify and commit**

Run: `npm test --workspace @innorder/ai-service -- --run test/event-consumer.test.ts test/retention.test.ts`

Run: `gradlew.bat :services:core:test --tests "com.innorder.occ.ai.AiDisabledIntegrationTest" --dependency-verification strict`

Expected: all pass.

```bash
git add services/ai/src/events services/ai/src/retention services/ai/test/event-consumer.test.ts services/ai/test/retention.test.ts services/ai/src/app.ts services/ai/src/config.ts services/core/src/main/kotlin/com/innorder/occ/ai/AiAvailabilityService.kt services/core/src/main/kotlin/com/innorder/occ/ai/GuidanceController.kt services/core/src/main/kotlin/com/innorder/occ/ai/RecommendationController.kt services/core/src/main/resources/application.yml services/core/src/test/kotlin/com/innorder/occ/ai/AiDisabledIntegrationTest.kt
git commit -m "feat(ai): make asynchronous guidance idempotent"
```

### Task 10: Wire Deployment And Mandatory Acceptance

**Files:**
- Modify: `infra/compose/compose.yml`
- Modify: `infra/compose/.env.example`
- Modify: `infra/compose/compose.contract.test.mjs`
- Create: `infra/compose/provider-stub/Dockerfile`
- Create: `infra/compose/provider-stub/server.mjs`
- Create: `infra/compose/governed-ai.acceptance.test.mjs`
- Create: `infra/compose/governed-ai.restore.test.mjs`
- Modify: `services/ai/Dockerfile`
- Modify: `services/ai/src/server.ts`
- Modify: `services/core/src/main/resources/application.yml`
- Modify: `scripts/verify.mjs`
- Modify: `scripts/verify.test.mjs`
- Modify: `Docs/Deployment/03-secrets-and-configuration.md`
- Modify: `Docs/Deployment/06-daily-operations-and-monitoring.md`
- Modify: `Docs/Deployment/07-backup-restore-and-dr.md`

- [ ] **Step 1: Write failing Compose/full-gate contracts**

Require separate Core/AI DB secrets, provider credential file, mTLS key/cert/trust files, fixed identities, AI-only egress, internal business routes, non-root parser limits, provider stub, AI enabled/disabled profiles, rotation/revocation fixtures, real pgvector/OPA/Kafka/Core/AI acceptance, structured result file, and no-skips enforcement. Add the official ClamAV 1.4.3 image pinned to the exact multi-arch digest resolved by `docker buildx imagetools inspect clamav/clamav:1.4.3`, an internal-only clamd socket, persistent signatures, `freshclam` updates, and a health check that fails when signatures are unavailable or stale.

- [ ] **Step 2: Prove deployment contracts fail**

Run: `npm run test:infra`

Run: `node --test scripts/verify.test.mjs`

Expected: FAIL because governed-AI topology and mandatory suite are absent.

- [ ] **Step 3: Wire services and full verification**

Mount every credential read-only from Compose secrets, give AI a distinct DB URL/user, configure HTTPS listeners and trust bundles, add the networkless parser sidecar with its shared request/result volumes and resource/security limits, and attach only AI/provider-stub to the egress test network. The acceptance runner writes `build/test-results/governed-ai/acceptance.json` with unique stable case IDs, status, duration, and sanitized evidence; `verify:full` rejects a missing, duplicate, unknown, skipped, or failing required ID. The restore runner stops the provider stub, restores database/object backups, and proves citation/trace integrity plus retrieval readiness without a provider call.

```js
const required = new Set([
  "authorized-cited-recommendation", "unauthorized-document-denied", "stale-grant-denied",
  "grant-replay-denied", "prompt-injection-denied", "uncited-output-denied",
  "malformed-output-denied", "capability-mismatch-denied", "provider-ssrf-denied",
  "provider-timeout-denied", "provider-failure-denied", "malware-infected-denied",
  "malware-signature-unavailable-denied", "embedding-build-rollback", "kafka-replay-idempotent",
  "kafka-terminal-dlq", "fresh-human-review-command", "ai-disabled-workflow",
  "mtls-wrong-identity-denied", "mtls-rotation-overlap", "provider-free-restore",
]);
assert.deepEqual(new Set(result.cases.map(({ id }) => id)), required);
assert.ok(result.cases.every(({ status }) => status === "PASSED"));
```

- [ ] **Step 4: Run focused acceptance**

Run: `npm run test:infra`

Run: `node infra/compose/governed-ai.acceptance.test.mjs`

Run: `node infra/compose/governed-ai.restore.test.mjs`

Expected: authorized recommendation and full trace pass; unauthorized/stale/injected/uncited/provider/build/replay cases fail closed; disabled Core workflow passes.

- [ ] **Step 5: Run repository gates**

Run: `npm run verify`

Expected: quick verification passes.

Run: `npm run verify:full`

Expected: Docker, OPA 1.5.1, real PostgreSQL/pgvector, Kafka, Core/AI/provider-stub, security evaluation, and all mandatory structured results pass with zero skips/failures.

- [ ] **Step 6: Commit**

```bash
git add infra services/ai/Dockerfile services/ai/src/server.ts services/core/src/main/resources/application.yml scripts Docs/Deployment
git commit -m "test: verify governed AI deployment paths"
```

### Task 11: Independent Reviews And Handoff

**Files:**
- Create: `Docs/superpowers/reviews/2026-08-01-governed-ai-rag-review.md`
- Create: `Docs/Integration/governed-ai-rag-handoff.md`

- [ ] **Step 1: Dispatch independent spec and code reviews in parallel**

One reviewer maps every prompt/design acceptance item to executable evidence. A separate reviewer inspects authorization, grant races, SQL privileges, SSRF/DNS/TLS, credential handling, parser sandbox, injection/citation validation, Kafka idempotency, and AI non-authority. Record file/line findings and commands, not assurances.

- [ ] **Step 2: Fix every high/medium finding with TDD**

For each finding, add a focused failing regression test, run it to observe failure, make the smallest correction, and rerun the owning suite. Record low-severity deferrals only when they are outside the delegated provider scope.

- [ ] **Step 3: Rerun final gates**

Run: `npm run verify`

Run: `npm run verify:full`

Expected: both pass; full has zero mandatory skips/failures.

- [ ] **Step 4: Write integration handoff**

Record branch and commit SHAs, V015 behavior, Core APIs/events, provider exact-origin/prefix/CIDR/secret configuration, evaluation formulas and observed metrics, all test counts/results, deferred provider features, migration/secret/certificate steps, and cherry-pick order for agent 06.

- [ ] **Step 5: Commit**

```bash
git add Docs/superpowers/reviews/2026-08-01-governed-ai-rag-review.md Docs/Integration/governed-ai-rag-handoff.md
git commit -m "docs: hand off governed AI RAG integration"
```
