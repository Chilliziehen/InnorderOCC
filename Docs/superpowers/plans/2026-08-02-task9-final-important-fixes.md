# Task 9 Final Important Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve real asynchronous command outcomes and prevent credentials from crossing origins when security cleanup fails.

**Architecture:** Notification command events form a strict discriminated union and are converted into typed terminal settlements before reaching the command registry. Origin changes remain serialized, invalidate memory first, attempt all security cleanup, and persist only after every prerequisite succeeds.

**Tech Stack:** TypeScript, Zod, Electron main process, Vitest, Playwright.

---

### Task 1: Typed Asynchronous Command Settlement

**Files:**
- Modify: `apps/desktop/src/desktop-contract.ts`
- Modify: `apps/desktop/src/notification-stream.ts`
- Modify: `apps/desktop/src/command-intents.ts`
- Modify: `apps/desktop/src/main.ts`
- Test: `apps/desktop/test/reliability-boundaries.test.ts`
- Test: `apps/desktop/test/command-intents.test.ts`

- [x] Add failing schema and stream tests proving incomplete/mixed command events reject, completed events settle as completed, and problem events retain validated safe fields.
- [x] Add a failing registry replay test proving a failed asynchronous command replays a problem receipt and never invokes the dependency again.
- [x] Run focused tests and confirm the current callback loses the outcome and synthesizes success.
- [x] Introduce a typed completed/problem settlement union, map strict notification variants into it, and persist the matching terminal receipt through existing TTL behavior.
- [x] Rerun focused notification and command tests.

### Task 2: Transactional Origin Change

**Files:**
- Modify: `apps/desktop/src/desktop-ipc.ts`
- Test: `apps/desktop/test/desktop-ipc.test.ts`

- [x] Add a failing test where profile session/vault cleanup clears memory then rejects, asserting profile persistence is never called and a reconstructed profile store retains the old origin beside the retained credential.
- [x] Run the focused IPC test and confirm the current implementation persists the new origin before reporting cleanup failure.
- [x] Keep scope invalidation and all-settled cleanup, throw the generic transition error before `profiles.save` when any prerequisite fails, and persist only after cleanup succeeds.
- [x] Rerun focused IPC tests.

### Task 3: Verification And Commit

**Files:** all files changed above.

- [x] Run focused command, notification, and IPC tests.
- [x] Run `npm run test --workspace @innorder/desktop`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run package --workspace @innorder/desktop`.
- [x] Run `npm run smoke --workspace @innorder/desktop`.
- [x] Inspect status, diff, recent history, and `git diff --check`; commit without amend as `fix(desktop): preserve async command and origin safety`.
