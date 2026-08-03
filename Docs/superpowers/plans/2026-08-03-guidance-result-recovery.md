# Guidance Result Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every validated guidance result recoverable from PostgreSQL or a deterministic encrypted Object-Locked envelope without a second provider call.

**Architecture:** Build one strict canonical recovery value after validation. Prefer the existing atomic PostgreSQL accounting/submission transaction, use the existing encrypted Object-Locked artifact store as the fallback channel and replay source, and gate Core dispatch on both prepared database state and ordinary trace artifact metadata.

**Tech Stack:** TypeScript, Vitest, PostgreSQL PL/pgSQL, AWS SDK S3/MinIO, Node.js test runner, Docker Compose.

---

### Task 1: Define and prove the deterministic recovery envelope

**Files:**
- Create: `services/ai/src/guidance/recovery-envelope.ts`
- Modify: `services/ai/test/guidance.test.ts`

- [ ] **Step 1: Write failing envelope tests**

Add tests that construct an envelope from canonical payload/accounting/artifact data, assert a key of `recovery/<runId>/<operationId>.json`, and reject extra fields, changed run/operation bindings, invalid hashes, negative accounting, or a changed body hash.

```ts
const recovery = createGuidanceRecoveryEnvelope({
  runId: ids.run, operationId: ids.run, invocationId: ids.invocation,
  payload, responseHash: hash("response"), providerRequestIdHash: hash("request"),
  inputTokens: 10, outputTokens: 5, cost: "3", latencyMs: 8,
  classification: "INTERNAL", artifact: { id: ids.artifact, objectKey, hash: artifactHash },
});
expect(recovery.objectKey).toBe(`recovery/${ids.run}/${ids.run}.json`);
expect(parseGuidanceRecoveryEnvelope(recovery.bytes, ids.run, ids.run)).toEqual(recovery.value);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm.cmd test --workspace @innorder/ai-service -- --run test/guidance.test.ts`

Expected: FAIL because the recovery envelope module does not exist.

- [ ] **Step 3: Implement strict canonical serialization and parsing**

Create exported `createGuidanceRecoveryEnvelope` and `parseGuidanceRecoveryEnvelope`. Use exact-key checks and the contracts output validator shape, represent cost as a decimal string, include `envelopeHash = sha256(canonical(bodyWithoutEnvelopeHash))`, and return canonical UTF-8 bytes plus their SHA-256. Never accept prompt text, provider body, or unvalidated fields.

```ts
export type GuidanceRecoveryEnvelope = Readonly<{
  version: 1; runId: string; operationId: string; invocationId: string;
  payload: Readonly<Record<string, unknown>>; responseHash: string;
  providerRequestIdHash: string | null; inputTokens: number; outputTokens: number;
  cost: string; latencyMs: number; classification: DataClassification;
  artifact: Readonly<{ id: string; objectKey: string; hash: string }>;
  envelopeHash: string;
}>;
```

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run: `npm.cmd test --workspace @innorder/ai-service -- --run test/guidance.test.ts`

Expected: all guidance tests pass.

### Task 2: Make the encrypted Object-Locked store replayable and idempotent

**Files:**
- Modify: `services/ai/src/object-store/minio-object-store.ts`
- Modify: `services/ai/test/guidance.test.ts`
- Modify: `services/ai/test/ingestion-container.test.mjs`

- [ ] **Step 1: Write failing object-store tests**

Cover verified retained reads and same-content upload replay. A `412 PreconditionFailed` must read the existing object and succeed only when its bytes match the expected hash. A recovery read must reject absent SSE-AES256, checksum, Governance Object Lock, one-year retention, wrong length, oversized data, or stream/hash mismatch.

```ts
await expect(store.upload(key, bytes, hash(bytes), signal)).resolves.toBeUndefined();
await expect(store.readRetained(key, signal)).resolves.toEqual(bytes);
expect(send.mock.calls.some(([command]) => command instanceof GetObjectCommand)).toBe(true);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm.cmd test --workspace @innorder/ai-service -- --run test/guidance.test.ts`

Expected: FAIL because `readRetained` and idempotent conflict handling are absent.

- [ ] **Step 3: Implement bounded retained reads and idempotent upload**

Add a shared bounded body reader. `readRetained` issues `GetObject` and `HeadObject`, checks the S3 checksum against returned bytes, and verifies SSE/Object Lock metadata. In `upload`, handle precondition conflicts by calling `readRetained` and comparing SHA-256 to `expectedHash`; retain conflict failure for different content.

- [ ] **Step 4: Extend real MinIO proof**

In `ingestion-container.test.mjs`, upload the same deterministic recovery key twice, read it through `readRetained`, and assert its version remains encrypted and Governance Object-Locked.

- [ ] **Step 5: Run service and MinIO tests and confirm GREEN**

Run: `npm.cmd test --workspace @innorder/ai-service -- --run test/guidance.test.ts`

Run: `node --test services/ai/test/ingestion-container.test.mjs`

Expected: both commands exit 0.

### Task 3: Retain deterministic artifact metadata in the atomic database preparation

**Files:**
- Modify: `database/migrations/V015__governed_ai_runtime.sql`
- Modify: `database/tests/schema-static.test.mjs`
- Modify: `database/tests/postgresql-governed-ai.test.mjs`
- Modify: `services/ai/src/guidance/guidance-repository.ts`
- Modify: `services/ai/test/guidance.test.ts`

- [ ] **Step 1: Write failing database and repository tests**

Extend preparation calls with artifact ID/key/hash. Assert one call both finalizes exact accounting and returns `PREPARED` with immutable artifact identity. Repeating exact input succeeds; changed accounting or artifact data fails and rolls back. Make `persist_run_artifact` idempotent for exact identity and reject conflicting retained metadata.

```sql
SELECT * FROM ai.prepare_guidance_recommendation_submission(
  run_id, operation_id, invocation_id, payload, response_hash, request_hash,
  10, 5, 3, 8, 'INTERNAL', artifact_id, artifact_key, artifact_hash
);
```

- [ ] **Step 2: Run static and real PostgreSQL tests and confirm RED**

Run: `npm.cmd run test:database`

Run: `node --test database/tests/postgresql-governed-ai.test.mjs`

Expected: FAIL because preparation does not retain artifact metadata and artifact persistence is not idempotent.

- [ ] **Step 3: Extend the table and bounded functions**

Add non-null `artifact_id`, `artifact_object_key`, and `artifact_hash` columns to `ai.recommendation_submission` with UUID/key/SHA constraints. Extend prepare/get return types and immutable replay checks. Change `persist_run_artifact` to `ON CONFLICT (id) DO NOTHING`, then select and compare all retained identity fields before returning.

- [ ] **Step 4: Extend repository types and calls**

Add artifact metadata to `PreparedRecommendationSubmission` and `completeProviderAndPrepare`, pass all SQL arguments, and strictly map returned rows.

```ts
artifact: { id: String(row.artifact_id), objectKey: String(row.artifact_object_key), hash: String(row.artifact_hash) }
```

- [ ] **Step 5: Run database and repository tests and confirm GREEN**

Run: `npm.cmd run test:database`

Run: `node --test database/tests/postgresql-governed-ai.test.mjs`

Run: `npm.cmd test --workspace @innorder/ai-service -- --run test/guidance.test.ts`

Expected: all commands exit 0.

### Task 4: Orchestrate database-first durability, fallback, and active replay

**Files:**
- Modify: `services/ai/src/guidance/guidance-runner.ts`
- Modify: `services/ai/test/guidance.test.ts`

- [ ] **Step 1: Write restart/replay failure tests**

Use a stateful harness whose database and object maps survive a new `GuidanceRunner`. Independently fail ordinary artifact upload, artifact metadata, database prepare, and bounded invocation finalize. Restart with `replayed: true` and prove exact response/request hashes, tokens, cost, timing, trace artifact/hash, one authoritative Core recommendation, and one provider call. Add a dual-channel failure test that expects `OCC-AI-RECONCILIATION-PENDING`, no Core call, and an exact finalization attempt.

```ts
expect(provider.chat).toHaveBeenCalledOnce();
expect(authoritativeRecommendations).toHaveLength(1);
expect(retainedAccounting).toEqual({ responseHash, providerRequestIdHash, inputTokens: 10, outputTokens: 5, cost: "3", latencyMs: 0 });
expect(retainedArtifact.hash).toBe(artifactHash);
```

- [ ] **Step 2: Run focused guidance tests and confirm RED**

Run: `npm.cmd test --workspace @innorder/ai-service -- --run test/guidance.test.ts`

Expected: replay with no submission does not probe recovery, and prepared replay dispatches before restoring artifact metadata.

- [ ] **Step 3: Implement database-first validated-result handling**

Immediately after validation, create deterministic artifact ID from run/operation/payload hash, trace bytes, exact accounting, and recovery envelope. Call `completeProviderAndPrepare` before ordinary artifact upload. On prepare failure, upload the recovery envelope with a non-aborted signal. If both fail, call `finalizeInvocation` with exact accounting and return pending.

- [ ] **Step 4: Implement active replay and dispatch gating**

For `RUNNING` replay, load prepared state. If absent, always call `readRetained(recoveryKey)` and strictly parse/import it through `completeProviderAndPrepare`. For every prepared state, idempotently upload the retained ordinary artifact bytes, persist matching metadata, and only then call `markSubmissionDispatched` and Core. Any unavailable boundary returns pending and retains the same deterministic identities.

- [ ] **Step 5: Run focused guidance tests and confirm GREEN**

Run: `npm.cmd test --workspace @innorder/ai-service -- --run test/guidance.test.ts`

Expected: all recovery matrix tests pass with zero second provider calls.

### Task 5: Run all gates and create the requested commit

**Files:**
- Verify all modified files above.

- [ ] **Step 1: Run formatting/static diff checks**

Run: `git diff --check`

Expected: no output, exit 0.

- [ ] **Step 2: Run the full verification gate**

Run: `npm.cmd run verify:full`

Expected: exit 0 with AI, contracts, PostgreSQL, PGlite, MinIO/Object Lock/ClamAV, OPA, Compose, and Electron gates passing.

- [ ] **Step 3: Inspect and commit only intended changes**

Run: `git status --short`, `git diff --stat`, `git diff -- database/migrations/V015__governed_ai_runtime.sql services/ai/src/guidance/guidance-runner.ts`

Run: `git add docs/superpowers/specs/2026-08-03-guidance-result-recovery-design.md docs/superpowers/plans/2026-08-03-guidance-result-recovery.md database/migrations/V015__governed_ai_runtime.sql database/tests/schema-static.test.mjs database/tests/postgresql-governed-ai.test.mjs services/ai/src/guidance/recovery-envelope.ts services/ai/src/guidance/guidance-repository.ts services/ai/src/guidance/guidance-runner.ts services/ai/src/object-store/minio-object-store.ts services/ai/test/guidance.test.ts services/ai/test/ingestion-container.test.mjs`

Run: `git commit -m "fix(ai): recover validated guidance results"`

Expected: one non-empty commit with the exact requested subject.

- [ ] **Step 4: Verify post-commit state**

Run: `git status --short --branch`, `git rev-parse HEAD`, `git show --stat --oneline --summary HEAD`

Expected: clean `feature/governed-ai-rag` worktree and the requested commit at `HEAD`.
