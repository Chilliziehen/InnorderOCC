import AxeBuilder from "@axe-core/playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, type ElectronApplication, type Page } from "playwright/test";

import { packagedSmokeLaunchOptions, preflightPackagedExecutable } from "../packaged-app";
import { WORKSPACE_MANIFEST } from "../../src/renderer/workspace-manifest";

export type SmokeRole = "administrator" | "teacher" | "participant" | "modeler" | "resource-manager";

const roleCapabilities: Record<SmokeRole, readonly string[]> = {
  administrator: [
    "occ.read", "occ.admin", "overview.query", "administration.query", "people.manage",
    "relationships.manage", "roles.manage", "policies.manage", "providers.manage",
    "knowledge.manage", "audit.query",
  ],
  teacher: [
    "occ.read", "overview.query", "processes.query", "cohorts.create", "processes.start",
    "interventions.query", "evidence.review", "interventions.resolve", "risks.query",
    "risks.acknowledge", "risks.mitigate", "risks.resolve",
  ],
  participant: [
    "occ.read", "overview.query", "tasks.query", "tasks.claim", "evidence.submit",
    "reservations.create", "recommendations.request", "interventions.query",
  ],
  modeler: [
    "occ.read", "occ.admin", "overview.query", "packages.query", "packages.import",
    "packages.validate", "packages.diff", "packages.approve", "packages.publish",
  ],
  "resource-manager": [
    "occ.read", "overview.query", "resources.query", "resources.create", "resources.change",
    "reservations.create", "reservations.cancel",
  ],
};

const operationPolicy = Object.fromEntries(WORKSPACE_MANIFEST.map((workspace) => [workspace.id, {
  query: { operation: workspace.query.operation, capability: workspace.query.capability },
  commands: Object.fromEntries(workspace.commands.map((command) => [command.operation, command.capability])),
}])) as Record<string, { query: { operation: string; capability: string }; commands: Record<string, string> }>;

const ids = {
  profile: "10000000-0000-4000-8000-000000000001",
  user: "10000000-0000-4000-8000-000000000002",
  command: "10000000-0000-4000-8000-000000000003",
  correlation: "10000000-0000-4000-8000-000000000004",
  upload: "10000000-0000-4000-8000-000000000005",
  evidence: "10000000-0000-4000-8000-000000000006",
} as const;

const queryItems: Record<string, readonly Record<string, unknown>[]> = {
  overview: [
    { item: "Pilot order exception", type: "attention", status: "open", dueAt: "2026-08-03T09:00:00.000Z" },
    { item: "Evidence review deadline", type: "deadline", status: "due-soon", dueAt: "2026-08-03T10:00:00.000Z" },
  ],
  administration: [{ subject: "Pilot Administrator", type: "person", status: "active", updatedAt: "2026-08-02T08:00:00.000Z" }],
  processes: [{
    id: "process-1", process: "Pilot onboarding", cohort: "August cohort", owner: "Teacher One", status: "RUNNING",
    expectedVersion: 7, progress: 45,
    participants: [{ id: "person-1", name: "Participant One", role: "participant" }],
    tasks: [{ id: "task-1", name: "Submit identity evidence", state: "AVAILABLE" }],
    evidence: [{ id: "evidence-1", name: "Identity document", state: "PENDING_REVIEW" }],
    risks: [{ id: "risk-1", name: "Late evidence", severity: "high" }],
    timeline: [{ id: "event-1", occurredAt: "2026-08-02T08:30:00.000Z", label: "Process started" }],
  }],
  interventions: [
    { id: "review-1", item: "Identity evidence review", type: "review", owner: "Teacher One", status: "OPEN", version: 4, evidenceVersion: 3 },
    { id: "recommendation-1", item: "Cited completion guidance", type: "recommendation", owner: null, status: "OPEN", version: 1, recommendation: { state: "cited", summary: "Verify the signed checklist before submission.", citations: ["Pilot handbook section 4.2"] } },
  ],
  risks: [{ id: "risk-1", risk: "Participant deadline at risk", severity: "high", owner: "Teacher One", status: "OPEN", deadline: "2026-08-04T12:00:00.000Z", sla: "due-soon", version: 5 }],
  "my-work": [{
    id: "task-1", task: "Submit identity evidence", process: "Pilot onboarding", state: "AVAILABLE", dueAt: "2026-08-04T12:00:00.000Z",
    evidenceRequirements: ["Signed checklist"], acceptedMediaTypes: ["text/plain", "application/pdf"], reservation: "No reservation",
    reviewHistory: [{ id: "review-history-1", outcome: "RETURNED", occurredAt: "2026-08-01T10:00:00.000Z", note: "Add the signed page" }],
  }],
  "domain-design": [{
    id: "package-1", name: "pilot-operations", version: "1.4.0", status: "approved",
    assets: [{ name: "model.json", kind: "model", digest: "sha256:pilot-model" }],
    validation: { state: "passed", summary: "All checks passed" },
    diff: { baseVersion: "1.3.0", summary: "One policy updated" }, approval: { state: "approved" },
  }],
  resources: [{
    id: "resource-1", name: "Assembly line A", type: "line", state: "available", capacity: 12, availableCapacity: 7,
    reservations: [{ id: "reservation-1", start: "2026-08-03T08:00:00.000Z", end: "2026-08-03T10:00:00.000Z", capacity: 3, state: "active" }],
    conflicts: [{ kind: "capacity", start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T09:30:00.000Z", capacity: 2 }],
  }],
};

export interface SmokeFixtureOptions {
  readonly role?: SmokeRole;
  readonly startWithoutProfile?: boolean;
}

export interface SmokeFixture {
  readonly application: ElectronApplication;
  readonly page: Page;
  readonly userData: string;
  close(): Promise<void>;
  calls(): Promise<Array<{ channel: string; input?: unknown }>>;
  setOnline(online: boolean): Promise<void>;
  setUploadPaused(paused: boolean): Promise<void>;
  setQueryState(workspace: string, state: "ready" | "stale" | "conflict"): Promise<void>;
  sendNotificationState(state: "online" | "reconnecting" | "unavailable"): Promise<void>;
}

export async function launchSmokeFixture(options: SmokeFixtureOptions = {}): Promise<SmokeFixture> {
  const role = options.role ?? "administrator";
  const executablePath = await preflightPackagedExecutable();
  const userData = await mkdtemp(path.join(tmpdir(), `innorder-role-${role}-`));
  const launchOptions = packagedSmokeLaunchOptions(executablePath, [`--user-data-dir=${userData}`]);
  let application = await electron.launch(launchOptions);
  let page: Page;
  try {
    page = await application.firstWindow({ timeout: 15_000 });
  } catch {
    await application.close().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    application = await electron.launch(launchOptions);
    page = await application.firstWindow({ timeout: 30_000 });
  }

  await application.evaluate(({ BrowserWindow, ipcMain }, fixture) => {
    const channels = {
      profilesList: "profiles:list", profilesCurrent: "profiles:current", profilesSave: "profiles:save", profilesSelect: "profiles:select", profilesRemove: "profiles:remove",
      sessionRestore: "session:restore", sessionLogin: "session:login", sessionLogout: "session:logout",
      statuses: "system-statuses:get", query: "workspaces:query", command: "commands:execute",
      uploadPreflight: "uploads:preflight", uploadBegin: "uploads:begin", uploadAppend: "uploads:append", uploadFinish: "uploads:finish", uploadCancel: "uploads:cancel",
      notificationsList: "notifications:list",
    } as const;
    type FixtureState = {
      profiles: Array<Record<string, unknown>>; current: Record<string, unknown> | null; authenticated: boolean;
      calls: Array<{ channel: string; input?: unknown }>; uploadBytes: number; uploadSize: number; uploadSequence: number; uploadCompleteCount: number; uploadIntent: string; uploadKind: "evidence" | "archive"; uploadActive: boolean; uploadPaused: boolean;
      online: boolean; queryStates: Record<string, "ready" | "stale" | "conflict">;
    };
    const state: FixtureState = {
      profiles: fixture.startWithoutProfile ? [] : [fixture.profile],
      current: fixture.startWithoutProfile ? null : fixture.profile,
      authenticated: !fixture.startWithoutProfile,
      calls: [], uploadBytes: 0, uploadSize: 1, uploadSequence: 0, uploadCompleteCount: 0, uploadIntent: fixture.ids.correlation, uploadKind: "evidence", uploadActive: false, uploadPaused: false, online: true, queryStates: {},
    };
    (globalThis as typeof globalThis & { __occSmokeFixture?: FixtureState }).__occSmokeFixture = state;
    const scrub = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(scrub);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, /password|secret|token/i.test(key) ? "[REDACTED]" : scrub(child)]));
    };
    const record = (channel: string, input?: unknown) => state.calls.push(input === undefined ? { channel } : { channel, input: scrub(input) });
    const assertObject = (channel: string, input: unknown) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${channel}: object request required`);
    };
    const install = (channel: string, handler: (...args: any[]) => unknown) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    install(channels.profilesList, () => { record(channels.profilesList); return state.profiles; });
    install(channels.profilesCurrent, () => { record(channels.profilesCurrent); return state.current; });
    install(channels.profilesSave, (_event, input: Record<string, unknown>) => {
      assertObject(channels.profilesSave, input); record(channels.profilesSave, input);
      if (typeof input.name !== "string" || typeof input.origin !== "string" || !input.origin.startsWith("https://")) throw new Error("invalid profile");
      const profile = { id: fixture.ids.profile, name: input.name, origin: input.origin, environment: input.environment ?? "pilot" };
      state.profiles = [profile]; state.current = profile; return profile;
    });
    install(channels.profilesSelect, (_event, id: string) => { record(channels.profilesSelect, id); state.current = state.profiles.find((item) => item.id === id) ?? null; });
    install(channels.profilesRemove, (_event, id: string) => { record(channels.profilesRemove, id); state.profiles = state.profiles.filter((item) => item.id !== id); if (state.current?.id === id) state.current = null; });
    install(channels.sessionRestore, () => { record(channels.sessionRestore); return state.authenticated ? fixture.session : { state: "anonymous" }; });
    install(channels.sessionLogin, (_event, input: Record<string, unknown>) => {
      assertObject(channels.sessionLogin, input); record(channels.sessionLogin, input);
      if (typeof input.username !== "string" || typeof input.password !== "string" || !input.username || !input.password) throw new Error("invalid credentials");
      state.authenticated = true; return fixture.session;
    });
    install(channels.sessionLogout, () => { record(channels.sessionLogout); state.authenticated = false; });
    install(channels.statuses, () => { record(channels.statuses); return fixture.statuses; });
    install(channels.query, (_event, input: Record<string, unknown>) => {
      assertObject(channels.query, input); record(channels.query, input);
      const workspace = String(input.workspace ?? "");
      const policy = (fixture.policy as Record<string, { query: { operation: string; capability: string }; commands: Record<string, string> }>)[workspace];
      if (!policy || input.operation !== policy.query.operation || typeof input.filters !== "object" || !fixture.capabilities.includes(policy.query.capability)) {
        return { state: "error", problem: { title: "Operation forbidden", code: "OPERATION_FORBIDDEN", status: 403 } };
      }
      let items = fixture.queryItems[workspace] ?? [];
      if (workspace === "my-work") {
        const tab = String((input.filters as Record<string, unknown>).tab ?? "available");
        const stateByTab: Record<string, string> = { available: "AVAILABLE", claimed: "CLAIMED", blocked: "BLOCKED", "pending-review": "PENDING_REVIEW", returned: "RETURNED", completed: "COMPLETED" };
        items = items.map((item) => ({ ...item, state: stateByTab[tab] ?? "AVAILABLE" }));
      }
      if (state.queryStates[workspace] === "conflict") return { state: "conflict", currentVersion: 9, correlationId: fixture.ids.correlation };
      if (state.queryStates[workspace] === "stale") return { state: "stale", items, count: items.length, fetchedAt: "2026-08-01T08:00:00.000Z" };
      if (!state.online && items.length) return { state: "offline", items, count: items.length, fetchedAt: "2026-08-01T08:00:00.000Z" };
      const availableOperations = Object.entries(policy.commands).filter(([, capability]) => fixture.capabilities.includes(capability)).map(([operation]) => operation);
      return items.length ? { state: "ready", items, count: items.length, fetchedAt: fixture.now, availableOperations } : { state: "empty", fetchedAt: fixture.now };
    });
    install(channels.command, (_event, input: Record<string, unknown>) => {
      assertObject(channels.command, input); record(channels.command, input);
      if (typeof input.workspace !== "string" || typeof input.operation !== "string" || typeof input.intentHandle !== "string" || typeof input.payload !== "object") throw new Error("invalid command");
      const policy = (fixture.policy as Record<string, { commands: Record<string, string> }>)[input.workspace];
      const capability = policy?.commands[input.operation];
      if (!capability || !fixture.capabilities.includes(capability)) return { state: "problem", problem: { title: "Operation forbidden", code: "OPERATION_FORBIDDEN", status: 403, correlationId: fixture.ids.correlation } };
      if (!state.online) return { state: "problem", problem: { title: "Offline mutations are locked", code: "OFFLINE_READ_ONLY", status: 503, correlationId: fixture.ids.correlation } };
      if (input.operation === "change" && (input.payload as Record<string, unknown>).expectedVersion === 1) return { state: "conflict", correlationId: fixture.ids.correlation, currentVersion: 2, detail: "Resource changed" };
      return { state: "completed", commandId: fixture.ids.command, correlationId: fixture.ids.correlation, result: { version: 2 } };
    });
    install(channels.uploadPreflight, (_event, input: Record<string, unknown>) => { assertObject(channels.uploadPreflight, input); record(channels.uploadPreflight, input); return { state: "available", maxBytes: 100 * 1024 * 1024 }; });
    install(channels.uploadBegin, (_event, input: Record<string, unknown>) => { assertObject(channels.uploadBegin, input); record(channels.uploadBegin, input); state.uploadBytes = 0; state.uploadSize = Number(input.size); state.uploadSequence = 0; state.uploadCompleteCount = 0; state.uploadIntent = String(input.intentHandle); state.uploadKind = input.workspace === "domain-design" ? "archive" : "evidence"; state.uploadActive = true; return { state: "started", uploadId: fixture.ids.upload }; });
    install(channels.uploadAppend, async (_event, input: Record<string, unknown>) => {
      assertObject(channels.uploadAppend, input); record(channels.uploadAppend, { ...input, data: "[BINARY]" });
      const bytes = (input.data as { byteLength?: number }).byteLength ?? 0;
      if (!state.uploadActive || input.uploadId !== fixture.ids.upload || input.sequence !== state.uploadSequence || bytes <= 0 || bytes > 1024 * 1024 || state.uploadBytes + bytes > state.uploadSize) throw new Error("invalid chunk");
      state.uploadSequence += 1;
      state.uploadBytes += bytes;
      BrowserWindow.getAllWindows()[0]?.webContents.send("uploads:progress", { uploadId: fixture.ids.upload, intentHandle: state.uploadIntent, percent: Math.min(100, Math.round(state.uploadBytes / state.uploadSize * 100)) });
      await new Promise((resolve) => setTimeout(resolve, 150));
      while (state.uploadPaused) await new Promise((resolve) => setTimeout(resolve, 10));
      if (!state.uploadActive) throw new Error("upload cancelled");
      return { acceptedBytes: bytes, receivedBytes: state.uploadBytes };
    });
    install(channels.uploadFinish, (_event, uploadId: string) => {
      record(channels.uploadFinish, uploadId); if (!state.uploadActive || uploadId !== fixture.ids.upload || state.uploadBytes !== state.uploadSize || state.uploadCompleteCount !== 0) throw new Error("invalid upload finish");
      state.uploadCompleteCount += 1;
      state.uploadActive = false;
      return state.uploadKind === "archive"
        ? { state: "completed", uploadId, kind: "archive", uploadReference: "packages/pilot-operations.zip", sha256: "a".repeat(64) }
        : { state: "completed", uploadId, kind: "evidence", evidenceId: fixture.ids.evidence, uploadReference: "quarantine/evidence-1", quarantineStatus: "quarantined", processingStatus: "scanning", reviewStatus: "pending" };
    });
    install(channels.uploadCancel, (_event, uploadId: string) => { record(channels.uploadCancel, uploadId); if (uploadId === fixture.ids.upload) { state.uploadActive = false; state.uploadBytes = 0; state.uploadSequence = 0; } });
    install(channels.notificationsList, (_event, cursor?: string) => { record(channels.notificationsList, cursor); return { items: fixture.notifications, nextCursor: "cursor-2" }; });
    BrowserWindow.getAllWindows()[0]?.webContents.send("notifications:state", { state: "online", changedAt: fixture.now, lastEventAt: fixture.now });
  }, {
    startWithoutProfile: options.startWithoutProfile === true,
    ids,
    profile: { id: ids.profile, name: "Pilot OCC", origin: "https://pilot.example.test", environment: "pilot" },
    session: { state: "authenticated", user: { id: ids.user, username: `${role}-operator`, displayName: `${role} operator`, status: "ACTIVE", capabilities: roleCapabilities[role] }, expiresAt: "2099-08-02T12:00:00.000Z" },
    capabilities: roleCapabilities[role],
    policy: operationPolicy,
    statuses: [{ service: "occ-core", version: "1.4.0", state: "READY", checkedAt: "2026-08-02T08:00:00.000Z", components: [] }],
    queryItems,
    now: "2026-08-02T08:00:00.000Z",
    notifications: [{ id: "10000000-0000-4000-8000-000000000007", cursor: "cursor-1", type: "task.updated", occurredAt: "2026-08-02T08:00:00.000Z", title: "Task updated", body: "Evidence is ready", read: false }],
  });
  await page.reload({ waitUntil: "domcontentloaded" });

  return {
    application, page, userData,
    close: async () => { await application.close(); await rm(userData, { recursive: true, force: true }); },
    calls: () => application.evaluate(() => (globalThis as typeof globalThis & { __occSmokeFixture?: { calls: Array<{ channel: string; input?: unknown }> } }).__occSmokeFixture?.calls ?? []),
    setOnline: (online) => application.evaluate((_electron, value) => { const state = (globalThis as typeof globalThis & { __occSmokeFixture?: { online: boolean } }).__occSmokeFixture; if (state) state.online = value; }, online),
    setUploadPaused: (paused) => application.evaluate((_electron, value) => { const state = (globalThis as typeof globalThis & { __occSmokeFixture?: { uploadPaused: boolean } }).__occSmokeFixture; if (state) state.uploadPaused = value; }, paused),
    setQueryState: (workspace, state) => application.evaluate((_electron, value) => { const fixture = (globalThis as typeof globalThis & { __occSmokeFixture?: { queryStates: Record<string, string> } }).__occSmokeFixture; if (fixture) fixture.queryStates[value.workspace] = value.state; }, { workspace, state }),
    sendNotificationState: (state) => application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]?.webContents.send("notifications:state", { state: value, changedAt: "2026-08-02T08:00:00.000Z", lastEventAt: "2026-08-02T07:59:00.000Z" }), state),
  };
}

export async function assertNoSeriousAxeViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).setLegacyMode().analyze();
  expect(result.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
}

export async function executeFixtureCommand(page: Page, workspace: string, operation: string, payload: Record<string, unknown>, targetId?: string) {
  return page.evaluate(({ workspace, operation, payload, targetId }) => window.occ.commands.execute({ workspace, operation, payload: payload as never, intentHandle: crypto.randomUUID(), ...(targetId ? { targetId } : {}) }), { workspace, operation, payload, targetId });
}

export { ids, queryItems, roleCapabilities };
