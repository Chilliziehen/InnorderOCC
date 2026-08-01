import { serialize } from "node:v8";

import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: electronMocks.handle,
    removeHandler: electronMocks.removeHandler,
  },
}));

import {
  createAtomicJsonPersistence,
  createAtomicTextPersistence,
  createDesktopUploadProgressSender,
  createDesktopApi,
  createSafeStorageVault,
  registerDesktopIpc,
  sendDesktopNotification,
  sendDesktopUploadProgress,
} from "../src/desktop-ipc";
import { DESKTOP_CHANNELS } from "../src/ipc-contract";
import { createCommandIntentRegistry } from "../src/command-intents";
import { createProfileStore } from "../src/profile-store";
import { createMainReliabilityApi } from "../src/main-reliability-composition";

const rendererUrl = "file:///D:/OCC/index.html";
const profileId = "11111111-1111-4111-8111-111111111111";
const profile = {
  id: profileId,
  name: "Pilot",
  origin: "https://occ.example.com",
  environment: "pilot" as const,
};

function dependencies() {
  return {
    profiles: {
      list: vi.fn().mockResolvedValue([profile]),
      current: vi.fn().mockResolvedValue(profile),
      save: vi.fn().mockResolvedValue(profile),
      select: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    session: {
      restore: vi.fn().mockResolvedValue({ state: "anonymous" }),
      login: vi.fn().mockResolvedValue({ state: "anonymous" }),
      logout: vi.fn().mockResolvedValue(undefined),
    },
    runtime: { statuses: vi.fn().mockResolvedValue([]) },
    workspaces: {
      query: vi.fn().mockResolvedValue({
        state: "unavailable",
        reason: "UNAVAILABLE_CONTRACT",
        resourceGroups: ["/tasks"],
        message: "Task API contract is unavailable",
      }),
    },
    commands: {
      execute: vi.fn().mockResolvedValue({
        state: "unavailable",
        reason: "UNAVAILABLE_CONTRACT",
        resourceGroups: ["/tasks"],
        message: "Task command contract is unavailable",
      }),
    },
    uploads: {
      preflight: vi.fn().mockResolvedValue({ state: "available", maxBytes: 100 * 1024 * 1024 }),
      start: vi.fn().mockResolvedValue({
        state: "started",
        uploadId: "22222222-2222-4222-8222-222222222222",
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
    notifications: {
      list: vi.fn().mockResolvedValue({ items: [] }),
    },
  };
}

function registeredHandler(channel: string) {
  return electronMocks.handle.mock.calls.find(([name]) => name === channel)?.[1];
}

function invokeChannels(): string[] {
  return Object.values(DESKTOP_CHANNELS).flatMap((group) =>
    Object.values(group).filter((channel) => channel !== DESKTOP_CHANNELS.notifications.event && channel !== DESKTOP_CHANNELS.uploads.progress),
  );
}

describe("desktop IPC", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers one named handler for every invoke channel", () => {
    registerDesktopIpc(rendererUrl, dependencies());

    const channels = invokeChannels();
    expect(electronMocks.handle.mock.calls.map(([channel]) => channel).sort()).toEqual(
      [...channels].sort(),
    );
    expect(channels).toHaveLength(15);
    expect(channels.join(" ")).not.toMatch(/request|path|url|filesystem|shell/i);
  });

  it("returns the durable selected profile through a validated named channel", async () => {
    const deps = dependencies();
    deps.profiles.current = vi.fn().mockResolvedValue(profile);
    registerDesktopIpc(rendererUrl, deps);
    const handler = registeredHandler(DESKTOP_CHANNELS.profiles.current);
    const event = { senderFrame: { url: rendererUrl, parent: null } };

    await expect(handler(event, undefined)).resolves.toEqual(profile);
    deps.profiles.current.mockResolvedValueOnce({ ...profile, token: "secret" });
    await expect(handler(event, undefined)).rejects.toThrow("IPC request failed");
  });

  it("accepts only the exact top-level renderer document sender", async () => {
    registerDesktopIpc(rendererUrl, dependencies());
    const handler = registeredHandler(DESKTOP_CHANNELS.profiles.list);

    await expect(handler({ senderFrame: undefined })).rejects.toThrow("IPC request rejected");
    await expect(
      handler({ senderFrame: { url: rendererUrl, parent: {} } }),
    ).rejects.toThrow("IPC request rejected");
    await expect(
      handler({ senderFrame: { url: "file:///D:/OCC/other.html", parent: null } }),
    ).rejects.toThrow("IPC request rejected");
    await expect(
      handler({ senderFrame: { url: rendererUrl, parent: null } }, undefined),
    ).resolves.toEqual([profile]);
  });

  it("strictly validates input and sanitizes handler failures", async () => {
    const deps = dependencies();
    registerDesktopIpc(rendererUrl, deps);
    const handler = registeredHandler(DESKTOP_CHANNELS.profiles.save);
    const event = { senderFrame: { url: rendererUrl, parent: null } };

    await expect(
      handler(event, { name: "Pilot", origin: profile.origin, extra: true }),
    ).rejects.toThrow("IPC request rejected");
    deps.profiles.save.mockRejectedValueOnce(new Error("refresh-token-secret"));
    const failure = await handler(event, {
      name: "Pilot",
      origin: profile.origin,
    }).catch((error: unknown) => error);
    expect(failure).toEqual(new Error("IPC request failed"));
    expect(String(failure)).not.toContain("refresh-token-secret");
  });

  it("validates command intent handles and conflict current versions across IPC", async () => {
    const deps = dependencies();
    deps.commands.execute.mockResolvedValue({ state: "conflict", currentVersion: 12, correlationId: profileId });
    registerDesktopIpc(rendererUrl, deps);
    const handler = registeredHandler(DESKTOP_CHANNELS.commands.execute);
    const event = { senderFrame: { url: rendererUrl, parent: null } };
    const command = { workspace: "risks", operation: "resolve", payload: {}, intentHandle: profileId };

    await expect(handler(event, command)).resolves.toEqual({ state: "conflict", currentVersion: 12, correlationId: profileId });
    expect(deps.commands.execute).toHaveBeenCalledWith({
      workspace: "risks",
      operation: "resolve",
      payload: {},
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(deps.commands.execute.mock.calls[0]![0]).not.toHaveProperty("intentHandle");
    await expect(handler(event, { ...command, intentHandle: undefined, idempotencyKey: profileId })).rejects.toThrow("IPC request rejected");
    deps.commands.execute.mockResolvedValueOnce({ state: "conflict", correlationId: profileId });
    await expect(handler(event, command)).rejects.toThrow("IPC request failed");
  });

  it("reuses main command keys after transport failure and rejects changed retained intents", async () => {
    const deps = dependencies();
    deps.commands.execute
      .mockRejectedValueOnce(new Error("transport timeout"))
      .mockResolvedValueOnce({ state: "accepted", commandId: profileId, correlationId: profileId });
    registerDesktopIpc(rendererUrl, deps);
    const handler = registeredHandler(DESKTOP_CHANNELS.commands.execute);
    const event = { senderFrame: { url: rendererUrl, parent: null } };
    const command = { workspace: "risks", operation: "resolve", payload: { expectedVersion: 2 }, intentHandle: profileId };

    await expect(handler(event, command)).rejects.toThrow("IPC request failed");
    await expect(handler(event, command)).resolves.toMatchObject({ state: "accepted" });
    expect(deps.commands.execute.mock.calls[1]![0].idempotencyKey).toBe(
      deps.commands.execute.mock.calls[0]![0].idempotencyKey,
    );
    await expect(handler(event, { ...command, payload: { expectedVersion: 3 } })).rejects.toThrow("IPC request failed");
    expect(deps.commands.execute).toHaveBeenCalledTimes(2);
  });

  it("uses an injected main-only command registry without exposing settle IPC", async () => {
    const deps = dependencies();
    const commandIntents = createCommandIntentRegistry();
    const execute = vi.spyOn(commandIntents, "execute");
    registerDesktopIpc(rendererUrl, deps, { commandIntents });
    const handler = registeredHandler(DESKTOP_CHANNELS.commands.execute);
    const event = { senderFrame: { url: rendererUrl, parent: null } };
    const command = { workspace: "risks", operation: "resolve", payload: {}, intentHandle: profileId };
    await handler(event, command);
    expect(execute).toHaveBeenCalledOnce();
    expect(invokeChannels()).not.toContain("commands:settle");
  });

  it("sizes all received arguments and rejects arity other than one", async () => {
    const sizeOf = vi.fn(() => 2 * 1024 * 1024);
    registerDesktopIpc(rendererUrl, dependencies(), { sizeOf });
    const handler = registeredHandler(DESKTOP_CHANNELS.profiles.list);
    const event = { senderFrame: { url: rendererUrl, parent: null } };
    const extra = { value: "x".repeat(2 * 1024 * 1024) };
    expect(serialize(extra).byteLength).toBeGreaterThan(2 * 1024 * 1024);

    await expect(handler(event, undefined, extra)).rejects.toThrow("IPC request rejected");
    expect(sizeOf).toHaveBeenCalledWith([undefined, extra]);
  });

  it("uses a bounded upload-only request allowance", async () => {
    let measuredSize = 100 * 1024 * 1024 + 64 * 1024;
    const deps = dependencies();
    registerDesktopIpc(rendererUrl, deps, { sizeOf: () => measuredSize });
    const handler = registeredHandler(DESKTOP_CHANNELS.uploads.start);
    const event = { senderFrame: { url: rendererUrl, parent: null } };
    const input = {
      workspace: "my-work",
      taskId: "task-1",
      fileName: "evidence.txt",
      mediaType: "text/plain",
      size: 1,
      data: new Uint8Array([1]),
      intentHandle: profileId,
    };

    await expect(handler(event, input)).resolves.toMatchObject({ state: "started" });
    measuredSize += 1;
    await expect(handler(event, input)).rejects.toThrow("IPC request rejected");
    expect(deps.uploads.start).toHaveBeenCalledOnce();
  });

  it("rejects requests above 1 MiB and invalid or oversized output", async () => {
    const deps = dependencies();
    registerDesktopIpc(rendererUrl, deps);
    const event = { senderFrame: { url: rendererUrl, parent: null } };
    const save = registeredHandler(DESKTOP_CHANNELS.profiles.save);
    const list = registeredHandler(DESKTOP_CHANNELS.profiles.list);
    const oversizedInput = { name: "x".repeat(1024 * 1024), origin: profile.origin };
    expect(serialize(oversizedInput).byteLength).toBeGreaterThan(1024 * 1024);

    await expect(save(event, oversizedInput)).rejects.toThrow("IPC request rejected");
    deps.profiles.list.mockResolvedValueOnce([{ ...profile, leaked: true }]);
    await expect(list(event, undefined)).rejects.toThrow("IPC request failed");
    deps.profiles.list.mockResolvedValueOnce([
      { ...profile, name: "x".repeat(2 * 1024 * 1024) },
    ]);
    await expect(list(event, undefined)).rejects.toThrow("IPC request failed");
  });

  it("replaces duplicate registrations and disposes every owned handler", () => {
    const disposeFirst = registerDesktopIpc(rendererUrl, dependencies());
    const disposeSecond = registerDesktopIpc(rendererUrl, dependencies());
    const count = invokeChannels().length;
    const replacedBeforeThisTest = count;

    expect(electronMocks.removeHandler).toHaveBeenCalledTimes(replacedBeforeThisTest + count);
    disposeFirst();
    expect(electronMocks.removeHandler).toHaveBeenCalledTimes(replacedBeforeThisTest + count);
    disposeSecond();
    expect(electronMocks.removeHandler).toHaveBeenCalledTimes(replacedBeforeThisTest + count * 2);
  });

  it("sends validated notifications on the canonical event channel", () => {
    const send = vi.fn();
    const event = {
      id: "33333333-3333-4333-8333-333333333333",
      type: "task.updated",
      occurredAt: "2026-08-01T12:00:00.000Z",
      title: "Task updated",
      read: false,
    };

    expect(sendDesktopNotification({ send }, event)).toBe(true);
    expect(send).toHaveBeenCalledWith(DESKTOP_CHANNELS.notifications.event, event);
  });

  it("rejects notifications whose structured-clone size exceeds 2 MiB", () => {
    const send = vi.fn();
    const padding = Object.fromEntries(
      Array.from({ length: 100_000 }, (_, index) => [
        `padding-${index.toString().padStart(6, "0")}-abcdefghij`,
        undefined,
      ]),
    );
    const event = {
      id: "33333333-3333-4333-8333-333333333333",
      type: "task.updated",
      occurredAt: "2026-08-01T12:00:00.000Z",
      title: "Task updated",
      read: false,
      data: padding,
    };
    expect(JSON.stringify(event).length).toBeLessThan(1024);
    expect(serialize(event).byteLength).toBeGreaterThan(2 * 1024 * 1024);

    expect(sendDesktopNotification({ send }, event)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("preflights strict upload metadata without accepting file bytes", async () => {
    const deps = dependencies();
    deps.uploads.preflight.mockResolvedValue({ state: "unavailable", reason: "UNAVAILABLE_CONTRACT", resourceGroups: ["/evidence"], message: "证据提交 API 合同尚未集成" });
    registerDesktopIpc(rendererUrl, deps);
    const handler = registeredHandler(DESKTOP_CHANNELS.uploads.preflight);
    const event = { senderFrame: { url: rendererUrl, parent: null } };
    const metadata = { workspace: "my-work", taskId: "task-1", fileName: "evidence.pdf", mediaType: "application/pdf", size: 4, intentHandle: profileId };
    await expect(handler(event, metadata)).resolves.toMatchObject({ state: "unavailable" });
    await expect(handler(event, { ...metadata, data: new Uint8Array(4) })).rejects.toThrow("IPC request rejected");
    expect(deps.uploads.preflight).toHaveBeenCalledOnce();
  });

  it("sends only validated monotonic upload progress on the named channel", () => {
    const send = vi.fn();
    const target = { send };
    const first = { uploadId: profileId, intentHandle: profileId, percent: 25 };
    expect(sendDesktopUploadProgress(target, first)).toBe(true);
    expect(sendDesktopUploadProgress(target, { ...first, percent: 20 })).toBe(false);
    expect(sendDesktopUploadProgress(target, { ...first, percent: 101 })).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(DESKTOP_CHANNELS.uploads.progress, first);
  });

  it("bounds progress tracking by capacity and TTL and removes terminal entries", () => {
    let now = 0;
    const sendProgress = createDesktopUploadProgressSender({ now: () => now, maxEntries: 1, ttlMs: 1_000 });
    const target = { send: vi.fn() };
    const first = { uploadId: profileId, intentHandle: profileId, percent: 10 };
    const second = { uploadId: "22222222-2222-4222-8222-222222222222", intentHandle: profileId, percent: 10 };
    expect(sendProgress(target, first)).toBe(true);
    expect(sendProgress(target, second)).toBe(false);
    now = 1_001;
    expect(sendProgress(target, second)).toBe(true);
    expect(sendProgress(target, { ...second, percent: 100 })).toBe(true);
    expect(sendProgress(target, first)).toBe(true);
    const throwing = createDesktopUploadProgressSender();
    expect(throwing({ send: () => { throw new Error("closed"); } }, first)).toBe(false);
  });
});

describe("desktop main composition", () => {
  it("integrates authenticated reliability dependencies while business contracts remain unavailable", async () => {
    const deps = dependencies();
    const customerInstanceId = "22222222-2222-4222-8222-222222222222";
    const principalId = "33333333-3333-4333-8333-333333333333";
    const authenticated = { state: "authenticated" as const, user: { id: principalId, username: "user", displayName: "User", status: "ACTIVE" as const, capabilities: [] }, expiresAt: "2026-08-03T00:00:00.000Z" };
    deps.session.restore.mockResolvedValue(authenticated);
    deps.session.login.mockResolvedValue(authenticated);
    let releaseLogout!: () => void;
    deps.session.logout.mockImplementation(() => new Promise<void>((resolve) => void (releaseLogout = resolve)));
    const notificationStream = { setSession: vi.fn().mockResolvedValue(undefined) };
    const readCache = {
      query: vi.fn(async (_scope, _input, _authenticated, remote) => remote()),
      purgeAccount: vi.fn().mockResolvedValue(undefined),
    };
    const uploads = { preflight: vi.fn().mockResolvedValue({ state: "unavailable", reason: "UNAVAILABLE_CONTRACT", resourceGroups: ["/evidence"], message: "证据提交 API 合同尚未集成" }), start: vi.fn(), cancel: vi.fn() };
    const profiles = { ...deps.profiles, selected: () => profile, validate: (input: unknown) => input };
    const api = createMainReliabilityApi({
      profiles: profiles as never,
      session: { ...deps.session, profileSwitched: vi.fn() },
      statuses: deps.runtime.statuses,
      clearProfile: vi.fn(), readCache: readCache as never, notificationStream,
      uploads, getCustomerInstanceId: () => customerInstanceId, isOnline: () => true,
    });
    await api.session.restore();
    expect(notificationStream.setSession).toHaveBeenLastCalledWith({ scope: { profileId, customerInstanceId, principalId }, origin: profile.origin, endpointAvailable: false });
    await api.session.login({ username: "user", password: "long-password" });
    expect(notificationStream.setSession).toHaveBeenLastCalledWith({ scope: { profileId, customerInstanceId, principalId }, origin: profile.origin, endpointAvailable: false });
    await expect(api.workspaces.query({ workspace: "risks", operation: "risks.query" })).resolves.toMatchObject({ state: "unavailable", reason: "UNAVAILABLE_CONTRACT" });
    expect(readCache.query).toHaveBeenCalledOnce();
    await expect(api.commands.execute({ workspace: "risks", operation: "acknowledge", targetId: "risk-1", payload: { expectedVersion: 1 }, idempotencyKey: profileId })).resolves.toMatchObject({ state: "unavailable" });
    await expect(api.uploads.preflight({ workspace: "my-work", taskId: "task-1", fileName: "evidence.pdf", mediaType: "application/pdf", size: 4, intentHandle: profileId })).resolves.toMatchObject({ state: "unavailable" });

    const logout = api.session.logout();
    expect(notificationStream.setSession).toHaveBeenLastCalledWith(null);
    await vi.waitFor(() => expect(deps.session.logout).toHaveBeenCalled());
    releaseLogout();
    await logout;
    expect(readCache.purgeAccount).toHaveBeenCalledWith({ profileId, customerInstanceId, principalId });
  });

  it("uses authenticated scoped cache fallback, purges logout scope, and rejects offline commands first", async () => {
    const deps = dependencies();
    const cacheScope = { profileId, customerInstanceId: "22222222-2222-4222-8222-222222222222", principalId: "33333333-3333-4333-8333-333333333333" };
    const queryResult = { state: "ready" as const, items: [{ id: "risk-1" }], count: 1, fetchedAt: "2026-08-02T00:00:00.000Z" };
    const readCache = {
      query: vi.fn((_scope, _query, _authenticated, remote) => remote()),
      purgeAccount: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceQuery = vi.fn().mockResolvedValue(queryResult);
    const executeCommand = vi.fn();
    deps.session.login.mockResolvedValue({ state: "authenticated", user: { id: cacheScope.principalId, username: "user", displayName: "User", status: "ACTIVE", capabilities: ["occ.read"] }, expiresAt: "2026-08-03T00:00:00.000Z" });
    const api = createDesktopApi({
      profiles: deps.profiles as never,
      session: { ...deps.session, profileSwitched: vi.fn().mockResolvedValue(undefined) },
      statuses: deps.runtime.statuses,
      clearProfile: vi.fn().mockResolvedValue(undefined),
      readCache,
      getCacheScope: () => cacheScope,
      workspaceQuery,
      executeCommand,
      isOnline: () => false,
    });

    await api.session.login({ username: "user", password: "long-password" });
    await expect(api.workspaces.query({ workspace: "risks", operation: "risks.query" })).resolves.toEqual(queryResult);
    expect(readCache.query).toHaveBeenCalledWith(cacheScope, expect.anything(), cacheScope, expect.any(Function), expect.any(Function));
    await expect(api.commands.execute({ workspace: "risks", operation: "resolve", payload: {}, idempotencyKey: profileId })).rejects.toThrow("offline");
    expect(executeCommand).not.toHaveBeenCalled();
    await api.session.logout();
    expect(readCache.purgeAccount).toHaveBeenCalledWith(cacheScope);
  });

  it("closes the authenticated cache gate before profile cleanup completes", async () => {
    let selected = profile;
    let releaseSelect!: () => void;
    const selectBlocked = new Promise<void>((resolve) => void (releaseSelect = resolve));
    const profiles = {
      list: vi.fn().mockResolvedValue([profile]), validate: vi.fn(), save: vi.fn(), remove: vi.fn(),
      selected: vi.fn(() => selected),
      select: vi.fn(async () => { await selectBlocked; selected = { ...profile, id: "22222222-2222-4222-8222-222222222222" }; }),
    };
    const cacheScope = { profileId, customerInstanceId: "22222222-2222-4222-8222-222222222222", principalId: "33333333-3333-4333-8333-333333333333" };
    const session = {
      restore: vi.fn(), logout: vi.fn(),
      login: vi.fn().mockResolvedValue({ state: "authenticated", user: { id: cacheScope.principalId, username: "user", displayName: "User", status: "ACTIVE", capabilities: [] }, expiresAt: "2026-08-03T00:00:00.000Z" }),
      profileSwitched: vi.fn().mockResolvedValue(undefined),
    };
    const readCache = { query: vi.fn((_scope, _input, _auth, remote) => remote()), purgeAccount: vi.fn() };
    const workspaceQuery = vi.fn().mockResolvedValue({ state: "empty", fetchedAt: "2026-08-02T00:00:00.000Z" });
    const api = createDesktopApi({ profiles: profiles as never, session, statuses: vi.fn(), clearProfile: vi.fn(), readCache, getCacheScope: () => cacheScope, workspaceQuery });
    await api.session.login({ username: "user", password: "long-password" });
    const switching = api.profiles.select("22222222-2222-4222-8222-222222222222");
    await vi.waitFor(() => expect(profiles.select).toHaveBeenCalled());
    await api.workspaces.query({ workspace: "risks", operation: "risks.query" });
    expect(readCache.query).not.toHaveBeenCalled();
    releaseSelect();
    await switching;
  });

  it("invalidates session scope synchronously before logout and publishes generations", async () => {
    let releaseLogout!: () => void;
    const logoutBlocked = new Promise<void>((resolve) => void (releaseLogout = resolve));
    const deps = dependencies();
    const cacheScope = { profileId, customerInstanceId: "22222222-2222-4222-8222-222222222222", principalId: "33333333-3333-4333-8333-333333333333" };
    deps.session.login.mockResolvedValue({ state: "authenticated", user: { id: cacheScope.principalId, username: "user", displayName: "User", status: "ACTIVE", capabilities: [] }, expiresAt: "2026-08-03T00:00:00.000Z" });
    deps.session.logout.mockImplementation(async () => logoutBlocked);
    const readCache = { query: vi.fn((_scope, _input, _auth, remote) => remote()), purgeAccount: vi.fn().mockResolvedValue(undefined) };
    const onSessionScopeChanged = vi.fn();
    const api = createDesktopApi({
      profiles: deps.profiles as never,
      session: { ...deps.session, profileSwitched: vi.fn() },
      statuses: deps.runtime.statuses,
      clearProfile: vi.fn(), readCache, getCacheScope: () => cacheScope,
      workspaceQuery: vi.fn().mockResolvedValue({ state: "empty", fetchedAt: "2026-08-02T00:00:00.000Z" }),
      onSessionScopeChanged,
    });
    await api.session.login({ username: "user", password: "long-password" });
    const logout = api.session.logout();

    expect(onSessionScopeChanged).toHaveBeenLastCalledWith(null, 2);
    await api.workspaces.query({ workspace: "risks", operation: "risks.query" });
    expect(readCache.query).not.toHaveBeenCalled();
    releaseLogout();
    await logout;
    expect(readCache.purgeAccount).toHaveBeenCalledWith(cacheScope);
  });

  it("invalidates a session installed by an earlier queued login before logout executes", async () => {
    let resolveLogin!: (snapshot: any) => void;
    const loginPending = new Promise<any>((resolve) => void (resolveLogin = resolve));
    const deps = dependencies();
    const cacheScope = { profileId, customerInstanceId: "22222222-2222-4222-8222-222222222222", principalId: "33333333-3333-4333-8333-333333333333" };
    deps.session.login.mockImplementation(() => loginPending);
    const readCache = { query: vi.fn(), purgeAccount: vi.fn().mockResolvedValue(undefined) };
    const onSessionScopeChanged = vi.fn();
    const api = createDesktopApi({ profiles: deps.profiles as never, session: { ...deps.session, profileSwitched: vi.fn() }, statuses: deps.runtime.statuses, clearProfile: vi.fn(), readCache, getCacheScope: () => cacheScope, onSessionScopeChanged });
    const login = api.session.login({ username: "user", password: "long-password" });
    const logout = api.session.logout();
    resolveLogin({ state: "authenticated", user: { id: cacheScope.principalId, username: "user", displayName: "User", status: "ACTIVE", capabilities: [] }, expiresAt: "2026-08-03T00:00:00.000Z" });
    await login;
    await logout;

    expect(onSessionScopeChanged).toHaveBeenLastCalledWith(null, 3);
    expect(readCache.purgeAccount).toHaveBeenCalledWith(cacheScope);
  });
  it("returns exact main-safe unavailable metadata for each workspace operation", async () => {
    const deps = dependencies();
    const api = createDesktopApi({
      profiles: deps.profiles as never,
      session: { ...deps.session, profileSwitched: vi.fn().mockResolvedValue(undefined) },
      statuses: deps.runtime.statuses,
      clearProfile: vi.fn().mockResolvedValue(undefined),
    });

    await expect(api.workspaces.query({
      workspace: "my-work",
      operation: "tasks.query",
      filters: {},
    })).resolves.toEqual({
      state: "unavailable",
      reason: "UNAVAILABLE_CONTRACT",
      resourceGroups: ["/tasks"],
      message: "任务 API 合同尚未集成",
    });
    await expect(api.commands.execute({
      workspace: "domain-design",
      operation: "import",
      payload: {},
      idempotencyKey: profileId,
    })).resolves.toEqual({
      state: "unavailable",
      reason: "UNAVAILABLE_CONTRACT",
      resourceGroups: ["/packages"],
      message: "领域包导入 API 合同尚未集成",
    });
  });

  it("writes JSON atomically with restrictive file intent", async () => {
    const files = new Map<string, string>();
    const fs = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(async (file: string) => {
        if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return files.get(file)!;
      }),
      writeFile: vi.fn(async (file: string, value: string) => void files.set(file, value)),
      rename: vi.fn(async (from: string, to: string) => {
        files.set(to, files.get(from)!);
        files.delete(from);
      }),
      unlink: vi.fn(async (file: string) => void files.delete(file)),
    };
    const persistence = createAtomicJsonPersistence("D:\\user-data\\profiles.json", fs);

    await expect(persistence.read()).resolves.toBeUndefined();
    await persistence.write({ profiles: [], selectedId: null });
    expect(fs.mkdir).toHaveBeenCalledWith("D:\\user-data", { recursive: true, mode: 0o700 });
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/profiles\.json\..+\.tmp$/),
      JSON.stringify({ profiles: [], selectedId: null }),
      { encoding: "utf8", mode: 0o600 },
    );
    expect(fs.rename).toHaveBeenCalledWith(
      expect.stringMatching(/profiles\.json\..+\.tmp$/),
      "D:\\user-data\\profiles.json",
    );
    await expect(persistence.read()).resolves.toEqual({ profiles: [], selectedId: null });
  });

  it("reads cache persistence as raw UTF-8 text and writes atomically", async () => {
    const file = "D:\\user-data\\cache.json";
    const files = new Map<string, string>([[file, "{not-json"]]);
    const fs = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(async (name: string) => {
        if (!files.has(name)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return files.get(name)!;
      }),
      writeFile: vi.fn(async (name: string, value: string) => void files.set(name, value)),
      rename: vi.fn(async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); }),
      unlink: vi.fn().mockResolvedValue(undefined),
    };
    const persistence = createAtomicTextPersistence(file, fs);
    await expect(persistence.read()).resolves.toEqual({ text: "{not-json", byteLength: 9 });
    await persistence.write({ version: 1, entries: [] });
    const text = JSON.stringify({ version: 1, entries: [] });
    await expect(persistence.read()).resolves.toEqual({ text, byteLength: Buffer.byteLength(text) });
  });

  it.each(["write", "rename"] as const)(
    "removes the temporary JSON file after %s failure",
    async (stage) => {
      const failure = new Error(`${stage} failed`);
      const fs = {
        mkdir: vi.fn().mockResolvedValue(undefined),
        readFile: vi.fn(),
        writeFile: stage === "write"
          ? vi.fn().mockRejectedValue(failure)
          : vi.fn().mockResolvedValue(undefined),
        rename: stage === "rename"
          ? vi.fn().mockRejectedValue(failure)
          : vi.fn().mockResolvedValue(undefined),
        unlink: vi.fn().mockResolvedValue(undefined),
      };
      const persistence = createAtomicJsonPersistence("D:\\user-data\\profiles.json", fs);

      await expect(persistence.write({ profiles: [] })).rejects.toBe(failure);
      expect(fs.unlink).toHaveBeenCalledWith(
        expect.stringMatching(/profiles\.json\..+\.tmp$/),
      );
    },
  );

  it("encrypts versioned credentials and never persists a plaintext refresh token", async () => {
    let persisted: unknown;
    const safeStorage = {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((value: string) => Buffer.from(`sealed:${value}`)),
      decryptString: vi.fn((value: Buffer) => value.toString().slice("sealed:".length)),
    };
    const vault = createSafeStorageVault(safeStorage, {
      read: async () => persisted,
      write: async (value) => void (persisted = structuredClone(value)),
    });
    const credential = { refreshToken: "refresh-token-secret", version: "v1" };

    await vault.encrypt(profileId, credential);
    expect(JSON.stringify(persisted)).not.toContain(credential.refreshToken);
    expect(persisted).toMatchObject({ version: 1, records: { [profileId]: expect.any(String) } });
    await expect(vault.decrypt(profileId)).resolves.toEqual(credential);
    await vault.remove(profileId, "stale-version");
    await expect(vault.decrypt(profileId)).resolves.toEqual(credential);
    await vault.remove(profileId, credential.version);
    await expect(vault.decrypt(profileId)).resolves.toBeNull();
  });

  it("fails closed when safeStorage encryption is unavailable", async () => {
    const vault = createSafeStorageVault(
      {
        isEncryptionAvailable: () => false,
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      },
      { read: async () => undefined, write: vi.fn() },
    );
    await expect(vault.encrypt(profileId, { refreshToken: "secret", version: "v1" })).rejects.toThrow(
      "Credential encryption unavailable",
    );
    await expect(vault.decrypt(profileId)).rejects.toThrow("Credential encryption unavailable");
  });

  it("cleans session and cache when selecting or removing profiles", async () => {
    let selected = profile;
    const profiles = {
      list: vi.fn().mockResolvedValue([profile]),
      validate: vi.fn(() => profile),
      save: vi.fn().mockResolvedValue(profile),
      select: vi.fn(async () => undefined),
      remove: vi.fn(async () => void (selected = undefined as never)),
      selected: vi.fn(() => selected),
    };
    const session = {
      restore: vi.fn(), login: vi.fn(), logout: vi.fn(),
      profileSwitched: vi.fn().mockResolvedValue(undefined),
    };
    const clearProfile = vi.fn().mockResolvedValue(undefined);
    const api = createDesktopApi({ profiles, session, statuses: vi.fn(), clearProfile });

    await api.profiles.select("22222222-2222-4222-8222-222222222222");
    expect(session.profileSwitched).toHaveBeenCalledWith(profileId);
    expect(clearProfile).toHaveBeenCalledWith(profileId);
    await api.profiles.remove(profileId);
    expect(session.profileSwitched).toHaveBeenLastCalledWith(profileId);
    expect(clearProfile).toHaveBeenLastCalledWith(profileId);
  });

  it("cleans a non-selected profile before persisting its changed origin", async () => {
    const otherId = "22222222-2222-4222-8222-222222222222";
    const otherProfile = {
      ...profile,
      id: otherId,
      name: "Production",
      origin: "https://old.example.com",
      environment: "production" as const,
    };
    const updatedProfile = { ...otherProfile, origin: "https://new.example.com" };
    const profiles = {
      list: vi.fn().mockResolvedValue([profile, otherProfile]),
      validate: vi.fn(() => updatedProfile),
      save: vi.fn().mockResolvedValue(updatedProfile),
      select: vi.fn(),
      remove: vi.fn(),
      selected: vi.fn(() => profile),
    };
    const session = {
      restore: vi.fn(), login: vi.fn(), logout: vi.fn(),
      profileSwitched: vi.fn().mockResolvedValue(undefined),
    };
    const clearProfile = vi.fn().mockResolvedValue(undefined);
    const api = createDesktopApi({ profiles, session, statuses: vi.fn(), clearProfile });

    await api.profiles.save({
      id: otherId,
      name: otherProfile.name,
      origin: updatedProfile.origin,
      environment: otherProfile.environment,
    });

    expect(session.profileSwitched).toHaveBeenCalledWith(otherId);
    expect(clearProfile).toHaveBeenCalledWith(otherId);
    expect(session.profileSwitched.mock.invocationCallOrder[0]).toBeLessThan(
      profiles.save.mock.invocationCallOrder[0]!,
    );
    expect(clearProfile.mock.invocationCallOrder[0]).toBeLessThan(
      profiles.save.mock.invocationCallOrder[0]!,
    );
  });

  it("validates packaged profile changes before destructive cleanup", async () => {
    const store = await createProfileStore({
      read: async () => ({ profiles: [profile], selectedId: profileId }),
      write: vi.fn(),
      packaged: true,
    });
    const session = {
      restore: vi.fn(), login: vi.fn(), logout: vi.fn(),
      profileSwitched: vi.fn().mockResolvedValue(undefined),
    };
    const clearProfile = vi.fn().mockResolvedValue(undefined);
    const api = createDesktopApi({ profiles: store, session, statuses: vi.fn(), clearProfile });

    await expect(api.profiles.save({
      id: profileId,
      name: profile.name,
      origin: "http://127.0.0.1:8080",
    })).rejects.toThrow("HTTPS is required");
    expect(session.profileSwitched).not.toHaveBeenCalled();
    expect(clearProfile).not.toHaveBeenCalled();
  });

  it("waits for a concurrent login then removes its old-origin credential before saving", async () => {
    let releaseLogin!: () => void;
    const loginGate = new Promise<void>((resolve) => void (releaseLogin = resolve));
    let credentialStored = false;
    const updatedProfile = { ...profile, origin: "https://new.example.com" };
    const profiles = {
      list: vi.fn().mockResolvedValue([profile]),
      validate: vi.fn(() => updatedProfile),
      save: vi.fn().mockResolvedValue(updatedProfile),
      select: vi.fn(), remove: vi.fn(), selected: vi.fn(() => profile),
    };
    const session = {
      restore: vi.fn(),
      login: vi.fn(async () => {
        await loginGate;
        credentialStored = true;
        return { state: "anonymous" as const };
      }),
      logout: vi.fn(),
      profileSwitched: vi.fn(async () => void (credentialStored = false)),
    };
    const api = createDesktopApi({
      profiles,
      session,
      statuses: vi.fn(),
      clearProfile: vi.fn().mockResolvedValue(undefined),
    });

    const login = api.session.login({
      username: "operator",
      password: "correct horse battery staple",
    });
    await vi.waitFor(() => expect(session.login).toHaveBeenCalledOnce());
    const save = api.profiles.save({
      id: profileId,
      name: profile.name,
      origin: updatedProfile.origin,
      environment: profile.environment,
    });
    await Promise.resolve();
    expect(profiles.save).not.toHaveBeenCalled();

    releaseLogin();
    await Promise.all([login, save]);

    expect(session.profileSwitched).toHaveBeenCalledWith(profileId);
    expect(credentialStored).toBe(false);
    expect(session.profileSwitched.mock.invocationCallOrder[0]).toBeLessThan(
      profiles.save.mock.invocationCallOrder[0]!,
    );
  });

  it("continues queued profile transitions after a session operation fails", async () => {
    const updatedProfile = { ...profile, origin: "https://new.example.com" };
    const profiles = {
      list: vi.fn().mockResolvedValue([profile]),
      validate: vi.fn(() => updatedProfile),
      save: vi.fn().mockResolvedValue(updatedProfile),
      select: vi.fn(), remove: vi.fn(), selected: vi.fn(() => profile),
    };
    const session = {
      restore: vi.fn(),
      login: vi.fn().mockRejectedValue(new Error("login failed")),
      logout: vi.fn(),
      profileSwitched: vi.fn().mockResolvedValue(undefined),
    };
    const api = createDesktopApi({
      profiles,
      session,
      statuses: vi.fn(),
      clearProfile: vi.fn().mockResolvedValue(undefined),
    });

    await expect(api.session.login({
      username: "operator",
      password: "correct horse battery staple",
    })).rejects.toThrow("login failed");
    await expect(api.profiles.save({
      id: profileId,
      name: profile.name,
      origin: updatedProfile.origin,
      environment: profile.environment,
    })).resolves.toEqual(updatedProfile);
  });
});
