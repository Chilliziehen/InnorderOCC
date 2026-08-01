import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";

import type { CapabilitySnapshot, ProviderConfig, ProviderProfile } from "@innorder/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleAdapter, type CapabilityRepository } from "../src/provider/openai-compatible.js";
import { ProviderError, type ResolvedProviderTarget } from "../src/provider/provider-policy.js";
import { SecureTransport, type ProviderTransport, type RawRequestFactory, type TransportTelemetry } from "../src/provider/secure-transport.js";

const TLS_CA = await readFile(new URL("./fixtures/provider-tls/ca.cert.pem", import.meta.url));
const TLS_CERT = await readFile(new URL("./fixtures/provider-tls/server.cert.pem", import.meta.url));
const TLS_KEY = await readFile(new URL("./fixtures/provider-tls/server.key.pem", import.meta.url));
const openServers: (HttpsServer | NetServer)[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const provider = {
  id: "00000000-0000-4000-8000-000000000001", name: "stub", origin: "https://provider.example:8443", apiPrefix: "/v1",
  approvedPrivateCidrs: [], credentialFile: "C:\\run\\provider", enabled: true, version: 1,
} satisfies ProviderConfig;
const snapshot: CapabilitySnapshot = {
  chat: true, embeddings: true, structuredOutput: true, embeddingDimensions: 3,
  maxInputTokens: 4096, maxOutputTokens: 1024, probedAt: "2026-08-01T00:00:00.000Z", snapshotHash: "0".repeat(64),
};
const profile = {
  id: "00000000-0000-4000-8000-000000000002", providerId: provider.id, name: "chat", purpose: "CHAT", model: "model-1",
  maxClassification: "INTERNAL", requiredCapabilities: { structuredOutput: true },
  timeouts: { connectMs: 100, totalMs: 1000 }, rateLimit: { requestsPerMinute: 100, tokensPerMinute: 10000, maxConcurrency: 2 },
  cost: { currency: "USD", inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000 }, capabilitySnapshot: snapshot,
  enabled: true, version: 1,
} satisfies ProviderProfile;

const modelMetadata = {
  id: "model-1",
  capabilities: { chat: true, embeddings: true, structured_output: true },
  max_input_tokens: 8192,
  max_output_tokens: 2048,
  embedding_dimensions: 3,
} as const;
const standardModel = { id: "model-1", object: "model", created: 1_722_470_400, owned_by: "openai" } as const;
const standardModelsResponse = { object: "list", data: [standardModel] } as const;

function standardChatResponse(content: string, usage?: Readonly<{ prompt_tokens: number; completion_tokens: number; total_tokens?: number }>) {
  return {
    id: "chatcmpl-fixture", object: "chat.completion", created: 1_722_470_400, model: profile.model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    ...(usage === undefined ? {} : { usage }),
  };
}

function standardEmbeddingResponse(embeddings: readonly (readonly number[])[], usage?: Readonly<{ prompt_tokens: number; total_tokens: number }>) {
  return {
    object: "list", model: profile.model,
    data: embeddings.map((embedding, index) => ({ object: "embedding", index, embedding })),
    ...(usage === undefined ? {} : { usage }),
  };
}

function target(): ResolvedProviderTarget {
  return { url: new URL("https://provider.example:8443/v1/chat/completions"), address: "93.184.216.34", family: 4, servername: "provider.example", hostHeader: "provider.example:8443" };
}

async function listen(server: HttpsServer | NetServer): Promise<number> {
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

function localTarget(port: number, path: string, servername = "provider.example"): ResolvedProviderTarget {
  return {
    url: new URL(`https://provider.example:${port}${path}`), address: "127.0.0.1", family: 4,
    servername, hostHeader: `provider.example:${port}`,
  };
}

function realTransport(port: number, options: Readonly<{ ca?: Buffer; servername?: string }> = {}): SecureTransport {
  return new SecureTransport({
    policy: { resolve: async (path) => localTarget(port, path, options.servername) },
    credentialReader: async () => Buffer.from("fixture-credential"),
    ...(options.ca === undefined ? {} : { tlsCa: options.ca }),
  });
}

function transportInput(path: string, overrides: Partial<Parameters<SecureTransport["request"]>[0]> = {}) {
  return {
    operationId: "real-operation", profileId: profile.id, model: profile.model, path, method: "GET" as const,
    connectMs: 200, totalMs: 1000, maxResponseBytes: 1024, signal: new AbortController().signal,
    ...overrides,
  };
}

describe("secure provider transport", () => {
  it("pins lookup while preserving TLS servername and Host and adds credentials only after policy validation", async () => {
    const events: TransportTelemetry[] = [];
    const requestFactory: RawRequestFactory = vi.fn(async (request) => {
      expect(request.address).toBe("93.184.216.34");
      expect(request.servername).toBe("provider.example");
      expect(request.headers.host).toBe("provider.example:8443");
      expect(request.headers.authorization).toBe("Bearer credential");
      return { status: 200, headers: { "content-type": "application/json", "x-request-id": "provider-secret-id", authorization: "never" }, body: Buffer.from(JSON.stringify(standardChatResponse("{}"))) };
    });
    const transport = new SecureTransport({
      policy: { resolve: vi.fn(async () => target()) }, requestFactory,
      credentialReader: vi.fn(async () => Buffer.from("credential")), telemetry: (event) => events.push(event), now: () => 10,
    });
    const response = await transport.request({ operationId: "op", profileId: profile.id, model: profile.model, path: "/v1/chat/completions", method: "POST", body: Buffer.from("{}"), connectMs: 100, totalMs: 1000, maxResponseBytes: 1024, signal: new AbortController().signal });

    expect(response.headers).toEqual({ "content-type": "application/json", "x-request-id-hash": hash("provider-secret-id") });
    expect(events[0]).toMatchObject({ operationId: "op", profileId: profile.id, status: 200, code: "OK" });
    expect(JSON.stringify(events)).not.toMatch(/credential|provider-secret-id|authorization|chat\/completions/i);
  });

  it("does not read or forward a credential when URL or DNS validation fails", async () => {
    const credentialReader = vi.fn(async () => Buffer.from("credential"));
    const requestFactory = vi.fn();
    const transport = new SecureTransport({ policy: { resolve: vi.fn(async () => { throw new ProviderError("OCC-AI-PROVIDER-ADDRESS", false); }) }, requestFactory, credentialReader });
    await expect(transport.request({ operationId: "op", profileId: profile.id, model: profile.model, path: "/v1/models", method: "GET", connectMs: 100, totalMs: 1000, maxResponseBytes: 100, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-ADDRESS" });
    expect(credentialReader).not.toHaveBeenCalled();
    expect(requestFactory).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 308])("rejects redirect status %s without a second dispatch", async (status) => {
    const requestFactory = vi.fn(async () => ({ status, headers: { location: "https://other.example/steal" }, body: Buffer.alloc(0) }));
    const transport = new SecureTransport({ policy: { resolve: async () => target() }, requestFactory, credentialReader: async () => Buffer.from("credential") });
    await expect(transport.request({ operationId: "op", profileId: profile.id, model: profile.model, path: "/v1/models", method: "GET", connectMs: 100, totalMs: 1000, maxResponseBytes: 100, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-REDIRECT" });
    expect(requestFactory).toHaveBeenCalledTimes(1);
  });

  it("enforces cancellation, total deadlines, body limits, and strict JSON content type", async () => {
    const cases = [
      { factory: async () => new Promise<never>(() => undefined), totalMs: 10, code: "OCC-AI-PROVIDER-TIMEOUT" },
      { factory: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.alloc(101) }), totalMs: 1000, code: "OCC-AI-PROVIDER-LIMIT" },
      { factory: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("{}") }), totalMs: 1000, code: "OCC-AI-PROVIDER-CONTENT-TYPE" },
      { factory: async () => ({ status: 200, headers: { "content-type": ["application/json", "text/html"] }, body: Buffer.from("{}") }), totalMs: 1000, code: "OCC-AI-PROVIDER-CONTENT-TYPE" },
    ];
    for (const item of cases) {
      const transport = new SecureTransport({ policy: { resolve: async () => target() }, requestFactory: item.factory, credentialReader: async () => Buffer.from("credential") });
      await expect(transport.request({ operationId: "op", profileId: profile.id, model: profile.model, path: "/v1/models", method: "GET", connectMs: Math.min(100, item.totalMs), totalMs: item.totalMs, maxResponseBytes: 100, signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: item.code });
    }
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    const transport = new SecureTransport({ policy: { resolve: async () => target() }, requestFactory: async () => new Promise<never>(() => undefined), credentialReader: async () => Buffer.from("credential") });
    await expect(transport.request({ operationId: "op", profileId: profile.id, model: profile.model, path: "/v1/models", method: "GET", connectMs: 100, totalMs: 1000, maxResponseBytes: 100, signal: controller.signal }))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CANCELLED", cause: controller.signal.reason });
  });

  it("applies the original total deadline to DNS resolution and credential reads", async () => {
    for (const dependencies of [
      { policy: { resolve: async () => new Promise<never>(() => undefined) }, credentialReader: async () => Buffer.from("credential") },
      { policy: { resolve: async () => target() }, credentialReader: async () => new Promise<Buffer>(() => undefined) },
    ]) {
      const transport = new SecureTransport({ ...dependencies, requestFactory: async () => response({ ok: true }) });
      await expect(transport.request({ operationId: "op", profileId: profile.id, model: profile.model, path: "/v1/models", method: "GET", connectMs: 10, totalMs: 10, maxResponseBytes: 100, signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-TIMEOUT" });
    }
  });

  it("enforces the response header limit for injected request factories", async () => {
    const transport = new SecureTransport({ policy: { resolve: async () => target() }, credentialReader: async () => Buffer.from("credential"), requestFactory: async () => ({ status: 200, headers: { "content-type": "application/json", "x-long": "x".repeat(100) }, body: Buffer.from("{}") }) });
    await expect(transport.request({ operationId: "op", profileId: profile.id, model: profile.model, path: "/v1/models", method: "GET", connectMs: 100, totalMs: 1000, maxResponseBytes: 100, maxResponseHeaderBytes: 32, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-LIMIT" });
  });

  it("sanitizes telemetry sink failures", async () => {
    const transport = new SecureTransport({
      policy: { resolve: async () => target() }, credentialReader: async () => Buffer.from("credential"),
      requestFactory: async () => response({ ok: true }), telemetry: async () => { throw new Error("raw telemetry secret"); },
    });
    const error = await transport.request({ operationId: "op", profileId: profile.id, model: profile.model, path: "/v1/models", method: "GET", connectMs: 100, totalMs: 1000, maxResponseBytes: 100, signal: new AbortController().signal }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "OCC-AI-PROVIDER-TELEMETRY" });
    expect(JSON.stringify(error)).not.toContain("raw telemetry secret");
  });

  it("cancels credential reads and zeroes a secret that resolves after cancellation", async () => {
    let resolveCredential!: (value: Buffer) => void;
    let readerSignal: AbortSignal | undefined;
    let readerStarted!: () => void;
    const started = new Promise<void>((resolve) => { readerStarted = resolve; });
    const secret = Buffer.from("late-known-secret");
    const controller = new AbortController();
    const transport = new SecureTransport({
      policy: { resolve: async () => target() },
      credentialReader: async (_path, signal) => {
        readerSignal = signal;
        readerStarted();
        return new Promise((resolve) => { resolveCredential = resolve; });
      },
      requestFactory: vi.fn(),
    });
    const pending = transport.request({ operationId: "op", profileId: profile.id, model: profile.model, path: "/v1/models", method: "GET", connectMs: 100, totalMs: 1_000, maxResponseBytes: 100, signal: controller.signal });

    await started;
    controller.abort(new Error("cancel credential read"));
    await expect(pending).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CANCELLED" });
    resolveCredential(secret);
    await new Promise((resolve) => setImmediate(resolve));
    expect(readerSignal?.aborted).toBe(true);
    expect([...secret]).toEqual(new Array(secret.length).fill(0));
  });

  it("keeps required telemetry inside the operation cancellation boundary", async () => {
    let telemetrySignal: AbortSignal | undefined;
    let telemetryStarted!: () => void;
    const started = new Promise<void>((resolve) => { telemetryStarted = resolve; });
    const controller = new AbortController();
    const transport = new SecureTransport({
      policy: { resolve: async () => target() }, credentialReader: async () => Buffer.from("credential"),
      requestFactory: async () => response({ ok: true }),
      telemetry: async (_event, signal) => { telemetrySignal = signal; telemetryStarted(); return new Promise(() => undefined); },
    });
    const pending = transport.request({ operationId: "op", profileId: profile.id, model: profile.model, path: "/v1/models", method: "GET", connectMs: 100, totalMs: 1_000, maxResponseBytes: 100, signal: controller.signal });

    await started;
    controller.abort(new Error("cancel telemetry"));
    await expect(Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve("hung"), 100))]))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CANCELLED" });
    expect(telemetrySignal?.aborted).toBe(true);
  });
});

describe("real Node HTTPS provider transport", () => {
  it("pins the selected address while preserving Host, SNI, authorization, and certificate validation", async () => {
    let received: Readonly<{ host?: string; authorization?: string; servername?: string }> = {};
    const server = createHttpsServer({ key: TLS_KEY, cert: TLS_CERT }, (request, response) => {
      received = { host: request.headers.host, authorization: request.headers.authorization, servername: request.socket.servername };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(standardChatResponse("{}")));
    });
    const port = await listen(server);

    await expect(realTransport(port, { ca: TLS_CA }).request(transportInput("/ok"))).resolves.toMatchObject({ status: 200 });
    expect(received).toEqual({ host: `provider.example:${port}`, authorization: "Bearer fixture-credential", servername: "provider.example" });
  });

  it("fails closed for an untrusted certificate and hostname mismatch", async () => {
    const server = createHttpsServer({ key: TLS_KEY, cert: TLS_CERT }, (_request, response) => response.end("{}"));
    const port = await listen(server);
    await expect(realTransport(port).request(transportInput("/untrusted"))).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-TLS" });
    await expect(realTransport(port, { ca: TLS_CA, servername: "wrong.example" }).request(transportInput("/hostname"))).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-TLS" });
  });

  it("rejects real redirects and bounded response overflow without another dispatch", async () => {
    let requests = 0;
    const server = createHttpsServer({ key: TLS_KEY, cert: TLS_CERT }, (request, response) => {
      requests += 1;
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/ok", "content-type": "application/json" });
        response.end("{}");
      } else if (request.url === "/headers") {
        response.writeHead(200, { "content-type": "application/json", "x-oversized": "x".repeat(1024) });
        response.end("{}");
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ value: "x".repeat(256) }));
      }
    });
    const port = await listen(server);
    const transport = realTransport(port, { ca: TLS_CA });
    await expect(transport.request(transportInput("/redirect"))).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-REDIRECT" });
    expect(requests).toBe(1);
    await expect(transport.request(transportInput("/large", { maxResponseBytes: 32 }))).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-LIMIT" });
    await expect(transport.request(transportInput("/headers", { maxResponseHeaderBytes: 128 }))).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-LIMIT" });
  });

  it("enforces connect and total deadlines on real sockets", async () => {
    const stalledSockets = new Set<Socket>();
    const stalled = createNetServer((socket) => {
      stalledSockets.add(socket);
      socket.once("close", () => stalledSockets.delete(socket));
    });
    const stalledPort = await listen(stalled);
    await expect(realTransport(stalledPort, { ca: TLS_CA }).request(transportInput("/connect", { connectMs: 20, totalMs: 200 })))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-TIMEOUT" });
    stalledSockets.forEach((socket) => socket.destroy());

    const slow = createHttpsServer({ key: TLS_KEY, cert: TLS_CERT }, (_request, response) => {
      setTimeout(() => { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); }, 500).unref();
    });
    const slowPort = await listen(slow);
    await expect(realTransport(slowPort, { ca: TLS_CA }).request(transportInput("/slow", { connectMs: 100, totalMs: 150 })))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-TIMEOUT" });
  });

  it("destroys the real socket on caller cancellation", async () => {
    let socketClosed!: Promise<void>;
    let requestArrived!: () => void;
    const arrived = new Promise<void>((resolve) => { requestArrived = resolve; });
    const server = createHttpsServer({ key: TLS_KEY, cert: TLS_CERT }, (request) => {
      socketClosed = new Promise((resolve) => request.socket.once("close", () => resolve()));
      requestArrived();
    });
    const port = await listen(server);
    const controller = new AbortController();
    const pending = realTransport(port, { ca: TLS_CA }).request(transportInput("/hang", { signal: controller.signal }));
    await arrived;
    controller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CANCELLED" });
    await socketClosed;
  });

  it("classifies pre-connect failure as retryable and reset after body dispatch as ambiguous", async () => {
    const unused = createNetServer();
    const unusedPort = await listen(unused);
    await new Promise<void>((resolve) => unused.close(() => resolve()));
    openServers.splice(openServers.indexOf(unused), 1);
    await expect(realTransport(unusedPort, { ca: TLS_CA }).request(transportInput("/refused", { method: "POST", body: Buffer.from("{}") })))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-TRANSIENT", retryable: true });

    const reset = createHttpsServer({ key: TLS_KEY, cert: TLS_CERT }, (request) => {
      request.once("data", () => request.socket.destroy());
    });
    const resetPort = await listen(reset);
    await expect(realTransport(resetPort, { ca: TLS_CA }).request(transportInput("/reset", { method: "POST", body: Buffer.from("{\"sent\":true}") })))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-DISPATCHED", retryable: false });
  });

  it("probes canonical OpenAI responses through the real HTTPS transport", async () => {
    const server = createHttpsServer({ key: TLS_KEY, cert: TLS_CERT }, (request, response) => {
      const body = request.url === "/v1/models"
        ? standardModelsResponse
        : request.url === "/v1/chat/completions"
          ? standardChatResponse("{\"probe\":true}", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
          : standardEmbeddingResponse([[1, 2, 3]], { prompt_tokens: 1, total_tokens: 1 });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    const port = await listen(server);
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport: realTransport(port, { ca: TLS_CA }), capabilityRepository: { save: async () => undefined } });

    await expect(adapter.probe(new AbortController().signal)).resolves.toMatchObject({
      chat: true, embeddings: true, structuredOutput: true, embeddingDimensions: 3,
    });
  });
});

function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }) {
  return { status, headers, body: Buffer.from(JSON.stringify(body)) };
}

describe("OpenAI-compatible adapter", () => {
  it("probes models, structured chat, and embeddings and persists one exact normalized snapshot", async () => {
    const transport = { request: vi.fn()
      .mockResolvedValueOnce(response(standardModelsResponse))
      .mockResolvedValueOnce(response(standardChatResponse("{\"probe\":true}", { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 })))
      .mockResolvedValueOnce(response(standardEmbeddingResponse([[0.1, 0.2, 0.3]], { prompt_tokens: 1, total_tokens: 1 }))), };
    const saved: CapabilitySnapshot[] = [];
    const repository: CapabilityRepository = { save: async (_providerId, _model, value) => { saved.push(value); } };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: repository, now: () => new Date("2026-08-01T00:00:00.000Z"), operationId: () => "operation" });

    const result = await adapter.probe(new AbortController().signal);
    expect(result).toMatchObject({ chat: true, embeddings: true, structuredOutput: true, embeddingDimensions: 3, maxInputTokens: 4096, maxOutputTokens: 1024 });
    expect(result.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved).toEqual([result]);
    expect(transport.request.mock.calls.map(([input]) => input.path)).toEqual(["/v1/models", "/v1/chat/completions", "/v1/embeddings"]);
  });

  it("uses one operation ID, deadline timestamp, and signal across the complete probe", async () => {
    const calls: Parameters<ProviderTransport["request"]>[0][] = [];
    const responses = [
      response({ data: [modelMetadata] }),
      response(standardChatResponse("{\"probe\":true}", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })),
      response(standardEmbeddingResponse([[1, 2, 3]], { prompt_tokens: 1, total_tokens: 1 })),
    ];
    const transport: ProviderTransport = { request: async (input) => { calls.push(input); return responses.shift()!; } };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: { save: async () => undefined }, operationId: () => "probe-operation" });
    await adapter.probe(new AbortController().signal);

    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(({ operationId }) => operationId))).toEqual(new Set(["probe-operation"]));
    expect(new Set(calls.map(({ deadline }) => deadline)).size).toBe(1);
    expect(calls.every(({ signal }) => signal === calls[0]!.signal)).toBe(true);
  });

  it("accepts bounded compatible model extensions but persists local configured limits", async () => {
    const transport = { request: vi.fn()
      .mockResolvedValueOnce(response({ object: "list", vendor_trace: "stripped", data: [{ ...standardModel, ...modelMetadata, capabilities: { ...modelMetadata.capabilities, vision: true }, context_length: 16_384, max_completion_tokens: 4096, vendor_field: { ignored: true } }] }))
      .mockResolvedValueOnce(response(standardChatResponse("{\"probe\":true}", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })))
      .mockResolvedValueOnce(response(standardEmbeddingResponse([[1, 2, 3]], { prompt_tokens: 1, total_tokens: 1 }))), };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: { save: async () => undefined } });
    await expect(adapter.probe(new AbortController().signal)).resolves.toMatchObject({ maxInputTokens: 4096, maxOutputTokens: 1024, embeddingDimensions: 3 });
  });

  it.each([
    { max_input_tokens: 4095 },
    { max_output_tokens: 1023 },
    { max_completion_tokens: 1000 },
    { context_length: 5000 },
    { embedding_dimensions: 4 },
  ])("fails closed when model extension policy is below configured requirements", async (extension) => {
    const transport = { request: vi.fn(async () => response({ object: "list", data: [{ ...standardModel, ...extension }] })) };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: { save: async () => undefined } });
    await expect(adapter.probe(new AbortController().signal)).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CAPABILITY" });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it("returns strict chat JSON and exact finite embeddings", async () => {
    const transport = { request: vi.fn()
      .mockResolvedValueOnce(response(standardChatResponse("{\"answer\":\"yes\"}", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })))
      .mockResolvedValueOnce(response(standardEmbeddingResponse([[1, 2, 3], [4, 5, 6]], { prompt_tokens: 2, total_tokens: 2 }))), };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: { save: async () => undefined }, operationId: () => "operation" });
    const chat = await adapter.chat({ messages: [{ role: "user", content: "question" }], schema: { type: "object" } }, new AbortController().signal);
    expect(chat).toMatchObject({ output: { answer: "yes" }, accounting: { estimated: true } });
    expect(chat.usage.inputTokens).toBeGreaterThan(3);
    expect(chat.usage.outputTokens).toBeGreaterThan(2);
    await expect(adapter.embed({ inputs: ["one", "two"], dimensions: 3 }, new AbortController().signal))
      .resolves.toMatchObject({ embeddings: [[1, 2, 3], [4, 5, 6]] });
  });

  it("accepts explicitly compatible bounded standard chat fields", async () => {
    const body = {
      ...standardChatResponse("{}", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      service_tier: "default", system_fingerprint: "fp_fixture",
      choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: "{}", refusal: null } }],
      usage: {
        prompt_tokens: 1, completion_tokens: 1, total_tokens: 2,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
      },
    };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response(body) }, capabilityRepository: { save: async () => undefined } });
    await expect(adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal))
      .resolves.toMatchObject({ output: {} });
  });

  it.each([
    { finish_reason: "length" },
    { finish_reason: "content_filter" },
    { finish_reason: "tool_calls" },
    { finish_reason: "function_call" },
    { finish_reason: "stop", refusal: "blocked" },
    { finish_reason: "stop", tool_calls: [] },
    { finish_reason: "stop", function_call: { name: "unsafe", arguments: "{}" } },
  ])("requires an unrefused terminal stop completion", async ({ finish_reason, refusal, tool_calls, function_call }) => {
    const message = {
      role: "assistant", content: "{}",
      ...(refusal === undefined ? {} : { refusal }),
      ...(tool_calls === undefined ? {} : { tool_calls }),
      ...(function_call === undefined ? {} : { function_call }),
    };
    const body = { ...standardChatResponse("{}"), choices: [{ index: 0, finish_reason, message }] };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response(body) }, capabilityRepository: { save: async () => undefined } });
    await expect(adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-MALFORMED" });
  });

  it("allows chat-only capability snapshots without requiring embedding dimensions", async () => {
    const chatOnlyProfile = {
      ...profile,
      capabilitySnapshot: { ...profile.capabilitySnapshot, embeddings: false, embeddingDimensions: undefined },
    };
    const transport = { request: vi.fn(async () => response(standardChatResponse("{}"))) };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile: chatOnlyProfile, transport, capabilityRepository: { save: async () => undefined } });

    await expect(adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal))
      .resolves.toMatchObject({ output: {} });
    await expect(adapter.embed({ inputs: ["x"], dimensions: 3 }, new AbortController().signal))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CAPABILITY" });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { body: { ...standardChatResponse("{}"), unknown: true } },
    { body: { ...standardChatResponse("{}"), id: "x".repeat(257) } },
    { body: { ...standardChatResponse("{}"), object: "chat.completion.chunk" } },
    { body: { ...standardChatResponse("{}"), model: "other-model" } },
    { body: { ...standardChatResponse("{}"), choices: [{ index: 1, finish_reason: "stop", message: { role: "assistant", content: "{}" } }] } },
    { body: { ...standardChatResponse("{}"), choices: [...standardChatResponse("{}").choices, ...standardChatResponse("{}").choices] } },
    { body: { ...standardChatResponse("{}"), choices: [{ index: 0, finish_reason: "invalid", message: { role: "assistant", content: "{}" } }] } },
    { body: { ...standardChatResponse("{}"), choices: [{ index: 0, finish_reason: "stop", message: { role: "user", content: "{}" } }] } },
    { body: { ...standardChatResponse("{}"), choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{}", unknown: true } }] } },
    { body: { ...standardChatResponse("{}"), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, unknown: true } } },
  ])("rejects unknown, invalid, or inconsistent standard chat fields", async ({ body }) => {
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response(body) }, capabilityRepository: { save: async () => undefined } });
    await expect(adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-MALFORMED" });
  });

  it.each([
    { body: { ...standardEmbeddingResponse([[1, 2, 3]]), unknown: true } },
    { body: { ...standardEmbeddingResponse([[1, 2, 3]]), object: "embedding" } },
    { body: { ...standardEmbeddingResponse([[1, 2, 3]]), model: "other-model" } },
    { body: standardEmbeddingResponse([[1, 2, 3], [4, 5, 6]]) },
    { body: { ...standardEmbeddingResponse([[1, 2, 3]]), data: [{ object: "other", index: 0, embedding: [1, 2, 3] }] } },
    { body: { ...standardEmbeddingResponse([[1, 2, 3]]), data: [{ object: "embedding", index: 0, embedding: [1, 2, 3], unknown: true }] } },
    { body: { ...standardEmbeddingResponse([[1, 2, 3]]), usage: { prompt_tokens: 1, total_tokens: 1, unknown: true } } },
  ])("rejects unknown, invalid, or inconsistent standard embedding fields", async ({ body }) => {
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response(body) }, capabilityRepository: { save: async () => undefined } });
    await expect(adapter.embed({ inputs: ["x"], dimensions: 3 }, new AbortController().signal))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CAPABILITY" });
  });

  it.each([
    { messages: [{ role: "tool", content: "x" }], schema: { type: "object" } },
    { messages: [{ role: "user", content: "" }], schema: { type: "object" } },
    { messages: [{ role: "user", content: "x", extra: true }], schema: { type: "object" } },
    { messages: [{ role: "user", content: "x" }], schema: { type: "object" }, extra: true },
    { messages: [], schema: { type: "object" } },
  ])("rejects malformed chat runtime input with a sanitized stable code", async (input) => {
    const transport = { request: vi.fn() };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: { save: async () => undefined } });
    const error = await adapter.chat(input as never, new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "OCC-AI-PROVIDER-INPUT" });
    expect(JSON.stringify(error)).not.toContain(JSON.stringify(input));
    expect(transport.request).not.toHaveBeenCalled();
  });

  it.each([
    { inputs: [], dimensions: 3 },
    { inputs: [""], dimensions: 3 },
    { inputs: ["x"], dimensions: 0 },
    { inputs: ["x"], dimensions: 3, extra: true },
  ])("rejects malformed embedding runtime input with a sanitized stable code", async (input) => {
    const transport = { request: vi.fn() };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: { save: async () => undefined } });
    await expect(adapter.embed(input as never, new AbortController().signal)).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-INPUT" });
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("strictly validates bounded provider model and profile configuration at runtime", () => {
    expect(() => new OpenAiCompatibleAdapter({ provider, profile: { ...profile, model: "x".repeat(257) }, transport: { request: vi.fn() }, capabilityRepository: { save: async () => undefined } }))
      .toThrow(expect.objectContaining({ code: "OCC-AI-PROVIDER-CAPABILITY" }));
    expect(() => new OpenAiCompatibleAdapter({ provider, profile: { ...profile, unexpected: true } as never, transport: { request: vi.fn() }, capabilityRepository: { save: async () => undefined } }))
      .toThrow(expect.objectContaining({ code: "OCC-AI-PROVIDER-CAPABILITY" }));
  });

  it("rejects oversized chat aggregates before policy, credential, or provider dispatch", async () => {
    const resolve = vi.fn(async () => target());
    const credentialReader = vi.fn(async () => Buffer.from("must-not-read"));
    const requestFactory = vi.fn();
    const transport = new SecureTransport({ policy: { resolve }, credentialReader, requestFactory });
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: { save: async () => undefined }, maxRequestBytes: 512 });
    const messages = Array.from({ length: 20 }, () => ({ role: "user" as const, content: "x".repeat(100) }));

    await expect(adapter.chat({ messages, schema: { type: "object", properties: { answer: { type: "string" } } } }, new AbortController().signal))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-LIMIT" });
    expect(resolve).not.toHaveBeenCalled();
    expect(credentialReader).not.toHaveBeenCalled();
    expect(requestFactory).not.toHaveBeenCalled();
  });

  it("enforces active input-token policy for embedding aggregates before dispatch", async () => {
    const transport = { request: vi.fn() };
    const constrainedProfile = { ...profile, capabilitySnapshot: { ...profile.capabilitySnapshot, maxInputTokens: 128 } };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile: constrainedProfile, transport, capabilityRepository: { save: async () => undefined }, maxRequestBytes: 10_000 });
    await expect(adapter.embed({ inputs: ["x".repeat(80), "y".repeat(80)], dimensions: 3 }, new AbortController().signal))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-LIMIT" });
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("accepts normal aggregate boundaries and dispatches bounded request bodies", async () => {
    const transport = { request: vi.fn()
      .mockResolvedValueOnce(response(standardChatResponse("{}", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })))
      .mockResolvedValueOnce(response(standardEmbeddingResponse([[1, 2, 3], [4, 5, 6]], { prompt_tokens: 1, total_tokens: 1 }))), };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: { save: async () => undefined }, maxRequestBytes: 1024 });
    await adapter.chat({ messages: [{ role: "system", content: "rules" }, { role: "user", content: "question" }, { role: "assistant", content: "context" }], schema: { type: "object" } }, new AbortController().signal);
    await adapter.embed({ inputs: ["one", "two"], dimensions: 3 }, new AbortController().signal);
    expect(transport.request).toHaveBeenCalledTimes(2);
    for (const [input] of transport.request.mock.calls) expect(input.body.byteLength).toBeLessThanOrEqual(1024);
  });

  it("validates generated JSON against the requested schema without coercion or property removal", async () => {
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } as const;
    for (const output of [{ answer: 42 }, { answer: "yes", extra: true }]) {
      const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response(standardChatResponse(JSON.stringify(output), { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })) }, capabilityRepository: { save: async () => undefined } });
      await expect(adapter.chat({ messages: [{ role: "user", content: "x" }], schema }, new AbortController().signal))
        .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-MALFORMED" });
    }
  });

  it.each([
    { $ref: "https://attacker.example/schema.json" },
    { type: "string", pattern: "(a+)+$" },
    { type: "object", properties: { value: { format: "unknown-remote-format" } } },
  ])("rejects unsupported or unsafe output schema features", async (schema) => {
    const transport = { request: vi.fn() };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: { save: async () => undefined } });
    await expect(adapter.chat({ messages: [{ role: "user", content: "x" }], schema }, new AbortController().signal))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CAPABILITY" });
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("binds chat and embeddings to the active capability dimensions before dispatch", async () => {
    const transport = { request: vi.fn() };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: { save: async () => undefined } });
    await expect(adapter.embed({ inputs: ["x"], dimensions: 2 }, new AbortController().signal))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CAPABILITY" });
    expect(() => new OpenAiCompatibleAdapter({ provider, profile: { ...profile, requiredCapabilities: { structuredOutput: true, embeddingDimensions: 2 } }, transport, capabilityRepository: { save: async () => undefined } }))
      .toThrow(expect.objectContaining({ code: "OCC-AI-PROVIDER-CAPABILITY" }));
    expect(transport.request).not.toHaveBeenCalled();
  });

  it.each([
    { body: { ...standardChatResponse("{}"), choices: [] }, code: "OCC-AI-PROVIDER-MALFORMED" },
    { body: standardChatResponse("not json"), code: "OCC-AI-PROVIDER-MALFORMED" },
    { body: { ...standardChatResponse("{}"), choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{}" }, extra: true }] }, code: "OCC-AI-PROVIDER-MALFORMED" },
    { body: { ...standardChatResponse("{}"), unknown: true }, code: "OCC-AI-PROVIDER-MALFORMED" },
  ])("rejects malformed or unknown chat payloads", async ({ body, code }) => {
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response(body) }, capabilityRepository: { save: async () => undefined }, operationId: () => "operation" });
    await expect(adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal)).rejects.toMatchObject({ code });
  });

  it.each([
    standardEmbeddingResponse([[1, 2]]),
    standardEmbeddingResponse([[1, Number.NaN, 3]]),
    { ...standardEmbeddingResponse([[1, 2, 3]]), data: [{ object: "embedding", index: 1, embedding: [1, 2, 3] }] },
    { ...standardEmbeddingResponse([[1, 2, 3]]), data: [{ object: "embedding", index: 0, embedding: [1, 2, 3], extra: true }] },
  ])("rejects embedding count, index, shape, dimension, and finite-value mismatch", async (body) => {
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response(body) }, capabilityRepository: { save: async () => undefined }, operationId: () => "operation" });
    await expect(adapter.embed({ inputs: ["x"], dimensions: 3 }, new AbortController().signal)).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CAPABILITY" });
  });

  it("fails closed when the configured model or required dimensions do not match the probe", async () => {
    const missingModel = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response({ data: [{ id: "other" }] }) }, capabilityRepository: { save: async () => undefined }, operationId: () => "operation" });
    await expect(missingModel.probe(new AbortController().signal)).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CAPABILITY" });

    const minimalMetadataTransport = { request: vi.fn()
      .mockResolvedValueOnce(response({ data: [{ id: "model-1" }] }))
      .mockResolvedValueOnce(response(standardChatResponse("{\"probe\":true}", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })))
      .mockResolvedValueOnce(response(standardEmbeddingResponse([[1, 2, 3]], { prompt_tokens: 1, total_tokens: 1 }))), };
    const minimalMetadata = new OpenAiCompatibleAdapter({ provider, profile, transport: minimalMetadataTransport, capabilityRepository: { save: async () => undefined } });
    await expect(minimalMetadata.probe(new AbortController().signal)).resolves.toMatchObject({ maxInputTokens: 4096, maxOutputTokens: 1024, embeddingDimensions: 3 });

    const mismatchedDimensions = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response({ data: [{ ...modelMetadata, embedding_dimensions: 4 }] }) }, capabilityRepository: { save: async () => undefined } });
    await expect(mismatchedDimensions.probe(new AbortController().signal)).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CAPABILITY" });

    const duplicateTransport = { request: vi.fn(async () => response({ data: [modelMetadata, { ...modelMetadata, max_input_tokens: 9999 }] })) };
    const duplicateModel = new OpenAiCompatibleAdapter({ provider, profile, transport: duplicateTransport, capabilityRepository: { save: async () => undefined } });
    await expect(duplicateModel.probe(new AbortController().signal)).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CAPABILITY" });
    expect(duplicateTransport.request).toHaveBeenCalledTimes(1);
  });

  it("marks accounting estimated when usage is absent or corrected by local floors", async () => {
    const withoutUsage = { request: vi.fn()
      .mockResolvedValueOnce(response(standardChatResponse("{}")))
      .mockResolvedValueOnce(response(standardEmbeddingResponse([[1, 2, 3]]))), };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport: withoutUsage, capabilityRepository: { save: async () => undefined } });
    await expect(adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal))
      .resolves.toMatchObject({ accounting: { estimated: true } });
    await expect(adapter.embed({ inputs: ["x"], dimensions: 3 }, new AbortController().signal))
      .resolves.toMatchObject({ accounting: { estimated: true } });

    const underReported = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response(standardChatResponse("{}", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })) }, capabilityRepository: { save: async () => undefined } });
    await expect(underReported.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal))
      .resolves.toMatchObject({ accounting: { estimated: true } });

    const withUsage = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response(standardChatResponse("{}", { prompt_tokens: 1_000, completion_tokens: 1_000, total_tokens: 2_000 })) }, capabilityRepository: { save: async () => undefined } });
    await expect(withUsage.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal))
      .resolves.toMatchObject({ accounting: { estimated: false } });
  });

  it("accounts each retry against rate limits, keeps the operation ID stable, and emits sanitized accounting", async () => {
    const release = vi.fn();
    const limiter = { acquire: vi.fn(async () => release) };
    const accounting: unknown[] = [];
    const transport = { request: vi.fn()
      .mockResolvedValueOnce(response({ error: "busy" }, 503, { "content-type": "application/json" }))
      .mockResolvedValueOnce(response(standardChatResponse("{}", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }))), };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: { save: async () => undefined }, operationId: () => "stable-operation", sleep: async () => undefined, limiter, accountingSink: async (event) => { accounting.push(event); } });

    await adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal);
    expect(transport.request.mock.calls.map(([input]) => input.operationId)).toEqual(["stable-operation", "stable-operation"]);
    expect(limiter.acquire).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(accounting).toEqual([expect.objectContaining({ operationId: "stable-operation", profileId: profile.id, model: profile.model, estimated: true, costMicros: expect.any(String) })]);
    expect((accounting[0] as { inputTokens: number }).inputTokens).toBeGreaterThan(1);
    expect((accounting[0] as { outputTokens: number }).outputTokens).toBeGreaterThan(1);
    expect(JSON.stringify(accounting)).not.toMatch(/question|credential|response|authorization/i);
  });

  it("keeps prescribed backoff when Retry-After is within the original deadline", async () => {
    const sleep = vi.fn(async () => undefined);
    const transport = { request: vi.fn()
      .mockResolvedValueOnce(response({ error: "busy" }, 429, { "content-type": "application/json", "retry-after": "1" }))
      .mockResolvedValueOnce(response(standardChatResponse("{}", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }))), };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile: { ...profile, timeouts: { connectMs: 100, totalMs: 2_000 } }, transport, capabilityRepository: { save: async () => undefined }, operationId: () => "operation", sleep });
    await adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("uses one deadline signal across queueing and every retry attempt", async () => {
    const seenSignals: AbortSignal[] = [];
    const seenDeadlines: number[] = [];
    const transport = { request: vi.fn(async (input) => {
      seenSignals.push(input.signal);
      seenDeadlines.push(input.deadline);
      if (seenSignals.length === 1) return response({ error: "busy" }, 503);
      return response(standardChatResponse("{}", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
    }) };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: { save: async () => undefined }, sleep: async () => undefined });
    await adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal);

    expect(seenSignals).toHaveLength(2);
    expect(seenSignals[0]).toBe(seenSignals[1]);
    expect(seenDeadlines[0]).toBe(seenDeadlines[1]);
  });

  it("applies the total deadline while queued for a rate permit", async () => {
    const limiter = { acquire: vi.fn(async (_tokens: number, signal: AbortSignal) => new Promise<() => void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile: { ...profile, timeouts: { connectMs: 100, totalMs: 100 } }, transport: { request: vi.fn() }, capabilityRepository: { save: async () => undefined }, limiter });
    const error = await adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "OCC-AI-PROVIDER-TIMEOUT" });
  });

  it("rejects inconsistent provider usage rather than under-accounting", async () => {
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response(standardChatResponse("{}", { prompt_tokens: 4, completion_tokens: 3, total_tokens: 6 })) }, capabilityRepository: { save: async () => undefined }, operationId: () => "operation" });
    await expect(adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-MALFORMED" });
  });

  it("sanitizes accounting and capability repository failures", async () => {
    const chatTransport = { request: async () => response(standardChatResponse("{}", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })) };
    const accountingAdapter = new OpenAiCompatibleAdapter({ provider, profile, transport: chatTransport, capabilityRepository: { save: async () => undefined }, accountingSink: async () => { throw new Error("raw accounting secret"); } });
    const accountingError = await accountingAdapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal).catch((caught: unknown) => caught);
    expect(accountingError).toMatchObject({ code: "OCC-AI-PROVIDER-ACCOUNTING" });
    expect(JSON.stringify(accountingError)).not.toContain("raw accounting secret");

    const probeTransport = { request: vi.fn()
      .mockResolvedValueOnce(response({ data: [modelMetadata] }))
      .mockResolvedValueOnce(response(standardChatResponse("{\"probe\":true}", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })))
      .mockResolvedValueOnce(response(standardEmbeddingResponse([[1, 2, 3]], { prompt_tokens: 1, total_tokens: 1 }))), };
    const capabilityAdapter = new OpenAiCompatibleAdapter({ provider, profile, transport: probeTransport, capabilityRepository: { save: async () => { throw new Error("raw repository secret"); } } });
    const capabilityError = await capabilityAdapter.probe(new AbortController().signal).catch((caught: unknown) => caught);
    expect(capabilityError).toMatchObject({ code: "OCC-AI-PROVIDER-CAPABILITY" });
    expect(JSON.stringify(capabilityError)).not.toContain("raw repository secret");
  });

  it("fails closed when required accounting persistence hangs after provider success", async () => {
    let sinkSignal: AbortSignal | undefined;
    let sinkStarted!: () => void;
    const started = new Promise<void>((resolve) => { sinkStarted = resolve; });
    const controller = new AbortController();
    const adapter = new OpenAiCompatibleAdapter({
      provider, profile, transport: { request: async () => response(standardChatResponse("{}")) }, capabilityRepository: { save: async () => undefined },
      accountingSink: async (_event, signal) => { sinkSignal = signal; sinkStarted(); return new Promise(() => undefined); },
    });
    const pending = adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, controller.signal);

    await started;
    controller.abort(new Error("cancel accounting"));
    await expect(Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve("hung"), 100))]))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CANCELLED" });
    expect(sinkSignal?.aborted).toBe(true);
  });

  it("fails closed when required capability persistence exceeds the original deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let repositorySignal: AbortSignal | undefined;
      let saveStarted!: () => void;
      const started = new Promise<void>((resolve) => { saveStarted = resolve; });
      const shortProfile = { ...profile, timeouts: { connectMs: 100, totalMs: 1_000 } };
      const transport = { request: vi.fn()
        .mockResolvedValueOnce(response(standardModelsResponse))
        .mockResolvedValueOnce(response(standardChatResponse("{\"probe\":true}")))
        .mockResolvedValueOnce(response(standardEmbeddingResponse([[1, 2, 3]]))), };
      const adapter = new OpenAiCompatibleAdapter({
        provider, profile: shortProfile, transport,
        capabilityRepository: { save: async (_providerId, _model, _snapshot, signal) => { repositorySignal = signal; saveStarted(); return new Promise(() => undefined); } },
      });
      const pending = adapter.probe(new AbortController().signal);

      await started;
      expect(vi.getTimerCount()).toBe(1);
      const rejection = expect(pending).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-TIMEOUT" });
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(repositorySignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
