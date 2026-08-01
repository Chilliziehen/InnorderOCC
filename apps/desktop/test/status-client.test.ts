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

    await expect(getSystemStatuses()).resolves.toEqual([
      expect.objectContaining({ service: "occ-core", state: "UNREACHABLE" }),
      expect.objectContaining({ service: "occ-ai", state: "UNREACHABLE" }),
    ]);
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

    await vi.advanceTimersByTimeAsync(1_000);
    expect(getStatuses).toHaveBeenCalledTimes(2);
    dispose();
    resolveRequest?.([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatuses).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
