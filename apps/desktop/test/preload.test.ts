import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: { invoke: electronMocks.invoke },
}));

import { SYSTEM_STATUSES_CHANNEL } from "../src/ipc-contract";

describe("preload bridge", () => {
  beforeEach(async () => {
    electronMocks.invoke.mockResolvedValue([]);
    vi.resetModules();
    await import("../src/preload");
  });

  it("exposes only getSystemStatuses on the fixed channel", async () => {
    expect(electronMocks.exposeInMainWorld).toHaveBeenCalledOnce();
    const [name, api] = electronMocks.exposeInMainWorld.mock.calls[0] ?? [];
    expect(name).toBe("occ");
    expect(Object.keys(api)).toEqual(["getSystemStatuses"]);

    await api.getSystemStatuses();
    expect(electronMocks.invoke).toHaveBeenCalledWith(SYSTEM_STATUSES_CHANNEL);
  });
});
