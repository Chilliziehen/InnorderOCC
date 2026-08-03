# Task10A Final Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish lifecycle locks atomically and abort retired profile requests before or after response headers.

**Architecture:** Lock contenders durably stage complete owner records and publish them with no-overwrite filesystem primitives before entering the critical section. Profile bindings register owned abort controllers before session fetch, expire pending requests and bodies together, and reject late responses before body registration.

**Tech Stack:** TypeScript, Node.js filesystem and Abort APIs, PowerShell 5.1, Vitest, Electron Forge, Playwright.

---

### Task 1: Atomic TypeScript Lock Publication

**Files:**
- Modify: `apps/desktop/src/certificate-manifest.ts`
- Test: `apps/desktop/test/release-binding.test.ts`

- [x] **Step 1: Write failing atomic-publication tests**

Add tests that inject a publication fault after temporary-file sync, assert the final lock never exists or contains partial JSON, assert random temporary files are removed, and run two contenders against the same destination to prove only one no-overwrite link succeeds.

```ts
await expect(withCertificateLifecycleLock(root, operation, {
  publishLock: async () => { throw new Error("simulated pre-publish crash"); },
})).rejects.toThrow(/pre-publish crash/i);
expect(await readdir(root)).not.toContain(".deployment-ca.lifecycle.lock");
expect((await readdir(root)).filter((name) => name.includes(".lock.") && name.endsWith(".tmp"))).toEqual([]);
```

- [x] **Step 2: Verify RED**

Run: `npx vitest run test/release-binding.test.ts`

Expected: FAIL because `publishLock` is unavailable and the current implementation creates the empty final lock before writing its record.

- [x] **Step 3: Implement durable staging and no-overwrite publication**

Extend lock dependencies with an injectable `publishLock(temporaryPath, lockPath)` defaulting to `fs.link`. Create a random same-directory temporary path, open it with `wx`, write and sync the strict record, publish through the hard link, unlink the temporary pathname while retaining its file handle, and return that handle as ownership. On publication failure, close the handle, remove the temporary path, and enter existing-lock recovery only for `EEXIST`.

```ts
const temporaryPath = `${lockPath}.${randomUUID()}.tmp`;
const handle = await fs.open(temporaryPath, "wx", 0o600);
await handle.writeFile(JSON.stringify(record));
await handle.sync();
await dependencies.publishLock(temporaryPath, lockPath);
await fs.rm(temporaryPath);
```

For aged malformed locks, call an injectable `inspectLegacyHolder(lockPath)` whose Windows default invokes trusted PowerShell and opens the path with `FileShare.None`. Return `true` only on exit zero; preserve on unsupported platforms and every indeterminate result. Continue quarantine recovery only after `true`.

- [x] **Step 4: Verify GREEN**

Run: `npx vitest run test/release-binding.test.ts`

Expected: all release-binding tests pass, including valid stale, malformed stale holder, publication race, and pre-publication crash cases.

### Task 2: Atomic PowerShell Lock Publication

**Files:**
- Modify: `apps/desktop/scripts/enroll-deployment-ca.ps1`
- Modify: `apps/desktop/scripts/remove-deployment-ca.ps1`
- Test: `apps/desktop/test/certificate-scripts.test.ts`

- [x] **Step 1: Write failing helper publication tests**

Add source-contract assertions requiring random `.tmp` staging, `Flush($true)` before `File.Move`, final-path `FileMode.Open` with `FileShare.None`, and `finally` cleanup. Extend the development crash phase with `BeforeLockPublish`, execute each helper, and assert no final lock or temporary lock remains.

```ts
expect(source).toMatch(/\.tmp[\s\S]+Flush\(\$true\)[\s\S]+\[IO\.File\]::Move/);
expect(source).toMatch(/FileMode\]::Open[\s\S]+FileShare\]::None/);
```

- [x] **Step 2: Verify RED**

Run: `npx vitest run test/certificate-scripts.test.ts -t "atomic lock publication"`

Expected: FAIL because helpers currently create and expose the final lock before serializing the owner record.

- [x] **Step 3: Implement helper staging, publication, and legacy probing**

Build the owner record before opening any final path. Write it to a random same-directory temporary file with `WriteThrough` and `Flush($true)`, optionally simulate `BeforeLockPublish`, dispose the staging stream, and call `[IO.File]::Move($temporaryPath, $lockPath)`. Reopen the published final path with `FileMode.Open`, `ReadWrite`, and `FileShare.None`, verify the owner bytes, and return the held stream. Delete the contender's own temporary path in `finally`.

For aged malformed legacy records, attempt a direct `FileMode.Open`, `ReadWrite`, `FileShare.None` probe and dispose it before quarantine rename. Sharing, access, and parse failures preserve the final lock.

- [x] **Step 4: Verify GREEN**

Run: `npx vitest run test/certificate-scripts.test.ts`

Expected: all helper tests pass, including every journal crash phase and both atomic lock publication crash tests.

### Task 3: Pending Profile Request Expiry

**Files:**
- Modify: `apps/desktop/src/profile-transport.ts`
- Test: `apps/desktop/test/profile-transport.test.ts`

- [x] **Step 1: Write failing deterministic request tests**

Use fake timers and deferred header promises to prove a retired timeout and retired-limit overflow abort a pending request, a caller signal reaches `session.fetch`, active current-profile requests remain pending, and a fetch implementation that ignores abort but resolves later has its response body cancelled and the transport promise rejected.

```ts
const pendingSignal = session.fetch.mock.calls[0]![1]!.signal!;
await vi.advanceTimersByTimeAsync(1_000);
expect(pendingSignal.aborted).toBe(true);
lateHeaders.resolve(new Response(lateBody));
await expect(request).rejects.toThrow(/retired/i);
expect(cancelLateBody).toHaveBeenCalledOnce();
```

- [x] **Step 2: Verify RED**

Run: `npx vitest run test/profile-transport.test.ts`

Expected: FAIL because current bindings track only response bodies and pass the caller request signal directly to `session.fetch`.

- [x] **Step 3: Implement owned pending trackers**

Add a pending tracker set to each binding. Before `session.fetch`, create and register an `AbortController`, compose it with `init.signal` using `AbortSignal.any`, and pass the composed signal in a copied `RequestInit`. Expiry aborts pending controllers before expiring bodies. After headers, unregister pending tracking and reject/cancel when the composed signal or binding has expired; only live responses enter `trackResponse`.

```ts
const controller = new AbortController();
const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
binding.pending.add(controller);
const response = await binding.session.fetch(input, { ...init, signal });
binding.pending.delete(controller);
if (signal.aborted || binding.expirationStarted) {
  void response.body?.cancel(signal.reason ?? retiredError).catch(() => undefined);
  throw signal.reason ?? retiredError;
}
```

- [x] **Step 4: Verify GREEN**

Run: `npx vitest run test/profile-transport.test.ts`

Expected: all profile transport tests pass with deterministic timers and no unsettled rejection warnings.

### Task 4: Release Verification and Commit

**Files:**
- Modify: `Docs/superpowers/plans/2026-08-02-task10a-final-quality.md`

- [x] **Step 1: Run focused and broad verification**

Run in order:

```powershell
npm run cert:verify --workspace @innorder/desktop
npm test --workspace @innorder/desktop
npm run typecheck
$env:OPA_PATH='C:\Users\30367\AppData\Local\Temp\opencode\opa-windows-1.5.1.exe'; npm run verify:full
npm run package --workspace @innorder/desktop
npm run make --workspace @innorder/desktop
npm run smoke --workspace @innorder/desktop
```

Expected: every command exits zero; strict full verification reports all required Docker JUnit results and `full verification passed`.

- [x] **Step 2: Review and commit**

Run `git diff --check`, inspect `git status`, `git diff`, and recent history, mark this plan complete, stage only the intended files, and create a non-amended commit:

```powershell
git commit -m "fix(desktop): publish locks before ownership"
```
