# Task10A Quality Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all remaining Task10A lifecycle, transaction, locking, path, and profile-session findings with crash and concurrency regressions.

**Architecture:** Keep certificate mutations in the signed PowerShell helpers, protected by a shared strict owner-record lock and a durable per-deployment transaction journal. Main resolves the exact System32 PowerShell executable and handles Squirrel events before normal single-instance registration. Profile transport creates an immutable partition per activation and owns each response body until EOF, cancellation, error, or bounded retired-binding expiry.

**Tech Stack:** TypeScript, Electron, Node.js filesystem/process APIs, PowerShell 5.1, Vitest, Playwright.

---

### Task 1: Trusted process and startup ordering

**Files:**
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/deployment-ca-lifecycle.ts`
- Test: `apps/desktop/test/deployment-ca-lifecycle.test.ts`

- [x] Add failing tests proving malicious `PATH` is ignored and lifecycle dispatch precedes the instance lock.
- [x] Resolve `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, reject non-absolute/reparse/non-file targets, and use it for both calls.
- [x] Run lifecycle tests and confirm they pass.

### Task 2: Immutable streaming profile generations

**Files:**
- Modify: `apps/desktop/src/profile-transport.ts`
- Test: `apps/desktop/test/profile-transport.test.ts`

- [x] Add failing deterministic-timer tests for streaming A to B to A, body EOF/cancel/error, and retired timeout cancellation.
- [x] Allocate a unique partition for every activation and wrap body consumption with one-shot request release.
- [x] Cancel only retired binding bodies at expiry, reject later reads, clear after drain, and evict bounded retired bindings.
- [x] Run profile transport tests and confirm they pass.

### Task 3: Strict cross-runtime stale lock policy

**Files:**
- Modify: `apps/desktop/src/certificate-manifest.ts`
- Modify: `apps/desktop/scripts/enroll-deployment-ca.ps1`
- Modify: `apps/desktop/scripts/remove-deployment-ca.ps1`
- Test: `apps/desktop/test/release-binding.test.ts`
- Test: `apps/desktop/test/certificate-scripts.test.ts`

- [x] Add failing dead/live/malformed/race lock tests.
- [x] Write strict version/PID/process-start/acquired/random-owner records before returning the lock.
- [x] Recover only valid, bounded-age records whose exact process instance is dead, using exclusive atomic rename ownership.
- [x] Preserve live and unknown/malformed fresh locks and delete locks only when owner tokens match.
- [x] Run lock tests and confirm they pass.

### Task 4: Durable helper transaction journal and rooted paths

**Files:**
- Modify: `apps/desktop/scripts/enroll-deployment-ca.ps1`
- Modify: `apps/desktop/scripts/remove-deployment-ca.ps1`
- Test: `apps/desktop/test/certificate-scripts.test.ts`

- [x] Add failing relative-path and simulated crash tests for journal-created, store-mutated, and state-committed phases.
- [x] Validate rootedness before every `GetFullPath` call for required absolute arguments.
- [x] Atomically write and fsync strict journals containing prior state, action, thumbprint, and prior ownership before mutation.
- [x] Recover enrollment by removing only newly imported unowned certificates or completing state; recover removal by restoring/completing state consistently.
- [x] Atomically commit state, fsync, then remove the journal; invoke recovery under the lifecycle lock on every entry.
- [x] Run helper tests and confirm all crash phases converge safely.

### Task 5: Verification coverage and release gates

**Files:**
- Modify: `apps/desktop/package.json`
- Test: `apps/desktop/test/certificate-scripts.test.ts`

- [x] Add a failing assertion for the complete `cert:verify` suite list.
- [x] Include certificate manifest, certificate scripts, release binding, deployment lifecycle, and profile transport tests.
- [x] Run `cert:verify`, full verification, typecheck, package, make, and packaged smoke.
- [x] Review the final diff and create one new non-amended commit.
