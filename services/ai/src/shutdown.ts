import type { FastifyInstance } from "fastify";

type ShutdownSignal = "SIGTERM" | "SIGINT";

export interface ShutdownRuntime {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
  exit(code: number): unknown;
}

export function registerShutdownHandlers(
  app: FastifyInstance,
  runtime: ShutdownRuntime = process,
): () => void {
  let shuttingDown = false;

  const removeHandlers = (): void => {
    runtime.off("SIGTERM", handleSignal);
    runtime.off("SIGINT", handleSignal);
  };

  const handleSignal = (): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    void Promise.resolve()
      .then(() => app.close())
      .then(
        () => {
          removeHandlers();
          runtime.exit(0);
        },
        (error: unknown) => {
          app.log.error({ err: error }, "Graceful shutdown failed");
          removeHandlers();
          runtime.exit(1);
        },
      );
  };

  runtime.on("SIGTERM", handleSignal);
  runtime.on("SIGINT", handleSignal);

  return removeHandlers;
}
