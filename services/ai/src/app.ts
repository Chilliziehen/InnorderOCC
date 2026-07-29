import { randomUUID } from "node:crypto";

import { SystemStatusSchema } from "@innorder/contracts";
import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig, type ServiceConfig } from "./config.js";
import { getProviderCapabilities } from "./provider-registry.js";

const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function correlationId(value: string | string[] | undefined): string {
  return typeof value === "string" && SAFE_CORRELATION_ID.test(value)
    ? value
    : randomUUID();
}

export function buildApp(config: ServiceConfig = loadConfig()): FastifyInstance {
  const app = Fastify({
    logger:
      config.environment === "production" ? { level: config.logLevel } : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header(
      "x-correlation-id",
      correlationId(request.headers["x-correlation-id"]),
    );
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error });
    const publicError =
      error instanceof Error ? error : new Error("Unknown error");
    const candidateStatus =
      "statusCode" in publicError &&
      typeof publicError.statusCode === "number"
        ? publicError.statusCode
        : undefined;
    const statusCode =
      candidateStatus !== undefined &&
      Number.isInteger(candidateStatus) &&
      candidateStatus >= 400 &&
      candidateStatus <= 599
        ? candidateStatus
        : 500;
    const isServerError = statusCode >= 500;

    return reply.status(statusCode).send({
      statusCode,
      error: isServerError ? "Internal Server Error" : publicError.name,
      message: isServerError ? "Internal Server Error" : publicError.message,
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/v1/system/status", async () => {
    const checkedAt = new Date().toISOString();

    return SystemStatusSchema.parse({
      service: "occ-ai",
      version: config.version,
      state: "READY",
      checkedAt,
      components: [
        {
          id: "agent-runtime",
          label: "Agent runtime",
          state: "READY",
          checkedAt,
        },
      ],
    });
  });

  app.get("/api/v1/providers/capabilities", async () =>
    getProviderCapabilities(),
  );

  return app;
}
