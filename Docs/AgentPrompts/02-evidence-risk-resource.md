# Initial Prompt: Evidence, Risk, And Resource Agent

You own the complete evidence/review, risk/intervention, and resource/reservation vertical slice. Work autonomously in repeated implement-test-review cycles until production-ready.

Base your isolated worktree branch `feature/evidence-risk-resource` on the latest `feature/deployable-pilot`. Never work in another branch/worktree. First read the deployable product design, evidence sequence diagram, database design, migrations V001-V012, command/authz kernel, contracts, MinIO Compose configuration, and deployment boundaries.

You have full delegated decision authority. Invoke the relevant superpowers skills, write a focused spec/plan, use TDD, run real integration tests, request spec and quality reviews, fix every Critical/Important issue, and continue without asking for routine approval. Do not stop at placeholders or UI mocks.

Scope:

- Evidence requirements, upload sessions, bounded authenticated Core streaming to private MinIO, SHA-256/media/extension/size verification, quarantine/scanner abstraction, immutable versions, submission, review history, and cleanup.
- Review decisions ACCEPTED/REJECTED/CONDITIONAL with the approved gate/follow-up semantics and segregation of duties.
- Evidence previews/download disposition and strict authorization; MinIO remains unreachable from clients.
- Risk creation, package-versioned rules for overdue/returns/inactivity/blockers/evidence/resource conflicts, severity/SLA, ownership, acknowledgement, escalation, mitigation, resolution, and intervention queue.
- Managed resources, availability, exclusive and capacity reservations, row locking, overlap/capacity constraints, conflict-safe redaction, changes/cancellation, and schedule queries.
- Notifications, audit, Outbox events, idempotency, optimistic versions, cursor queries, OpenAPI/contracts, and complete service tests.

Ownership and conflicts:

- Reserve migration `V014__evidence_risk_resource.sql`; do not edit earlier migrations.
- Own focused Core packages `evidence`, `risk`, and `resource` plus MinIO adapter.
- Treat malware scanning as a production interface with a deterministic safe test implementation; deployment agent may supply the final scanner container.
- Do not implement process/task internals. Consume stable interfaces/events from agent 01 and provide explicit integration adapters/notes.
- Put shared OpenAPI/contract edits in separate commits.

Acceptance:

- Participant uploads an allowed file, Core verifies and versions it, teacher returns it, participant resubmits, teacher accepts, and audit/events remain immutable.
- Infected/polyglot/macro/encrypted/oversized/wrong-hash/decompression-bomb fixtures fail closed with no accessible object.
- Risk and intervention paths are deterministic and measured.
- Concurrent exclusive/capacity reservations cannot overbook; stale/unauthorized commands fail safely.
- Real PostgreSQL, MinIO, OPA and concurrency tests are mandatory; all verification including `verify:full` passes.

Return branch, commits, migration, API/event contracts, infrastructure assumptions, exact tests/full result, residual risks, and integration instructions for agent 06.
