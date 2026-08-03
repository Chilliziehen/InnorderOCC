# Process And Task Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the production-ready cohort, Flowable process, task projection, notification, contract, authorization, and real-infrastructure workflow slice for the deployable pilot.

**Architecture:** PostgreSQL owns aggregate facts and OCC projections while embedded Flowable owns execution lifecycle; both share the Core datasource and Spring transaction manager. Cohort, process, and task remain separate aggregates coordinated by the existing authorized command kernel, extended with predeclared multi-aggregate lock plans and per-aggregate Outbox events. Relationship-aware OPA authorization and fail-closed persisted gate facts protect every command and query.

**Tech Stack:** PostgreSQL 16/Flyway SQL, Kotlin 2/Spring Boot/JDBC, Flowable 7.1, OPA/Rego, OpenAPI 3.1, TypeScript/Zod/Vitest, Testcontainers, Node test runner, Gradle 8.14.

---

## File Map

Database ownership:

- Create `database/migrations/V013__process_task_workflow.sql`: all forward schema changes owned by this slice.
- Create `database/tests/003_process_task_workflow.sql`: real PostgreSQL lifecycle and constraint checks.
- Create `database/tests/postgresql-workflow-races.test.mjs`: start, claim, and relationship races.
- Create `database/tests/postgresql-process-task.test.mjs`: deterministic Testcontainers runner that applies V001-V013 and executes SQL tests.
- Modify `database/innorder_occ_full_schema.sql`, `database/tests/run_all.sql`, `database/tests/schema-static.test.mjs`, and `database/tests/pglite-smoke.mjs`: register V013 and verify it.

Shared contracts and policy:

- Create `packages/contracts/src/workflow-common.ts`, `cohort.ts`, `process.ts`, `task.ts`, and `notifications.ts`: strict DTO schemas.
- Modify `packages/contracts/src/events.ts`, `problem-details.ts`, `authorization.ts`, `index.ts`, and `openapi/occ-core.yaml`: typed events, workflow errors, authorization v2, exports, and APIs.
- Create `packages/contracts/test/workflow-contracts.test.ts`, `workflow-events.test.ts`, and `workflow-openapi-parity.test.ts`.
- Modify `policies/opa/platform/authz.rego` and `authz_test.rego`: active workflow relationship authorization.

Shared Core kernel:

- Create `services/core/src/main/kotlin/com/innorder/occ/command/AggregateLockRegistry.kt`.
- Modify `command/AuthorizedCommand.kt`, `CommandExecutor.kt`, `AuditRepository.kt`, and `events/OutboxRepository.kt`.
- Modify `authz/AuthorizationModels.kt`, `AuthorizationSnapshotRepository.kt`, and `AuthorizationDecisionValidator.kt`.
- Extend existing command/authz integration tests; do not create a second command path.

Domain modules:

- Create focused files under `services/core/src/main/kotlin/com/innorder/occ/cohort/`, `process/`, `task/`, and `notification/`.
- Create the immutable package under `services/core/src/main/resources/domain-packages/embedded-medical-device-pilot/1.0.0/`.
- Create focused unit/integration tests under matching Core test packages.
- Modify `scripts/verify.mjs` and `scripts/verify.test.mjs` only in the final gate task.

### Task 1: V013 Static Schema Contract

**Files:**
- Create: `database/migrations/V013__process_task_workflow.sql`
- Modify: `database/innorder_occ_full_schema.sql`
- Modify: `database/tests/schema-static.test.mjs`
- Modify: `database/tests/pglite-smoke.mjs`

- [ ] **Step 1: Write the failing static migration tests**

Add assertions that V013 is the only migration after V012, is present in each entrypoint, creates every owned table, alters process/task projections, and does not edit old migrations:

```js
test("V013 is the next process task migration", () => {
  assert.deepEqual(migrationNames.slice(-2), [
    "V012__outbox_publisher_lifecycle.sql",
    "V013__process_task_workflow.sql",
  ]);
  assert.match(v013, /CREATE TABLE occ\.cohort/);
  assert.match(v013, /CREATE TABLE occ\.task_gate_provider_state/);
  assert.match(v013, /CREATE TABLE occ\.task_review_projection_fact/);
  assert.match(v013, /CREATE TABLE occ\.notification/);
});
```

- [ ] **Step 2: Run the static test and confirm RED**

Run: `npm run test:database`

Expected: FAIL because `V013__process_task_workflow.sql` is absent.

- [ ] **Step 3: Add the forward migration skeleton and entrypoints**

Create V013 with the owned tables and register it after V012:

```sql
CREATE TABLE occ.cohort (
    id uuid PRIMARY KEY REFERENCES authz.entity(id),
    customer_instance_id uuid NOT NULL REFERENCES platform.customer_instance(id),
    code text NOT NULL CHECK (code = lower(btrim(code)) AND code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 256),
    package_version_id uuid NOT NULL REFERENCES catalog.package_version(id),
    owner_principal_id uuid NOT NULL REFERENCES iam.principal(id),
    start_date date NOT NULL,
    end_date date,
    status text NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_by uuid NOT NULL REFERENCES iam.principal(id),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_by uuid NOT NULL REFERENCES iam.principal(id),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    archived_at timestamptz,
    UNIQUE (customer_instance_id, code),
    CHECK (end_date IS NULL OR end_date >= start_date),
    CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
```

Include explicit upgrade guards for non-empty legacy process/task tables that cannot be truthfully backfilled; raise SQLSTATE `55000` instead of inventing cohort ownership.

- [ ] **Step 4: Run static and PGlite tests**

Run: `npm run test:database`

Expected: PASS.

Run: `npm run test:database:pglite`

Expected: PASS and output includes `V013__process_task_workflow.sql`.

- [ ] **Step 5: Commit the migration skeleton**

```powershell
git add database
git commit -m "feat(database): reserve process task workflow schema"
```

### Task 2: PostgreSQL Workflow Constraints And Races

**Files:**
- Modify: `database/migrations/V013__process_task_workflow.sql`
- Create: `database/tests/003_process_task_workflow.sql`
- Create: `database/tests/postgresql-process-task.test.mjs`
- Create: `database/tests/postgresql-workflow-races.test.mjs`
- Modify: `database/tests/run_all.sql`
- Modify: `package.json`
- Create: `services/core/src/test/kotlin/com/innorder/occ/ProcessTaskSchemaIntegrationTest.kt`

- [ ] **Step 1: Write real PostgreSQL constraint tests**

Cover normalization, package consistency, lifecycle, owner projection, relationship re-enrollment, process uniqueness, task occurrence identity, append-only facts, gate readiness, notification read-once, version triggers, indexes, and runtime privileges. Use SQLSTATE assertions such as:

```sql
DO $$
BEGIN
  BEGIN
    INSERT INTO occ.cohort (id, customer_instance_id, code, name, package_version_id,
      owner_principal_id, start_date, status, created_by, updated_by)
    VALUES (:'cohort_id', :'customer_id', ' Not-Normalized ', 'Cohort', :'package_version_id',
      :'owner_id', current_date, 'DRAFT', :'owner_id', :'owner_id');
    RAISE EXCEPTION 'expected cohort code check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
```

Create `services/core/src/test/kotlin/com/innorder/occ/ProcessTaskSchemaIntegrationTest.kt` with tests `appliesV013WithRuntimePrivileges`, `rejectsUntruthfulLegacyBackfill`, and `enforcesProcessTaskConstraints` against a fresh Testcontainer.

- [ ] **Step 2: Write concurrency tests before constraints and confirm RED**

Create the three race tests against a fresh container, then run: `node --test database/tests/postgresql-workflow-races.test.mjs`

Expected: FAIL because duplicate starts/claims or overlapping relationships are admitted.

- [ ] **Step 3: Add the deterministic PostgreSQL runner and confirm SQL RED**

`postgresql-process-task.test.mjs` must start the pinned repository PostgreSQL image, apply migrations in filename order, execute `run_all.sql`, and always stop the container. It must not consume `DATABASE_URL`.

Run: `node --test database/tests/postgresql-process-task.test.mjs`

Expected: FAIL on the first incomplete V013 invariant.

- [ ] **Step 4: Complete V013 constraints and projections**

Add composite package FKs; immutable binding/process identity triggers; cohort/process/task version triggers; task blocker/gate/timeline/review facts; notifications; and relationship effective-window exclusion:

```sql
DROP INDEX authz.uq_relationship_active;
ALTER TABLE authz.relationship ADD CONSTRAINT ex_relationship_effective_window
EXCLUDE USING gist (
  relation_definition_id WITH =,
  subject_entity_id WITH =,
  object_entity_id WITH =,
  tstzrange(valid_from,
    least(coalesce(valid_until, 'infinity'::timestamptz),
          coalesce(revoked_at, 'infinity'::timestamptz)), '[)') WITH &&
);

CREATE UNIQUE INDEX uq_task_review_submission
ON occ.task_review_projection_fact(task_id, evidence_version_id)
WHERE fact_kind = 'SUBMITTED';

CREATE UNIQUE INDEX uq_task_review_decision
ON occ.task_review_projection_fact(submission_fact_id)
WHERE fact_kind = 'DECIDED';
```

Add `audit.dependency_failure_attempt` with bounded command/dependency/category fields, correlation/actor/target IDs and timestamp; grant runtime insert/select needed by the recorder, and reject arbitrary exception detail.

- [ ] **Step 5: Run deterministic SQL, schema integration, and race tests**

Run: `node --test database/tests/postgresql-process-task.test.mjs database/tests/postgresql-workflow-races.test.mjs`

Expected: all tests PASS, 0 skipped.

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.ProcessTaskSchemaIntegrationTest"`

Expected: PASS against real PostgreSQL, 0 skipped when Docker is available.

- [ ] **Step 6: Run all database gates**

Run: `npm run test:database`

Expected: PASS.

Run: `npm run test:database:pglite`

Expected: PASS.

- [ ] **Step 7: Commit complete V013**

```powershell
git add database package.json services/core/src/test/kotlin/com/innorder/occ/ProcessTaskSchemaIntegrationTest.kt
git commit -m "feat(database): enforce process task workflow invariants"
```

### Task 3: Workflow OpenAPI, Zod, And Typed Events

**Files:**
- Create: `packages/contracts/src/workflow-common.ts`
- Create: `packages/contracts/src/cohort.ts`
- Create: `packages/contracts/src/process.ts`
- Create: `packages/contracts/src/task.ts`
- Create: `packages/contracts/src/notifications.ts`
- Modify: `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/problem-details.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/openapi/occ-core.yaml`
- Create: `packages/contracts/test/workflow-contracts.test.ts`
- Create: `packages/contracts/test/workflow-events.test.ts`
- Create: `packages/contracts/test/workflow-openapi-parity.test.ts`

- [ ] **Step 1: Write failing strict DTO tests**

Test every design endpoint, enum, bound, command header/body, cursor page, unknown-field rejection, and absence of Flowable IDs/total counts:

```ts
it("rejects unknown task command fields", () => {
  expect(() => claimTaskRequestSchema.parse({ expectedVersion: 1, flowableTaskId: "x" })).toThrow();
});

it("accepts all presentation states", () => {
  for (const state of ["AVAILABLE", "CLAIMED", "BLOCKED", "PENDING_REVIEW",
    "RETURNED", "COMPLETED", "CANCELLED", "FAILED"]) {
    expect(taskPresentationStateSchema.parse(state)).toBe(state);
  }
});
```

- [ ] **Step 2: Run contract tests and confirm RED**

Run: `npm run test --workspace @innorder/contracts -- --run test/workflow-contracts.test.ts`

Expected: FAIL because workflow schemas are missing.

- [ ] **Step 3: Implement strict Zod schemas**

Use shared primitives and `.strict()` everywhere:

```ts
export const safeVersionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const taskPresentationStateSchema = z.enum([
  "AVAILABLE", "CLAIMED", "BLOCKED", "PENDING_REVIEW",
  "RETURNED", "COMPLETED", "CANCELLED", "FAILED",
]);
export const cursorPageInfoSchema = z.object({ nextCursor: z.string().min(1).max(4096).optional() }).strict();
```

- [ ] **Step 4: Write failing typed-event registry tests**

Parameterize all design event names and assert aggregate/payload mismatch, unknown fields, sensitive fields, and Flowable identifiers fail.

Run: `npm run test --workspace @innorder/contracts -- --run test/workflow-events.test.ts`

Expected: FAIL because the owned event registry does not exist.

- [ ] **Step 5: Implement typed event envelopes**

```ts
const typedEvent = <T extends string, A extends string>(
  type: T, aggregateType: A, payload: z.ZodType,
) => eventEnvelopeSchema.extend({
  type: z.literal(type), schemaVersion: z.literal(1),
  aggregateType: z.literal(aggregateType), payload,
}).strict();
```

Register every cohort/process/task event explicitly, including owner/participant transfer and assignee change.

Run: `npm run test --workspace @innorder/contracts -- --run test/workflow-events.test.ts`

Expected: PASS.

- [ ] **Step 6: Write OpenAPI parity tests and confirm RED**

Assert all paths, `Idempotency-Key`, `expectedVersion`, `X-Idempotent-Replay`, strict schemas, filters, and `400/401/403/404/409/503/500` responses.

Run: `npm run test --workspace @innorder/contracts -- --run test/workflow-openapi-parity.test.ts`

Expected: FAIL on missing workflow paths.

- [ ] **Step 7: Extend OpenAPI and run all contract gates**

Run: `npm run test --workspace @innorder/contracts`

Expected: PASS.

Run: `npm run build --workspace @innorder/contracts`

Expected: TypeScript build succeeds with zero errors.

- [ ] **Step 8: Commit shared contracts**

```powershell
git add packages/contracts
git commit -m "feat(contracts): add process task workflow contracts"
```

### Task 4: Multi-Aggregate Command Kernel

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/command/AggregateLockRegistry.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/command/AuthorizedCommand.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/command/CommandExecutor.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/command/AuditRepository.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/events/OutboxRepository.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/command/CommandExecutorIntegrationTest.kt`

- [ ] **Step 1: Write failing lock-plan tests**

Add tests named `lock plan resolves in global order`, `unknown duplicate and missing locks fail`, `created aggregates use baseline zero`, and `mutation rejects undeclared aggregate changes`.

- [ ] **Step 2: Run command tests and confirm RED**

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.command.CommandExecutorIntegrationTest" --rerun-tasks`

Expected: compilation FAIL because lock-plan types do not exist.

- [ ] **Step 3: Implement the predeclared lock registry**

```kotlin
data class AggregateReference(val type: String, val id: UUID)
data class AggregateLockPlan(
    val existing: List<AggregateReference>,
    val created: List<AggregateReference> = emptyList(),
)
interface AggregateLockResolver {
    val aggregateType: String
    val order: Int
    fun lock(id: UUID, jdbc: JdbcOperations): Long?
}
```

Replace `lockCurrentVersion` with `lockPlan`; sort by `(order, id, type)`; make locked versions immutable in `CommandContext`; migrate every existing command/test to a one-entry plan.

For a created aggregate, declare `beforeVersion=0`, insert `row_version=1`, return `afterVersion=1`, and emit event version 1. Add assertions that database, response, audit, and Outbox all agree.

- [ ] **Step 4: Write failing multi-aggregate event tests**

Cover independent aggregate identity/version, undeclared event rejection, per-aggregate ordering, bounded audit summary, and atomic rollback.

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.command.CommandExecutorIntegrationTest" --rerun-tasks`

Expected: FAIL because events still inherit the primary descriptor aggregate.

- [ ] **Step 5: Implement aggregate changes and event identity**

```kotlin
data class AggregateChange(
    val aggregate: AggregateReference,
    val beforeVersion: Long,
    val afterVersion: Long,
)
data class PendingEventSpec(
    val aggregate: AggregateReference,
    val aggregateVersion: Long,
    val eventType: String,
    val schemaVersion: Int,
    val payload: CanonicalJsonObject,
)
```

Require `afterVersion == beforeVersion + 1`; write each event's aggregate to Outbox; retain primary versions in audit and add a sorted bounded `affectedAggregates` detail.

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.command.CommandExecutorIntegrationTest" --rerun-tasks`

Expected: multi-aggregate event tests PASS.

- [ ] **Step 6: Write and implement replay reauthorization tests**

Tests: stored replay authorizes again, revoked caller cannot read response, OPA outage denies without deleting result, later authorized retry replays unchanged content.

Run the same focused command before implementation.

Expected: FAIL because `IdempotencyAcquisition.Replay` returns before authorization.

Move authorization before the replay return while keeping replay free of domain locks/execution/audit/outbox writes.

Run the same focused command after implementation.

Expected: replay authorization tests PASS.

- [ ] **Step 7: Run focused and Core tests**

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.command.CommandExecutorIntegrationTest" --rerun-tasks`

Expected: PASS, 0 skipped.

- [ ] **Step 8: Commit the isolated shared kernel change**

```powershell
git add services/core/src/main/kotlin/com/innorder/occ/command services/core/src/main/kotlin/com/innorder/occ/events services/core/src/test/kotlin/com/innorder/occ/command
git commit -m "feat(core): govern multi aggregate workflow commands"
```

### Task 5: Relationship-Aware Authorization V2

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/authz/AuthorizationModels.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/authz/AuthorizationSnapshotRepository.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/authz/AuthorizationDecisionValidator.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/authz/WorkflowAuthorizationSnapshotIntegrationTest.kt`
- Modify: `packages/contracts/src/authorization.ts`
- Modify: `packages/contracts/test/authorization-parity.test.ts`
- Modify: `packages/contracts/test/fixtures/authorization-parity.json`
- Modify: `policies/opa/platform/authz.rego`
- Modify: `policies/opa/platform/authz_test.rego`

- [ ] **Step 1: Write failing snapshot and Rego tests**

Cover active owner/teacher/participant/candidate/assignee facts, revoked/expired/future exclusion, 256-row bound, default deny, no implicit administrator/modeler authority, and task claim/complete relationship checks.

- [ ] **Step 2: Run authorization tests and confirm RED**

Run: `& $env:OPA_PATH test policies/opa/platform -v`

Expected: FAIL because contract v2 relationships are absent.

Run: `npm run test:authz-parity`

Expected: FAIL for the same contract mismatch.

- [ ] **Step 3: Implement strict relationship facts**

```kotlin
enum class AuthorizationRelation {
    COHORT_OWNER, COHORT_TEACHER, COHORT_PARTICIPANT,
    TASK_CANDIDATE, TASK_ASSIGNEE,
}
data class AuthorizationRelationshipFact(
    val relation: AuthorizationRelation,
    val subjectId: UUID,
    val objectId: UUID,
)
```

Load only allowlisted active relationships at `snapshotAt`, use `LIMIT 257`, fail closed above 256, sort and deduplicate, and update Kotlin/Zod/Rego contract version to 2.

- [ ] **Step 4: Implement relationship policy rules**

```rego
workflow_relationship(relation, object_id) if {
  some fact in input.relationships
  fact.relation == relation
  lower(fact.subjectId) == lower(input.principal.id)
  lower(fact.objectId) == lower(object_id)
}
```

Add exact action grants to the signed platform test manifest. Relationship facts are mandatory additional constraints on those workflow grants, not an independent ALLOW source: successful decisions retain `ALLOW_GRANT_MATCH` and a `grant:<sha256>` matched policy ID. Do not add partial wildcard grants or a second decision reason format.

- [ ] **Step 5: Run OPA, parity, and Kotlin tests**

Run: `& $env:OPA_PATH check --strict policies/opa`

Expected: PASS.

Run: `& $env:OPA_PATH test policies/opa -v`

Expected: PASS.

Run: `npm run test:authz-parity`

Expected: PASS.

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.authz.*"`

Expected: PASS.

- [ ] **Step 6: Commit authorization changes separately**

```powershell
git add services/core/src/main/kotlin/com/innorder/occ/authz services/core/src/test/kotlin/com/innorder/occ/authz packages/contracts/src/authorization.ts packages/contracts/test policies/opa/platform
git commit -m "feat(authz): authorize workflow relationship facts"
```

### Task 6: Catalog Installation And Shared Cursor

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/catalog/EmbeddedWorkflowCatalogInstaller.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/api/cursor/CursorCodec.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/api/cursor/CursorKeyRing.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/api/cursor/CursorProperties.kt`
- Modify: `services/core/src/main/resources/application.yml`
- Create: `services/core/src/test/kotlin/com/innorder/occ/catalog/EmbeddedWorkflowCatalogInstallerIntegrationTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/api/cursor/CursorCodecTest.kt`

- [ ] **Step 1: Write failing deterministic catalog installation tests**

Assert the installer idempotently creates and publishes entity type/version rows for `cohort`, `process`, and `task`, plus relation definitions `COHORT_OWNER`, `COHORT_TEACHER`, `COHORT_PARTICIPANT`, `TASK_CANDIDATE`, and `TASK_ASSIGNEE`. Re-running must preserve IDs and versions. Workflow/form definitions are deliberately installed in Task 9 after their immutable resources exist.

- [ ] **Step 2: Run catalog tests and confirm RED**

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.catalog.EmbeddedWorkflowCatalogInstallerIntegrationTest" --rerun-tasks`

Expected: compilation FAIL because the installer is absent.

- [ ] **Step 3: Implement the installer with deterministic UUIDv5 identifiers**

```kotlin
@Component
class EmbeddedWorkflowCatalogInstaller(private val jdbc: JdbcOperations) {
    @Transactional
    fun install() {
        installEntityType("cohort")
        installEntityType("process")
        installEntityType("task")
        WorkflowRelation.entries.forEach(::installRelationDefinition)
    }
}
```

Implement this component as an ordered `ApplicationRunner` so Core startup installs these prerequisite types before domain use. Use fixed namespace/name UUIDv5 values, strict insert-or-verify semantics, and fail startup when existing immutable content differs.

- [ ] **Step 4: Run catalog tests and confirm GREEN**

Run the Step 2 command.

Expected: PASS against fresh and already-installed databases.

- [ ] **Step 5: Write failing cursor security tests**

Test canonical filter digest, current/previous key acceptance, unknown key rejection, 24-hour expiry, subject/endpoint/filter binding, bad signature, malformed JSON, and 4096-byte bound.

- [ ] **Step 6: Run cursor tests and confirm RED**

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.api.cursor.CursorCodecTest" --rerun-tasks`

Expected: compilation FAIL because cursor classes are absent.

- [ ] **Step 7: Implement the file-backed rotating HMAC codec**

```kotlin
data class CursorPayload(
    val version: Int, val subjectId: UUID, val endpoint: String,
    val filterDigest: String, val sortTimestamp: Instant, val lastId: UUID,
    val issuedAt: Instant, val keyId: String,
)
interface CursorCodec {
    fun encode(payload: CursorPayload): String
    fun decode(cursor: String, binding: CursorBinding): CursorPayload
}
```

Load exactly current and optional previous key files from config, require at least 32 random bytes, use HMAC-SHA-256 and constant-time verification, and never log cursor/key content.

- [ ] **Step 8: Run cursor tests and commit shared infrastructure**

Run the Step 6 command.

Expected: PASS.

```powershell
git add services/core/src/main/kotlin/com/innorder/occ/catalog services/core/src/main/kotlin/com/innorder/occ/api/cursor services/core/src/main/resources/application.yml services/core/src/test/kotlin/com/innorder/occ/catalog services/core/src/test/kotlin/com/innorder/occ/api/cursor
git commit -m "feat(core): install workflow catalog and secure cursors"
```

### Task 7: Cohort Aggregate And API

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/cohort/CohortModels.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/cohort/CohortRepository.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/cohort/CohortCommands.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/cohort/CohortQueryService.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/cohort/CohortController.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/cohort/CohortAggregateLockResolver.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/cohort/CohortIntegrationTest.kt`

- [ ] **Step 1: Write failing cohort lifecycle tests**

Tests: create binds published package and sole owner; duplicate code conflicts; membership add/remove/re-enroll increments authorization revision; owner transfer is atomic; first participant start activates draft; archive rejects running process; stale/duplicate/denied commands are safe; query filters before cursor seek.

- [ ] **Step 2: Run cohort tests and confirm RED**

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.cohort.*" --rerun-tasks`

Expected: compilation FAIL because cohort module is absent.

- [ ] **Step 3: Implement focused models and repository**

```kotlin
enum class CohortStatus { DRAFT, ACTIVE, ARCHIVED }
data class Cohort(
    val id: UUID, val customerInstanceId: UUID, val code: String, val name: String,
    val packageVersionId: UUID, val ownerPrincipalId: UUID,
    val status: CohortStatus, val rowVersion: Long,
)
fun interface ParticipantProcessStarter {
    fun start(input: StartParticipantProcess): ParticipantProcessStartResult
}
```

Use SQL seek pagination and active relationship predicates; cohort code normalizes once at input and is checked again by PostgreSQL.

- [ ] **Step 4: Implement commands and controller through CommandExecutor**

Create/update/member/owner/archive commands must declare exact lock plans and `changesAuthorizationFacts`; Cohort never imports Flowable. Test participant start through an injected fake `ParticipantProcessStarter`; defer the production participant-start controller wiring and draft activation journey to Task 9.

- [ ] **Step 5: Run cohort and Core tests**

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.cohort.*"`

Expected: PASS, 0 skipped.

- [ ] **Step 6: Commit the cohort module**

```powershell
git add services/core/src/main/kotlin/com/innorder/occ/cohort services/core/src/test/kotlin/com/innorder/occ/cohort
git commit -m "feat(core): add cohort lifecycle and membership"
```

### Task 8: Task Projection Foundation And Notifications

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/task/TaskModels.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/task/TaskRepository.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/task/TaskPresentationState.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/task/TaskProjectionSynchronizer.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/task/TaskAggregateLockResolver.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/notification/NotificationWriter.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/notification/NotificationRepository.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/notification/NotificationQueryService.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/notification/NotificationController.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/task/TaskPresentationStateTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/task/TaskProjectionSynchronizerIntegrationTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/notification/NotificationRepositoryIntegrationTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/notification/NotificationQueryIntegrationTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/notification/NotificationReadCommandIntegrationTest.kt`

- [ ] **Step 1: Write and run failing state/synchronizer tests**

Cover presentation precedence and synchronization of new/completed/repeated Flowable activity occurrences without importing Flowable types.

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.task.TaskPresentationStateTest" --tests "com.innorder.occ.task.TaskProjectionSynchronizerIntegrationTest" --rerun-tasks`

Expected: compilation FAIL because the task foundation is absent.

- [ ] **Step 2: Implement the projection boundary**

```kotlin
data class EngineTaskSnapshot(
    val engineTaskId: String, val executionId: String, val activityKey: String,
    val name: String, val assigneeId: UUID?, val createdAt: Instant,
)
interface TaskProjectionSynchronizer {
    fun synchronize(processId: UUID, snapshots: List<EngineTaskSnapshot>): TaskProjectionChanges
}
```

Persist task entities, candidates, timelines, and task events through the command context; use internal engine occurrence identity and the design precedence.

- [ ] **Step 3: Run task foundation tests and confirm GREEN**

Run the Step 1 command.

Expected: PASS.

- [ ] **Step 4: Write and run failing notification tests**

Test idempotent `(recipient,event,type)` writes, per-recipient monotonic cursor, authorization-filtered seek query using shared `CursorCodec`, and `read_at` null-to-value only.

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.notification.*" --rerun-tasks`

Expected: compilation FAIL because notification classes are absent.

- [ ] **Step 5: Implement notifications and confirm GREEN**

```kotlin
fun interface NotificationWriter { fun write(input: NotificationWrite): Notification }
```

Run the Step 4 command.

Expected: PASS.

- [ ] **Step 6: Commit the task foundation**

```powershell
git add services/core/src/main/kotlin/com/innorder/occ/task services/core/src/main/kotlin/com/innorder/occ/notification services/core/src/test/kotlin/com/innorder/occ/task services/core/src/test/kotlin/com/innorder/occ/notification
git commit -m "feat(core): add task projection and notification foundation"
```

### Task 9: Pilot Package And Flowable Process Module

**Files:**
- Create: `services/core/src/main/resources/domain-packages/embedded-medical-device-pilot/1.0.0/manifest.json`
- Create: `services/core/src/main/resources/domain-packages/embedded-medical-device-pilot/1.0.0/processes/medical-device-development-v1.bpmn20.xml`
- Create schema/UI pairs in `.../forms/` named `baseline-skills`, `safety-checklist`, `intended-use`, `requirements`, `architecture`, `hazards`, `bill-of-materials`, `design-review`, `firmware-scaffold`, `test-plan`, `power-up`, `calibration`, `verification`, `final-review`, and `conditional-follow-up`.
- Create: `services/core/src/main/resources/domain-packages/embedded-medical-device-pilot/1.0.0/rules/gates.json`
- Create: `services/core/src/main/resources/domain-packages/embedded-medical-device-pilot/1.0.0/rules/conditional-advance.json`
- Create scenarios in `.../scenarios/` named `happy-path.json`, `review-return-resubmission.json`, `conditional-evidence.json`, `safety-failure.json`, `parallel-wait-work.json`, `exclusive-resource-conflict.json`, `capacity-conflict.json`, `severe-electrical-risk.json`, `package-rejection.json`, and `ai-disabled-completion.json`.
- Create: `services/core/src/main/kotlin/com/innorder/occ/process/ProcessModels.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/process/ProcessRepository.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/process/ProcessEnginePort.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/process/FlowableProcessAdapter.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/process/ProcessDefinitionDeploymentService.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/process/ProcessCommands.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/process/ProcessQueryService.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/process/ProcessController.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/process/ProcessReconciliationJob.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/process/ProcessAggregateLockResolver.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/process/DependencyFailureRecorder.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/process/EmbeddedPackageContractTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/process/FlowableProcessWorkflowIntegrationTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/process/DependencyFailureRecorderIntegrationTest.kt`

- [ ] **Step 1: Write failing package contract tests**

Assert exact 12-stage keys, forms, hard gates, no scripts/unsafe expressions, stage-8 three-way fork/join, conditional follow-up, hashes, and every regression scenario's expected activity/blocker/event sequence.

- [ ] **Step 2: Run package tests and confirm RED**

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.process.EmbeddedPackageContractTest" --rerun-tasks`

Expected: FAIL because package assets are absent.

- [ ] **Step 3: Add immutable package resources**

Use a synchronous executable process with stable keys. The stage-8 shape must be:

```xml
<parallelGateway id="stage8-fork"/>
<receiveTask id="procurement-wait" name="Procurement and manufacturing wait"/>
<userTask id="firmware-scaffold" name="Firmware scaffold"/>
<userTask id="test-plan" name="Test plan"/>
<parallelGateway id="stage8-join"/>
```

Generate and record SHA-256 values after content stabilizes; every manifest hash must be a real digest of the committed asset.

Extend `EmbeddedWorkflowCatalogInstaller` with `installPackage(manifest)` and invoke it from the same startup runner after prerequisite types. It must install/verify workflow and every form definition from committed resources and fail startup on hash/content drift.

- [ ] **Step 4: Write failing process transaction tests**

Tests: deploy exact binding; deterministic participant start; duplicate/concurrent start; suspend/resume/cancel/fail; participant transfer; wait release; reconciliation; stage-8 join; Flowable exception rollback; distinct datasource/transaction manager startup rejection.

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.process.FlowableProcessWorkflowIntegrationTest" --rerun-tasks`

Expected: compilation FAIL because the process adapter and commands are absent.

- [ ] **Step 5: Implement process ports, adapter, commands, queries, and job**

```kotlin
interface ProcessEnginePort {
    fun deploy(asset: ProcessAsset): DeploymentBinding
    fun start(binding: DeploymentBinding, businessKey: String): EngineProcessSnapshot
    fun suspend(engineId: String)
    fun activate(engineId: String)
    fun cancel(engineId: String, reasonCode: String)
    fun signalWait(engineId: String, activityKey: String)
    fun snapshot(engineId: String): EngineProcessSnapshot
}
```

Only the Flowable adapter imports Flowable classes. Synchronize OCC projections, relationships, audit, notifications, and events before transaction commit.

Implement `DependencyFailureRecorder` with a `REQUIRES_NEW` transaction invoked only after the business transaction rolls back. Tests must prove a safe bounded row is stored, business writes remain absent, exception text is excluded, and recorder failure produces only a structured redacted operations log.

- [ ] **Step 6: Run process tests**

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.process.*"`

Expected: PASS, real PostgreSQL/Flowable tests 0 skipped when Docker is available.

- [ ] **Step 7: Commit process assets and module**

```powershell
git add services/core/src/main/resources/domain-packages services/core/src/main/kotlin/com/innorder/occ/process services/core/src/test/kotlin/com/innorder/occ/process
git commit -m "feat(core): add pilot Flowable process workflow"
```

### Task 10: Task Commands, Gates, And API

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/task/TaskEnginePort.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/task/FlowableTaskAdapter.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/task/TaskCommands.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/task/TaskCrossSliceServices.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/task/TaskQueryService.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/task/TaskController.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/task/TaskCommandIntegrationTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/task/TaskConcurrencyIntegrationTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/task/TaskQueryIntegrationTest.kt`

- [ ] **Step 1: Write failing task command and concurrency tests**

Cover candidate-only claim, one claim winner, assignee-only completion, no Flowable call while blocked, missing/stale provider `503`, source fact/blocker atomic refresh, accepted/rejected/conditional review, complete/cancel and review/cancel lock ordering, task fail path, successor event versions, and replay after revocation.

- [ ] **Step 2: Run command tests and confirm RED**

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.task.TaskCommandIntegrationTest" --tests "com.innorder.occ.task.TaskConcurrencyIntegrationTest" --rerun-tasks`

Expected: compilation FAIL because task engine commands do not exist.

- [ ] **Step 3: Implement task domain and Flowable adapter**

```kotlin
interface TaskEnginePort {
    fun claim(engineTaskId: String, principalId: UUID)
    fun complete(engineTaskId: String, variables: Map<String, Any?> = emptyMap())
    fun synchronize(processEngineId: String): List<EngineTaskSnapshot>
}
interface TaskGateFactWriter { fun write(input: TaskGateFactWrite): TaskGateSnapshot }
interface TaskSubmissionCommandService { fun submit(input: TaskSubmissionInput): TaskSubmissionResult }
interface TaskReviewCommandService { fun review(input: TaskReviewInput): TaskReviewResult }
```

Keep Flowable IDs internal and allowlist completion variables/outcomes.

- [ ] **Step 4: Implement task commands and persisted gate services**

All task mutations declare process then task lock refs. Gate fact writes use the same transaction and review facts append submission/decision rows. Conditional advancement creates the BPMN follow-up task.

- [ ] **Step 5: Run command tests and confirm GREEN**

Run the Step 2 command.

Expected: PASS, including real Flowable/PostgreSQL concurrency cases.

- [ ] **Step 6: Implement task queries and event catch-up**

Use shared `CursorCodec`. Implement My Work, task detail/history/blockers, and authorized event catch-up without totals; notifications were completed in Task 8.

- [ ] **Step 7: Run task tests**

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.task.*" --tests "com.innorder.occ.notification.*"`

Expected: PASS.

- [ ] **Step 8: Commit task command modules**

```powershell
git add services/core/src/main/kotlin/com/innorder/occ/task services/core/src/test/kotlin/com/innorder/occ/task
git commit -m "feat(core): add governed task workflow commands"
```

### Task 11: Role-Aware End-To-End Workflow API

**Files:**
- Create: `services/core/src/test/kotlin/com/innorder/occ/api/WorkflowDtoContractTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/api/CohortProcessTaskApiJourneyIntegrationTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/api/WorkflowRaceIntegrationTest.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/api/ApiExceptionHandler.kt`

- [ ] **Step 1: Write failing Kotlin/OpenAPI parity tests**

Use shared JSON fixtures to assert exact fields/enums/nullability, unknown-field rejection, stable Problem Details, and no Flowable identifiers.

- [ ] **Step 2: Write the complete teacher/participant journey**

Test a teacher creates a cohort, adds participants, starts one process each, and a participant lists, claims, is blocked, and completes eligible work. Assert teacher/participant/outsider/admin visibility and one audit plus expected aggregate events per transition.

- [ ] **Step 3: Write duplicate, stale, race, and dependency-failure journeys**

Cover same/different idempotency body, duplicate start keys, concurrent claim, stale versions, authorization revocation, cancellation races, Flowable rollback, OPA down/malformed, and Kafka-unavailable Outbox accumulation.

- [ ] **Step 4: Run API tests and confirm RED**

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.api.Workflow*" --rerun-tasks`

Expected: FAIL on missing controller/error mappings or behavioral mismatch.

- [ ] **Step 5: Implement minimal DTO and error mapping corrections**

Map only stable codes from the design; preserve generic 404/403 data minimization and current-version 409 responses.

- [ ] **Step 6: Run focused and full Core tests**

Run: `.\gradlew.bat :services:core:test --tests "com.innorder.occ.api.Workflow*"`

Expected: PASS.

Run: `.\gradlew.bat :services:core:test`

Expected: PASS; Docker-dependent tests may skip only in this local pre-gate run.

- [ ] **Step 7: Commit API acceptance tests and fixes**

```powershell
git add services/core/src/main/kotlin/com/innorder/occ/api services/core/src/test/kotlin/com/innorder/occ/api
git commit -m "test(core): prove process task workflow journeys"
```

### Task 12: Mandatory Verification Gate And Reviews

**Files:**
- Modify: `scripts/verify.test.mjs`
- Modify: `scripts/verify.mjs`

- [ ] **Step 1: Write the failing verifier self-test**

Assert full mode explicitly runs `database/tests/postgresql-process-task.test.mjs` and `database/tests/postgresql-workflow-races.test.mjs`, and selects/parses JUnit XML for `ProcessTaskSchemaIntegrationTest`, `FlowableProcessWorkflowIntegrationTest`, `TaskConcurrencyIntegrationTest`, and `CohortProcessTaskApiJourneyIntegrationTest`, rejecting missing/zero/skipped/failed results.

- [ ] **Step 2: Run verifier tests and confirm RED**

Run: `npm run test:verify`

Expected: FAIL because workflow suites are not mandatory.

- [ ] **Step 3: Register workflow suites in full verification**

Add exact Gradle `--tests` selectors and result XML names to `scripts/verify.mjs`; full mode must invoke both deterministic workflow PostgreSQL Node runners, while local mode may report an explicit Docker skip. Do not weaken any existing gate.

- [ ] **Step 4: Run focused complete verification**

Run: `npm run test:database`

Expected: PASS.

Run: `npm run test --workspace @innorder/contracts`

Expected: PASS.

Run: `npm run test:verify`

Expected: PASS.

Run: `.\gradlew.bat :services:core:test --dependency-verification strict`

Expected: PASS.

- [ ] **Step 5: Dispatch two-stage review and fix every finding**

First dispatch a specification reviewer against the design and this plan; after fixes and focused tests, dispatch a code-quality reviewer against the branch diff. Repeat each review until no blocking findings remain.

- [ ] **Step 6: Commit reviewed fixes by ownership boundary**

Inspect `git status` and `git diff`, rerun each affected focused gate, then stage only related files. Use one or more non-empty commits with messages matching the affected boundary, for example `fix(core): close workflow review findings` or `fix(contracts): align workflow review contracts`. Do not mix schema, contracts, or domain fixes solely to make the tree clean.

- [ ] **Step 7: Run the strict full gate**

Run: `npm run verify:full`

Expected: `full verification passed`; all required JUnit files contain tests with `failures=0`, `errors=0`, and `skipped=0`.

- [ ] **Step 8: Commit gate registration**

```powershell
git add scripts/verify.mjs scripts/verify.test.mjs
git commit -m "test: require workflow integration release gates"
```

- [ ] **Step 9: Produce integration evidence**

Record branch/worktree, ordered commits, V013 objects, OpenAPI endpoints, typed events, focused and full test counts, exact `verify:full` result, residual risks, and cherry-pick/conflict instructions for agent 06. Confirm `git status --short` is empty and do not merge another workstream.
