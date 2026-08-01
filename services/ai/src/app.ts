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

export interface AppDependencies {
  authenticateCore?: (request: import("fastify").FastifyRequest) => boolean;
  https?: Record<string, unknown>;
  operationStatus?: (operationId: string) => Promise<unknown>;
  cancelOperation?: (operationId: string) => Promise<unknown>;
}

export function buildApp(config: ServiceConfig = loadConfig(), dependencies: AppDependencies = {}): FastifyInstance {
  const app = Fastify({
    logger:
      config.environment === "production" ? { level: config.logLevel } : false,
    https: dependencies.https as never,
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header(
      "x-correlation-id",
      correlationId(request.headers["x-correlation-id"]),
    );
    if (config.businessEnabled && request.url.split("?", 1)[0] !== "/health") {
      if (request.headers.authorization !== undefined) {
        await reply.status(400).send({ errorCode: "OCC-AI-BEARER-FORBIDDEN" });
        return;
      }
      if (dependencies.authenticateCore?.(request) !== true) {
        await reply.status(401).send({ errorCode: "OCC-AI-SERVICE-IDENTITY-INVALID" });
      }
    }
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

  const requireCore = async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply): Promise<boolean> => {
    if (request.headers.authorization !== undefined) { await reply.status(400).send({ errorCode: "OCC-AI-BEARER-FORBIDDEN" }); return false; }
    if (dependencies.authenticateCore?.(request) !== true) { await reply.status(401).send({ errorCode: "OCC-AI-SERVICE-IDENTITY-INVALID" }); return false; }
    return true;
  };
  app.get<{ Params: { operationId: string } }>("/internal/v1/ai/operations/:operationId/status", async (request, reply) => {
    if (!(await requireCore(request, reply))) return reply;
    if (dependencies.operationStatus === undefined) return reply.status(503).send({ errorCode: "OCC-AI-DISABLED" });
    return dependencies.operationStatus(request.params.operationId);
  });
  app.post<{ Params: { operationId: string } }>("/internal/v1/ai/operations/:operationId/cancel", async (request, reply) => {
    if (!(await requireCore(request, reply))) return reply;
    if (dependencies.cancelOperation === undefined) return reply.status(503).send({ errorCode: "OCC-AI-DISABLED" });
    return dependencies.cancelOperation(request.params.operationId);
  });

  return app;
}
