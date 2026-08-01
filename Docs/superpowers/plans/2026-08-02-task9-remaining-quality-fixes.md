# Task 9 Remaining Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining upload, command settlement, lifecycle cleanup, and archive cancellation findings without reintroducing whole-buffer IPC or lost-response duplication.

**Architecture:** Main retains ownership of open spool file descriptors, command/upload intent bindings, and lifecycle cleanup. Renderer owns only bounded file slices and always cancels an acquired upload session when archive processing exits unsuccessfully.

**Tech Stack:** TypeScript, Electron IPC/preload, Node FileHandle streams, React, Vitest, Playwright.

---

### Task 1: Descriptor-Owned Spool Transport

**Files:**
- Modify: `apps/desktop/src/evidence-upload.ts`
- Test: `apps/desktop/test/chunked-upload.test.ts`

- [x] Add failing tests that replace the spool pathname after finish begins, reject append after finishing, and verify transport bytes still come from the original handle with exact final `stat.size` and digest.
- [x] Run `npm run test --workspace @innorder/desktop -- chunked-upload.test.ts` and confirm path replacement currently changes or breaks transport.
- [x] Keep the validated `FileHandle` open through transport, call `stat()` after queued appends, stream with controlled positional `read()` calls and awaited yields, and close/unlink only after transport ends.
- [x] Rerun the focused upload tests and require all to pass.

### Task 2: SSE Terminal Command Tombstones

**Files:**
- Modify: `apps/desktop/src/command-intents.ts`
- Test: `apps/desktop/test/command-intents.test.ts`

- [x] Add failing tests proving matching SSE settlement changes accepted state to a TTL-bounded terminal receipt, exact replay invokes no dependency and retains the original key, and changed payload/target rejects.
- [x] Run `npm run test --workspace @innorder/desktop -- command-intents.test.ts` and confirm settlement currently deletes the binding and allocates a new key.
- [x] Change `settle()` to retain a validated completed/already-completed receipt using the existing terminal timestamp and key binding instead of deleting.
- [x] Correct the old settlement test and rerun the command tests.

### Task 3: Retryable Upload Cancellation

**Files:**
- Modify: `apps/desktop/src/evidence-upload.ts`
- Test: `apps/desktop/test/chunked-upload.test.ts`

- [x] Add failing tests where cancellation returns a retryable problem, exact `begin` immediately creates a fresh spool with the same main idempotency key, changed metadata rejects, and successful retry performs transport.
- [x] Run the focused upload tests and confirm current terminal cancellation is permanently replayed.
- [x] Never store `UPLOAD_CANCELLED` in `binding.terminal`; retain the canonical metadata/key binding with a fresh touch time and let exact `begin` allocate a new session.
- [x] Rerun upload tests.

### Task 4: Failure-Resilient Session Cleanup

**Files:**
- Modify: `apps/desktop/src/desktop-ipc.ts`
- Test: `apps/desktop/test/desktop-ipc.test.ts`

- [x] Add failing tests where `abortAll` or `abortScope` rejects but session logout/profile cleanup still run, local session cleanup clears credentials, cache cleanup is attempted, and the operation reports contained failures.
- [x] Run `npm run test --workspace @innorder/desktop -- desktop-ipc.test.ts` and confirm abort currently short-circuits cleanup.
- [x] Use `Promise.allSettled` for independent abort/session/cache operations, preserve ordering by starting abort before mutation, and throw a sanitized aggregate only after every required cleanup has settled.
- [x] Rerun desktop IPC tests.

### Task 5: Archive Session Ownership

**Files:**
- Modify: `apps/desktop/src/renderer/components/WorkspaceRouter.tsx`
- Test: `apps/desktop/test/workspaces-resources-domain.test.tsx`

- [x] Add failing tests for archive read, append, and finish failures after `begin`, asserting 1 MiB slices and exactly one `cancel(uploadId)` call.
- [x] Run `npm run test --workspace @innorder/desktop -- workspaces-integration.test.tsx` and confirm archive sessions currently leak.
- [x] Wrap post-begin archive work in `try/finally`, mark success only after a validated archive receipt, and cancel exactly once on every unsuccessful exit.
- [x] Rerun archive tests.

### Task 6: Verification And Commit

**Files:** all files changed above.

- [x] Run focused tests for upload, command intents, desktop IPC, and domain archive integration.
- [x] Run `npm run test --workspace @innorder/desktop` and require zero failures.
- [x] Run `npm run typecheck` and require all workspaces to pass.
- [x] Run `npm run package --workspace @innorder/desktop`.
- [x] Run `npm run smoke --workspace @innorder/desktop` and require all packaged Playwright tests to pass.
- [x] Inspect status, staged diff, recent history, and `git diff --check`; commit without amend using `fix(desktop): close remaining Task 9 quality gaps`.
