# Complete Desktop Product Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a secure, role-aware Windows Electron OCC console with real profile/authentication support, complete workspace states, narrow IPC, accessible packaged journeys, and installer preparation.

**Architecture:** Electron main owns profiles, credentials, HTTP, cache, and runtime events; preload exposes a frozen schema-bounded API; the renderer uses a capability-aware hash router and reusable workspace state model. Missing business contracts remain explicit unavailable operations in production while test-only injected adapters exercise every role and state without fake production data.

**Tech Stack:** Electron 43, Electron Forge/Vite, React 19, TypeScript, Zod contracts, Ant Design 5, Lucide, Vitest/Testing Library, Playwright, axe-core, Squirrel.Windows.

---

## File Structure

- `apps/desktop/src/desktop-contract.ts`: renderer/main data types, schemas, channel names, and public API.
- `apps/desktop/src/profile-store.ts`: profile validation and durable non-secret persistence.
- `apps/desktop/src/session-manager.ts`: safeStorage refresh credential lifecycle and in-memory access token.
- `apps/desktop/src/core-client.ts`: bounded typed HTTP behavior, Problem Details, idempotency, and connectivity.
- `apps/desktop/src/desktop-ipc.ts`: sender-validated named IPC registration.
- `apps/desktop/src/preload.ts`: frozen narrow bridge only.
- `apps/desktop/src/main.ts`: lifecycle composition, single-instance handling, and permission denial.
- `apps/desktop/src/renderer/routes.ts`: route/capability manifest and hash routing helpers.
- `apps/desktop/src/renderer/app-controller.ts`: bootstrap/session/connectivity reducer.
- `apps/desktop/src/renderer/components/`: shell, bootstrap, login, state views, command/query controls.
- `apps/desktop/src/renderer/workspaces/`: nine approved workspace views plus settings.
- `apps/desktop/src/renderer/App.tsx`: thin composition root.
- `apps/desktop/src/renderer/styles.css`: console tokens, responsive/reflow, reduced motion, and forced colors.
- `apps/desktop/test/`: unit, component, IPC, security, accessibility, and role matrix tests.
- `apps/desktop/smoke/`: packaged security, role, screenshot, and installed-app tests.
- `apps/desktop/assets/`: Windows icon source and generated `.ico`.
- `apps/desktop/forge.config.ts`: stable identity, icon, fuses, and Squirrel maker.

## Dependency And Ownership Order

Tasks 1-6 are sequential because they establish shared contracts, privileged
boundaries, routing, shell composition, and common state components. After Task
6, the nine workspace files in Task 7 may be assigned one per agent with
exclusive file ownership; the primary agent alone integrates `App.tsx`, route
composition, shared tests, and CSS. Task 9 follows Tasks 3 and 6. Task 8 follows
workspace integration. Tasks 10 and 10A own packaging and certificate files and
may run parallel to renderer accessibility once the main lifecycle is stable.
Task 11 follows packaging, and Tasks 12-13 are final sequential gates.

### Task 1: Desktop Contract And Profile Validation

**Files:**
- Create: `apps/desktop/src/desktop-contract.ts`
- Create: `apps/desktop/src/profile-store.ts`
- Test: `apps/desktop/test/profile-store.test.ts`

- [ ] **Step 1: Write failing profile and contract tests**

Test that HTTPS root origins are normalized, packaged HTTP is rejected, development loopback HTTP requires both development gates, credentials/path/query/fragment are rejected, profiles are persisted without secrets, and profile changes produce a different cache scope.

```ts
expect(parseServerProfile({ name: "Pilot", origin: "https://occ.test/" }, true).origin)
  .toBe("https://occ.test");
expect(() => parseServerProfile({ name: "Pilot", origin: "http://127.0.0.1:8080" }, true))
  .toThrow("HTTPS is required");
expect(parseServerProfile({ name: "Dev", origin: "http://127.0.0.1:8080" }, false, true).environment)
  .toBe("development");
```

- [ ] **Step 2: Verify RED**

Run: `npm run test --workspace @innorder/desktop -- profile-store.test.ts`
Expected: FAIL because `profile-store.ts` does not exist.

- [ ] **Step 3: Implement strict schemas and injected persistence**

Define `ServerProfile`, `SessionSnapshot`, `Connectivity`, `WorkspaceResult`, `ProblemReceipt`, and `OccApi` in `desktop-contract.ts`. Implement `parseServerProfile(input, packaged, allowDevelopmentHttp)` with `URL`, exact-root checks, HTTPS enforcement, UUID generation, and no trust-bypass field. Implement `createProfileStore({ read, write })` so tests use memory and main later injects atomic JSON storage.

```ts
export interface ServerProfile {
  id: string;
  name: string;
  origin: string;
  environment: "production" | "pilot" | "development";
  caFingerprint?: string;
}

export interface OccApi {
  profiles: { list(): Promise<ServerProfile[]>; save(input: ProfileInput): Promise<ServerProfile>; select(id: string): Promise<void>; remove(id: string): Promise<void> };
  session: { restore(): Promise<SessionSnapshot>; login(input: LoginInput): Promise<SessionSnapshot>; logout(): Promise<void> };
  runtime: { statuses(): Promise<SystemStatus[]> };
  workspaces: { query(input: WorkspaceQuery): Promise<WorkspaceResult> };
  commands: { execute(input: WorkspaceCommand): Promise<CommandReceipt> };
  uploads: { start(input: EvidenceUploadInput): Promise<UploadReceipt>; cancel(uploadId: string): Promise<void> };
  notifications: { list(cursor?: string): Promise<NotificationPage>; subscribe(listener: (event: NotificationEvent) => void): () => void };
}
```

The same module defines Zod schemas and inferred types for every referenced
input/result above; `ipc-contract.ts` re-exports this canonical contract and
channel constants only. Add `zod` as a direct desktop dependency. Generate the
currently committed auth/status client from `occ-core.yaml`; only absent
business groups use unavailable operation descriptors.

- [ ] **Step 4: Verify GREEN and typecheck**

Run: `npm run test --workspace @innorder/desktop -- profile-store.test.ts && npm run typecheck --workspace @innorder/desktop`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/desktop-contract.ts apps/desktop/src/profile-store.ts apps/desktop/test/profile-store.test.ts
git commit -m "feat(desktop): add validated server profiles"
```

### Task 2: Main-Owned HTTP And Session Security

**Files:**
- Create: `apps/desktop/src/core-client.ts`
- Create: `apps/desktop/src/session-manager.ts`
- Test: `apps/desktop/test/core-client.test.ts`
- Test: `apps/desktop/test/session-manager.test.ts`

- [ ] **Step 1: Write failing HTTP and credential tests**

Cover redirect rejection, bounded timeout, strict auth response validation, normalized Problem Details, generic login errors, serialized refresh, safeStorage-only refresh persistence, in-memory access token, expiry cleanup, and logout cleanup even when revocation fails.

```ts
expect(fetcher).toHaveBeenCalledWith("https://occ.test/api/v1/me", expect.objectContaining({ redirect: "error" }));
expect(vault.persisted()).not.toContain("access-token");
await Promise.all([manager.refresh(), manager.refresh()]);
expect(refreshFetch).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Verify RED**

Run: `npm run test --workspace @innorder/desktop -- core-client.test.ts session-manager.test.ts`
Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement the bounded Core client**

Implement named `login`, `refresh`, `logout`, `me`, and `systemStatus` operations. Use `AbortSignal.timeout`, `redirect: "error"`, JSON content-type checks, a 2 MiB response cap, and contract Zod schemas. Never return raw response bodies on errors.

- [ ] **Step 4: Implement session manager with injected vault**

Use an interface `{ encrypt, decrypt, remove }` backed by `safeStorage` and an atomic credential file in main. Strip refresh token before returning `SessionSnapshot`; store access token in a closure; serialize refresh with one promise; clear both tokens on expiry/logout/profile switch.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test --workspace @innorder/desktop -- core-client.test.ts session-manager.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/core-client.ts apps/desktop/src/session-manager.ts apps/desktop/test/core-client.test.ts apps/desktop/test/session-manager.test.ts
git commit -m "feat(desktop): secure core sessions in main"
```

### Task 3: Narrow IPC, Preload, And Electron Lifecycle

**Files:**
- Create: `apps/desktop/src/desktop-ipc.ts`
- Modify: `apps/desktop/src/ipc-contract.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/global.d.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/electron-security.ts`
- Test: `apps/desktop/test/desktop-ipc.test.ts`
- Modify: `apps/desktop/test/preload.test.ts`
- Modify: `apps/desktop/test/electron-security.test.ts`

- [ ] **Step 1: Write failing security-boundary tests**

Require exact sender URL, strict input parsing, payload limits, frozen grouped preload keys, no token/path/request/fetch/shell methods, permission denial, single-instance focus, and handler disposal.

```ts
expect(Object.keys(exposed)).toEqual(["profiles", "session", "runtime", "workspaces", "commands", "uploads", "notifications"]);
expect(Object.isFrozen(exposed)).toBe(true);
expect(recursiveKeys(exposed)).not.toEqual(expect.arrayContaining(["token", "filesystem", "shell", "request", "fetch"]));
```

- [ ] **Step 2: Verify RED**

Run: `npm run test --workspace @innorder/desktop -- desktop-ipc.test.ts preload.test.ts electron-security.test.ts`
Expected: FAIL on the expanded API and lifecycle requirements.

- [ ] **Step 3: Register named validated handlers**

Build one helper that parses request schemas, checks `event.senderFrame.url` against the renderer document, invokes one dependency method, validates the result, and returns sanitized failures. Register only contract channel constants.

- [ ] **Step 4: Compose main and preload**

Make preload a mechanical bridge with recursively frozen groups and a
synchronous notification subscription wrapper that returns an event-listener
disposer. In main, atomically persist profiles under `app.getPath("userData")`,
wrap `safeStorage`, deny every permission request, acquire
`requestSingleInstanceLock`, and focus/restore the first window on
`second-instance`.

- [ ] **Step 5: Verify GREEN and full desktop regression**

Run: `npm run test --workspace @innorder/desktop && npm run typecheck --workspace @innorder/desktop`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src apps/desktop/test
git commit -m "feat(desktop): expose secure named IPC"
```

### Task 4: Application State And Capability Router

**Files:**
- Create: `apps/desktop/src/renderer/routes.ts`
- Create: `apps/desktop/src/renderer/app-controller.ts`
- Test: `apps/desktop/test/routes.test.ts`
- Test: `apps/desktop/test/app-controller.test.ts`

- [ ] **Step 1: Write failing route and state tests**

Test all approved paths, coarse read-only visibility, specific mutation capability requirements, admin route denial, unknown-route fallback, profile/login/authenticated/offline/expired transitions, stale mutation lockout, and cross-profile reset.

```ts
expect(visibleRoutes(["occ.read"]).map((route) => route.path)).toContain("/overview");
expect(canAccessRoute("/administration", ["occ.read"])).toBe(false);
expect(reduceAppState(online, { type: "OFFLINE", at: now }).mode).toBe("offline");
expect(canMutate(reduceAppState(online, { type: "OFFLINE", at: now }))).toBe(false);
```

- [ ] **Step 2: Verify RED**

Run: `npm run test --workspace @innorder/desktop -- routes.test.ts app-controller.test.ts`
Expected: FAIL because router/controller modules do not exist.

- [ ] **Step 3: Implement pure route policy and reducer**

Define route metadata for Overview, My Work, Processes, Intervention Center, Risks, Resources, Domain Design, Administration, System Operations, and Settings. Parse and set `location.hash` without a router dependency. Keep route access pure and default deny. Implement a discriminated app-state union and exhaustive reducer.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test --workspace @innorder/desktop -- routes.test.ts app-controller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/routes.ts apps/desktop/src/renderer/app-controller.ts apps/desktop/test/routes.test.ts apps/desktop/test/app-controller.test.ts
git commit -m "feat(desktop): add capability-aware application state"
```

### Task 5: Bootstrap, Login, And Authenticated Shell

**Files:**
- Create: `apps/desktop/src/renderer/components/ProfileBootstrap.tsx`
- Create: `apps/desktop/src/renderer/components/Login.tsx`
- Create: `apps/desktop/src/renderer/components/AppShell.tsx`
- Create: `apps/desktop/src/renderer/components/StatusBanner.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Test: `apps/desktop/test/auth-shell.test.tsx`

- [ ] **Step 1: Write failing component tests**

Cover validated profile form, environment identity, generic login failure, no password echo after submit, capability-filtered navigation, direct-route denial without query calls, route heading focus, logout, session expiry announcement, and offline mutation lockout.

- [ ] **Step 2: Verify RED**

Run: `npm run test --workspace @innorder/desktop -- auth-shell.test.tsx`
Expected: FAIL on missing components.

- [ ] **Step 3: Implement controller-driven entry screens**

Use labelled native inputs and explicit submit buttons. Display profile hostname and environment at login. Keep credentials only in local form state and clear password in `finally`. Show generic errors with correlation ID only when supplied.

- [ ] **Step 4: Implement shell and focus management**

Render route-manifest navigation, compact icon tooltips, user/profile menu, connectivity/freshness banner, `aria-live` announcements, and a main heading with `tabIndex={-1}` focused after hash changes.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test --workspace @innorder/desktop -- auth-shell.test.tsx App.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer apps/desktop/test/auth-shell.test.tsx apps/desktop/test/App.test.tsx
git commit -m "feat(desktop): add profile and authenticated shell"
```

### Task 6: Reusable Workspace Query And Command States

**Files:**
- Create: `apps/desktop/src/renderer/components/WorkspaceState.tsx`
- Create: `apps/desktop/src/renderer/components/QueryToolbar.tsx`
- Create: `apps/desktop/src/renderer/components/CommandPanel.tsx`
- Create: `apps/desktop/src/renderer/workspaces/workspace-definitions.ts`
- Test: `apps/desktop/test/workspace-state.test.tsx`

- [ ] **Step 1: Write failing state tests**

Cover loading, empty, unavailable, Problem Details with correlation receipt, stale age, offline read-only, conflict refresh, cursor controls, filter/sort state, command double-click coalescing, and unavailable command explanations.

- [ ] **Step 2: Verify RED**

Run: `npm run test --workspace @innorder/desktop -- workspace-state.test.tsx`
Expected: FAIL because shared components do not exist.

- [ ] **Step 3: Implement stable query and command surfaces**

Use discriminated `WorkspaceResult` states. Keep toolbar and result dimensions stable, announce transitions, disable mutations whenever connectivity is not online or a command capability/operation is unavailable, and render correlation IDs as copyable text.

- [ ] **Step 4: Define production operation metadata**

For each workspace, list required API groups, filters, tabs, columns, and commands. Mark only committed status/auth operations available; all missing business operations use an `UNAVAILABLE_CONTRACT` state containing exact resource groups, never sample records.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test --workspace @innorder/desktop -- workspace-state.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/components apps/desktop/src/renderer/workspaces apps/desktop/test/workspace-state.test.tsx
git commit -m "feat(desktop): add honest workspace states"
```

### Task 7: Nine Operational Workspaces

**Files:**
- Create: `apps/desktop/src/renderer/workspaces/Overview.tsx`
- Create: `apps/desktop/src/renderer/workspaces/MyWork.tsx`
- Create: `apps/desktop/src/renderer/workspaces/Processes.tsx`
- Create: `apps/desktop/src/renderer/workspaces/Interventions.tsx`
- Create: `apps/desktop/src/renderer/workspaces/Risks.tsx`
- Create: `apps/desktop/src/renderer/workspaces/Resources.tsx`
- Create: `apps/desktop/src/renderer/workspaces/DomainDesign.tsx`
- Create: `apps/desktop/src/renderer/workspaces/Administration.tsx`
- Create: `apps/desktop/src/renderer/workspaces/SystemOperations.tsx`
- Create: `apps/desktop/src/renderer/workspaces/Settings.tsx`
- Test: `apps/desktop/test/workspaces.test.tsx`

- [ ] **Step 1: Write failing role/workspace matrix tests**

Assert every workspace title, tabs, filters, capability-disabled controls, and
unavailable API note. The exact matrix is: My Work uses `/tasks`, `/evidence`,
`/reservations`, `/recommendations` with state tabs and claim/submit/reserve/
guidance commands; Processes uses `/cohorts`, `/processes`, `/tasks` with search,
status, participant and timeline filters plus create/start/suspend/cancel;
Interventions uses `/evidence`, `/risks`, `/recommendations`, `/audit` with
review/exception/policy/AI tabs and accept/conditional/reject/return; Risks uses
`/risks` with severity, SLA, owner and status filters plus acknowledge/assign/
mitigate/escalate/resolve; Resources uses `/resources`, `/reservations` with
type, availability and conflict filters plus create/change/reserve/cancel;
Domain Design uses `/packages`, `/package-versions`, `/policy-releases` with
draft/version/validation tabs plus import/validate/diff/approve/publish;
Administration uses `/people`, `/relationships`, `/roles`, `/policy-releases`,
`/providers`, `/knowledge`, `/audit` with corresponding tabs and named create,
disable, assign, release, test, ingest and inspect commands. Settings provides
profile select/edit/remove, TLS fingerprint/trust status, preferences, logout,
and selected-profile removal confirmation. Include participant, process owner,
domain modeler, resource manager, and administrator matrices. Assert System
Operations has no restart, shell, backup, restore, or container controls.

- [ ] **Step 2: Verify RED**

Run: `npm run test --workspace @innorder/desktop -- workspaces.test.tsx`
Expected: FAIL because workspace modules do not exist.

- [ ] **Step 3: Implement read/query surfaces**

Compose shared toolbar/state components for every approved information architecture item. Overview reuses live Core status data. System Operations presents service components, version, environment, freshness, and explicit unavailable Outbox/notification summaries.

- [ ] **Step 4: Implement command entry surfaces**

Add evidence upload/review, task/process, reservation, risk, package publication, people/policy/provider/knowledge command forms with strict client-side shape validation and specific capability checks. Production submission remains disabled until the named contract operation is available.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test --workspace @innorder/desktop -- workspaces.test.tsx App.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/workspaces apps/desktop/test/workspaces.test.tsx
git commit -m "feat(desktop): build operational workspaces"
```

### Task 8: Accessibility And Responsive Visual System

**Files:**
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/src/renderer/index.html`
- Modify: `apps/desktop/package.json`
- Modify: `package-lock.json`
- Create: `apps/desktop/test/accessibility.test.tsx`

- [ ] **Step 1: Add axe and write failing accessibility tests**

Install pinned `axe-core`/test integration with `npm install -D --workspace @innorder/desktop @axe-core/playwright@4.10.2 jest-axe@10.0.0`. Test bootstrap, login, each shell route, keyboard navigation, visible focus hooks, announcements, and no serious/critical violations.

- [ ] **Step 2: Verify RED**

Run: `npm run test --workspace @innorder/desktop -- accessibility.test.tsx`
Expected: FAIL on current semantics/reflow.

- [ ] **Step 3: Implement tokens and reflow**

Extract existing neutral/teal console colors into CSS variables, retain compact 5-6 px radii, add stable toolbar/table/control dimensions, wrap long status text, collapse navigation with tooltips, stack tabular rows at compact widths, and avoid nested cards.

- [ ] **Step 4: Add accessibility media behavior**

Add `prefers-reduced-motion`, `forced-colors: active`, 200% zoom-compatible layouts, `:focus-visible`, minimum 24 CSS-pixel icon controls, and screen-reader-only utilities. Do not scale font size with viewport width.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test --workspace @innorder/desktop -- accessibility.test.tsx && npm run typecheck --workspace @innorder/desktop`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer apps/desktop/test/accessibility.test.tsx apps/desktop/package.json package-lock.json
git commit -m "feat(desktop): enforce accessible responsive console"
```

### Task 9: Offline Cache, Conflicts, SSE, And Upload Boundaries

**Files:**
- Create: `apps/desktop/src/read-cache.ts`
- Create: `apps/desktop/src/notification-stream.ts`
- Create: `apps/desktop/src/command-intents.ts`
- Create: `apps/desktop/src/evidence-upload.ts`
- Modify: `apps/desktop/src/desktop-contract.ts`
- Modify: `apps/desktop/src/desktop-ipc.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/main.ts`
- Test: `apps/desktop/test/read-cache.test.ts`
- Test: `apps/desktop/test/reliability-boundaries.test.ts`

- [ ] **Step 1: Write failing reliability tests**

Test profile/customer/principal cache isolation, local session re-entry before
cached disclosure, logout/profile/account-removal purge, sensitive-kind
rejection, stale age, offline mutation rejection, cursor isolation,
notification query fallback, bounded SSE reconnect, 409 normalization/
currentVersion, exact-payload idempotency reuse, changed-payload key rotation,
upload retry/quarantine/review-history states, size/type limits, cancellation,
and no MinIO URL acceptance.

- [ ] **Step 2: Verify RED**

Run: `npm run test --workspace @innorder/desktop -- read-cache.test.ts reliability-boundaries.test.ts`
Expected: FAIL because reliability modules do not exist.

- [ ] **Step 3: Implement bounded stores and state machines**

Use injected persistence and clock/timer dependencies. Cache only allowlisted projection kinds. Implement command intent hashes with canonical JSON and UUIDs. Implement SSE state without connecting until a committed endpoint is configured. Implement upload request validation and progress callbacks without direct object-store access.

- [ ] **Step 4: Wire named IPC methods**

Expose cache-backed workspace queries, notification subscription/disposal, command execution, conflict receipts, and evidence progress through named methods only. Return unavailable before any absent endpoint call.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test --workspace @innorder/desktop -- read-cache.test.ts reliability-boundaries.test.ts desktop-ipc.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src apps/desktop/test
git commit -m "feat(desktop): add offline and conflict safety"
```

### Task 10: Windows Identity, Installer, And Single-Instance Package

**Files:**
- Create: `apps/desktop/assets/occ.ico`
- Modify: `apps/desktop/forge.config.ts`
- Modify: `apps/desktop/scripts/run-forge.mjs`
- Modify: `apps/desktop/package.json`
- Modify: `package-lock.json`
- Create: `apps/desktop/test/forge-config.test.ts`

- [ ] **Step 1: Write failing package configuration tests**

Require product name `Innorder OCC`, stable executable `InnorderOCC`, Windows x64, ASAR, icon, Squirrel maker, development-unsigned artifact label, no embedded signing secret, and `make` command support.

- [ ] **Step 2: Verify RED**

Run: `npm run test --workspace @innorder/desktop -- forge-config.test.ts`
Expected: FAIL because makers and metadata are absent.

- [ ] **Step 3: Add pinned maker and package metadata**

Install the Forge Squirrel maker version matching Forge. Configure `packagerConfig.name`, `executableName`, `icon`, `appBundleId`, company metadata, and one x64 Squirrel maker. Extend `run-forge.mjs` to accept `make` while preserving provenance checks. Add `make` script.

- [ ] **Step 4: Add reviewed multi-resolution icon**

Create a square Windows icon carrying the existing `序` brand mark with 16, 24, 32, 48, 64, 128, and 256 px layers. Verify Forge consumes the `.ico` and no default Electron icon remains.

- [ ] **Step 5: Verify package config and make**

Run: `npm run test --workspace @innorder/desktop -- forge-config.test.ts && npm run make --workspace @innorder/desktop`
Expected: PASS and an unsigned-development x64 installer under `apps/desktop/out/make`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/assets apps/desktop/forge.config.ts apps/desktop/scripts/run-forge.mjs apps/desktop/package.json package-lock.json apps/desktop/test/forge-config.test.ts
git commit -m "build(desktop): prepare Windows installer"
```

### Task 10A: Deployment CA Enrollment Boundary

**Files:**
- Create: `apps/desktop/src/certificate-manifest.ts`
- Create: `apps/desktop/scripts/enroll-deployment-ca.ps1`
- Create: `apps/desktop/scripts/remove-deployment-ca.ps1`
- Create: `apps/desktop/test/certificate-manifest.test.ts`
- Create: `apps/desktop/test/certificate-scripts.test.ts`

- [ ] **Step 1: Write failing manifest and trust lifecycle tests**

Require a release-manifest SHA-256 match, exact CA fingerprint confirmation,
`Cert:\CurrentUser\Root` only, product-owned thumbprint recording, profile
reference counting, idempotent import, and removal only when no profile
references the owned certificate. Test wrong-host, expired, replaced, and
untrusted server certificates fail without a bypass.

- [ ] **Step 2: Verify RED**

Run: `npm run test --workspace @innorder/desktop -- certificate-manifest.test.ts certificate-scripts.test.ts`
Expected: FAIL because certificate modules do not exist.

- [ ] **Step 3: Implement bounded signed-helper inputs**

Parse a fixed manifest schema containing certificate path, SHA-256, subject,
and fingerprint; reject paths outside the installer payload and any mismatch.
PowerShell scripts accept only the verified absolute certificate path,
fingerprint, and product state path, never an arbitrary command. Persist only
owned thumbprints and profile references.

- [ ] **Step 4: Verify trust lifecycle**

Run: `npm run test --workspace @innorder/desktop -- certificate-manifest.test.ts certificate-scripts.test.ts`
Expected: PASS. Release acceptance remains blocked until the helper and
installer are Authenticode-signed with external credentials.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/certificate-manifest.ts apps/desktop/scripts/enroll-deployment-ca.ps1 apps/desktop/scripts/remove-deployment-ca.ps1 apps/desktop/test/certificate-manifest.test.ts apps/desktop/test/certificate-scripts.test.ts
git commit -m "feat(desktop): bound deployment CA enrollment"
```

### Task 11: Packaged Role Journeys And Visual Review

**Files:**
- Modify: `apps/desktop/playwright.config.ts`
- Modify: `apps/desktop/smoke/packaged.spec.ts`
- Create: `apps/desktop/smoke/role-journeys.spec.ts`
- Create: `apps/desktop/smoke/accessibility.spec.ts`
- Create: `apps/desktop/smoke/visual.spec.ts`
- Create: `apps/desktop/smoke/fixtures/smoke-adapter.ts`
- Create: `apps/desktop/vite.smoke.config.ts`

- [ ] **Step 1: Write packaged journey tests**

Build a separately named smoke artifact from `vite.smoke.config.ts`; production
main and renderer entries cannot import `smoke/fixtures`. Inspect the production
ASAR to prove the adapter source and fixture marker are absent, and verify
environment variables, CLI arguments, and persisted settings cannot activate
an adapter. Cover administrator profile/login, teacher review/risk, participant
task/evidence/resource/guidance, modeler package publication, resource-manager
conflict, AI enabled/disabled/stale/unavailable, offline/reconnect, and 409
refresh.

- [ ] **Step 2: Add accessibility and visual gates**

Run axe on every route; test keyboard traversal, route focus, 200% zoom, reduced motion, and forced-colors emulation. Capture reviewed screenshots at 1440x900, 1024x768, and 600x800 and fail on horizontal overflow, overlap, clipped controls, blank content, or console errors.

- [ ] **Step 3: Build and verify packaged smoke**

Run: `npm run package --workspace @innorder/desktop && npm run smoke --workspace @innorder/desktop`
Expected: all packaged security, role, accessibility, and visual tests PASS with screenshot artifacts.

- [ ] **Step 4: Review screenshots**

Open every generated PNG and confirm navigation, headings, controls, state messages, and tooltips are legible and non-overlapping. Correct CSS and regenerate until clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/playwright.config.ts apps/desktop/smoke apps/desktop/vite.smoke.config.ts
git commit -m "test(desktop): cover packaged role journeys"
```

### Task 12: Installed Smoke, Documentation, And Full Verification

**Files:**
- Create: `apps/desktop/scripts/installed-smoke.ps1`
- Create: `Docs/Integration/desktop-product.md`
- Modify: `README.md`

- [ ] **Step 1: Implement idempotent installed smoke script**

Locate the generated installer, install for the current standard user, launch `InnorderOCC.exe`, wait for the profile screen, verify one process owns the app after a second launch, close it, run upgrade/install again, uninstall, and assert product-owned files are removed without deleting unrelated profiles/certificates. Exit nonzero on every skipped assertion.

- [ ] **Step 2: Run installed smoke**

Run: `powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/installed-smoke.ps1`
Expected: PASS on Windows with install, launch, upgrade, and uninstall receipts. If policy or environment prevents this, record the exact blocker and do not claim final release acceptance.

- [ ] **Step 3: Write integration notes**

Document branch commits, route/capability matrix, missing API resource groups, generated client replacement points, SSE/upload assumptions, artifact locations, screenshot locations, unsigned signing status, and exact commands for agent 06. State that unavailable operations block final release acceptance.

- [ ] **Step 4: Run focused and repository gates**

Run: `npm run test --workspace @innorder/desktop`
Expected: all desktop tests PASS.

Run: `npm run typecheck --workspace @innorder/desktop`
Expected: PASS.

Run: `npm run verify`
Expected: workspace tests, Core build, TypeScript builds/typechecks, and Windows x64 Electron package PASS.

Run: `npm run smoke --workspace @innorder/desktop`
Expected: all packaged Playwright tests PASS.

- [ ] **Step 5: Inspect changes and commit**

```bash
git status --short
git diff --check
git add apps/desktop/scripts/installed-smoke.ps1 Docs/Integration/desktop-product.md README.md
git commit -m "docs: hand off desktop integration"
```

### Task 13: Independent Spec, Code, And Security Review

**Files:**
- Modify only files implicated by verified findings.

- [ ] **Step 1: Dispatch independent reviewers**

Dispatch one reviewer for specification coverage, one for Electron/IPC security, and one for renderer accessibility/visual quality. Require severity-ordered findings with file and line references.

- [ ] **Step 2: Validate every finding**

Reproduce each claimed issue with a focused test or direct packaged observation. Reject findings that conflict with committed contracts or invent unavailable backend behavior.

- [ ] **Step 3: Fix accepted findings with TDD**

For each accepted issue, add a failing regression test, verify RED, implement the smallest correction, and verify GREEN.

- [ ] **Step 4: Run final clean verification**

Run: `npm run test --workspace @innorder/desktop && npm run typecheck --workspace @innorder/desktop && npm run verify && npm run smoke --workspace @innorder/desktop`
Expected: every command exits 0 with no required skips.

- [ ] **Step 5: Commit review fixes**

```bash
git add -u apps/desktop Docs/Integration README.md
git commit -m "fix(desktop): address acceptance review"
```
