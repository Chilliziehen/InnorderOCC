# Task 12 Quality Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all remaining Task 12 production wiring and verification quality findings.

**Architecture:** Keep production configuration in Compose and validate its rendered form independently of test resources. Make verification strict by structurally reconciling source files and JUnit XML while allowing only the explicitly optional OPA suite to skip outside strict full mode.

**Tech Stack:** Docker Compose, Spring Boot/Kotlin, JUnit 5, Node.js 22, Saxes XML parser, Gradle, OPA 1.5.1.

---

### Task 1: Production JWT Compose Wiring

**Files:**
- Modify: `infra/compose/compose.yml`
- Modify: `infra/compose/compose.contract.test.mjs`
- Modify: `infra/compose/.env.example`
- Modify: `infra/compose/README.md`
- Modify: `Docs/Deployment/03-secrets-and-configuration.md`
- Modify additional deployment chapters that state secret inventory counts

- [ ] Add failing contracts for required issuer/key host variables, fixed Option A container paths, exact consumers, and real rendered Compose configuration without test resources.
- [ ] Run `npm run test:infra` and confirm the new contracts fail on missing wiring.
- [ ] Add `OCC_JWT_ISSUER`, both fixed key paths, and private/public secrets to `core` and `flowable-init` only.
- [ ] Extend host secret inventory, generation/validation instructions, and deployment contracts from eight to ten files.
- [ ] Run real `docker compose config` proof and `npm run test:infra`.

### Task 2: Optional OPA Outside Strict Full

**Files:**
- Modify: `services/core/src/test/kotlin/com/innorder/occ/PlatformSecurityKernelIntegrationTest.kt`
- Modify: `scripts/verify.test.mjs`
- Modify: `Docs/Development/verification.md`

- [ ] Add verifier/no-OPA tests proving quick test mode completes and reports the platform suite skipped rather than class-init failure.
- [ ] Run `npm test` with `OPA_PATH` removed and confirm the current failure.
- [ ] Make OPA construction lazy and use a JUnit environment condition for the suite.
- [ ] Run `npm test` without OPA and focused platform acceptance with trusted OPA.

### Task 3: Structural JUnit Reconciliation

**Files:**
- Modify: `scripts/verify-process.mjs`
- Modify: `scripts/verify.test.mjs`

- [ ] Add adversarial tests for forged summaries, direct skipped/failure/error testcase children, nested suites, self-closing/zero testcase suites, count mismatches, and valid Gradle `system-out`/`system-err`.
- [ ] Run `npm run test:verify` and confirm failures expose summary-only validation.
- [ ] Track direct testcase nodes and their direct outcome children with Saxes; reconcile exact root totals.
- [ ] Run `npm run test:verify` and confirm all adversarial cases pass.

### Task 4: Lexical Kotlin Test Convention

**Files:**
- Modify: `scripts/verify-process.mjs`
- Modify: `scripts/verify.test.mjs`

- [ ] Add source fixtures for indented/multiline modifiers, matching concrete class, abstract match, nested match, comments, escaped strings, and raw-string decoys.
- [ ] Run `npm run test:verify` and confirm current regex discovery fails.
- [ ] Implement a deterministic comment/string/brace-aware Kotlin token scanner and require one concrete top-level class matching each filename.
- [ ] Reject every malformed or nonconforming `*Test.kt` source instead of omitting it.
- [ ] Run verifier tests and the repository source-to-suite guard.

### Task 5: Deployment Lifecycle Facts

**Files:**
- Modify stale files under `Docs/Deployment/`
- Modify: `scripts/deployment-docs.test.mjs`

- [ ] Add contract patterns rejecting `八/两状态` and all old ten-service/two-one-shot variants.
- [ ] Run `npm run test:deployment-docs` and confirm stale wording is detected.
- [ ] Replace stale lifecycle wording with eleven services, eight long-running services, and three one-shots.
- [ ] Run deployment documentation contracts.

### Task 6: Final Verification and Commit

**Files:** all files above.

- [ ] Run `npm test` with `OPA_PATH` absent.
- [ ] Run verifier, deployment docs, real Compose config, and focused trusted-OPA acceptance.
- [ ] Run complete `:services:core:test` with Docker and trusted OPA.
- [ ] Run explicit trusted `OPA_PATH` `npm run verify:full` and confirm complete JUnit enforcement passes.
- [ ] Inspect status, diff, and recent log; stage only Task 12 files.
- [ ] Commit as `fix(test): harden platform verification wiring` without amend.
