# Workflow Catalog Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow fresh V001-V013 bootstrap V2 deployments to authorize non-workflow commands without installing Task6 workflow catalog definitions, while workflow actions continue to fail closed when those definitions are absent.

**Architecture:** `AuthorizationSnapshotRepository` classifies the exact current workflow action set from the shared role action contract. Only those actions validate and load canonical workflow relationships; all other actions receive an immutable empty relationship list without querying workflow catalog metadata.

**Tech Stack:** Kotlin, Spring JDBC, PostgreSQL Testcontainers, OPA 1.5.1, JUnit 5, AssertJ, Gradle

**Ownership boundary:** This change does not create relation definitions, modify migrations, or add a workflow success journey. Task6 owns catalog installation and will add the installed-workflow success journey later.

---

### Task 1: Isolate workflow catalog prerequisites by action

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/authz/AuthorizationSnapshotRepository.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/PlatformSecurityKernelIntegrationTest.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/authz/WorkflowAuthorizationSnapshotIntegrationTest.kt`

- [x] **Step 1: Write the failing fresh-deployment and fail-closed tests**

Remove the kernel test's manual installation of `WorkflowAuthorizationRelationDefinitions`. Add a real `occ.execute` command test that asserts a fresh V001-V013 plus bootstrap V2 database contains none of those definitions and still receives an OPA ALLOW. Add a snapshot test that deletes all canonical workflow definitions under `session_replication_role = replica` and asserts `cohort.create` throws `AuthorizationSnapshotException`.

- [x] **Step 2: Run focused tests and verify RED**

```powershell
$env:OPA_DOCKER_IMAGE='openpolicyagent/opa:1.5.1'
.\gradlew.bat :services:core:test --tests "com.innorder.occ.PlatformSecurityKernelIntegrationTest.fresh V001 V013 bootstrap v2 authorizes non workflow command without workflow catalog" --tests "com.innorder.occ.authz.WorkflowAuthorizationSnapshotIntegrationTest.workflow action fails closed when canonical definitions are absent" --rerun-tasks --no-daemon
```

Expected: the fresh non-workflow command fails because snapshot loading unconditionally validates missing workflow definitions; the workflow request remains denied.

- [x] **Step 3: Add the minimal explicit action boundary**

Define the repository-private exact set:

```kotlin
private val WORKFLOW_ACTIONS = WorkflowAuthorizationRoles.processOwnerActions +
    WorkflowAuthorizationRoles.participantActions
```

Guard relationship loading in `load`:

```kotlin
val relationships = if (request.action in WORKFLOW_ACTIONS) {
    loadRelationships(request, snapshotAt)
} else {
    emptyList()
}
```

- [x] **Step 4: Verify GREEN and full gates**

Run the focused command from Step 2, then:

```powershell
$env:OPA_DOCKER_IMAGE='openpolicyagent/opa:1.5.1'
.\gradlew.bat :services:core:test --dependency-verification strict --rerun-tasks --no-daemon
docker run --rm -v "${PWD}:/workspace" -w /workspace openpolicyagent/opa:1.5.1 test policies/opa
git diff --check
```

Expected: all core and OPA tests pass, and `git diff --check` reports no errors.

- [x] **Step 5: Commit**

```powershell
git add -- Docs/superpowers/plans/2026-08-02-workflow-catalog-prerequisites.md services/core/src/main/kotlin/com/innorder/occ/authz/AuthorizationSnapshotRepository.kt services/core/src/test/kotlin/com/innorder/occ/PlatformSecurityKernelIntegrationTest.kt services/core/src/test/kotlin/com/innorder/occ/authz/WorkflowAuthorizationSnapshotIntegrationTest.kt
git commit -m "fix(authz): isolate workflow catalog prerequisites"
```
