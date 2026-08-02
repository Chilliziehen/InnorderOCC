import {
  ProviderCapabilitySchema,
  SystemStatusSchema,
} from "@innorder/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { parseProviderCapabilities } from "../src/provider-registry.js";

const apps: FastifyInstance[] = [];

function createApp(): FastifyInstance {
  const app = buildApp();
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

describe("AI service routes", () => {
  it("provides minimal liveness", async () => {
    const response = await createApp().inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("returns the strict shared system-status contract", async () => {
    const productionParse = vi.spyOn(SystemStatusSchema, "parse");
    const before = Date.now();
    const response = await createApp().inject({
      method: "GET",
      url: "/api/v1/system/status",
    });

    expect(productionParse).toHaveBeenCalledTimes(1);
    const status = SystemStatusSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(status.service).toBe("occ-ai");
    expect(status.state).toBe("READY");
    expect(status.components).toHaveLength(1);
    expect(status.components[0]).toMatchObject({
      id: "agent-runtime",
      state: "READY",
    });
    expect(Date.parse(status.checkedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(status.components[0]!.checkedAt)).toBeGreaterThanOrEqual(
      before,
    );
  });

  it("advertises strict provider capabilities without connection details", async () => {
    const response = await createApp().inject({
      method: "GET",
      url: "/api/v1/providers/capabilities",
    });
    const body = ProviderCapabilitySchema.array().parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "openai-compatible" }),
      ]),
    );
    expect(JSON.stringify(body)).not.toMatch(/endpoint|credential|api[_-]?key/i);
  });

  it("rejects invalid provider registry values at runtime", () => {
    expect(parseProviderCapabilities).toBeTypeOf("function");
    expect(() =>
      parseProviderCapabilities([
        {
          provider: "openai-compatible",
          models: ["openai-compatible/*"],
          supportsTools: true,
          supportsStructuredOutput: true,
          endpoint: "https://must-not-pass.example",
        },
      ]),
    ).toThrow();
  });

  it("adds a generated correlation ID to responses", async () => {
    const response = await createApp().inject({ method: "GET", url: "/health" });

    expect(response.headers["x-correlation-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("preserves a bounded safe inbound correlation ID", async () => {
    const response = await createApp().inject({
      method: "GET",
      url: "/health",
      headers: { "x-correlation-id": "request-123:child_4" },
    });

    expect(response.headers["x-correlation-id"]).toBe("request-123:child_4");
  });

  it("does not reflect unsafe or unbounded correlation IDs", async () => {
    const app = createApp();
    const unsafe = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-correlation-id": "unsafe value" },
    });
    const unboundedValue = "a".repeat(129);
    const unbounded = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-correlation-id": unboundedValue },
    });

    expect(unsafe.headers["x-correlation-id"]).not.toBe("unsafe value");
    expect(unbounded.headers["x-correlation-id"]).not.toBe(unboundedValue);
  });

  it("returns a correlated 404 for unknown routes", async () => {
    const response = await createApp().inject({
      method: "GET",
      url: "/not-found",
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["x-correlation-id"]).toBeTypeOf("string");
  });

  it("does not expose stack traces in production error JSON", async () => {
    const app = createApp();
    app.get("/explode", async () => {
      throw new Error("failure");
    });

    const response = await app.inject({ method: "GET", url: "/explode" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).not.toHaveProperty("stack");
  });

  it("preserves integer HTTP error statuses from 400 through 599", async () => {
    const app = createApp();
    app.get("/teapot", async () => {
      throw Object.assign(new Error("short and stout"), { statusCode: 418 });
    });

    const response = await app.inject({ method: "GET", url: "/teapot" });

    expect(response.statusCode).toBe(418);
    expect(response.json()).not.toHaveProperty("stack");
  });

  it.each([200, 399, 600, 500.5, "500", Number.NaN])(
    "normalizes untrusted error status %s to 500",
    async (statusCode) => {
      const app = createApp();
      app.get("/invalid-status", async () => {
        throw Object.assign(new Error("failure"), { statusCode });
      });

      const response = await app.inject({
        method: "GET",
        url: "/invalid-status",
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).not.toHaveProperty("stack");
    },
  );
});

describe("configuration", () => {
  it("uses safe defaults", () => {
    expect(loadConfig({})).toEqual({
      environment: "development",
      host: "127.0.0.1",
      logLevel: "info",
      port: 3100,
      version: "dev",
      businessEnabled: false,
      databasePoolSize: 10,
      ingestionEnabled: false,
      parserTimeoutMs: 60_000,
      parserPollMs: 25,
      parserHeartbeatMaxAgeMs: 10_000,
    });
  });

  it("enables the configured logger in production", async () => {
    const app = buildApp(
      loadConfig({ NODE_ENV: "production", LOG_LEVEL: "warn" }),
    );
    apps.push(app);

    expect(app.log.level).toBe("warn");
  });

  it.each(["", "verbose", "warning", "INFO"])(
    "rejects unsupported log level %s",
    (logLevel) => {
      expect(() => loadConfig({ LOG_LEVEL: logLevel })).toThrow();
    },
  );

  it.each(["0", "65536", "3.14", "not-a-port"])(
    "rejects invalid port %s",
    (port) => {
      expect(() => loadConfig({ PORT: port })).toThrow();
    },
  );
});
