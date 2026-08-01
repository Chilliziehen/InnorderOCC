# Evidence Content Quality Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make evidence parsing and scanning structurally precise, bounded, and enforceably isolated.

**Architecture:** Add a scanner-specific Docker process sandbox with a bounded protocol and concurrency gate. Tighten OOXML parsing around QName identity, replace raw signatures with structural boundaries and validated nested probes, and isolate real Docker tests behind a forced full-integration property.

**Tech Stack:** Kotlin/JVM 21, JUnit 5, AssertJ, StAX, PDFBox 3, Java ZIP/GZIP APIs, Docker CLI, Gradle 8.

---

### Task 1: Exact OOXML QNames

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/ArchiveContentValidator.kt`
- Test: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceContentInspectorTest.kt`

- [ ] Add wrong content-types/relationships/main-root namespace and namespaced-shadow attribute fixtures expecting `MALFORMED_ARCHIVE`.
- [ ] Run `:services:core:test --tests "*EvidenceContentInspectorTest"` and confirm the new cases fail.
- [ ] Pass element namespace plus attribute QNames from StAX, enforce exact OPC/application namespaces, and read required unqualified attributes uniquely.
- [ ] Rerun the focused test and confirm it passes.

### Task 2: Process Scanner Sandbox

**Files:**
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/ScannerSandbox.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/evidence/ProcessScannerSandbox.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceContentInspector.kt`
- Test: `services/core/src/test/kotlin/com/innorder/occ/evidence/ProcessScannerSandboxTest.kt`
- Test: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceContentInspectorTest.kt`

- [ ] Add protocol round-trip, constrained Docker command, timeout, malformed/oversized output, cleanup, exact absence proof, saturation, and interrupt-ignoring process tests.
- [ ] Run `:services:core:test --tests "*ProcessScannerSandboxTest"` and confirm compilation or assertions fail because the adapter is absent.
- [ ] Implement bounded request/result framing, validated Docker configuration, generated names, semaphore admission, one fixed bounded reader facility, process timeout, forced removal, and exact-name absence verification.
- [ ] Remove the per-request executor from `EvidenceContentInspector`; consume `ScannerSandboxResult` and fail closed.
- [ ] Rerun scanner and inspector tests and confirm they pass.

### Task 3: Structural Format Detection

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/EvidenceContentInspector.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/PdfContentValidator.kt`
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/ArchiveContentValidator.kt`
- Test: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceContentInspectorTest.kt`

- [ ] Add a PDFBox-generated JPEG/DCT PDF acceptance test, appended top-level PDF/ZIP polyglots, incidental nested magic payloads, valid nested ZIP/gzip/TAR, and prefixed valid ZIP tests.
- [ ] Run the inspector test and confirm JPEG/incidental-byte cases fail under raw scanning.
- [ ] Remove whole-file signature booleans, enforce PDF terminal boundary after strict parse, and replace nested magic scanning with bounded valid-container probes.
- [ ] Rerun the inspector test and confirm all structural cases pass.

### Task 4: Bounded Full Docker Tests

**Files:**
- Modify: `services/core/build.gradle.kts`
- Modify: `services/core/src/test/kotlin/com/innorder/occ/evidence/ProcessParserSandboxDockerIntegrationTest.kt`
- Create: `services/core/src/test/kotlin/com/innorder/occ/evidence/ProcessScannerSandboxDockerIntegrationTest.kt`

- [ ] Guard and tag Docker tests with the explicit full-integration system property and add a bounded concurrent output collector.
- [ ] Run the default focused suite and verify Docker tests are skipped rather than executed.
- [ ] Run with `-PfullEvidenceIntegration=true`; verify parser and scanner real Docker lifecycle tests execute with zero skips and leave no named containers.

### Task 5: Final Verification And Commit

**Files:** all files above plus this approved design and plan.

- [ ] Run forced evidence unit tests with strict dependency verification, rerun tasks, and caches disabled.
- [ ] Run forced real Docker tests with `-PfullEvidenceIntegration=true` and confirm zero skips.
- [ ] Run `git diff --check`, inspect the full diff, and verify no residual evidence containers.
- [ ] Commit all intended files with `git commit -m "fix(core): harden evidence content isolation"` without amending prior commits.

### Task 6: Structural Nested ZIP Probe

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/ArchiveContentValidator.kt`
- Test: `services/core/src/test/kotlin/com/innorder/occ/evidence/EvidenceContentInspectorTest.kt`

- [ ] Generate neutral-name nested ZIP fixtures whose local and central flags mark encryption and whose method is unsupported, plus malformed PK controls.
- [ ] Run the inspector test and confirm encrypted and unsupported nested ZIPs are not rejected as `NESTED_ARCHIVE`.
- [ ] Replace decompression-based ZIP probing with bounded EOCD, central-record, and local-record validation that accounts for self-extracting prefixes.
- [ ] Rerun the inspector test and confirm structural ZIP cases pass.

### Task 7: Bounded Parser Runner

**Files:**
- Modify: `services/core/src/main/kotlin/com/innorder/occ/evidence/ProcessParserSandbox.kt`
- Test: `services/core/src/test/kotlin/com/innorder/occ/evidence/ProcessParserSandboxTest.kt`
- Test: `services/core/src/test/kotlin/com/innorder/occ/evidence/ProcessParserSandboxDockerIntegrationTest.kt`

- [ ] Add parser saturation, admitted-launch count, shared-reader thread count, deadline, and close lifecycle tests.
- [ ] Run the parser sandbox test and confirm the new bounded-concurrency API and assertions fail.
- [ ] Add fair bounded admission/active semaphores, one fixed bounded output executor, saturation rejection, and `AutoCloseable` lifecycle management; remove per-command executors.
- [ ] Run forced parser and complete evidence unit tests with zero skips.
- [ ] Run forced full-integration Docker parser/scanner lifecycle tests with zero skips.
- [ ] Commit with `git commit -m "fix(core): bound parser execution and nested ZIP probes"` without amending.
