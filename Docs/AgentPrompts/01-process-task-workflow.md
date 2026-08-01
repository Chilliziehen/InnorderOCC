# Initial Prompt: Process And Task Workflow Agent

You own the complete OCC process/task/cohort vertical slice. Work autonomously until your branch is production-ready; do not stop at analysis, scaffolding, or a partial API.

Repository: `D:\Repositories\ComplexProjects\InnorderOCC`

Start from the latest `feature/deployable-pilot`. Create an isolated worktree and branch `feature/process-task-workflow`. Never edit another agent's worktree. Read `README.md`, `Docs/superpowers/specs/2026-07-30-deployable-pilot-product-design.md`, all platform plans, project specifications/diagrams, migrations V001-V012, Core modules, contracts, policies, and verification scripts before deciding implementation details.

You have full delegated decision authority. Follow repository patterns and choose the smallest production-correct design. Use the installed superpowers workflow: brainstorming/specification, writing-plans, TDD, systematic debugging, verification-before-completion, and two-stage spec/code review. Continue the cycle automatically until all findings are fixed and all required tests pass. Commit frequently; never amend or weaken tests/security gates.

Scope:

- Cohort aggregate, package-version binding, memberships, ownership, dates, versioning, archival, and idempotent participant process start.
- Flowable deployment bindings and the included `medical-device-development-v1` BPMN route.
- Process start/suspend/cancel/query/history and synchronized OCC projections.
- Task availability/claim/complete/return/fail behavior and the approved presentation states/blocker codes.
- Candidate/assignee relationships, optimistic concurrency, idempotency, authorization, audit, Outbox, notifications, and read models.
- Query APIs for My Work, running processes, route progress, blockers, participants, timelines, filtering, cursor pagination, and SSE-relevant events.
- OpenAPI/Zod/Kotlin contract parity and complete role-aware end-to-end API tests.
- Included package BPMN/forms/rules and regression scenarios required for the first route where this branch is the natural owner.

Ownership and conflict rules:

- Reserve forward migration `V013__process_task_workflow.sql`; do not edit V001-V012.
- Keep new code under focused `cohort`, `process`, and `task` Core packages.
- You may extend shared OpenAPI/contracts and the platform command kernel only when required; isolate shared edits in dedicated commits for the integration agent.
- Do not implement evidence storage, risk/resource internals, AI, desktop screens, or deployment scripts beyond the interfaces this slice requires.
- Flowable calls remain limited to process-definition, process-instance, and task adapters and must share the Core PostgreSQL transaction manager.

Acceptance:

- A teacher creates a cohort and starts one process per participant.
- A participant sees, claims, and completes valid work; blocked/returned/review states are deterministic.
- Duplicate, concurrent, stale-version, unauthorized, cancellation, retry, and Flowable failure paths are safe and audited.
- PostgreSQL/Flowable/OPA/Outbox integration tests use real infrastructure and are mandatory in `verify:full`.
- All focused tests, Core tests, contracts, database tests, real OPA tests, and `npm run verify:full` pass with zero required skips.

At completion return: branch/worktree, commit list, migrations/contracts/APIs delivered, test counts, exact full-gate result, residual risks, and integration instructions for agent 06.
