# Risk Quality Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden adjudication ordering, risk API errors, due batch progress, and adjudication database linkage invariants.

**Architecture:** Keep all risk-dependent adjudication work inside the authorized command lifecycle, map explicit domain/request exceptions to static RFC 9457 problems, execute due commands independently from a bounded scan, and enforce the same outcome/link partition in Kotlin and V014.

**Tech Stack:** Kotlin, Spring Boot, command kernel, PostgreSQL/Testcontainers, Flyway SQL, OPA 1.5.1, Node infra contracts.

---

### Task 1: Adjudication Authorization Ordering

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskService.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/risk/RiskServiceIntegrationTest.kt`

- [x] Add a failing test that denies `risk.adjudicate` for a linked nonexistent/cross-target risk and asserts no advisory/risk lookup oracle before authorization.
- [x] Run the focused real PostgreSQL test and verify the current pre-command lock/load causes the wrong exception or database interaction.
- [x] Build the command descriptor only from request IDs and move advisory lock, linked-risk lock, and cross-target validation into `lockCurrentVersion` after authorization.
- [x] Rerun focused adjudication concurrency, replay, linked, and denied tests green.

### Task 2: Stable Risk Problems And Request Validation

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskModels.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskService.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/api/ApiExceptionHandler.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/api/OccProblem.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/api/ApiErrorHandlingTest.kt`

- [x] Add failing API assertions for static 404 risk-not-found, 409 terminal-risk, 400 invalid-risk-action, and 400 invalid-risk-request problems.
- [x] Add malformed adjudication date/outcome linkage request coverage and verify no internal-error response.
- [x] Introduce `InvalidRiskRequestException`, replace public risk `require()` checks with explicit request/action exceptions, and add bounded handlers/responses.
- [x] Run all API error tests green.

### Task 3: Due Batch Per-Item Isolation

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskModels.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskRepository.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskService.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/risk/RiskServiceIntegrationTest.kt`

- [x] Add a failing scheduler test with batch size one, an earlier denied due risk, and a later valid due risk; assert the valid risk advances and the denied risk remains unchanged.
- [x] Remove the outer batch transaction, select a bounded deterministic scan, and execute/catch each command independently until the success limit.
- [x] Defer escalation severity parsing to per-item processing so malformed candidate data cannot abort selection of later candidates.
- [x] Run focused due escalation/SLA tests green and assert deterministic replay progress.

### Task 4: Adjudication Linkage Constraint

**Files:**
- Modify: `database/migrations/V014__evidence_risk_resource.sql`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskModels.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/risk/RiskServiceIntegrationTest.kt`

- [x] Add direct runtime DML tests proving TP/FP require risk, MISSED/NOT_APPLICABLE forbid risk, and valid rows succeed.
- [x] Run focused PostgreSQL test red against the current one-sided check.
- [x] Replace V014 check with the exact two-group outcome/risk partition and align DTO validation.
- [x] Rerun DML and adjudication correction/metrics tests green.

### Task 5: Verification And Commit

**Files:**
- Review all files above.

- [x] Run forced real PostgreSQL risk, API, baseline/startup, and context tests with `--rerun-tasks` and strict dependency verification.
- [x] Run pinned OPA 1.5.1 `check --strict` and `test` in the digest-pinned container.
- [x] Run `npm run test:infra`, `git diff --check`, full/cached diff review, and self-review oracle, status, transaction, starvation, and SQL behavior.
- [ ] Create one new commit without amend, push, merge, or worktree cleanup.
