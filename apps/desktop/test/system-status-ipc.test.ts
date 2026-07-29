import { SystemStatusSchema } from "@innorder/contracts";
import { ipcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

import {
  fetchSystemStatuses,
  registerSystemStatusIpc,
  SYSTEM_STATUSES_CHANNEL,
} from "../src/system-status-ipc";

function validStatus(service: "occ-core" | "occ-ai") {
  return {
    service,
    version: "0.1.0",
    state: "READY",
    checkedAt: "2026-07-28T08:00:00.000Z",
    components: [],
  };
}

describe("main-process status fetching", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates successful responses with the shared schema", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validStatus("occ-core")), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validStatus("occ-ai")), { status: 200 }),
      );

    const result = await fetchSystemStatuses({
      coreBaseUrl: "http://127.0.0.1:8080",
      aiBaseUrl: "http://127.0.0.1:3100",
      timeoutMs: 100,
    });

    expect(result).toHaveLength(2);
    expect(result.map(({ service }) => service)).toEqual(["occ-core", "occ-ai"]);
    result.forEach((row) => expect(SystemStatusSchema.safeParse(row).success).toBe(true));
  });

  it("rejects a valid response with the wrong service identity", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validStatus("occ-ai")), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validStatus("occ-ai")), { status: 200 }),
      );

    const result = await fetchSystemStatuses({
      coreBaseUrl: "http://127.0.0.1:8080",
      aiBaseUrl: "http://127.0.0.1:3100",
      timeoutMs: 100,
    });

    expect(result[0]).toMatchObject({
      service: "occ-core",
      state: "UNREACHABLE",
      version: "unknown",
    });
    expect(result[1]).toMatchObject({ service: "occ-ai", state: "READY" });
  });

  it("maps invalid and network responses to sanitized unreachable rows", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockRejectedValueOnce(new Error("C:\\private\\secret"));

    const result = await fetchSystemStatuses({
      coreBaseUrl: "http://127.0.0.1:8080",
      aiBaseUrl: "http://127.0.0.1:3100",
      timeoutMs: 100,
    });

    expect(result.map(({ state }) => state)).toEqual(["UNREACHABLE", "UNREACHABLE"]);
    expect(JSON.stringify(result)).not.toContain("private");
    result.forEach((row) => expect(SystemStatusSchema.safeParse(row).success).toBe(true));
  });

  it("aborts bounded requests and maps timeouts to unreachable rows", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.mocked(fetch).mockImplementation((_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing abort signal");
      }
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted")));
      });
    });

    const pending = fetchSystemStatuses({
      coreBaseUrl: "http://127.0.0.1:8080",
      aiBaseUrl: "http://127.0.0.1:3100",
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toEqual([
      expect.objectContaining({ service: "occ-core", state: "UNREACHABLE" }),
      expect.objectContaining({ service: "occ-ai", state: "UNREACHABLE" }),
    ]);
    expect(signals).toHaveLength(2);
    expect(signals.every(({ aborted }) => aborted)).toBe(true);
  });

  it("registers the fixed IPC handler and removes it on disposal", () => {
    const dispose = registerSystemStatusIpc({
      coreBaseUrl: "http://127.0.0.1:8080",
      aiBaseUrl: "http://127.0.0.1:3100",
      timeoutMs: 100,
    });

    expect(ipcMain.removeHandler).toHaveBeenCalledWith(SYSTEM_STATUSES_CHANNEL);
    expect(ipcMain.handle).toHaveBeenCalledWith(
      SYSTEM_STATUSES_CHANNEL,
      expect.any(Function),
    );
    const handler = vi.mocked(ipcMain.handle).mock.calls[0]?.[1];
    expect(handler?.length).toBe(0);

    dispose();
    expect(ipcMain.removeHandler).toHaveBeenLastCalledWith(SYSTEM_STATUSES_CHANNEL);
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(2);
  });
});
