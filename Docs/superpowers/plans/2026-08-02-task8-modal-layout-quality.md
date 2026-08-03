# Task8 Modal and Packaged Layout Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep focus inside an asynchronous removal dialog and prove every authenticated route plus dense representative workspaces reflow correctly in packaged Electron.

**Architecture:** `Settings` owns the dialog focus state and moves focus to the dialog when removal is pending, while `AppShell` continues to own background isolation. Packaged Playwright uses test-only IPC overrides and reusable geometry assertions; production receives only the minimal focus semantics and any CSS corrections exposed by real Chromium.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Electron 43, Playwright 1.62.

---

### Task 1: Pending Removal Focus Trap

**Files:**
- Modify: `apps/desktop/test/workspaces-admin-settings.test.tsx`
- Modify: `apps/desktop/src/renderer/workspaces/Settings.tsx`
- Modify: `apps/desktop/smoke/accessibility.spec.ts`

- [x] **Step 1: Write the failing unit test**

Use the existing `deferred<void>()` helper, start removal, and assert the pending state:

```tsx
const removal = deferred<void>();
handlers.onRemove.mockReturnValue(removal.promise);
render(<Settings profiles={[current]} current={current} connectivity="online" {...handlers} />);
fireEvent.click(screen.getByRole("button", { name: "移除 Pilot" }));
fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
const dialog = screen.getByRole("dialog", { name: "确认移除配置" });
expect(dialog).toHaveFocus();
expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
fireEvent.keyDown(dialog, { key: "Tab" });
expect(dialog).toHaveFocus();
fireEvent.keyDown(dialog, { key: "Escape" });
expect(dialog).toBeInTheDocument();
expect(handlers.onRemove).toHaveBeenCalledOnce();
```

- [x] **Step 2: Verify RED**

Run: `npm test --workspace @innorder/desktop -- --run test/workspaces-admin-settings.test.tsx -t "keeps focus trapped while profile removal is pending"`

Expected: FAIL because the disabled Confirm button retains or loses focus and the dialog is not focusable.

- [x] **Step 3: Implement pending dialog focus**

Add `dialogRef`, set `tabIndex={-1}`, and update the focus effect and key handler:

```tsx
const dialogRef = useRef<HTMLDivElement>(null);
const removing = pendingAction === "remove";

useEffect(() => {
  if (!pendingRemoval) return;
  if (removing) dialogRef.current?.focus();
  else confirmRemovalRef.current?.focus();
}, [pendingRemoval, removing]);

if (event.key === "Tab" && removing) {
  event.preventDefault();
  dialogRef.current?.focus();
  return;
}
```

Keep both actions disabled while `removing`; the existing ref guard prevents duplicate submission and `closeRemoval` prevents Escape closure. On rejection, `removing` becomes false and the effect returns focus to Confirm.

- [x] **Step 4: Verify GREEN and focused regressions**

Run: `npm test --workspace @innorder/desktop -- --run test/workspaces-admin-settings.test.tsx test/accessibility.test.tsx test/auth-shell.test.tsx`

Expected: 80+ tests pass with no failures.

- [x] **Step 5: Add a packaged deferred-handler test**

Make the fixture removal IPC handler return a controllable unresolved promise. In Playwright, submit removal, press Tab and Shift+Tab, attempt Escape and a duplicate click, and assert `document.activeElement` remains the dialog and never `body` or `.app-shell`. Resolve or reject through `application.evaluate` and assert the post-pending focus transition.

### Task 2: Authenticated Route and Layout Matrix

**Files:**
- Modify: `apps/desktop/smoke/accessibility.spec.ts`
- Modify if RED exposes defects: `apps/desktop/src/renderer/styles.css`
- Modify if compact labels are semantically absent: the specific renderer workspace component exposed by RED

- [x] **Step 1: Expand the test-only fixture**

Supply `occ.read`, `occ.admin`, every workspace query capability, and every command capability. Return a `ready` result by `request.workspace`, including schema-valid Resources and Administration rows:

```ts
resources: {
  id: "resource-smoke-1", name: "装配线 A 超长资源名称", type: "line",
  state: "available", capacity: 12, availableCapacity: 7,
  reservations: [{ id: "reservation-1", start, end, capacity: 3, state: "active" }],
  conflicts: [{ kind: "capacity", start, end, capacity: 2 }],
},
administration: {
  subject: "值班管理员超长显示名称", type: "person", status: "active", updatedAt,
},
```

- [x] **Step 2: Add all-route navigation smoke and verify RED**

Navigate all ten route links and assert the expected route heading is visible and the document remains rendered. Run the packaged smoke test against the current executable:

`npm run smoke --workspace @innorder/desktop -- --grep "navigates every authenticated route"`

Expected: FAIL until the fixture exposes all capabilities and operation-specific valid results.

- [x] **Step 3: Add the reusable layout checker**

For visible controls and leaf text elements, collect bounding boxes and report only unrelated intersecting elements. Exclude ancestor/descendant pairs, hidden/zero-area nodes, overlays, and elements whose nearest positioned control is the same. Return document widths, overlap descriptions, visible compact `data-label` pseudo-content, nav accessible names, and tooltip text.

- [x] **Step 4: Add the dense route matrix and verify RED**

For Overview, Resources, and Administration, run 1440x900, 1024x768, 600x800 at zoom 1 and 1280x720 at zoom 2. Assert:

```ts
expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.clientWidth);
expect(layout.overlaps).toEqual([]);
if (layout.innerWidth <= 700) expect(layout.visibleDataLabels.length).toBeGreaterThan(0);
expect(layout.navNames).toEqual(expect.arrayContaining(routeLabels));
```

Run: `npm run smoke --workspace @innorder/desktop -- --grep "authenticated layout matrix"`

Expected: FAIL with concrete route, viewport, and geometry evidence before any CSS correction.

- [x] **Step 5: Apply minimal renderer corrections and verify GREEN**

Change only selectors identified by RED evidence, using `min-width: 0`, wrapping, compact grid tracks, or overflow constraints. Repackage and rerun the matrix until all cases pass.

### Task 3: Full Verification and Commit

**Files:**
- Verify all modified Task8 files and the design/plan documents.

- [x] **Step 1: Run focused tests**

Run: `npm test --workspace @innorder/desktop -- --run test/workspaces-admin-settings.test.tsx test/accessibility.test.tsx test/auth-shell.test.tsx`

- [x] **Step 2: Run full tests and typecheck**

Run: `npm test --workspace @innorder/desktop`

Run: `npm run typecheck --workspace @innorder/desktop`

- [x] **Step 3: Build the packaged executable**

Run: `npm run package --workspace @innorder/desktop`

- [x] **Step 4: Run targeted and full packaged smoke**

Run: `npm run smoke --workspace @innorder/desktop -- --grep "pending profile removal|authenticated layout matrix|navigates every authenticated route"`

Run: `npm run smoke --workspace @innorder/desktop`

- [x] **Step 5: Review and commit**

Run `git diff --check`, inspect the complete diff and status, stage only intended files, and commit:

```bash
git commit -m "fix(desktop): harden modal and packaged layouts"
```
