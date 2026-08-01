import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getSystemStatuses,
  startStatusPolling,
} from "../src/renderer/status-client";

afterEach(() => {
  vi.useRealTimers();
});

describe("status client", () => {
  it("maps an IPC rejection to valid unreachable service rows", async () => {
    Object.defineProperty(window, "occ", {
      configurable: true,
      value: {
        runtime: {
          statuses: vi.fn().mockRejectedValue(new Error("secret path")),
        },
      },
    });

    await expect(getSystemStatuses()).resolves.toEqual({
      statuses: [
        expect.objectContaining({ service: "occ-core", state: "UNREACHABLE" }),
        expect.objectContaining({ service: "occ-ai", state: "UNREACHABLE" }),
      ],
      successful: false,
      coreReachable: false,
      polledAt: expect.any(Number),
    });
  });

  it("reports successful polling and explicit Core reachability", async () => {
    const checkedAt = "2026-08-01T12:00:00.000Z";
    Object.defineProperty(window, "occ", {
      configurable: true,
      value: { runtime: { statuses: vi.fn().mockResolvedValue([{
        service: "occ-core",
        version: "0.1.0",
        state: "UNREACHABLE",
        checkedAt,
        components: [],
      }]) } },
    });

    await expect(getSystemStatuses()).resolves.toMatchObject({
      successful: true,
      coreReachable: false,
      statuses: [expect.objectContaining({ service: "occ-core" })],
    });
  });

  it("does not overlap requests or notify after disposal", async () => {
    vi.useFakeTimers();
    let resolveRequest: ((value: []) => void) | undefined;
    const getStatuses = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    Object.defineProperty(window, "occ", {
      configurable: true,
      value: { runtime: { statuses: getStatuses } },
    });
    const onStatuses = vi.fn();

    const dispose = startStatusPolling(onStatuses, 1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getStatuses).toHaveBeenCalledTimes(1);

    resolveRequest?.([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatuses).toHaveBeenCalledTimes(1);
    expect(onStatuses).toHaveBeenCalledWith(expect.objectContaining({
      statuses: [],
      successful: true,
      coreReachable: true,
    }));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(getStatuses).toHaveBeenCalledTimes(2);
    dispose();
    resolveRequest?.([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatuses).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
