# Workflow Role Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the exact V2 workflow role actions through `/api/v1/me.capabilities` without implicitly granting platform administrator capabilities.

**Architecture:** `WorkflowAuthorizationRoles` remains the single source for workflow role identities, action sets, and capability mappings. `PrincipalRepository` combines that shared mapping with the existing platform role mapping, while its existing SQL remains authoritative for assignment definition, entity/principal state, validity, and revocation.

**Tech Stack:** Kotlin, Spring JDBC, Spring MockMvc, JUnit 5, AssertJ, PostgreSQL Testcontainers, Gradle

**V2 release basis:** Do not create V3 or compatibility behavior. V2 has never been published, merged, or consumed by a deployed persisted consumer; these commits form one unpublished development sequence, and the final branch result is the first V2.

---

### Task 1: Expose exact workflow capabilities

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/authz/WorkflowAuthorizationRoles.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/iam/PrincipalRepository.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/iam/WorkflowAuthorizationRolesTest.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/auth/AuthControllerIntegrationTest.kt`

- [x] **Step 1: Write failing shared-contract and `/me` integration tests**

Assert that the shared capability map contains process-owner and participant exact action sets and an explicit empty domain-modeler set. Seed effective workflow assignments plus future administrator, expired operator, and revoked viewer assignments; assert `/me.capabilities` equals the sorted, deduplicated union of process-owner and participant actions and contains no `occ.admin`, `occ.execute`, or `occ.read`.

- [x] **Step 2: Run tests to verify RED**

Run:

```powershell
.\gradlew.bat :services:core:test --tests "com.innorder.occ.iam.WorkflowAuthorizationRolesTest" --tests "com.innorder.occ.auth.AuthControllerIntegrationTest.me exposes exact sorted workflow capabilities from effective role assignments" --rerun-tasks --no-daemon
```

Expected: FAIL because the shared workflow capability map and repository mappings do not exist.

- [x] **Step 3: Implement the minimal shared mapping**

Add an immutable `capabilitiesByRoleKey` map to `WorkflowAuthorizationRoles`:

```kotlin
val capabilitiesByRoleKey = Collections.unmodifiableMap(linkedMapOf(
    processOwner.key to processOwnerActions,
    participant.key to participantActions,
    domainModeler.key to emptySet(),
))
```

Compose it into the repository map without changing SQL validity semantics:

```kotlin
private val ROLE_CAPABILITIES: Map<String, Collection<String>> = mapOf(
    "role:viewer" to listOf("occ.read"),
    "role:operator" to listOf("occ.execute", "occ.read"),
    "role:administrator" to listOf("occ.admin", "occ.execute", "occ.read"),
) + WorkflowAuthorizationRoles.capabilitiesByRoleKey
```

- [x] **Step 4: Verify GREEN and full gates**

Run the focused command from Step 2, then:

```powershell
$env:OPA_DOCKER_IMAGE='openpolicyagent/opa:1.5.1'
.\gradlew.bat :services:core:test --dependency-verification strict --rerun-tasks --no-daemon
docker run --rm -v "${PWD}:/workspace" -w /workspace openpolicyagent/opa:1.5.1 test policies/opa
git diff --check
```

Expected: all core tests and all OPA tests pass; `git diff --check` emits no errors.

- [x] **Step 5: Commit the complete unpublished V2 change**

```powershell
git add -- Docs/superpowers/plans/2026-08-02-workflow-role-capabilities.md services/core/src/main/kotlin/com/innorder/occ/authz/WorkflowAuthorizationRoles.kt services/core/src/main/kotlin/com/innorder/occ/iam/PrincipalRepository.kt services/core/src/test/kotlin/com/innorder/occ/iam/WorkflowAuthorizationRolesTest.kt services/core/src/test/kotlin/com/innorder/occ/auth/AuthControllerIntegrationTest.kt
git commit -m "fix(iam): expose workflow role capabilities"
```
