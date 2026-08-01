import { serialize } from "node:v8";

import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

import { DESKTOP_CHANNELS } from "../src/ipc-contract";

function recursiveKeys(value: object): string[] {
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...(typeof child === "object" && child !== null ? recursiveKeys(child) : []),
  ]);
}

describe("preload bridge", () => {
  beforeEach(async () => {
    electronMocks.invoke.mockResolvedValue([]);
    vi.resetModules();
    await import("../src/preload");
  });

  it("exposes the complete recursively frozen grouped API", () => {
    expect(electronMocks.exposeInMainWorld).toHaveBeenCalledOnce();
    const [name, api] = electronMocks.exposeInMainWorld.mock.calls[0] ?? [];
    expect(name).toBe("occ");
    expect(Object.keys(api)).toEqual([
      "profiles",
      "session",
      "runtime",
      "workspaces",
      "commands",
      "uploads",
      "notifications",
    ]);
    expect(recursiveKeys(api)).not.toEqual(
      expect.arrayContaining(["token", "path", "env", "network", "request", "fetch", "shell"]),
    );
    expect(Object.isFrozen(api)).toBe(true);
    for (const group of Object.values(api)) expect(Object.isFrozen(group)).toBe(true);
  });

  it("mechanically invokes every named channel with its contract argument", async () => {
    const api = electronMocks.exposeInMainWorld.mock.calls[0]?.[1];
    const input = { marker: true };

    await api.profiles.list();
    await api.profiles.save(input);
    await api.profiles.select("profile-id");
    await api.profiles.remove("profile-id");
    await api.session.restore();
    await api.session.login(input);
    await api.session.logout();
    await api.runtime.statuses();
    await api.workspaces.query(input);
    await api.commands.execute(input);
    await api.uploads.start(input);
    await api.uploads.cancel("upload-id");
    await api.notifications.list("cursor");

    expect(electronMocks.invoke.mock.calls).toEqual([
      [DESKTOP_CHANNELS.profiles.list],
      [DESKTOP_CHANNELS.profiles.save, input],
      [DESKTOP_CHANNELS.profiles.select, "profile-id"],
      [DESKTOP_CHANNELS.profiles.remove, "profile-id"],
      [DESKTOP_CHANNELS.session.restore],
      [DESKTOP_CHANNELS.session.login, input],
      [DESKTOP_CHANNELS.session.logout],
      [DESKTOP_CHANNELS.runtime.statuses],
      [DESKTOP_CHANNELS.workspaces.query, input],
      [DESKTOP_CHANNELS.commands.execute, input],
      [DESKTOP_CHANNELS.uploads.start, input],
      [DESKTOP_CHANNELS.uploads.cancel, "upload-id"],
      [DESKTOP_CHANNELS.notifications.list, "cursor"],
    ]);
  });

  it("validates notification events and synchronously disposes the listener", () => {
    const api = electronMocks.exposeInMainWorld.mock.calls[0]?.[1];
    const listener = vi.fn();
    const dispose = api.notifications.subscribe(listener);
    expect(typeof dispose).toBe("function");
    expect(electronMocks.on).toHaveBeenCalledWith(
      DESKTOP_CHANNELS.notifications.event,
      expect.any(Function),
    );

    const wrapped = electronMocks.on.mock.calls[0]?.[1];
    wrapped({}, { invalid: true });
    expect(listener).not.toHaveBeenCalled();
    const event = {
      id: "33333333-3333-4333-8333-333333333333",
      type: "task.updated",
      occurredAt: "2026-08-01T12:00:00.000Z",
      title: "Task updated",
      read: false,
    };
    wrapped({}, event);
    expect(listener).toHaveBeenCalledWith(event);
    dispose();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      DESKTOP_CHANNELS.notifications.event,
      wrapped,
    );
  });

  it("rejects notification events above the 2 MiB serialized output limit", () => {
    const api = electronMocks.exposeInMainWorld.mock.calls[0]?.[1];
    const listener = vi.fn();
    api.notifications.subscribe(listener);
    const wrapped = electronMocks.on.mock.calls[0]?.[1];
    const event = {
      id: "33333333-3333-4333-8333-333333333333",
      type: "task.updated",
      occurredAt: "2026-08-01T12:00:00.000Z",
      title: "Task updated",
      read: false,
      data: { value: "x".repeat(2 * 1024 * 1024) },
    };
    expect(serialize(event).byteLength).toBeGreaterThan(2 * 1024 * 1024);

    wrapped({}, event);

    expect(listener).not.toHaveBeenCalled();
  });
});
