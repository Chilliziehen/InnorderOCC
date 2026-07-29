import { EventEmitter } from "node:events";

import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerShutdownHandlers } from "../src/shutdown.js";

class TestRuntime extends EventEmitter {
  readonly exit = vi.fn();
}

function createApp(close: () => Promise<void>): FastifyInstance {
  return {
    close: vi.fn(close),
    log: { error: vi.fn() },
  } as unknown as FastifyInstance;
}

describe("shutdown handlers", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "closes and exits successfully on %s",
    async (signal) => {
      const runtime = new TestRuntime();
      const app = createApp(async () => undefined);
      registerShutdownHandlers(app, runtime);

      runtime.emit(signal);

      await vi.waitFor(() => expect(app.close).toHaveBeenCalledOnce());
      expect(runtime.exit).toHaveBeenCalledWith(0);
      expect(runtime.listenerCount("SIGTERM")).toBe(0);
      expect(runtime.listenerCount("SIGINT")).toBe(0);
    },
  );

  it("ignores duplicate signals while close is pending", async () => {
    let finishClose: (() => void) | undefined;
    const runtime = new TestRuntime();
    const app = createApp(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    registerShutdownHandlers(app, runtime);

    runtime.emit("SIGTERM");
    runtime.emit("SIGINT");
    await vi.waitFor(() => expect(app.close).toHaveBeenCalledOnce());
    finishClose!();

    await vi.waitFor(() => expect(runtime.exit).toHaveBeenCalledOnce());
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("logs close failures, removes handlers, and exits unsuccessfully", async () => {
    const failure = new Error("close failed");
    const runtime = new TestRuntime();
    const app = createApp(async () => Promise.reject(failure));
    registerShutdownHandlers(app, runtime);

    runtime.emit("SIGTERM");

    await vi.waitFor(() => expect(runtime.exit).toHaveBeenCalledWith(1));
    expect(app.log.error).toHaveBeenCalledWith(
      { err: failure },
      "Graceful shutdown failed",
    );
    expect(runtime.listenerCount("SIGTERM")).toBe(0);
    expect(runtime.listenerCount("SIGINT")).toBe(0);
  });
});
