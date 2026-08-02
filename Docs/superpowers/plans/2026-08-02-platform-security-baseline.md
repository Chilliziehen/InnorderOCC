# Platform Security Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed the platform security baseline unconditionally so risk runtime startup does not depend on a one-shot administrator secret.

**Architecture:** Extract exact catalog, role, and policy seeding into an ordered transactional `PlatformSecurityBaseline` service/runner. Keep `BootstrapAdministrator` conditional and focused on first-admin creation in a later independent transaction, followed by risk provisioning and validation.

**Tech Stack:** Kotlin, Spring Boot `ApplicationRunner`/`Ordered`, JDBC, PostgreSQL advisory and authorization-state locks, Testcontainers, OPA 1.5.1, Node Compose contracts.

---

### Task 1: No-Password Startup Contract

**Files:**
- Modify: `services/core/src/test/kotlin/com/innorder/occ/iam/BootstrapAdministratorStartupIntegrationTest.kt`

- [x] Add a real PostgreSQL startup test with no `occ.bootstrap-administrator.password-file`, risk identities enabled, and assertions for readiness, exact platform baseline, risk SERVICE/report rows, and zero USER/admin accounts.
- [x] Run `gradlew.bat :services:core:test --tests "*BootstrapAdministratorStartupIntegrationTest*without administrator*" --rerun-tasks --dependency-verification strict`.
- [x] Verify red because the conditional administrator currently owns baseline seeding and risk provisioning fails.

### Task 2: Extract Unconditional Baseline

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/iam/PlatformSecurityBaseline.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/iam/BootstrapAdministrator.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/iam/BootstrapAdministratorIntegrationTest.kt`

- [x] Move deterministic IDs, canonical hashes, exact `ensure` checks, catalog publication, role seeding, and policy release seeding into `PlatformSecurityBaseline` without changing values or SQL semantics.
- [x] Make baseline `ApplicationRunner` order `0`; execute under the existing advisory transaction lock, then authorization-state change lock before role/policy facts.
- [x] Inject baseline into optional admin, set admin order `10`, call `baseline.ensure()` before its separate first-admin transaction, and retain secret cleanup/error mapping.
- [x] Update direct integration construction and run all `BootstrapAdministratorIntegrationTest` tests; require existing hash, collision, concurrency, and revision assertions to pass.

### Task 3: Ordering, Persistence, And Rollback

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskRuntimeIdentityProvisioner.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskRuntimeIdentityValidator.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/iam/BootstrapAdministratorStartupIntegrationTest.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/iam/BootstrapAdministratorIntegrationTest.kt`

- [x] Assert `PlatformSecurityBaseline.ORDER < BootstrapAdministrator.ORDER < RiskRuntimeIdentityProvisioner.ORDER < RiskRuntimeIdentityValidator.ORDER`.
- [x] Add restart assertions proving baseline/risk rows and authorization revision do not change.
- [x] Add baseline-collision startup assertions proving rollback and no later risk/admin rows.
- [x] Extend configured-secret failure startup assertions: readiness fails, baseline remains exact, and no USER/account exists.
- [x] Move risk provisioner/validator orders to `20`/`30` and run focused startup tests green.

### Task 4: Deployment Contract

**Files:**
- Modify: `infra/compose/README.md`
- Modify: `infra/compose/compose.contract.test.mjs`

- [x] Add a failing contract that Compose documentation states administrator bootstrap is optional/one-shot and platform/risk provisioning works without its password.
- [x] Update documentation without adding an administrator password to Compose or `.env.example`.
- [x] Run `npm run test:infra` green.

### Task 5: Verification And Commit

**Files:**
- Review every file above plus unchanged migrations and OPA policy baseline behavior.

- [x] Run forced bootstrap, startup, risk, context, and API tests with strict real PostgreSQL selection and `--rerun-tasks`.
- [x] Run pinned OPA 1.5.1 container `check --strict` and `test`.
- [x] Run full infra contracts, `git diff --check`, cached diff review, and self-review lock order/revision/hash/collision behavior.
- [ ] Create one new commit without amending, pushing, merging, or removing the worktree.
