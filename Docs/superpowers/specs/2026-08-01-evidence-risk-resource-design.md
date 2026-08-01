# Evidence, Risk, And Resource Vertical Slice Design

Date: 2026-08-01
Status: Approved for implementation under delegated workstream authority
Branch: `feature/evidence-risk-resource`
Base: `feature/deployable-pilot` at `8ba677f`

## Purpose

This workstream implements the production Core vertical slice for evidence and review, deterministic risk and intervention, and managed-resource reservations. PostgreSQL remains the authority, Core is the only client-facing object-storage boundary, OPA authorizes every protected operation, and the existing command kernel supplies idempotency, optimistic concurrency, audit, and transactional Outbox behavior.

The implementation owns migration `V014__evidence_risk_resource.sql`, Kotlin packages `evidence`, `risk`, and `resource`, the private MinIO adapter, focused tests, and the associated shared contracts. It does not implement process/task internals or expose MinIO to clients.

## Requirements Resolution

The approved deployable-product design and this workstream prompt supersede the older evidence sequence where they conflict. Upload bytes always pass through an authenticated, bounded Core endpoint. A conditional decision returns follow-up work and does not satisfy a hard gate unless the immutable package requirement explicitly permits conditional advancement. An exclusive reservation conflicts with every overlapping active reservation, not only another exclusive reservation.

The backend slice does not require visual design work. Missing routine choices are resolved in this specification under the delegated decision authority; no external credential, legal choice, or unavailable infrastructure is needed to define the implementation.

## Considered Architectures

### Selected: focused Core packages with ports and adapters

Each domain has a small application service and JDBC repository behind interfaces. Mutations enter through the existing `CommandExecutor`; MinIO, file inspection, malware scanning, clocks, and process/task integration are ports. This preserves one PostgreSQL transaction for domain state, audit, and Outbox while making unsafe I/O deterministic in tests.

Advantages are compatibility with the current modular monolith, direct reuse of authorization and command invariants, bounded files, and independently testable domain logic. The trade-off is explicit compensation for object-store operations because PostgreSQL and MinIO cannot share a transaction.

### Rejected: one cross-domain service and repository

A single service minimizes initial names but couples three state machines, makes reservation lock ordering harder to review, and forces evidence-specific I/O concerns into risk and scheduling code. The lower file count does not offset the test and ownership cost.

### Rejected: asynchronous storage/scanning microservice

This would isolate hostile-file processing, but it adds a distributed command protocol and leaves the first production slice with ambiguous upload confirmation and gate timing. The existing deployment and Outbox infrastructure does not provide an authoritative external workflow for this purpose. A scanner remains a replaceable production interface without becoming a separate authority.

## Common Command And Query Contract

Protected mutations use the authenticated principal, exactly one bounded `Idempotency-Key`, a UUID correlation ID, and `Expected-Version` on updates. Commands authorize against an existing parent or aggregate `authz.entity`, lock the aggregate row where applicable, execute the state change, append bounded audit detail, and emit at least one aggregate-versioned Outbox event through `CommandExecutor`.

Create commands authorize against an existing target or resource entity because the new aggregate is not yet present in the authorization snapshot. Evidence, risks, and managed resources use globally unique UUIDs that also identify `authz.entity` rows. Reservations use globally unique UUIDs but authorize against their managed resource and requester target.

Canonical request bytes drive idempotency hashes. The existing kernel atomically inserts the idempotency record or locks the conflicting row, compares descriptor and request hash, replays only a completed matching result, and conflicts on changed input or unsafe in-progress ownership. Business state, response, audit, Outbox, and idempotency completion commit together. Same principal, command key, key, descriptor, and request therefore replay the stored result; a changed request conflicts. MinIO streaming does not hold that database transaction open: the upload-session lease and unique object key are the external-I/O authority, while session creation and terminal confirmation are normal kernel commands. Updates require the current row version and return RFC 9457 Problem Details with `currentVersion` on stale input.

Growing lists use opaque authenticated cursor tokens. The initial codec uses URL-safe Base64 of canonical JSON plus an HMAC-SHA-256 signature from application secret material. The authenticated payload includes endpoint/query type, customer instance, normalized filters, sort name/version, page direction, expiry, and the stable ordering tuple. A cursor is rejected if any context differs. Queries request one extra row and never accept client-provided raw offsets.

## Evidence Architecture

### Requirement policy

`catalog.evidence_requirement.validation_schema` remains the immutable package-owned source for extension, detected media type, maximum bytes, minimum count, gate hardness, conditional advancement, follow-up SLA, and archive limits. Core parses it through a strict DTO and rejects unknown fields, invalid media/extension pairs, limits above 100 MiB, or unsafe archive limits. Published definitions remain database-immutable.

The accepted schema shape is:

```json
{
  "allowedExtensions": ["pdf"],
  "allowedMediaTypes": ["application/pdf"],
  "maximumBytes": 104857600,
  "minimumCount": 1,
  "hardGate": true,
  "conditionalAdvancement": false,
  "conditionalFollowUpHours": 48,
  "archive": {
    "maximumEntries": 1000,
    "maximumExpandedBytes": 209715200,
    "maximumCompressionRatio": 100
  }
}
```

### Upload lifecycle

1. `POST /api/v1/evidence/upload-sessions` authorizes against the target entity and either creates a new evidence head and slot or names an existing `evidenceId` for resubmission. The request fixes requirement, target, evidence ID/slot, normalized extension, expected SHA-256, and expected byte count. A new slot is a caller-supplied bounded stable key unique within `(target, requirement)`; it allows `minimumCount > 1` without conflating evidence heads. Resubmission supplies `Expected-Version`. Core creates unique unpredictable quarantine and immutable object keys for this upload; clients never choose object keys.
2. `PUT /api/v1/evidence/upload-sessions/{id}/content` accepts a non-multipart request body, enforces both declared and streamed limits, computes SHA-256 while streaming to the private MinIO quarantine prefix, and never buffers the complete file. The endpoint is authenticated and authorizes the session on every request. It atomically claims a persisted upload lease with states `CREATED`, `STREAMING`, `INSPECTING`, `SCANNING`, `PROMOTING`, and terminal `CONFIRMED`, `FAILED`, or `EXPIRED`.
3. Core aborts the object write on read, timeout, persistence, size, or digest failure. It marks the session `FAILED` with a bounded machine-readable failure code and schedules cleanup. No evidence version exists.
4. After persistence, the application inspects magic bytes and structure in bounded workers. Extension, detected media, polyglot markers, macro-enabled Office content, encryption, archive entry count, expanded size, compression ratio, and malformed structures are checked before scanning.
5. The production `MalwareScanner` port and protocol return only `CLEAN`, `INFECTED`, or `ERROR` with a bounded signature/reference. `INFECTED` and `ERROR` fail closed. The deterministic test scanner is content-driven and cannot be selected in production configuration. Production startup fails when no production scanner endpoint is configured. Agent 05 owns a pinned concrete scanner image, signatures/update policy, health check, and resource isolation; release acceptance runs the production adapter and image against clean and infected fixtures.
6. A clean object moves from quarantine to its unique immutable per-upload object key before the database confirmation transaction. The transaction locks the evidence head, inserts the next immutable `evidence_version` linked to its upload session, advances `current_version`, and marks the upload `CONFIRMED`. If the database transaction fails, a separate retrying compensation transaction records the unique object as a cleanup candidate. A deterministic orphan sweeper also discovers unreferenced keys. Both wait through a retry grace period and recheck under lock that no confirmed version references the object before deletion.
7. `POST /api/v1/evidence/{id}/submit` transitions the head to `SUBMITTED` only when the current immutable version is clean and belongs to the requirement. Submission is separate from upload confirmation.

Only one content upload can claim a session. The lease records owner, acquisition, heartbeat, and expiry; active streaming/inspection/scanning extends the lease but never beyond a fixed two-hour absolute deadline. A retry with the same idempotency key and descriptor replays the persisted terminal response or resumes status observation; another key conflicts while the lease is live. A stale lease may be reclaimed only after checking object state. Disconnects before persistence abort; disconnects after persistence continue bounded inspection and are observed through `GET /upload-sessions/{id}`; confirmation remains replayable. Sessions unclaimed for 30 minutes expire.

Upload transitions use row locking and database constraints. Accepted and current submitted-version objects inherit seven-year evidence retention. Superseded, rejected, and conditional-version objects also remain for seven years because they are immutable review history. Failed, quarantined, and orphan objects are deleted after a 24-hour retry grace; their operational records expire after 30 days. Legal hold on an evidence head propagates to every version/object and prevents deletion. Backup manifests include all retained immutable objects; cleanup cannot act on an object participating in an in-progress backup snapshot.

### File inspection boundary

`EvidenceContentInspector` consumes a bounded replayable stream or local bounded spool created with owner-only permissions. It checks signatures before trusting declared MIME. ZIP-family formats use a streaming central-directory reader with maximum entry count, cumulative expanded bytes, per-entry and total compression-ratio limits, path normalization, and rejection of nested archives. Office Open XML files reject encryption and macro parts. PDFs reject encryption and active embedded-file/action constructs. A file matching multiple incompatible formats is a polyglot and is rejected.

The scanner runs only after structural validation. Parser processes have a fixed byte budget, wall-clock deadline, memory ceiling supplied by the production adapter, and no network. Timeout, crash, malformed output, or unknown result is `ERROR` and fails closed.

### Versions, submission, and review

Evidence versions and review records are append-only at the database layer. Version numbers are allocated while locking the evidence head and increase by exactly one. Each version records the upload session, object key, SHA-256, detected media, normalized extension, size, submitter, scanner engine/version/result reference, and creation time.

`POST /api/v1/evidence/{id}/reviews` requires the current version, evidence row version, decision, bounded reason, and structured conditions. A reviewer cannot be the version submitter or original evidence creator. The command authorizes the review action, locks the evidence row, rejects a stale/non-current version, inserts one immutable review, and transitions the evidence head:

- `ACCEPTED`: evidence becomes `ACCEPTED`; Core recomputes the requirement predicate over distinct current accepted evidence heads/slots. The process/task adapter receives gate satisfaction only when accepted count reaches `minimumCount` and every applicable hard rule passes.
- `REJECTED`: evidence becomes `REJECTED`; the adapter receives a return result for the prior assignee. Resubmission requires a new immutable version.
- `CONDITIONAL`: evidence becomes `REJECTED` for presentation, conditions and due time are stored on the immutable review, and the adapter receives a follow-up result. Gate satisfaction is true only when the published requirement permits it.

Terminal review decisions are never updated or deleted. A subsequent review is possible only for a newly submitted version. This gives one effective review per evidence version. The requirement predicate is evaluated while locking applicable evidence heads in UUID order, so simultaneous reviews cannot advance a gate from a partial count. Rejection, conditional return, or supersession removes that head from the accepted current count. Replacement uses the same slot; additional required items use distinct slots.

### Process/task integration

The evidence package defines a narrow `EvidenceWorkflowPort` with read methods for task eligibility/prior assignee and one command method that applies an immutable review outcome in the caller's transaction. A no-transition adapter exists only in tests. Production startup requires an agent-01-compatible adapter using Core's datasource and transaction manager; absence fails startup. The review, task projection/Flowable effect, audit, and Outbox commit or roll back together. An integration note specifies required values: evidence ID/version, review ID/decision, follow-up due time, requirement-level gate-satisfied flag, and correlation ID.

### Read authorization and object delivery

Metadata, version history, review history, preview, and download endpoints authorize each target at read time. Raw evidence is streamed by Core from MinIO with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, a safe filename, bounded range support, and no object-store URL or credential. Inline responses are permitted only for separately stored server-generated sanitized previews. Unconfirmed, failed, quarantined, rejected-without-retention, or unauthorized objects are never returned.

## Risk And Intervention Architecture

### Deterministic rule model

Published `catalog.risk_rule_definition` content is parsed into strict package-versioned rules. Supported initial trigger kinds are `OVERDUE_CRITICAL_WORK`, `CONSECUTIVE_RETURNS`, `INACTIVITY`, `BLOCKER_AGE`, `EVIDENCE_FAILURE`, `MISSING_CRITICAL_EVIDENCE`, and `RESOURCE_CONFLICT`. Each definition fixes severity, SLA, owner relationship type, escalation steps, trigger-specific thresholds, threshold kind (`ELAPSED` or `BUSINESS`), IANA time zone, and immutable package calendar/version. Business thresholds exclude package-calendar weekends and holidays and evaluate zoned dates; elapsed thresholds use durations. Each occurrence stores the calendar/version and evaluation instant, making weekend, holiday, and daylight-saving behavior reproducible.

The evaluator accepts an immutable `RiskEvaluationFacts` snapshot supplied by stable process/task/evidence/resource ports and a fixed evaluation instant. It performs no wall-clock reads inside rules. It produces a canonical occurrence key from rule definition, target entity, triggering fact IDs, and threshold window. A unique database constraint deduplicates the same occurrence while allowing a later independent occurrence after resolution.

### Lifecycle and history

A risk has `INFO`, `YELLOW`, or `RED` severity and `OPEN`, `ACKNOWLEDGED`, `RESOLVED`, or `DISMISSED` state. Creation records rule definition, target, occurrence key, confidence, bounded reason, detected time, SLA due time, owner relationship reference, and row version.

Acknowledgement, assignment, escalation, mitigation, resolution, and dismissal are command-kernel mutations with optimistic versioning. Rather than overwriting evidence, each action appends an immutable `risk_action` row with actor, type, reason/data, and time. The risk head stores only current state, severity, SLA, last escalation level/time, resolved time, and row version.

Escalation is deterministic: a scheduled evaluator selects due active risks with `FOR UPDATE SKIP LOCKED`, compares the fixed evaluation time to immutable escalation steps, appends exactly one action per level, changes owner/severity when defined, and emits an event. Re-running the same evaluation instant is idempotent through occurrence/action uniqueness.

### Intervention queue and measurement

YELLOW and RED active risks appear in the intervention queue; INFO remains queryable but is not significant by default. The queue supports severity, state, SLA status, target, and authorized ownership filters with cursor ordering `(due_at NULLS LAST, severity rank DESC, id)`.

Risk metrics derive only from persisted facts: trigger evaluations, risk occurrences, acknowledgements, escalations, resolutions, dismissals, SLA duration, and teacher adjudication. `risk_adjudication` is an immutable versioned fact recording reporting period, evaluator, known-event key, target, whether the event was severe, linked risk where present, outcome (`TRUE_POSITIVE`, `FALSE_POSITIVE`, `MISSED`, `NOT_APPLICABLE`), reason, and superseded-adjudication reference. Authorized correction appends a superseding fact; it never edits history. This makes severe-risk miss and false-positive pilot measures reproducible. Metrics never infer a missed event from absence alone.

## Resource And Reservation Architecture

### Managed resources and availability

Managed resources are authorizable entities with type, positive capacity, lifecycle state, strict extensible data, and optimistic row version. Availability windows are immutable interval rows with `AVAILABLE` or `UNAVAILABLE` mode and optional bounded reason. The default is available when no windows exist; any overlapping `UNAVAILABLE` window overrides `AVAILABLE`, and `AVAILABLE` windows otherwise restrict reservable time to their union. Availability mutation locks the resource first. Adding unavailability that overlaps active reservations is rejected with redacted conflicts; it never silently cancels them.

Inventory and schedule queries reauthorize each resource, use cursor pagination, and redact requester/process/task details unless separately authorized. A conflict response always includes the resource ID and conflicting interval, but exposes reservation IDs or participant identity only when permitted.

### Reservation transaction

Every create or change transaction locks `occ.managed_resource` first with `SELECT ... FOR UPDATE`, validates state and availability, then locks the reservation for updates. The requested range is canonical half-open `[start,end)` and capacity is positive and no greater than resource capacity.

An active exclusive request conflicts with any overlapping active reservation. An active non-exclusive request conflicts with any overlapping active exclusive reservation. A replacement exclusion strategy uses a generated active range plus a trigger that locks the resource and checks both directions; the existing partial exclusion alone is removed because it cannot express exclusive-versus-any semantics.

For non-exclusive capacity, the same resource-row lock serializes contenders. The command computes peak simultaneous load at the candidate start and every existing active range boundary inside the candidate, excluding the reservation being changed, and rejects only when `peak + requested > resource.capacity`. Because all reservation writes, availability writes, and capacity changes take the resource lock first, write skew cannot overbook.

Changes reuse authorization, idempotency, expected version, lock order, availability, exclusive, and capacity checks. `resource_id`, requester, process, and task links are immutable; moving between resources is cancel-and-create, avoiding cross-parent lock inversion. Cancellation is terminal and releases capacity immediately; completion is terminal and normally scheduler-owned. Physical deletion is forbidden. Resource capacity cannot be reduced below peak active commitments, and unavailable, maintenance, or archived resources reject new/changed reservations.

Schedule queries use stable `(lower(time_range), id)` cursors and explicit UTC instants. The API accepts ISO-8601 offsets and stores `timestamptz`; no server-local time interpretation is allowed.

## Migration V014

The forward-only migration extends the V005 tables without editing V001-V012. It adds upload requirement/extension/status/lease/detail fields; nullable legacy-compatible version provenance/scanner columns that an insert trigger requires for all new rows; a separate mutable object-disposition table for retention, legal hold, cleanup lease/attempt/error, and deletion state; immutable review follow-up data; risk occurrence/action/adjudication/intervention data; resource availability; reservation lifecycle timestamps; and supporting indexes.

Database functions enforce legal state transitions, evidence version/review immutability, upload-to-version consistency, risk terminal behavior, reservation parent locking, exclusive conflict semantics, capacity-safe writes, and resource capacity changes. V014 preserves the existing whole-row immutability triggers. It preflights legacy multiple-review versions and existing exclusive/capacity violations under an `ACCESS EXCLUSIVE` migration lock, aborting with concrete IDs instead of rewriting immutable history. Future one-review behavior is an insert trigger that locks the evidence head and rejects when a review already exists, avoiding an upgrade-unsafe unique constraint.

Reservation parent links are immutable, physical delete is rejected, and every insert/state/range/capacity update locks the parent resource. Application code still locks the parent before issuing reservation DML; the trigger provides safety for direct runtime DML. Finite ranges are canonical `[)`. Functions use fixed `search_path`, revoke public execute where appropriate, and grant only the bounded runtime capability. Existing runtime default privileges cover normal DML.

V014 deliberately does not reference V013-only objects beyond V005's stable process/task tables. Agent 06 may add forward-only integration constraints after V013 and V015 are merged. Static migration lists, the full-schema entrypoint, PGlite compatibility logic, and PostgreSQL expected Flyway versions are updated without editing earlier migration files.

## API And Event Surface

The shared OpenAPI and TypeScript contracts cover:

- Evidence requirements, upload-session creation/status/content result, evidence metadata, submit/review commands, version/review history, preview metadata, and attachment download headers.
- Risks, risk actions, intervention filters/items, acknowledge/assign/escalate/mitigate/resolve/dismiss commands, and evaluation summaries.
- Managed resources, availability windows, reservation availability/schedule/conflict queries, and reserve/change/cancel commands.
- Cursor pages, optimistic-version headers, idempotent replay headers, and stable Problem Details codes.

Events contain IDs, state, versions, decisions, severity, intervals, capacity, and bounded reason codes. They never contain file bytes, object credentials, raw malware details, participant-sensitive labels, tokens, or provider secrets. Event types include evidence upload failed/confirmed/submitted/reviewed, risk opened/actioned/escalated/resolved/dismissed, resource availability changed, and reservation created/changed/cancelled/conflicted.

Shared contract edits are committed separately from domain implementation so agent 06 can resolve concurrent OpenAPI work predictably.

## Failure Handling And Compensation

- OPA unavailable, stale, malformed, or denying: no mutation or object delivery.
- PostgreSQL unavailable: no new upload session, confirmation, review, risk command, or reservation command.
- MinIO unavailable during upload: abort stream, fail the session, create no version, retain no accessible object.
- Database failure after immutable object promotion: record the unique per-upload key in a separate compensation transaction or discover it with the orphan sweeper, wait through the retry grace, and recheck confirmed references under lock before removal. The object is never reachable because no confirmed version authorizes it.
- Scanner unavailable, timeout, crash, or unknown result: fail closed and schedule quarantine cleanup.
- Workflow adapter rejection: review transaction rolls back, including review, evidence state, audit, and Outbox. The immutable object/version remains available for a later valid review.
- Reservation exclusion/capacity conflict: return `409 OCC-RESERVATION-CONFLICT` with a redacted conflict descriptor; no partial reservation or event.
- Kafka unavailable: business state, audit, and Outbox commit; publisher retries under existing policy.
- Cleanup failure: retain inaccessible object, record bounded attempt/error state, and retry with a lease. Legal hold always wins.

## Security Boundaries

MinIO stays on the Compose backend network. Core receives only bucket-scoped application credentials through config-tree secrets and never logs or returns them. Object keys are unique random internal identifiers, not user filenames. Filenames are normalized only for safe response headers.

All file-derived text is untrusted. Logs, audit details, events, and scanner output are bounded and sanitized. Database queries parameterize values. Download and preview endpoints authorize every request and do not rely on possession of a URL. Quarantine objects have no client retrieval path.

Segregation of duties is enforced in both application logic and a database trigger comparing reviewer with version submitter/evidence creator. OPA still decides whether the distinct reviewer has the review capability.

## Test Strategy

Tests follow TDD and production boundaries:

1. Contract tests reject unknown fields, invalid enums/limits/cursors, missing idempotency/version headers, and OpenAPI/Zod drift.
2. Migration static and PGlite tests prove ordered V014 inclusion and portable constraints where supported.
3. Real PostgreSQL tests prove migration upgrade, immutable versions/reviews/actions, state transitions, runtime privileges, upload/version consistency, risk deduplication, and reservation lock/concurrency behavior.
4. Evidence unit tests cover byte bounds, SHA-256 mismatch, extension/media mismatch, signatures, polyglots, macro/encrypted Office files, encrypted/active PDFs, malformed archives, entry/expanded-size/ratio bombs, nested archives, scanner outcomes, and safe disposition.
5. Real MinIO Testcontainers tests use the production adapter and private bucket policy for bounded streaming, abort, promotion, download, range behavior, orphan cleanup, and inaccessible quarantine objects.
6. Real OPA plus Core/PostgreSQL tests prove read/write authorization, stale policy failure, segregation of duties, redaction, idempotency, optimistic conflicts, and transactional audit/Outbox behavior.
7. Reservation concurrency tests run simultaneous exclusive-versus-capacity and aggregate-capacity commands and assert that committed totals never overbook.
8. Risk clock-controlled tests prove every initial trigger, deduplication, SLA, acknowledgement, escalation, mitigation, resolution, dismissal, queue ordering, and metrics.
9. Workflow adapter contract tests prove accepted, rejected/resubmitted, conditional-hard-gate, and rollback semantics without implementing agent 01 internals.
10. `verify:full` explicitly includes mandatory PostgreSQL, MinIO, OPA, and concurrency JUnit result files and rejects skips.

The acceptance journey is participant upload, clean confirmation/version 1, submission, teacher rejection, participant version 2/resubmission, teacher acceptance, with immutable versions/reviews/audit/events. Every named malicious fixture fails closed with no accessible object. Concurrent reservation acceptance never exceeds exclusivity or capacity.

Upload integration additionally tests disconnects before and after persistence, scanning lease expiry/reclaim, two equal-content sessions, and cleanup racing confirmation. Risk tests cover weekends, package holidays, daylight-saving boundaries, adjudication supersession, missed severe events, and false-positive reporting. Resource tests cover concurrent availability mutation versus reservation creation.

## Notifications

Agent 01 owns the shared notification aggregate, SSE delivery, and cursor query implementation. This branch owns domain notification intents written transactionally with evidence reviews, risk creation/escalation/SLA breach, and reservation conflict/change/cancellation events. Each intent contains event ID, recipient relationship selector, type, severity, authorized resource link, and bounded template data; event ID plus recipient deduplicates materialization. No raw filename, scanner detail, risk-sensitive reason, or requester identity is embedded. A test adapter verifies recipient derivation and idempotency; production startup requires agent 01's notification sink at final integration.

## Operational Assumptions

The Compose PostgreSQL 16/pgvector image, MinIO release and bucket-scoped application user, OPA 1.5.1, Kafka, and Core config-tree boundaries remain unchanged. This branch provides the strict production scanner adapter/protocol and deterministic safe test implementation. Agent 05 must provide the pinned production scanner container and operational policy; production Core fails startup without a configured production scanner.

Default retention is seven years for evidence metadata/reviews and 30 days for failed upload/transient cleanup records. Legal hold is represented in PostgreSQL and prevents application deletion. Backup/restore must treat PostgreSQL evidence metadata and MinIO objects as one recovery set, which remains an agent 05/06 deployment concern.

## Integration Boundary For Agent 06

Cherry-pick this branch's commits in order, keeping the contracts commit independently resolvable. Merge V013 before V014 and V015 after it. Bind agent 01's stable workflow and notification adapters; production has no no-op fallback and Flowable types remain outside evidence code. Reconcile hard-coded migration lists to V001-V015 and retain all mandatory JUnit result checks. Agent 03 should reuse the scanner/content-inspection ports for knowledge ingestion without sharing evidence aggregate tables.
