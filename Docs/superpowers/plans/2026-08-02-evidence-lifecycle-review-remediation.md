# Evidence Lifecycle Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Task 5 evidence lifecycle into exact parity with committed contracts while closing production binding, failure-command, lease recovery, preview, and cleanup safety gaps.

**Architecture:** Treat committed Zod/OpenAPI definitions as the HTTP and event oracle. Keep upload bytes and lease heartbeats outside command transactions, but route every terminal mutation through `CommandExecutor`; persist workflow/notification intents in the same transaction and require real production sinks when evidence production mode is enabled. Extend only V014 for additional provenance and object metadata.

**Tech Stack:** Kotlin/JDK 21, Spring Boot/JDBC, PostgreSQL 16/Flyway V014, MinIO, OPA 1.5.1, Testcontainers, Node/Zod/OpenAPI.

---

### Task 1: Contract-Parity API And Requirement Policy

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceModels.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceController.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceService.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceRepository.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceControllerContractParityTest.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceServiceIntegrationTest.kt`

- [x] Write failing reflection/serialization tests for every committed evidence path, request field, response field, status, and command response header.
- [x] Run the focused tests and confirm failures identify current path/shape drift.
- [x] Implement exact requirement, upload session/status, content result, metadata, submit/review, version/review page, preview metadata, and download metadata DTOs.
- [x] Implement requirement list/read, upload status, split version/review history, preview metadata, current-version download, Digest, suffix ranges, and 416 support.
- [x] Run focused controller/policy tests green.

### Task 2: Transactional Integration Binding And Review Semantics

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceWorkflowPort.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/DomainNotificationPort.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceProductionBindingVerifier.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceService.kt`
- Modify: `services/core/src/main/resources/application.yml`
- Modify: `infra/compose/compose.yaml`
- Create: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceProductionBindingVerifierTest.kt`

- [x] Write failing startup tests for production mode with intent-only/missing bindings and passing tests with explicit transactional sinks.
- [x] Define narrow workflow snapshot/dispatch and notification dispatch bindings while retaining transactional intent stores.
- [x] Derive prior assignee from workflow snapshot and conditional due time from DB transaction time plus requirement policy.
- [x] Prove adapter rejection rolls review, audit, outbox, review, and intents back.

### Task 3: Commandized Terminal Upload Failures And Recoverable Leases

**Files:**
- Modify: `database/migrations/V014__evidence_risk_resource.sql`
- Modify: `database/tests/evidence-risk-resource-static.test.mjs`
- Modify: `database/tests/pglite-smoke.mjs`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceRepository.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceService.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceServiceIntegrationTest.kt`

- [x] Write failing tests for content idempotency identity, same-key terminal replay, different-key conflict, commandized 413/422 failures, phase heartbeats, stale phase recovery after object inspection, and response disconnect continuation.
- [x] Add V014 content-command provenance, processing phase, and preview metadata columns/constraints.
- [x] Implement lease-only transitions and `AuthorizedCommand` terminal failure/confirmation paths with contract event payloads.
- [x] Implement stale recovery for all active phases by inspecting quarantine/immutable object state before resuming.
- [x] Run focused PostgreSQL/MinIO lifecycle tests green.

### Task 4: Object-Backed Preview And Scheduled Cleanup

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/ObjectStore.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/MinioObjectStore.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidencePreviewService.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceCleanupJob.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceRepository.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceServiceIntegrationTest.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/evidence/MinioObjectStoreIntegrationTest.kt`

- [x] Write failing tests for separate preview keys, bounded sanitized inline preview, 24-hour orphan grace, scheduled cleanup, prefix sweep, and cleanup-confirmation/legal-hold races.
- [x] Store text/Markdown previews as immutable private objects and persist only metadata/key provenance.
- [x] Schedule cleanup with production properties, lease database dispositions, and sweep unreferenced prefixed objects after 24 hours.
- [x] Recheck references/holds/backups under row locks immediately before bounded deletion and never claim retained versions.

### Task 5: Error Mapping, Acceptance, And Verification

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/api/ApiExceptionHandler.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/api/OccProblem.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceControllerContractParityTest.kt`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceServiceIntegrationTest.kt`
- Modify: `Docs/Architecture/evidence-workflow-integration.md`

- [x] Write failing tests for exact 400/413/422/416 contract problems and non-leaking bounded details.
- [x] Complete end-to-end v1 reject/v2 accept, immutable event/audit payload, conditional/minimumCount, malicious fixture, equal-content key, cleanup race, lease expiry, and recipient derivation coverage.
- [x] Run forced evidence package, exact V014 PostgreSQL, database static/PGlite, contract build, and OpenAPI parity with zero required skips.
- [x] Review the complete diff; commit follows this plan update without amending `5811bbe`.
