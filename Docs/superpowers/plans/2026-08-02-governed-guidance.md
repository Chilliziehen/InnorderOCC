# Governed Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce authorized, immutable, fully cited participant guidance without exposing a public start route.

**Architecture:** A PostgreSQL retrieval repository invokes only V015 bounded functions and returns immutable persisted hit identities. A hybrid retriever embeds with the grant-bound space, validates classification, and persists a deterministic trace. A guidance runner validates the exact run configuration, builds a bounded immutable prompt, invokes the provider, validates citations, stores a canonical artifact, submits a bounded recommendation to Core, and transitions the run terminally.

**Tech Stack:** TypeScript, Vitest, PostgreSQL/pgvector, Zod contracts, OpenAI-compatible provider adapter, S3-compatible object storage.

---

### Task 1: Authorized Retrieval

**Files:**
- Create: `services/ai/test/retrieval.test.ts`
- Create: `services/ai/src/retrieval/postgres-retrieval-repository.ts`
- Create: `services/ai/src/retrieval/hybrid-retriever.ts`

- [x] Write tests proving bounds, exact embedding dimensions/profile, deterministic ranks, classification denial, empty-result denial, V015-only SQL, and persisted trace/hit identity.
- [x] Run `npm test --workspace @innorder/ai-service -- --run test/retrieval.test.ts` and verify missing-module failure.
- [x] Implement the smallest repository and retriever satisfying those tests.
- [x] Re-run the focused test and verify it passes.

### Task 2: Strict Guidance Validation and Prompting

**Files:**
- Create: `services/ai/test/guidance.test.ts`
- Create: `services/ai/src/guidance/output-validator.ts`
- Create: `services/ai/src/guidance/prompt-builder.ts`

- [x] Write tests for strict contract parsing, exact same-run citation identities/hashes, duplicate/foreign/stale citations, step citation coverage, marked and multilingual semantic injection, delimiter escaping, canonical 32 KiB task context, and provider input bounds.
- [x] Run the focused guidance test and verify missing-module failure.
- [x] Implement canonical prompt construction and output validation with stable sanitized errors.
- [x] Re-run the focused test and verify it passes.

### Task 3: Guidance Orchestration

**Files:**
- Create: `services/ai/src/guidance/guidance-repository.ts`
- Create: `services/ai/src/guidance/guidance-runner.ts`
- Modify: `services/ai/test/guidance.test.ts`

- [x] Add failing tests for exact immutable configuration, no-provider precondition failures, invocation accounting, artifact persistence, Core submission ordering, failure/cancellation transitions, and terminal replay without a second provider call.
- [x] Implement V015-only invocation/artifact/run persistence and the fail-closed runner.
- [x] Re-run focused tests and verify all cases pass.

### Task 4: Core and Artifact Boundaries

**Files:**
- Modify: `services/ai/src/core/core-client.ts`
- Modify: `services/ai/src/object-store/minio-object-store.ts`
- Modify: `services/ai/test/guidance.test.ts`

- [x] Add failing hostile/success Core and artifact integrity tests.
- [x] Implement strict recommendation submission and a non-quarantine encrypted trace object store factory.
- [x] Re-run focused tests and verify all cases pass.

### Task 5: Composition and Real PostgreSQL

**Files:**
- Modify: `services/ai/src/composition-root.ts`
- Modify: `services/ai/test/postgres-real.test.ts`

- [x] Add a real pgvector test with an unauthorized highest-scoring chunk and a fully persisted authorized trace.
- [x] Wire a runner factory into the composition root without an HTTP controller or Kafka trigger.
- [ ] Run AI focused/full tests, contracts, builds, database checks, provenance, audit, and `verify:full`. All component gates passed; `verify:full` requires a native Windows OPA executable for the Core host-process integration, and the official asset download was blocked.
- [x] Review the diff for direct runtime DML, secret logging, raw provider response persistence, public routes, and unrelated changes.
- [ ] Commit with `feat(ai): produce authorized cited guidance`.
