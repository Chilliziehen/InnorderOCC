# Workflow Targets And Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind workflow authorization targets to authoritative cohort ownership and make the transactional v1-to-v2 upgrade increment authorization revision exactly once.

**Architecture:** `AuthorizationSnapshotRepository` validates workflow entity/resource pairs against PostgreSQL before deriving caller-independent context or loading grants. V013 adds a guarded transaction-scoped revision batch used only around actual upgrader DML; existing locks and triggers remain active, but batch-triggered bumps collapse to one safe final bump.

**Tech Stack:** Kotlin, Spring JDBC, PostgreSQL 16, Flyway, Testcontainers, OPA 1.5.1, JUnit 5, AssertJ, Gradle

---

### Task 1: Bind workflow targets to authoritative rows

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/authz/AuthorizationSnapshotRepository.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/authz/WorkflowAuthorizationSnapshotIntegrationTest.kt`

- [x] **Step 1: Write failing PostgreSQL and OPA tests**

Seed customer-root `authz.entity`, cohort A and B, process/task rows for each cohort, and one principal with owner, participant, candidate, assignee, process-owner, and participant roles. Assert same-cohort `cohort.read`, `process.read`, `process.fail`, `task.read`, `task.fail`, `task.assignment.manage`, and `task.complete` authorize. Pair cohort A as entity with cohort B process/task resources and assert fail closed even when caller context claims cohort A. Assert missing cohort/process/task rows fail with `AuthorizationSnapshotException`.

- [x] **Step 2: Verify target tests fail for cross-cohort combinations**

```powershell
$env:OPA_DOCKER_IMAGE='openpolicyagent/opa:1.5.1'
.\gradlew.bat :services:core:test --tests "com.innorder.occ.authz.WorkflowAuthorizationSnapshotIntegrationTest" --rerun-tasks --no-daemon
```

Expected: cross-cohort process/task requests are currently allowed or reach OPA because no authoritative ownership check exists.

- [x] **Step 3: Implement authoritative target validation**

Call `validateWorkflowTarget(request)` immediately after structural request validation. Implement exact branches:

```kotlin
when {
    request.action == "cohort.create" -> requireTarget(
        request.entityId == request.resourceId && count(
            "SELECT count(*) FROM platform.customer_instance WHERE singleton AND id = ?",
            request.entityId,
        ) == 1L,
    )
    request.action.startsWith("cohort.") -> requireTarget(
        request.entityId == request.resourceId &&
            count("SELECT count(*) FROM occ.cohort WHERE id = ?", request.entityId) == 1L,
    )
    request.action.startsWith("process.") -> requireTarget(
        count("SELECT count(*) FROM occ.process_instance WHERE id = ? AND cohort_id = ?",
            request.resourceId, request.entityId) == 1L,
    )
    request.action.startsWith("task.") -> requireTarget(
        count("""SELECT count(*) FROM occ.task_projection task
                  JOIN occ.process_instance process ON process.id = task.process_instance_id
                  WHERE task.id = ? AND process.cohort_id = ?""",
            request.resourceId, request.entityId) == 1L,
    )
}
```

The existing entity-state load then independently requires the strict customer root and every other target to be active `authz.entity` rows.

- [x] **Step 4: Verify target tests pass**

Run the command from Step 2. Expected: same-cohort journeys pass; missing and cross-cohort combinations fail closed.

### Task 2: Collapse upgrader revision changes into one boundary

**Files:**
- Modify: `database/migrations/V013__process_task_workflow.sql`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/iam/PlatformPolicyV2Upgrader.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/iam/PlatformPolicyV2UpgraderIntegrationTest.kt`
- Test: `database/tests/001_schema_contract.sql`

- [x] **Step 1: Write failing revision assertions**

Capture `authz.authorization_state.current_revision` immediately before upgrade and assert successful v1-to-v2 upgrade is `before + 1`; assert restart no-op and fresh no-policy no-op are `+0`; assert content-drift failure rolls back to its prior revision. Run:

```powershell
.\gradlew.bat :services:core:test --tests "com.innorder.occ.iam.PlatformPolicyV2UpgraderIntegrationTest" --rerun-tasks --no-daemon
```

Expected: successful upgrade reports `before + 3`, proving the regression.

- [x] **Step 2: Add the guarded V013 batch mechanism**

In V013, add `authz.authorization_revision_batch(transaction_id xid8 PRIMARY KEY, changed boolean NOT NULL DEFAULT false)`, revoke direct access, and add SECURITY DEFINER begin/finish/commit-guard functions with fixed search paths. Replace `authz.bump_authorization_revision()` so it marks the current batch dirty and returns the unchanged revision when a batch exists; otherwise it preserves the existing immediate increment. A deferred constraint trigger rejects commit while the current transaction still has an open batch.

- [x] **Step 3: Wrap only actual v1-to-v2 DML**

After all v1 validation and collision checks, call:

```kotlin
jdbc.queryForObject("SELECT authz.begin_authorization_revision_batch()", Long::class.java) ?: fail()
```

After the final release activation, call:

```kotlin
jdbc.queryForObject("SELECT authz.finish_authorization_revision_batch()", Long::class.java) ?: fail()
```

Do not open a batch for fresh or already-v2 no-op paths. Exceptions rollback the batch row, DML, and revision together.

- [x] **Step 4: Run focused and database gates**

```powershell
.\gradlew.bat :services:core:test --tests "com.innorder.occ.iam.PlatformPolicyV2UpgraderIntegrationTest" --tests "com.innorder.occ.authz.WorkflowAuthorizationSnapshotIntegrationTest" --rerun-tasks --no-daemon
npm run test:database
```

Expected: focused tests pass and SQL schema/constraint/workflow tests pass.

- [x] **Step 5: Run full verification and commit**

```powershell
$env:OPA_DOCKER_IMAGE='openpolicyagent/opa:1.5.1'
.\gradlew.bat :services:core:test --dependency-verification strict --rerun-tasks --no-daemon
docker run --rm -v "${PWD}:/workspace" -w /workspace openpolicyagent/opa:1.5.1 test policies/opa
git diff --check
git commit -m "fix(authz): bind workflow targets and revision"
```
