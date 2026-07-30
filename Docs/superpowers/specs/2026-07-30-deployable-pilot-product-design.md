# Deployable Pilot Product Design

## Purpose

This design turns the existing OCC software foundation into a complete, deployable pilot product for one embedded-development teaching cohort. It covers the deterministic workflow, evidence, review, risk, resource, governed-AI, desktop, security, and operational paths required for 10-20 concurrent users.

The release is complete when a new Ubuntu 22.04 AMD64 host and Windows x64 clients can be installed from release artifacts, an administrator can configure a cohort, and participants and teachers can complete the end-to-end workflow without direct database or container access.

## Product Boundary

The first release supports one private customer instance and one versioned teaching-domain package. It is not a generic multi-industry authoring platform, a SaaS multi-tenant service, or a high-availability cluster.

Included roles:

- Participant: sees assigned work, blockers, process progress, evidence requirements, reservations, risks, and cited AI guidance.
- Process owner: starts and supervises processes, reviews evidence, handles exceptions, risks, and failed work.
- Domain modeler: manages package drafts, process definitions, evidence and risk rules, validation, approval, and publication.
- Resource manager: manages resources, availability, capacity, and reservations.
- Administrator: manages identities, relationships, policy releases, AI/knowledge configuration, retention, and audit access.

Included business lifecycle:

1. An administrator creates or imports users and assigns roles.
2. A modeler validates and publishes a teaching-domain package.
3. A teacher creates a cohort and starts one process instance per participant.
4. A participant claims and completes available tasks, including evidence submission and resource reservation.
5. A teacher accepts, conditionally accepts, rejects, or returns evidence.
6. Workflow state, projections, risks, audit records, and events remain consistent under retries and conflicts.
7. AI can retrieve authorized knowledge and submit cited recommendations for human review.
8. Operators can install, upgrade, back up, restore, diagnose, and roll back the release through supported scripts and runbooks.

Deferred capabilities:

- Multi-customer operation inside one deployment.
- Kubernetes, multi-host high availability, and offline writes.
- Arbitrary customer scripts, DDL, Rego, or executable package extensions.
- General-purpose BPMN/DMN source editing beyond the supported package schema and validated process assets.
- Multiple production model-provider families, autonomous high-risk tools, or AI-only grading.
- Marketplace, external government submission, RPA, billing, and mobile clients.

## Delivery Strategy

Implementation proceeds as tested vertical slices. Contract, migration, backend, policy, renderer, and end-to-end tests for one user outcome land together before the next outcome begins. Shared security and command infrastructure is completed first because every mutation depends on it.

Six workstreams are delivered in dependency order:

1. Platform contracts and security kernel.
2. Process and task lifecycle.
3. Evidence, review, risk, and resources.
4. Governed AI and authorization-first RAG.
5. Complete desktop workspaces.
6. Installation, operations, and release evidence.

## Deployment Architecture

The supported server is one Ubuntu 22.04 AMD64 host running Docker Engine and Docker Compose. PostgreSQL/pgvector, Flowable, Core, AI, OPA, Kafka, Redis, MinIO, and Caddy run as containers on private Compose networks.

Caddy is the only remotely reachable application entry point. PostgreSQL, Kafka, Redis, MinIO, OPA, Core, and AI do not publish LAN interfaces. Caddy exposes only versioned Core HTTP APIs and authenticated Core notification streams. Core mediates AI requests and relays bounded AI streams; AI accepts no end-user credentials.

Two TLS modes are supported:

- Public DNS mode requires administrator-provided DNS, ports 80/443 reachability for the selected ACME challenge, and a recovery contact. Caddy obtains and renews the certificate.
- Private LAN mode generates a deployment CA and server certificate containing the configured DNS name and any explicitly approved IP SANs. The CA private key is readable only by root, server certificates renew 30 days before expiry with overlap, and expiry alerts begin at 45 days. The Windows installer imports only the selected deployment CA into the current user's trust store after confirmation and removes only its own unreferenced certificate on uninstall.

Clients validate the configured profile hostname and never disable certificate verification. Install and upgrade tests cover wrong-host, expired, replaced, and untrusted certificates. Changing the server hostname requires issuing a new overlapping certificate and updating client profiles before retiring the old name.

The Electron application stores the selected server profile and non-secret preferences in its user-data directory. Refresh credentials are protected with Electron `safeStorage`; access credentials remain in memory. The renderer never receives refresh credentials, filesystem access, environment variables, or unrestricted network access.

The application runs deterministically when AI is disabled or unavailable. AI degradation removes recommendation actions and marks existing recommendations stale; it does not block authentication, workflow, evidence, review, risk, resource, or administration commands.

## Service Ownership

### Core

Core is the sole authority for identities, authorization facts, package publication, workflow commands, OCC projections, evidence metadata, risks, resources, recommendations, audit records, idempotency records, and Outbox events.

Only the process-definition, process-instance, and task modules call Flowable APIs. Other modules use explicit application interfaces and cannot depend on Flowable types.

Core exposes OpenAPI-described `/api/v1` APIs. Query responses use cursor pagination where lists can grow. Commands require an `Idempotency-Key`; updates also require `expectedVersion`. Errors use RFC 9457 Problem Details with stable OCC error codes and a correlation ID.

### AI

AI owns model invocation, parsing, chunking, embedding generation, retrieval execution, prompt rendering, run traces, and evaluation execution. It receives a dedicated database identity limited to AI runtime and index tables. It cannot mutate IAM, authorization, catalog, workflow, evidence, resource, risk, audit, or Outbox facts.

AI obtains authorized document identifiers and command-scoped tool grants from authenticated Core APIs. Recommendations are submitted to Core through an authenticated service command. Accepting a recommendation always executes a normal Core command with fresh human authorization.

The first provider adapter supports OpenAI-compatible chat and embedding endpoints. Provider URLs require HTTPS and an administrator allowlist of exact origins and ports. Resolution rejects loopback, link-local, metadata, multicast, and private addresses unless a specific private-provider CIDR is approved; every connection rechecks the resolved address, rejects cross-origin redirects, limits response size and duration, and never forwards credentials to another origin. Credentials are file-backed secrets, capability claims are probed, and model profiles fail closed when required structured-output or embedding capabilities are absent.

### Desktop

The desktop is a role-aware operations console, not an infrastructure shell. It contains these workspaces:

- Overview: attention queue, deadlines, risks, active processes, service health, environment, and freshness.
- My Work: available, claimed, blocked, pending-review, returned, and completed work.
- Processes: cohort and process search, route progress, participants, tasks, evidence, risks, and timeline.
- Intervention Center: evidence reviews, exceptions, failed automation, policy blocks, and AI recommendations.
- Risks: severity/SLA filters, ownership, acknowledgement, mitigation, and resolution.
- Resources: inventory, availability, capacity, reservations, and conflicts.
- Domain Design: packages, versions, supported process assets, validation, diff, approval, and publication.
- Administration: people, relationships, policy releases, AI providers, knowledge, retention, and audit.
- System Operations: read-only application health, Outbox lag, notification delivery, version, and configuration summary.

Navigation visibility follows effective capabilities returned by Core, not hard-coded role names. Direct routes still enforce server authorization. Infrastructure lifecycle actions such as Compose restart and database restore remain in operator scripts, not renderer buttons.

## Identity And Authorization

The first release implements local authentication with Argon2id password hashes, a default minimum of 12 characters and a configurable 12-128 character limit, lockout for 15 minutes after five failed attempts in 15 minutes, administrator reset, 15-minute signed access tokens, seven-day rotating refresh tokens, logout/revocation, and bootstrap-administrator creation through a one-shot deployment command. Interactive OIDC login is explicitly deferred and is a documented pilot variance from FR-IAM-01; OIDC cannot be advertised as supported until provider login, logout, mapping, disabled-user, claim-change, and outage tests pass.

Access tokens identify a principal, customer instance, session, and token version. Core validates issuer, audience, expiry, signature, session state, and principal state. Core and AI use mutually authenticated TLS with deployment-generated, file-backed service certificates containing fixed service identities. Certificates rotate with a 24-hour overlap and can be revoked without rebuilding images. AI rejects end-user access tokens.

For every protected command, Core:

1. Opens a database transaction and takes a shared lock on the authorization-state row. Authorization-changing commands take an exclusive lock and increment the revision.
2. Loads the principal, active direct relationships, target facts, authorization revision, and the atomically composed PLATFORM, DOMAIN, and CUSTOMER releases. Each applicable layer returns `ALLOW`, `DENY`, or `ABSTAIN`. Any `DENY` rejects the command; otherwise at least one layer must return `ALLOW`. Platform constraints are always evaluated, platform `DENY` cannot be overridden, and all-`ABSTAIN` is denied.
3. Calls OPA with size-bounded, schema-validated input containing the revision and all release IDs.
4. Fails closed if OPA is unavailable, malformed, or returns a stale revision/release.
5. Records allowed decisions in the business transaction. DENY and ERROR decisions are appended in a separate bounded transaction so command rollback does not erase security evidence.
6. Applies idempotency and optimistic-concurrency checks.
7. Updates domain state, Flowable where applicable, audit, and Outbox atomically.

Embedded Flowable and Core use the same PostgreSQL datasource and Spring transaction manager. Synchronous Flowable commands, Flowable runtime/history tables, OCC projections, audit, and Outbox therefore commit or roll back in one local database transaction; XA and distributed transactions are not used. Startup fails if Flowable is configured with a separate datasource or transaction manager. Asynchronous Flowable jobs publish completion through the Outbox and update projections in an idempotent follow-up transaction; a reconciliation job detects and repairs projection drift without inventing workflow state.

Policy publication requires successful compile/tests, approval by a different authorized principal, immutable release content, and successful OPA activation before the active release changes.

## Domain Model Decisions

Task presentation state is a projection, not a new Flowable truth. `AVAILABLE`, `CLAIMED`, `BLOCKED`, `PENDING_REVIEW`, `RETURNED`, `COMPLETED`, `CANCELLED`, and `FAILED` are derived from task lifecycle, active gate requirements, evidence review, and process state. The projection includes explicit blocker codes and is rebuilt from authoritative facts.

Conditional evidence acceptance does not satisfy a hard gate by itself. It creates required follow-up work with a due date; the gate advances only when the package rule explicitly permits conditional advancement. Every review references one immutable evidence version.

Relationship validity uses `valid_from <= now` and `valid_until IS NULL OR valid_until > now`. Expired relationships do not authorize access, block replacements, or participate in active cardinality and cycle checks.

Notifications are persisted facts with recipient, type, severity, resource link, created time, read time, and event cursor. SSE is a delivery optimization. Reconnection resumes from a cursor; missed notifications remain queryable.

A cohort is a Core aggregate with ID, code, name, package-version ID, owner principal, start/end dates, status, row version, and participant/teacher relationships. Cohort code is unique within the customer instance. Starting processes is idempotent per cohort participant. Removing membership stops future assignments but does not rewrite or reassign an already started process; that requires an explicit audited transfer or cancellation command.

Task and evidence presentation follows this transition table:

| Command or fact | Source | Result | Gate effect |
| --- | --- | --- | --- |
| Process reaches user task | none | `AVAILABLE` | No advancement |
| Claim task | `AVAILABLE` | `CLAIMED` | No advancement |
| Unsatisfied prerequisite/resource rule | active task | `BLOCKED` | No advancement |
| Submit evidence for review | `CLAIMED` | `PENDING_REVIEW` | No advancement |
| Review `ACCEPTED` | `PENDING_REVIEW` | `COMPLETED` | Satisfies the matching gate |
| Review `REJECTED` | `PENDING_REVIEW` | `RETURNED` to the prior assignee | Gate remains unsatisfied; resubmission creates a new evidence version |
| Review `CONDITIONAL` | `PENDING_REVIEW` | `RETURNED` with follow-up due date | Advances only when the published package rule permits it |
| Cancel/fail process activity | active state | `CANCELLED` or `FAILED` | Never satisfies a gate |

`RETURNED` is a projection caused by a review decision, not a separate Flowable command. Retries use the original idempotency key. Each transition records the review/evidence version where applicable and emits one aggregate-versioned event.

## Business APIs

The Core contract includes these resource groups:

- `/auth`: bootstrap status, login, refresh, logout, session and password changes.
- `/me`: profile, effective capabilities, assignments, notifications, and preferences.
- `/people`, `/relationships`, `/roles`: identity and access administration.
- `/packages`, `/package-versions`, `/policy-releases`: draft, validate, diff, approve, publish, and inspect.
- `/cohorts`, `/processes`, `/tasks`: creation, queries, claim, complete, return, suspend, cancel, and history.
- `/evidence`: requirements, upload sessions, confirmation, submission, review, and version history.
- `/risks`: queries, acknowledgement, assignment, mitigation, escalation, and resolution.
- `/resources`, `/reservations`: inventory, availability, reserve, change, and cancel.
- `/recommendations`, `/knowledge`, `/providers`: governed AI administration and review.
- `/audit`, `/events`, `/notifications`, `/system`: authorized operational queries.

Clients upload evidence to an authenticated Core endpoint. Core streams a maximum 100 MiB request to MinIO while computing SHA-256, verifies detected media type, declared extension, package size/type rules, and successful object persistence, then creates the immutable evidence version. Files remain quarantined until malware scanning succeeds. Macro-enabled, encrypted, polyglot, infected, unsupported, and decompression-bomb inputs are rejected; parsing uses bounded sandboxed workers. Downloads use attachment disposition unless a server-generated sanitized preview is available. Unconfirmed or rejected objects expire and are cleaned by a scheduled job. MinIO remains unreachable from clients.

Exclusive reservations use database exclusion constraints. Capacity reservations lock the resource row and reject totals above capacity. Every conflict returns the conflicting interval/resource without disclosing unauthorized participant details.

Risk rules initially cover overdue work, repeated returns, inactivity, unresolved blockers, evidence failure, and resource conflicts. Significant risks enter the intervention queue. Rules and thresholds are package-versioned and auditable.

## Events And Consistency

PostgreSQL is the fact store. Kafka is never required to acknowledge a user command. Each successful command writes an Outbox record in the same transaction as domain and audit state.

The publisher claims batches with `SKIP LOCKED`, publishes a versioned event envelope, and marks delivery after broker acknowledgement. Retries use bounded exponential backoff; exhausted records move to a dead-letter state with an operator-visible reason. Consumers deduplicate by event ID and make handlers idempotent.

The event envelope contains event ID, customer-instance ID, type, schema version, aggregate type/ID/version, occurred time, actor reference, correlation ID, causation ID, and a classification-aware payload. Aggregate ID is the Kafka partition key and consumers enforce increasing aggregate version. Event schemas are backward compatible within a major API version; incompatible changes use a new event type/version. Operators may retry repaired dead-letter records or abandon them only with an audited reason. Sensitive evidence content, tokens, passwords, and provider secrets never enter events.

Redis is limited to disposable caches, rate limits, and short-lived coordination. Loss of Redis degrades performance and login throttling conservatively but does not lose authoritative state.

## Governed AI Flow

The initial AI use case is a cited participant guidance recommendation:

1. Core emits a task-context request event or receives an explicit user request and creates a Core-signed, single-use grant containing principal, target, purpose, request ID, authorization revision, policy releases, and a maximum five-minute expiry.
2. AI authenticates to Core with mTLS and exchanges the grant for caller-authorized knowledge document IDs and bounded task context. Core rejects used, expired, or stale-revision grants.
3. AI applies profile data policy and retrieves only from authorized IDs using full-text and vector ranking.
4. The provider receives a versioned prompt, untrusted retrieved content, and a strict output schema.
5. AI validates structure, citations, document versions, confidence, token/cost limits, and generated-content labeling.
6. AI submits the recommendation and citations to Core.
7. Core reauthorizes recommendation visibility at read time. The participant may view it; a teacher can review it where package policy requires review.
8. Any proposed state-changing action remains a separate authorized Core command.

Knowledge ingestion applies the same quarantine, media-detection, malware, parser, archive, and size controls as evidence. It verifies hashes, parses supported UTF-8 text, Markdown, PDF, DOCX, and XLSX documents, chunks deterministically, and builds a new embedding space in `BUILDING`. Activation requires 100% eligible-chunk coverage, zero authorization-leak test failures, citation precision of at least 0.95, and recall@10 of at least 0.85 on the included evaluation set. Failure leaves the previous active space unchanged.

Retrieved content cannot add instructions, expand authorization, grant tools, alter policy, or waive review. The first release exposes no arbitrary model-generated tool execution.

## Included Teaching Package

The release includes immutable package `embedded-medical-device-pilot` version `1.0.0`. Domain Design can import a signed package archive and edit only fields declared by the package JSON Schemas. Graphical BPMN/DMN editing, arbitrary source editing, scripts, DDL, Rego, and migration of running instances are deferred.

The package contains one BPMN process, `medical-device-development-v1`, with these ordered stages:

1. Baseline assessment and cohort onboarding.
2. Laboratory and electrical-safety qualification.
3. User need, intended use, and measurable requirement definition.
4. System architecture and preliminary hazard analysis.
5. Component selection, bill of materials, and procurement approval.
6. Schematic capture and teacher design review.
7. PCB layout, design-rule report, and manufacturing handoff.
8. Procurement/manufacturing wait, with parallel firmware scaffold and test-plan tasks.
9. Board inspection, power-up checklist, and hardware bring-up.
10. Sensor calibration and firmware integration.
11. Verification against requirements and risk controls.
12. Final technical report, demonstration, retrospective, and teacher acceptance.

Included forms cover baseline skills, safety checklist, intended use, requirements, hazards, architecture, bill of materials, design review, power-up, calibration, verification, and final review. Hard evidence gates require safety qualification, approved requirements, reviewed schematic, clean design-rule report, signed power-up checklist, calibration data, requirement-verification matrix, and final report/demo record.

Risk rules cover overdue critical work, two consecutive rejected submissions, seven days of inactivity, unresolved blocker over two business days, failed safety/electrical checks, missing critical evidence, and reservation conflict within 24 hours. Resources include electronics benches, oscilloscopes, programmable supplies, soldering stations, environmental-test slots, and teacher review appointments. Knowledge contains package instructions, laboratory safety, review checklists, component guidance, calibration guidance, and verification templates.

Regression scenarios prove the happy path, rejected/resubmitted schematic, conditional non-critical evidence, failed safety gate, procurement wait parallel work, exclusive-resource conflict, aggregate-capacity conflict, severe electrical-risk escalation, package-publication rejection, and AI-disabled completion. All package files, schemas, BPMN, forms, rules, knowledge manifests, signatures, and scenario expectations are release artifacts.

## Error And Degradation Behavior

- Authentication failure returns a generic response; security-relevant detail is audit-only.
- OPA failure denies protected commands. Public readiness indicates degraded authorization without policy details.
- Flowable or PostgreSQL failure disables mutations and presents a read-only desktop state.
- MinIO failure disables new uploads but preserves metadata queries and reviews of existing accessible evidence.
- Kafka failure accumulates Outbox records and alerts operators without rolling back committed commands.
- Redis failure bypasses caches and applies conservative local limits.
- AI/provider failure disables new recommendations and records a bounded failure reason without blocking Core workflows.
- Optimistic conflicts return current version and a refresh action. Idempotent retries return the original result.
- Desktop network failure retains last successful read models, visibly labels their age, and disables all mutations.

## Testing Strategy

Tests follow the production boundaries:

- Contracts: OpenAPI validation, generated client compatibility, Problem Details, event envelopes, and unknown-field rejection.
- Database: forward-only migrations, subtype/package constraints, relationship validity, lifecycle transitions, reservation concurrency, idempotency races, Outbox replay, privileges, and upgrade from the prior release.
- OPA: default deny, release layering, relationship facts, stale revision/release, segregation of duties, malformed input, and Core integration.
- Core: module unit tests, PostgreSQL/Flowable/MinIO/Kafka integration tests, transaction rollback and concurrency tests, authentication and authorization tests, and complete workflow API tests.
- AI: provider adapter contracts, authorized retrieval, injection resistance, citation validation, capability mismatch, provider failure, embedding cutover, recommendation submission, and deterministic evaluation fixtures.
- Desktop: component/accessibility tests, route and capability tests, conflict/offline/error states, evidence upload, review flows, and Playwright role journeys.
- Deployment: Compose contracts, clean Ubuntu install, reboot recovery, upgrade/rollback, encrypted backup/restore, Windows standard-user install/upgrade/uninstall, certificate trust, artifact signatures, and smoke workflows.

Linux backend verification and Windows Electron verification are separate CI jobs. No Linux gate launches a Windows executable. A release is blocked by skipped required integration tests.

The performance gate records CPU, memory, storage, network, dataset size, and exact image digests. On the minimum supported server profile of 4 x86-64 cores, 16 GiB RAM, SSD storage, and 100 Mbps LAN, a 30-minute test with 20 active users must achieve query p95 <= 500 ms, command p95 <= 700 ms, event-to-consumer p95 <= 2 seconds, error rate below 1%, and zero lost or duplicate transitions. Evidence uploads are tested at 100 MiB with at least four concurrent uploads. The specification's 100-session target remains a post-pilot scale gate.

Every desktop workspace has a role/capability matrix test covering visible navigation, permitted commands, direct-route denial, loading/empty/error states, redaction, stale/offline behavior, and optimistic-conflict recovery. Keyboard-only operation, visible focus, route focus management, 200% zoom/reflow, reduced motion, accessible status announcements, and automated axe checks have no serious or critical violations.

## Release And Operations

The Ubuntu release bundle contains an idempotent installer, pinned Compose manifest, environment schema, secret generator, Caddy templates, systemd unit, health verifier, backup/restore tools, upgrade/recovery tool, uninstall tool, image digest manifest, SBOMs, checksums, and the deployment manual.

Every release declares minimum and maximum compatible schema versions. Application rollback is permitted only when the target images support the current schema. Otherwise recovery restores the pre-upgrade PostgreSQL, MinIO, configuration, and secrets set into an isolated target, validates it, and then cuts over. Reverse Flyway migrations and partial component rollback are unsupported.

The Windows release contains a signed x64 installer, publisher metadata, application icon, server-profile bootstrap, certificate enrollment, upgrade/uninstall behavior, checksums, and provenance. Unsigned local-development builds are clearly labeled and are not production artifacts.

Backups include PostgreSQL, MinIO objects, deployment configuration, encrypted secrets, release metadata, and integrity manifests. Restore runs only into an isolated recovery target until validation completes. The release records measured backup and restore times and does not claim point-in-time recovery unless WAL archiving is implemented and tested.

Default retention is seven years for audit, evidence metadata, and review decisions; one year for operational notifications and AI traces; and 30 days for failed uploads and transient job records. A legal hold blocks deletion. Principal deletion disables login and pseudonymizes non-audit display fields while immutable actor references remain. Backup retention is 30 daily and 12 monthly recovery sets. Backup encryption uses an externally held recovery key that is never stored in the backup destination; acceptance restores from only the documented recovery set and the separately escrowed key.

Observability includes structured redacted logs, correlation propagation, Prometheus metrics, OpenTelemetry traces for command/AI boundaries, health/readiness, Outbox lag, failed jobs, storage capacity, certificate expiry, backup age, and alert delivery tests.

## Acceptance Criteria

The product release is accepted only when all of the following are demonstrated from release artifacts:

1. A clean Ubuntu 22.04 AMD64 host installs the stack idempotently, survives reboot, and passes health verification.
2. A clean Windows x64 standard-user VM installs the desktop, enrolls the server profile, authenticates, upgrades, and uninstalls successfully.
3. An administrator bootstraps the instance, creates users, assigns roles, configures one provider optionally, and publishes the included teaching package.
4. A teacher creates a cohort and starts participant processes.
5. A participant claims work, reserves a resource, uploads evidence, receives a review return, resubmits, and completes the process.
6. A teacher reviews evidence, handles a risk and conflict, and inspects the immutable audit timeline.
7. Duplicate commands, stale versions, authorization changes, dependency failures, and network retries produce the specified safe outcomes.
8. With an AI provider configured, authorized knowledge produces a structured cited recommendation; unauthorized documents and uncited output are rejected.
9. With AI disabled, the same deterministic business workflow completes successfully.
10. Backup and isolated restore reproduce users, package versions, active processes, evidence metadata and objects, audit history, and configuration.
11. Required test suites, vulnerability policy, SBOM generation, image/artifact signing checks, and end-to-end release gates pass without required skips.
12. Deployment and operations documentation matches the shipped commands and has executable contract tests for referenced paths and commands.

Pilot outcome acceptance is measured across the 16-week pilot from audit/event facts, excluding administrator test processes identified before pilot start. The process owner signs the report:

- Critical-node evidence completeness: completed critical gates with accepted required evidence divided by completed critical gates, at least 95%.
- Invalid-skip interception: blocked invalid transition attempts divided by all known invalid transition attempts from regression and audited pilot review, at least 90%.
- Teacher follow-up reduction: median weekly manual reminder minutes per active participant versus a four-week pre-pilot baseline, at least 30% lower.
- Waiting-work coverage: wait intervals over one business day with at least one completed suggested parallel task divided by eligible wait intervals, at least 70%.
- Severe-risk misses: known severe events identified by weekly teacher adjudication without a preceding RED risk, zero.
- Risk false positives: dismissed YELLOW/RED risks divided by adjudicated YELLOW/RED risks, at most 20%.
- Weekly participant activity: enrolled participants with at least one meaningful audited task/evidence action divided by active enrolled participants, at least 80%.
- Process-change lead time: approved package changes published within one business day divided by approved pilot package changes, 100%.

Release security gates reject known critical vulnerabilities and high vulnerabilities with a fix available. A time-bounded exception requires a documented exploitability assessment, compensating control, owner, and expiry approved by the security reviewer; exceptions ship in the release evidence.

## Implementation Governance

Each workstream receives a written implementation plan and isolated ownership. Shared contracts, migrations, and high-conflict configuration files are changed by designated integration tasks rather than concurrently by multiple agents. Every workstream ends with focused verification and a cross-workstream review before the next dependency layer starts.

Implementation may simplify internal structure where tests prove the same behavior, but it may not weaken default-deny authorization, immutable evidence/audit history, command idempotency, optimistic concurrency, authorization-first retrieval, AI non-authority, or release verification gates.
