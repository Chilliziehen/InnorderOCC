# Task 9 Quality Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Task 9 with restart-safe offline reads, bounded chunk uploads, lifecycle cancellation, notification state/catch-up, terminal command replay, and byte-aware LRU persistence.

**Architecture:** Electron main remains the only owner of network, credentials, idempotency keys, spool paths, and persisted scope. Renderer uses strict named IPC operations whose largest binary argument is 1 MiB. All mutable registries are bounded, generation-aware, and exact-replay only.

**Tech Stack:** TypeScript, Electron IPC/preload, React, Zod, Node filesystem/crypto streams, Vitest, Playwright.

---

### Task 1: Main Offline Query Path

**Files:**
- Modify: `apps/desktop/src/desktop-ipc.ts`
- Modify: `apps/desktop/src/renderer/components/WorkspaceRouter.tsx`
- Test: `apps/desktop/test/desktop-ipc.test.ts`
- Test: `apps/desktop/test/workspaces-integration.test.tsx`

- [ ] Write failing tests proving offline navigation invokes `workspaces.query`, main calls `readCache.get` but not `workspaceQuery`, restart data returns `stale`, and renderer retention is used only when IPC rejects.
- [ ] Run `npm run test --workspace @innorder/desktop -- desktop-ipc.test.ts workspaces-integration.test.tsx` and confirm the offline tests fail.
- [ ] Add `readCache.get(scope, input, authenticatedScope)` to `DesktopApiDependencies`; branch before remote query:

```ts
if (dependencies.isOnline?.() === false) {
  const cached = scope && await dependencies.readCache?.get(scope, input, scope);
  return cached ?? { state: "error", problem: { title: "Offline cache unavailable", code: "OFFLINE_NO_CACHE", status: 503 } };
}
```

- [ ] Remove the renderer early offline return; invoke named query for online/offline modes and use retained data only in the rejection/missing-API branch.
- [ ] Rerun the focused files and confirm they pass.

### Task 2: Terminal Command Intent Replay

**Files:**
- Modify: `apps/desktop/src/command-intents.ts`
- Test: `apps/desktop/test/command-intents.test.ts`

- [ ] Write failing tests for exact terminal completed/conflict/non-retryable receipt replay, changed payload rejection, main-generated key reuse, new-handle new execution, TTL expiry, and capacity recovery.
- [ ] Run `npm run test --workspace @innorder/desktop -- command-intents.test.ts` and confirm terminal calls currently reinvoke.
- [ ] Extend bindings with validated `terminalReceipt` and `terminalAt`; return it before invoking when identity/payload hashes match. Preserve accepted notification settlement and retryable transport behavior.
- [ ] Include terminal bindings in bounded cleanup and rerun the focused test.

### Task 3: Byte-Aware Read Cache And Cursor LRU

**Files:**
- Modify: `apps/desktop/src/read-cache.ts`
- Modify: `apps/desktop/src/notification-stream.ts`
- Test: `apps/desktop/test/read-cache.test.ts`
- Test: `apps/desktop/test/reliability-boundaries.test.ts`

- [ ] Write failing tests where adding a large valid cache entry evicts oldest entries until bytes fit, reads touch LRU order, oversized single entries reject without blocking later writes, and cursor scopes evict by count/bytes.
- [ ] Run both focused files and confirm current byte-limit persistence freezes instead of evicting.
- [ ] Store access timestamps and serialize candidate cache files in a loop:

```ts
while (entries.length > maxEntries || serializedBytes(entries) > maxBytes) entries.shift();
if (entries.length === 0 && serializedBytes([candidate]) > maxBytes) throw new Error("Read cache entry exceeds byte limit");
```

- [ ] Serialize read touches through the existing mutation queue. Change cursor records to `{ cursor, accessedAt }`, enforce strict max scopes/max bytes, and purge oldest records before every write.
- [ ] Rerun focused tests.

### Task 4: Notification Catch-Up And Connection State

**Files:**
- Modify: `apps/desktop/src/desktop-contract.ts`
- Modify: `apps/desktop/src/ipc-contract.ts`
- Modify: `apps/desktop/src/notification-stream.ts`
- Modify: `apps/desktop/src/desktop-ipc.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/renderer/AppShell.tsx`
- Test: `apps/desktop/test/reliability-boundaries.test.ts`
- Test: `apps/desktop/test/desktop-ipc.test.ts`
- Test: `apps/desktop/test/preload.test.ts`
- Test: `apps/desktop/test/auth-shell.test.tsx`

- [ ] Write failing tests for multipage catch-up, request-token versus delivered-event cursor separation, max-page fail-closed behavior, and validated state transitions/freshness subscription.
- [ ] Run focused notification/preload/renderer tests and confirm failures.
- [ ] Add strict state contract:

```ts
type NotificationConnectionState = {
  state: "connecting" | "online" | "reconnecting" | "unavailable";
  changedAt: string;
  lastEventAt?: string;
};
```

- [ ] Loop catch-up for at most 20 pages and 2,000 events; pass `nextCursor` only to the next query, persist the actual emitted event cursor, and connect SSE with the last delivered cursor.
- [ ] Publish state only on meaningful change/event freshness, forward through one named event, validate in preload, and render a quiet stale notification indicator.
- [ ] Ensure reliability composition clears the old session before evaluating the replacement session.
- [ ] Rerun focused tests.

### Task 5: Chunk Upload Main Service

**Files:**
- Rewrite: `apps/desktop/src/evidence-upload.ts`
- Modify: `apps/desktop/src/desktop-contract.ts`
- Modify: `apps/desktop/src/ipc-contract.ts`
- Modify: `apps/desktop/src/desktop-ipc.ts`
- Modify: `apps/desktop/src/preload.ts`
- Test: `apps/desktop/test/reliability-boundaries.test.ts`
- Test: `apps/desktop/test/desktop-ipc.test.ts`
- Test: `apps/desktop/test/preload.test.ts`

- [ ] Write failing tests for begin/append/finish, 1 MiB chunk bound, exact sequence, four-session cap, total buffered cap, incremental hash, restrictive random spool path, finish/cancel deletion, crash cleanup ownership/age, replay receipts, and duplicate active intent behavior.
- [ ] Run upload-focused tests and confirm the old whole-buffer API fails.
- [ ] Replace `start` with strict operations:

```ts
uploads.preflight(metadata)
uploads.begin({ metadata, intentHandle }): Promise<{ sessionId: string } | UploadReceipt>
uploads.append({ sessionId, sequence, data }): Promise<{ acceptedBytes: number }>
uploads.finish(sessionId): Promise<UploadReceipt>
uploads.cancel(sessionId): Promise<void>
```

- [ ] Main creates `sessionId`, idempotency key, and `${sessionId}.occ-upload` under injected spool root. Append validates at most 1 MiB, awaits file-handle writes, updates one incremental hash, and keeps no accumulated payload buffer. Finish closes, validates count/hash, streams the spool with cancellation/backpressure to transport, stores terminal replay, and deletes the file.
- [ ] Add `abortScope`, `abortAll`, `dispose`, and startup cleanup with strict filename, regular-file, root containment, and age checks.
- [ ] Set append IPC request allowance to approximately 1.1 MiB and keep every other channel at the normal bound.
- [ ] Rerun upload-focused tests.

### Task 6: Upload Lifecycle And Renderer Migration

**Files:**
- Modify: `apps/desktop/src/main-reliability-composition.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/renderer/components/WorkspaceRouter.tsx`
- Test: `apps/desktop/test/desktop-ipc.test.ts`
- Test: `apps/desktop/test/workspaces-integration.test.tsx`

- [ ] Write failing lifecycle tests proving abort occurs before logout/profile mutation and old append/transport work stops. Write renderer tests spying on `File.arrayBuffer` and `File.slice`.
- [ ] Run focused tests and confirm whole-file reads and missing abort ordering.
- [ ] Inject upload lifecycle into reliability composition and invoke `abortAll`/`abortScope` synchronously before queued credential/profile transitions.
- [ ] Implement renderer upload loop:

```ts
for (let offset = 0, sequence = 0; offset < file.size; offset += MAX_CHUNK_BYTES, sequence++) {
  const data = new Uint8Array(await file.slice(offset, offset + MAX_CHUNK_BYTES).arrayBuffer());
  await uploads.append({ sessionId, sequence, data });
}
return uploads.finish(sessionId);
```

- [ ] Generate a new renderer intent only on explicit user start; retries retain the prior handle. Cancel session on scope change or local cancellation.
- [ ] Rerun focused lifecycle/renderer tests.

### Task 7: Final Verification And Commit

**Files:** all files changed above.

- [ ] Run focused tests for cache, command intents, upload, notifications, IPC, preload, and renderer.
- [ ] Run `npm run test --workspace @innorder/desktop` and require zero failures.
- [ ] Run `npm run typecheck` and require all workspaces to pass.
- [ ] Run `npm run package --workspace @innorder/desktop`.
- [ ] Run `npm run smoke --workspace @innorder/desktop` and require all packaged Playwright tests to pass.
- [ ] Inspect `git status --short`, `git diff --check`, `git diff`, and recent log; stage only intended Task 9 files.
- [ ] Commit without amend using `fix(desktop): complete Task 9 reliability boundaries` and report the full SHA and evidence.
