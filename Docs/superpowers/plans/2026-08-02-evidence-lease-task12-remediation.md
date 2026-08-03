# Evidence Lease And Task12 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close authorization ordering, lease fencing, deterministic failed-command replay, conditional review, contract-code, and full-verification selection gaps.

**Architecture:** Keep authorization read-only and ahead of mutation, then combine content identity binding and lease acquisition under one row lock. Fence every worker mutation with `(session, owner, prior phase)`, maintain leases from a bounded scheduled heartbeat guard, and return the persisted terminal command result on first execution and replay. Extend strict full verification with explicit Gradle selectors and mandatory JUnit result checks.

**Tech Stack:** Kotlin/JDK 21, Spring JDBC transactions, PostgreSQL 16, MinIO, OPA, JUnit/Testcontainers, Node.js verification orchestration.

---

### Task 1: Authorized Atomic PUT Claim

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceService.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceRepository.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceServiceIntegrationTest.kt`

- [ ] Add an attacker-prebinding test that snapshots session provenance and proves denied PUT changes no column, audit, outbox, or idempotency row.
- [ ] Run the focused test red because content identity currently binds before OPA authorization.
- [ ] Perform read-only session/uploader/version checks and authorization first; atomically bind descriptor and acquire/replay under one row lock.
- [ ] Run the focused test green.

### Task 2: Continuous Fenced Lease Ownership

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceService.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceRepository.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceServiceIntegrationTest.kt`

- [ ] Add red tests for parser/scanner work longer than one lease interval, reclaim during blocked work, and stale old-worker terminal/failure attempts.
- [ ] Add a bounded daemon scheduled heartbeat guard and configurable test durations.
- [ ] Predicate STREAMING-to-INSPECTING, SCANNING, PROMOTING, confirmation, failure, and heartbeat writes on owner and expected phase.
- [ ] Treat ownership loss as fail-closed without terminal mutation from the stale worker.
- [ ] Run lease race tests green.

### Task 3: Review, Replay, And Problem Contracts

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceRepository.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceService.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/api/OccProblem.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceServiceIntegrationTest.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceProblemMappingTest.kt`

- [ ] Add red tests proving conditional state is always REJECTED while workflow gate can advance.
- [ ] Add red tests proving first and repeated 413/422 calls return identical status/body with only replay changing.
- [ ] Change failure handling to return the stored command result and replay it through `CommandExecutor`.
- [ ] Replace uncommitted evidence request/not-found codes with `OCC-INVALID-REQUEST` and `OCC-NOT-FOUND`.
- [ ] Run focused lifecycle and problem tests green.
- [ ] Commit application changes without amending prior commits.

### Task 4: Task12 Lifecycle Fixture Table

**Files:**
- Modify: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceServiceIntegrationTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/evidence/ProcessScannerSandboxDockerIntegrationTest.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/evidence/ProcessParserSandboxDockerIntegrationTest.kt`

- [ ] Add upload-level table coverage for infected, polyglot, macro, encrypted, oversized, wrong-hash, and decompression-bomb inputs.
- [ ] Assert every row has FAILED status, no version, no retained/downloadable object, completed command audit/outbox, and no unsafe parser path reaches scanner.
- [ ] Keep parser and scanner production protocols as separate required real-Docker test classes.
- [ ] Run forced evidence tests with zero skips.

### Task 5: Strict Verify Selection

**Files:**
- Modify: `scripts/verify.mjs`
- Modify: `scripts/verify.test.mjs`

- [ ] Add red dry-run tests for every required evidence, parser, scanner, reservation concurrency, and PostgreSQL reservation race selector.
- [ ] Add missing/skipped/failed JUnit rejection tests for every required Gradle suite.
- [ ] Explicitly run the PostgreSQL reservation race script in full mode.
- [ ] Implement selectors, full-integration property, strict database environment, and mandatory result checks.
- [ ] Run verify orchestrator tests green.
- [ ] Commit shared verification changes separately.

### Task 6: Final Verification

- [ ] Run forced evidence package with zero skips.
- [ ] Run all contract tests and contracts build.
- [ ] Run exact V014 PostgreSQL integration, database static tests, and PGlite.
- [ ] Run verification orchestrator tests and dry-run full selection assertions.
- [ ] Inspect status/diff/log, commit remaining changes, and report SHAs and results.
