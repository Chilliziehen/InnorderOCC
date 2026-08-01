# Process And Task Workflow Design

## Purpose

This design delivers the complete cohort, process, and task vertical slice for the deployable pilot. It extends the existing security command kernel without bypassing its authorization, idempotency, audit, optimistic-concurrency, transaction, or Outbox guarantees.

The slice is complete when a process owner can create a package-bound cohort, manage memberships, and idempotently start one Flowable process per participant; a participant can query, claim, and complete valid work; and all lifecycle, projection, authorization, retry, concurrency, and dependency-failure paths are deterministic and tested against real PostgreSQL, Flowable, OPA, and Outbox infrastructure.

## Authority And Scope

The deployable pilot product design is authoritative where it conflicts with older specifications. In particular, task presentation state is a rebuildable OCC projection and not a Flowable lifecycle extension.

This branch owns:

- `V013__process_task_workflow.sql` and its schema verification.
- Focused `cohort`, `process`, and `task` Core packages.
- The included `embedded-medical-device-pilot` package's process assets, form references, and workflow regression fixtures.
- Cohort/process/task OpenAPI, Zod, Kotlin DTO, event, policy, and API test parity.
- The minimal shared command-kernel and authorization-snapshot extensions needed by this slice.
- Persistent task notifications and query support needed by the slice.

This branch does not own evidence object storage or reviews, risk/resource internals, AI, desktop screens, or deployment automation. Those modules integrate through the ports and events defined here.

## Selected Architecture

Three approaches were considered:

1. Store all eight presentation states directly in Flowable. This is small but violates the product decision that Flowable lifecycle and OCC presentation are separate truths.
2. Treat one process and all its tasks as one aggregate. This avoids a command-kernel extension but creates coarse locking, weak task concurrency, and misleading aggregate events.
3. Keep cohort, process, and task as separate aggregates, use Flowable as execution truth, synchronously update OCC projections, and extend the kernel only where a command legitimately emits changes for multiple aggregates.

Approach 3 is selected. It preserves module ownership, enables independent optimistic concurrency, supports exact aggregate event ordering, and keeps projections rebuildable.

## Module Boundaries

### Cohort

The `cohort` package owns cohort lifecycle, package-version binding, owner, dates, memberships, participant start eligibility, archival, and cohort read models. It does not call Flowable. Starting participants delegates one participant at a time to the process application port.

### Process

The `process` package owns process-definition deployment bindings, process-instance lifecycle, participant binding, route progress, process history, and reconciliation. Its Flowable adapter exposes domain values only and is the only process-instance/definition code that calls Flowable APIs.

### Task

The `task` package owns synchronized task lifecycle projections, candidate and assignee relationships, blockers, presentation-state derivation, task history, My Work, and task commands. Its Flowable adapter is the only task code that calls Flowable task APIs.

### Shared Ports

- `ParticipantProcessStarter` starts exactly one participant and returns an existing result on a valid idempotent replay.
- `TaskGateFactWriter` is the only cross-slice gate contract. Evidence and resource source-fact commands use it in the same Core transaction to persist structured blockers and provider readiness without depending on Flowable. Every published activity declares required provider keys. Missing, `UNAVAILABLE`, or `STALE` required provider state fails closed with `OCC_TASK_GATE_UNAVAILABLE`; it is never interpreted as no blockers.
- `TaskSubmissionCommandService` is called by evidence submission in the same Core transaction. It records the immutable evidence version reference, monotonic review sequence, prior assignee, and `PENDING_REVIEW` projection with one shared idempotency result. Repeated submission replays the same projection; a different evidence version requires a new key and sequence.
- `TaskReviewCommandService` is called by the evidence review application command in the same Core transaction. Its strict input contains task, evidence, evidence-version and review IDs and versions, actor, idempotency key, decision, prior assignee, optional follow-up due date, and published conditional-advance rule version. It owns the resulting Flowable task transition and task projection; evidence owns the immutable review fact. It never exposes a generic Flowable return command.
- `ProcessWaitReleasePort` correlates an allowlisted package wait key and immutable procurement/resource fact to a Flowable receive task. A process owner may also use the same command through the public API with a required audited reason.
- `NotificationWriter` stores recipient notifications in the command transaction. Other slices may call it without owning notification persistence.

No module outside `process` and `task` receives a Flowable type or identifier.

## Data Model

`V013` is forward-only and does not edit V001-V012.

### Cohort Aggregate

`occ.cohort` contains:

- `id`, also an `authz.entity`.
- `customer_instance_id`, normalized `code`, `name`, and immutable `package_version_id`.
- authoritative `owner_principal_id`, `start_date`, optional `end_date`.
- `status` in `DRAFT`, `ACTIVE`, `ARCHIVED`.
- `row_version`, audit timestamps, creator/updater, and `archived_at`.

The database enforces unique `(customer_instance_id, code)`, normalized code, valid date order, package immutability after creation, and archived timestamp consistency. `owner_principal_id` is authoritative; exactly one active `COHORT_OWNER` relationship is a database-maintained authorization projection and must equal that column. Ownership transfer is a dedicated versioned command that changes both values under one authorization revision lock. `DRAFT -> ACTIVE -> ARCHIVED` is the only lifecycle. The first successful participant start activates a draft cohort. Archival is terminal and requires no non-terminal process.

### Membership

Membership is represented by `authz.relationship` using stable relation definitions for `COHORT_OWNER`, `COHORT_TEACHER`, and `COHORT_PARTICIPANT`. Validity is always `valid_from <= transaction_timestamp()` and `valid_until IS NULL OR valid_until > transaction_timestamp()`.

Membership removal closes the relationship validity window and sets `revoked_at` to the same command timestamp. V013 drops `uq_relationship_active` and replaces it with a GiST exclusion constraint over relation definition, subject, object, and the effective half-open range ending at the earliest of `valid_until` or `revoked_at`. This permits a non-overlapping replacement after natural expiry or revocation while preventing overlapping duplicate authority. Subject/object lookup indexes remain optimized for current non-revoked rows.

Removal prevents future process starts and assignments but does not alter an existing process. Existing processes require the explicit transfer command below or cancellation.

### Definition Binding

The existing `occ.process_definition_binding` gains constraints that prove the workflow definition and binding belong to the same package version. A binding is immutable after insertion and unique by package version and BPMN key. The adapter validates deployment content hash, definition key, definition version, and tenant-independent configuration before storing the binding.

### Process Instance

The existing `occ.process_instance` gains required `cohort_id`, immutable `started_for_participant_id`, current `participant_id`, plus stable route metadata. `UNIQUE(cohort_id, started_for_participant_id)` is the concurrency-safe start idempotency boundary. Transfer rejects a target that already has a process in that cohort. A composite foreign key ensures cohort, definition binding, and process use one package version.

Process states remain `RUNNING`, `SUSPENDED`, `COMPLETED`, `CANCELLED`, and `FAILED`. Valid transitions are:

- `RUNNING -> SUSPENDED | COMPLETED | CANCELLED | FAILED`
- `SUSPENDED -> RUNNING | CANCELLED | FAILED`

Terminal states cannot change. Terminal states require `ended_at`; active states forbid it.

### Task Projection

The existing `occ.task_projection.state` remains the engine lifecycle and is forward-adjusted to `AVAILABLE`, `CLAIMED`, `COMPLETED`, `CANCELLED`, and `FAILED`. It gains activity name, assignee, form key, task timestamps, failure code, and internal engine execution ID. `flowable_task_id` is unique for the lifetime of the deployment; `(process_instance_id, flowable_execution_id, activity_key, created_at)` identifies repeated or multi-instance activity occurrences. These engine identifiers remain internal and never enter APIs or events.

`occ.task_blocker` stores one current or resolved structured blocker per task/source/code, including source entity, severity, created time, resolved time, and safe metadata. Approved blocker codes are:

- `PREREQUISITE_UNSATISFIED`
- `EVIDENCE_REQUIRED`
- `EVIDENCE_REVIEW_PENDING`
- `EVIDENCE_RETURNED`
- `RESOURCE_REQUIRED`
- `RESOURCE_CONFLICT`
- `PROCESS_SUSPENDED`
- `PROCESS_CANCELLED`
- `POLICY_DENIED`
- `GATE_PROVIDER_UNAVAILABLE`

`occ.task_gate_requirement` copies each activity's required provider keys from the immutable package at process start. `occ.task_gate_provider_state` records provider status (`READY`, `UNAVAILABLE`, `STALE`), latest source entity/version, and refresh time per task/provider. Evidence/resource fact commands lock their source after process/task, then call `TaskGateFactWriter` to atomically upsert or resolve blocker rows and provider state with that exact source row version. A later source mutation must update provider state in the same transaction; database trigger/contract tests reject a source transition that omits its gate update. Provider failures explicitly write `UNAVAILABLE`; reconciliation marks unverifiable source references `STALE`.

Completion locks the process and task and reads these same persisted rows; it does not call a provider or make a second eventually-consistent decision. A missing required provider row or non-`READY` status creates `GATE_PROVIDER_UNAVAILABLE` and returns `503 OCC_TASK_GATE_UNAVAILABLE`; an active business blocker returns `409 OCC_TASK_BLOCKED`. Therefore My Work, detail, and completion use one transaction snapshot. Reconciliation may refresh projections only from authoritative provider facts and records every correction.

The task response derives presentation state in this strict precedence:

1. Engine `COMPLETED`, `CANCELLED`, or `FAILED`.
2. The highest immutable review sequence for the current evidence submission yields `PENDING_REVIEW` or, for rejected/conditional decisions, `RETURNED` to the recorded prior assignee. A conditional return also carries its required follow-up due date and published conditional-advance rule version.
3. Any active hard blocker gives `BLOCKED`.
4. Engine `CLAIMED` gives `CLAIMED`.
5. Otherwise `AVAILABLE`.

`occ.task_timeline` records immutable bounded facts for lifecycle, assignment, blocker, and review projection changes. Process and cohort timelines are composed by stable cursor queries over immutable facts and audit references.

`occ.task_review_projection_fact` is owned by V013 and is an append-only fact stream. A `SUBMITTED` row stores task ID, immutable evidence/evidence-version reference, monotonic per-task review sequence, submission idempotency reference, prior assignee, and creation time. Exactly one optional `DECIDED` row for that submission stores immutable review ID/version, decision (`ACCEPTED`, `REJECTED`, `CONDITIONAL`), follow-up due date, conditional-rule version, and decision time. The decision row references the submission row; no row is updated.

Evidence and review IDs are stable cross-slice UUID references; V014 may add stronger foreign keys after its schema is present. Unique `(task_id, review_sequence, fact_kind)`, unique submission `(task_id, evidence_version_id)`, and unique non-null `review_id` constraints permit one submission plus one decision while making retries and latest-fact selection deterministic.

### Notifications

`occ.notification` stores recipient, type, severity, resource type/id, event id, monotonically increasing cursor, created time, and read time. `(recipient_id, event_id, type)` is idempotent. Read state only moves from null to a timestamp. SSE uses the cursor but is not an authority; missed items remain queryable.

## Command Kernel Extension

The current kernel correctly owns transaction, authorization, idempotency, audit, and Outbox but assumes every event belongs to the command descriptor's aggregate. Task completion may update a task and process and create successor tasks.

All domain and cross-slice commands obey one lock order: authorization revision, cohort, process, tasks sorted by UUID, then evidence/resource facts sorted by UUID. A command that may change membership, owner, candidate, or assignee relationships requests the exclusive authorization revision lock before snapshot construction and increments the revision exactly once. There is no shared-to-exclusive lock upgrade. Task completion locks the process before its task, verifies both versions/states, then declares one version increment for each changed aggregate. Process cancellation uses the same order and locks active tasks by UUID, preventing lost updates and deadlocks in complete/cancel races.

The kernel replaces `AuthorizedCommand.lockCurrentVersion` with a predeclared `lockPlan()` containing every existing aggregate reference affected by the request. The executor validates and globally sorts the plan, then resolves every lock before command execution. An extensible `AggregateLockRegistry` has allowlisted resolver beans registered by each owning module; this branch provides cohort/process/task resolvers, while evidence/resource modules register their own before calling cross-slice services. A resolver executes the canonical `SELECT ... FOR UPDATE`, records the returned row version, and rejects missing, duplicate, or undeclared locks. Thus an evidence-primary command declares process, task, and evidence while the executor still locks them in global order.

Mutation validation accepts existing aggregate changes only when their before-version exactly matches this immutable registry. Newly created aggregate IDs are declared separately and use baseline version zero. Domain repositories cannot submit an unregistered secondary aggregate version. Existing single-aggregate commands migrate mechanically to a one-entry lock plan and retain behavior.

`PendingEventSpec` will carry explicit aggregate type, ID, and version. `CommandMutation` will carry a bounded list of aggregate changes. Validation will require:

- The primary descriptor aggregate is present and matches the mutation response.
- Each aggregate appears once in the change set.
- Versions are safe integers and strictly increase from the command-locked version or an explicitly supplied newly-created baseline.
- Events reference a declared aggregate change and are strictly ordered per aggregate.
- Every event type and payload passes existing minimization policy.
- Authorization-changing namespaces still require the exclusive authorization revision lock.

Audit remains one command record with a bounded summary of affected aggregate references. Outbox receives each event with its own aggregate identity. Existing single-aggregate commands retain their behavior through the same model, not a second path.

Creation commands authorize against an existing parent resource. Cohort creation targets the authenticated customer-instance root; process creation targets the cohort; task creation is an internal consequence of the already-authorized process command. Newly created entities are inserted only after authorization succeeds.

Idempotency acquisition may find a stored response before authorization, but the kernel never returns it directly. Every replay rebuilds a fresh authorization snapshot for the original action/entity/resource and returns the response only after allow. A revoked or disabled caller receives the current authorization denial and cannot recover historical response contents; the immutable original result remains stored for a later authorized retry.

The adapters use only embedded Flowable Java APIs configured with Core's PostgreSQL datasource and Spring transaction manager. Startup fails when Flowable has a distinct datasource or transaction manager. No REST or remote Flowable adapter is supported by this release.

## Authorization

Stable actions are explicit and do not use partial wildcards:

- `cohort.create`, `cohort.read`, `cohort.update`, `cohort.owner.transfer`, `cohort.members.manage`, `cohort.archive`, `cohort.process.start`
- `process.read`, `process.suspend`, `process.resume`, `process.cancel`, `process.fail`, `process.transfer`, `process.reconcile`, `process.wait.release`
- `task.read`, `task.claim`, `task.complete`, `task.fail`, `task.assignment.manage`

The authorization snapshot remains transaction-consistent and gains bounded active relationship facts relevant to the principal, entity, and resource. It maps cohort owner/teacher/participant and task candidate/assignee relationships into strict grants or structured context accepted by contract version 2. The OPA policy validates contract version, applies default deny, rejects stale release/revision data, and enforces:

- Process owners can manage only cohorts they own or teach.
- Participants can read their cohort/process and claim only active candidate tasks.
- Participants can complete only their own claimed task while the process runs and hard blockers are absent.
- Modelers manage definitions but do not operate process instances.
- Administrators receive no implicit teaching or task authority.

Queries apply the same active relationship predicates in SQL, so list membership and counts do not leak unauthorized entities. Commands still pass through the existing OPA decision path; SQL filtering is not treated as command authorization.

Membership, candidate, assignee, and ownership mutations set `changesAuthorizationFacts=true`, acquire the exclusive revision lock before authorization snapshot construction, and increment the revision in the same transaction. Start, claim, complete, cancel, fail, review, assignment, and reconciliation commands conservatively use this mode whenever their possible Flowable result can change candidates or assignees.

## Command Flows

### Create Cohort

1. Parse and strictly validate the request and metadata.
2. Acquire idempotency ownership and authorization snapshot on the customer-instance root.
3. Insert `authz.entity`, cohort, and owner/teacher relationships.
4. Insert audit, `cohort.created`, and owner notification.
5. Complete the idempotency record and commit.

### Start Participant Process

Each participant is one command and one transaction. A batch endpoint is a bounded orchestrator returning one result per participant; it does not claim all-or-nothing semantics.

1. Lock cohort, validate expected version, active membership, dates, package publication, and definition binding.
2. Check the unique cohort/participant process binding.
3. Call Flowable start with deterministic business key `cohort:{cohortId}:participant:{participantId}`.
4. Insert process entity/projection and synchronize initial Flowable tasks, candidate relationships, timeline, and notifications.
5. Activate a draft cohort if needed.
6. Write aggregate events, command audit, and idempotency result and commit.

Flowable failure rolls back all OCC, authorization, business audit, idempotency, notification, and Outbox writes. After rollback, the bounded dependency-error recorder writes a separate redacted attempt record containing command key, principal, target, correlation ID, dependency code, and safe failure category; it never stores exception text. If that independent write also fails, the request remains failed and a structured redacted error is emitted to operations logging.

Start idempotency has four explicit outcomes:

- Same idempotency key and same body replays the stored success and sets `X-Idempotent-Replay: true`.
- Same key and different body returns `409 OCC_IDEMPOTENCY_CONFLICT`.
- A different key after the participant process already exists returns `409 OCC_PARTICIPANT_PROCESS_EXISTS` with the authorized existing process ID.
- Concurrent different keys serialize on the cohort row; one starts Flowable and the loser observes the existing row and returns the same `409`. The deterministic Flowable business key is also unique, but the database check occurs before the Flowable call.

### Transfer Cohort Ownership

`POST /api/v1/cohorts/{cohortId}/owner` requires `cohort.owner.transfer`, cohort expected version, an active teacher target, idempotency key, and audited reason. It locks cohort and old/new principal facts, updates authoritative `owner_principal_id`, closes the old `COHORT_OWNER` relationship, creates the sole replacement relationship, increments authorization revision once, and emits `cohort.owner-transferred`. Existing process/task ownership and history remain unchanged; participant process transfer is separate.

### Claim Task

1. Lock process, then task, and validate expected task version and running process state.
2. Reauthorize active candidate relationship.
3. Call Flowable claim.
4. Synchronize engine lifecycle, assignee relationship, presentation projection, timeline, notification, audit, and `task.claimed`.

Only one concurrent claimant succeeds. A stale claimant receives `409` with current version. A Flowable conflict is mapped to the same stable conflict response after synchronized reread.

### Complete Task

1. Lock process, then task, and validate expected task version, assignee, process state, and persisted gate facts.
2. Reject active hard blockers with stable blocker details without calling Flowable.
3. Call Flowable complete with a strict allowlisted variable map.
4. Mark the old task complete; synchronize successor tasks, candidates, process completion, timelines, notifications, and events from Flowable within the same transaction.
5. Commit one command audit and all aggregate events atomically.

Evidence submission reaches `PENDING_REVIEW` through `TaskSubmissionCommandService`, atomically recording the submitted evidence version, review sequence, and prior assignee while leaving the Flowable user task active. Review then uses `TaskReviewCommandService`. Both evidence commands lock process, task, then evidence in the global order and supply one idempotency key covering evidence and task consequences. `ACCEPTED` completes the Flowable task only when all hard providers allow it. `REJECTED` leaves the Flowable task active and restores the prior assignee with `RETURNED`. `CONDITIONAL` does the same with a required due date unless the versioned package rule explicitly permits advancement, in which case it completes Flowable and creates follow-up work atomically.

Cancellation and review race solely on the process lock. If cancellation commits first, submission/review wakes, observes terminal process state, and returns `409 OCC_PROCESS_NOT_RUNNING` without a new review fact. If submission/review commits first, cancellation wakes and cancels the resulting active or successor tasks; it never rewrites the committed immutable review. There is no attempt to cancel another transaction's uncommitted review. Retries replay both evidence and task consequences. `RETURNED` is never a generic task command.

### Suspend, Resume, Cancel, And Fail

Process lifecycle commands lock the process, call the matching embedded Flowable operation, synchronize all active task presentation states and blockers, write reason-bearing audit/events, and commit atomically. Cancellation uses Flowable process-instance deletion with an allowlisted cancellation code, removes future availability, and retains Flowable/OCC history. Process failure uses the same engine termination primitive with a distinct allowlisted failure code and maps the OCC terminal state to `FAILED`.

Every included user task has an explicit BPMN outcome gateway. `task.fail` completes the engine task with the allowlisted internal outcome `FAILED`, takes the failure path to process termination, and atomically records task/process `FAILED`; clients cannot submit arbitrary Flowable variables or outcome names. This avoids an OCC-only terminal state that disagrees with the engine. Failure records a stable bounded code and operator-safe reason; it never stores stack traces or secrets.

### Release Package Wait

Stage 8 uses a Flowable receive task with stable correlation key `procurement-wait`. `POST /api/v1/processes/{processId}/waits/{activityKey}/release` requires `process.wait.release`, expected process version, idempotency key, an allowlisted completion fact type/reference, and an audited reason. `ProcessWaitReleasePort` verifies that the process is waiting at the key and that the referenced resource/procurement fact is current, then sends the embedded Flowable signal and synchronizes the parallel join. Duplicate correlation is an idempotent replay; an unknown or already-consumed wait returns `409 OCC_WAIT_NOT_ACTIVE`.

### Transfer Participant Process

`POST /api/v1/processes/{processId}/transfer` requires `process.transfer`, expected process version, active target cohort membership, target participant ID, and an audited reason. It locks cohort, process, active tasks, old/new participant facts in global order; rejects terminal processes and a target with any process in the cohort; updates only current `participant_id`; closes old participant/candidate/assignee relationships; and creates target participant/candidate relationships. Claimed active tasks become `AVAILABLE` for the target rather than silently preserving the old assignee. Flowable candidate/assignee mirrors are updated in the same transaction. Immutable `started_for_participant_id`, prior task timelines, actor references, and history remain unchanged. The command increments authorization revision once and emits `process.transferred` plus affected task assignment events.

### Reconciliation

Reconciliation is an authorized, idempotent application command. It reads embedded Flowable definition/runtime/history truth, pairs runtime and historic tasks by internal Flowable task ID and execution/activity occurrence, compares OCC projections, and applies only derivable repairs. Missing active engine tasks create projections; engine-completed tasks close matching projections; engine assignment updates only its mirrored assignee relationship. Ambiguous matches fail closed for operator intervention. Reconciliation cannot invent assignments absent from Flowable, reviews, evidence, or blocker facts. Every repair is audited and emits a projection-reconciled event.

The internal scheduled job invokes this same application command for each active process with a deterministic idempotency key derived from process ID, engine snapshot digest, and schedule window. Process owners may invoke the manual endpoint. No separate ungoverned repair path exists.

## Included Process Assets

The branch includes immutable resources for package `embedded-medical-device-pilot` version `1.0.0`:

- A manifest with hashes and stable identifiers.
- `medical-device-development-v1.bpmn20.xml` containing all 12 ordered stages.
- Stage 8 parallel firmware-scaffold and test-plan work while procurement/manufacturing waits.
- Strict form JSON Schemas and UI metadata references for the included forms.
- Safe deterministic rule metadata for hard gates; evidence/risk/resource internals consume these definitions in their own slices.
- Regression scenario fixtures for happy path, review return/resubmission, conditional evidence, safety failure, parallel wait work, resource conflicts, severe electrical risk, package rejection, and AI-disabled completion.

The activity contract is:

| Stage | Stable activity key | Form/gate contract | Route expectation |
| --- | --- | --- | --- |
| 1 | `baseline-onboarding` | `baseline-skills` | sequential |
| 2 | `safety-qualification` | `safety-checklist`, hard `safety-qualified` | sequential |
| 3 | `requirements-definition` | `intended-use`, `requirements`, hard `requirements-approved` | sequential |
| 4 | `architecture-hazards` | `architecture`, `hazards` | sequential |
| 5 | `bom-procurement` | `bill-of-materials` | sequential |
| 6 | `schematic-review` | `design-review`, hard `schematic-reviewed` | sequential |
| 7 | `pcb-manufacturing-handoff` | hard `design-rules-clean` | sequential |
| 8a | `procurement-wait` | wait signal | parallel fork branch |
| 8b | `firmware-scaffold` | task form | parallel fork branch |
| 8c | `test-plan` | task form | parallel fork branch, all branches join |
| 9 | `hardware-bring-up` | `power-up`, hard `power-up-signed` | sequential |
| 10 | `calibration-integration` | `calibration`, hard `calibration-data` | sequential |
| 11 | `requirements-verification` | `verification`, hard `verification-matrix` | sequential |
| 12 | `final-acceptance` | `final-review`, hard `final-report-demo` | terminal acceptance |

Each regression fixture declares input facts, expected activity sequence, expected parallel tokens/join, blocker codes, terminal state, and aggregate event sequence. The formal package route always requires its declared gate providers and fails closed if another workstream is absent. A test-only no-gate process may be used for isolated adapter unit tests but is not published and cannot satisfy route acceptance.

Package rules identify the non-critical gates that permit conditional advancement. Each conditional outcome enters a parallel gateway: one branch advances normally and the other creates `conditional-follow-up-{sourceActivityKey}` for the prior assignee, with form key `conditional-follow-up` and the reviewed due date. The branch rejoins before final acceptance, so normal work can advance while unresolved follow-up still prevents process completion. Creation emits `task.available`; completion emits `task.completed`; cancellation/failure uses normal task semantics. Hard gates never expose this route.

The BPMN uses synchronous user tasks and gateways in the pilot. It does not enable asynchronous continuations or arbitrary expressions/scripts. Deployment verifies exact hashes and expected task/activity/form/gate/candidate keys.

## API And Contract Design

All command bodies are strict objects. Commands require `Idempotency-Key`; updates require `expectedVersion` in the body. Successful replays set `X-Idempotent-Replay: true`. Errors use existing Problem Details plus stable codes.

Primary endpoints are:

- `POST /api/v1/cohorts`, `GET /api/v1/cohorts`, `GET/PATCH /api/v1/cohorts/{cohortId}`
- `POST/DELETE /api/v1/cohorts/{cohortId}/members`, `POST /api/v1/cohorts/{cohortId}/archive`
- `POST /api/v1/cohorts/{cohortId}/participants/{participantId}/process`
- `POST /api/v1/cohorts/{cohortId}/owner`
- `GET /api/v1/processes`, `GET /api/v1/processes/{processId}`
- `GET /api/v1/processes/{processId}/progress|participants|tasks|timeline`
- `POST /api/v1/processes/{processId}/suspend|resume|cancel|fail`
- `POST /api/v1/processes/{processId}/transfer`
- `POST /api/v1/processes/{processId}/reconcile` for authorized manual repair; the scheduler uses the same command.
- `POST /api/v1/processes/{processId}/waits/{activityKey}/release`
- `GET /api/v1/tasks/my-work`, `GET /api/v1/tasks/{taskId}`, `GET /api/v1/tasks/{taskId}/history`
- `POST /api/v1/tasks/{taskId}/claim|complete|fail`
- `GET /api/v1/tasks/{taskId}/blockers`
- `GET /api/v1/me/notifications`, `POST /api/v1/me/notifications/{notificationId}/read`
- `GET /api/v1/events` for authorized SSE-relevant event catch-up; live SSE transport may use the same cursor contract.

Growing lists use authenticated opaque cursors over a versioned canonical JSON tuple and deterministic `(sort_timestamp DESC, id DESC)` seek order. The cursor contains subject ID, endpoint, normalized filter/sort digest, last tuple, issued time, and key ID, authenticated with a file-backed rotating HMAC key. Current and previous keys overlap for 24 hours; cursors expire after 24 hours and cannot be reused by another subject or filter. Default page size is 25 and maximum is 100. Invalid, expired, cross-subject, cross-filter, bad-signature, or oversized cursors return `400`; responses do not expose total counts.

Process filters are cohort, participant, state, package version, and updated-before; task filters are presentation state, process, cohort, due-before, blocker code, and updated-before. Notification filters are unread, type, severity, and created-before. Every list is authorization-filtered before seek pagination. Process owners see owned/taught cohorts; participants see only their own process/tasks; administrators and modelers have no implicit visibility. Blockers are embedded in task detail and independently pageable through the blocker endpoint. Event catch-up returns only events whose resource is currently visible to the caller.

OpenAPI, Zod, and Kotlin share exact field names, enums, bounds, nullability, unknown-field rejection, and safe-integer constraints. Typed event payload schemas are registered for every cohort/process/task event. Flowable IDs and types are absent from public contracts.

## Events

Events use lowercase dot-separated names and schema version 1:

- `cohort.created`, `cohort.updated`, `cohort.owner-transferred`, `cohort.member-added`, `cohort.member-removed`, `cohort.activated`, `cohort.archived`
- `process.started`, `process.suspended`, `process.resumed`, `process.transferred`, `process.completed`, `process.cancelled`, `process.failed`, `process.projection-reconciled`
- `task.available`, `task.claimed`, `task.assignee-changed`, `task.blocked`, `task.pending-review`, `task.returned`, `task.completed`, `task.cancelled`, `task.failed`, `task.projection-reconciled`

Payloads contain stable IDs, state/code, package version, and safe timestamps only as required. They exclude names, email addresses, form/evidence content, Flowable identifiers, credentials, and arbitrary exception text.

## Error Semantics

- Validation and malformed cursor: `400` with `OCC_INVALID_REQUEST` or `OCC_INVALID_CURSOR`.
- Missing authentication: `401`.
- OPA deny: `403` with `OCC_FORBIDDEN`; no resource detail.
- Missing or invisible resource: `404` with `OCC_NOT_FOUND`.
- Duplicate code, stale version, claim race, existing participant process, or invalid transition: `409` with a specific stable code and current version where applicable.
- Active completion blocker: `409` with `OCC_TASK_BLOCKED` and authorized blocker codes.
- OPA or Flowable unavailable/malformed: `503` with `OCC_AUTHORIZATION_UNAVAILABLE` or `OCC_WORKFLOW_UNAVAILABLE`.
- Missing, unavailable, or stale required gate provider: `503 OCC_TASK_GATE_UNAVAILABLE` with authorized provider keys only.
- Unexpected failures: redacted `500`; correlation ID links to server logs.

Kafka failure never rolls back a command because delivery occurs after transactional Outbox insertion. PostgreSQL or synchronous Flowable failure rolls back the whole command.

## Verification Strategy

Implementation follows TDD with the following gates:

### Contracts

- Strict Zod behavior and OpenAPI parity for every schema, path, header, query, enum, and error response.
- Kotlin HTTP fixtures prove exact serialization and unknown-field rejection.
- Typed event registry accepts every owned event and rejects unknown or unsafe payloads.

### Database

- Static migration ordering and V013 content checks.
- PGlite-compatible smoke where supported.
- Real PostgreSQL constraints for lifecycle, package consistency, unique started-for participant process, non-overlapping replacement relationships, version triggers, immutable history, notification cursors, indexes, and runtime privileges.
- Concurrent process-start and task-claim races.

### Core And Flowable

- Focused repository, state-derivation, cursor, adapter, and command tests.
- Real PostgreSQL/Flowable tests for deployment binding, 12-stage route, stage-8 parallelism, start, claim, complete, suspend/resume/cancel/fail, history, reconciliation, mandatory gate-provider failure, startup rejection for a distinct Flowable transaction boundary, and rollback after injected failures.
- Idempotent replay, same key/different body, stale version, duplicate start, claim race, cancel/complete race, transfer/cancel race, transfer to an occupied participant, relationship expiry/re-enrollment, and relationship revocation races.
- Replays after membership/role revocation are freshly denied without exposing stored responses; evidence submission/review and wait-release races are deterministic.

### Authorization

- Rego tests for every action and role/relationship combination, disabled principals, inactive relationships, default deny, malformed input, stale revision/release, and forbidden actions.
- Real OPA Core tests prove allow, deny, timeout/down, malformed response, relationship revision behavior, and claim/complete races against membership revocation.

### API Journey

- A teacher creates a cohort and starts a process for each participant.
- A participant sees only authorized work, claims it, observes deterministic blockers, and completes allowed work.
- Outsiders and role-only administrators cannot infer or mutate teaching resources.
- Every transition has one expected audit record and correctly versioned Outbox event set.

The new mandatory integration classes are explicitly registered in `scripts/verify.mjs`, and verifier self-tests prove their JUnit XML must exist, contain tests, and have zero skips/failures/errors. `npm run verify:full` remains the final release gate.

## Integration And Commit Boundaries

Commits are grouped so agent 06 can resolve shared conflicts safely:

1. Design and implementation plan.
2. V013 schema and database tests.
3. Shared OpenAPI/Zod event and API contracts.
4. Shared command-kernel and relationship-aware authorization extensions.
5. Cohort module.
6. Process definition/instance adapters and included BPMN package.
7. Task module and projections.
8. End-to-end integration and full-gate registration.

Shared files are not mixed with unrelated domain implementation in the same commit. No migration before V013 is edited.

## Residual Cross-Workstream Contracts

- Evidence supplies immutable submission/review and persisted gate facts through `TaskSubmissionCommandService`, `TaskGateFactWriter`, and `TaskReviewCommandService`; missing required evidence integration fails closed.
- Resource supplies structured reservation blockers and wait-release facts through `TaskGateFactWriter` and `ProcessWaitReleasePort`.
- Risk consumes task/process events and does not mutate workflow state.
- Desktop consumes the OpenAPI contract and notification cursor; it has no Flowable or database access.
- Final integration may combine notification producers, but this branch remains the owner of notification persistence and query semantics.

These are compile-time/domain contracts. The formal 12-stage package cannot pass a declared hard gate while a required downstream provider is absent; only explicitly gate-free activities can complete without one.
