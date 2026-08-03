# Risk Runtime Identity Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision deterministic due-evaluation and metrics identities on a fresh Compose database without granting the runtime service administrative authority.

**Architecture:** Bootstrap publishes immutable platform USER, ROLE, and SYSTEM entity types plus a dedicated risk-runtime role with only the two due actions. An ordered transactional provisioner uses those published assets to create and strictly verify configured runtime entities and their role assignment before the existing validator runs.

**Tech Stack:** Kotlin 2, Spring Boot ApplicationRunner ordering, JdbcTemplate, PostgreSQL advisory/authorization locks, Testcontainers PostgreSQL, OPA 1.5.1, Node Compose contracts.

---

### Task 1: Provisioner Contract

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskRuntimeIdentityProvisioner.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/iam/BootstrapAdministratorIntegrationTest.kt`

- [x] Write real PostgreSQL tests that bootstrap an empty migrated database and assert fresh creation of the configured SERVICE principal entity, report SYSTEM entity, and dedicated role relationship.
- [x] Run the focused bootstrap integration tests and verify the missing provisioner contract fails.
- [x] Implement an `ApplicationRunner` that executes in one transaction, takes a fixed transaction advisory lock followed by `authz.lock_authorization_state_for_change()`, and inserts only missing exact rows.
- [x] Add restart, collision, rollback, and authorization revision assertions; rerun after each minimal implementation step.

### Task 2: Published Platform Assets And Least Privilege

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/iam/BootstrapAdministrator.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/iam/BootstrapAdministratorIntegrationTest.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/iam/BootstrapAdministratorIntegrationTest.kt`

- [x] Extend the failing tests to require deterministic `platform.system`, `role:risk-runtime`, and exactly `risk.escalate` plus `risk.sla_breach` role grants with no wildcard action or admin grant.
- [x] Run the focused bootstrap/provisioner tests and verify they fail on missing assets.
- [x] Seed the SYSTEM type/version before package publication, seed the risk-runtime role, and include the two exact grants in the canonical policy baseline hashes.
- [x] Verify published catalog rows are only validated on restart and are never modified; collisions raise the existing bootstrap baseline exception.

### Task 3: Runner Ordering And Exact Validation

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/iam/BootstrapAdministrator.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskRuntimeIdentityProvisioner.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/risk/RiskRuntimeIdentityValidator.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/iam/BootstrapAdministratorIntegrationTest.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/OccCoreApplicationTest.kt`

- [x] Add failing assertions for `BootstrapAdministrator.ORDER < RiskRuntimeIdentityProvisioner.ORDER < RiskRuntimeIdentityValidator.ORDER` and validator success immediately after provisioning.
- [x] Implement explicit `Ordered` values and make validator checks match the provisioner's exact platform type, entity key, and principal contract.
- [x] Run focused provisioner and context tests with `--rerun-tasks` and require zero failures/skips.

### Task 4: Compose Defaults, Documentation, And OPA Behavior

**Files:**
- Modify: `infra/compose/.env.example`
- Modify: `infra/compose/compose.yml`
- Modify: `infra/compose/compose.contract.test.mjs`
- Modify: `infra/compose/README.md`
- Modify: `policies/opa/platform/authz_test.rego`

- [x] Add failing contracts for stable UUID defaults, override interpolation, startup provisioning documentation, and due-only policy behavior.
- [x] Set non-secret UUID defaults in `.env.example` and Compose interpolation while preserving environment overrides.
- [x] Document deterministic identity provisioning, collision failure, and non-secret override behavior.
- [x] Add an OPA test that allows both due actions with the runtime grant set and denies `occ.admin`.

### Task 5: Forced Verification And Commit

**Files:**
- Review all files above.

- [x] Run forced bootstrap, provisioner/risk, application-context, and API contract Gradle tests against real PostgreSQL.
- [x] Run `npm run test:infra`.
- [x] Run pinned OPA 1.5.1 container `check --strict /policies` and `test /policies`.
- [x] Run `git diff --check`, inspect the full diff, and self-review collision, lock ordering, revision, privilege, and restart behavior.
- [ ] Commit all intended files in one new commit without amending prior commits.
