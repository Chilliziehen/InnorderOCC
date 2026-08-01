import { createHash } from "node:crypto";

import type { CapabilitySnapshot, ProviderConfig, ProviderProfile } from "@innorder/contracts";
import { describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleAdapter, type CapabilityRepository } from "../src/provider/openai-compatible.js";
import { ProviderError, type ResolvedProviderTarget } from "../src/provider/provider-policy.js";
import { SecureTransport, type RawRequestFactory, type TransportTelemetry } from "../src/provider/secure-transport.js";

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

function target(): ResolvedProviderTarget {
  return { url: new URL("https://provider.example:8443/v1/chat/completions"), address: "93.184.216.34", family: 4, servername: "provider.example", hostHeader: "provider.example:8443" };
}

describe("secure provider transport", () => {
  it("pins lookup while preserving TLS servername and Host and adds credentials only after policy validation", async () => {
    const events: TransportTelemetry[] = [];
    const requestFactory: RawRequestFactory = vi.fn(async (request) => {
      expect(request.address).toBe("93.184.216.34");
      expect(request.servername).toBe("provider.example");
      expect(request.headers.host).toBe("provider.example:8443");
      expect(request.headers.authorization).toBe("Bearer credential");
      return { status: 200, headers: { "content-type": "application/json", "x-request-id": "provider-secret-id", authorization: "never" }, body: Buffer.from("{\"ok\":true}") };
    });
    const transport = new SecureTransport({
      policy: { resolve: vi.fn(async () => target()) }, requestFactory,
      credentialReader: vi.fn(async () => Buffer.from("credential")), telemetry: (event) => events.push(event), now: () => 10,
    });
    const response = await transport.request({ operationId: "op", profileId: profile.id, model: profile.model, path: "/v1/chat/completions", method: "POST", body: Buffer.from("{}"), connectMs: 100, totalMs: 1000, maxResponseBytes: 100, signal: new AbortController().signal });

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
});

function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }) {
  return { status, headers, body: Buffer.from(JSON.stringify(body)) };
}

describe("OpenAI-compatible adapter", () => {
  it("probes models, structured chat, and embeddings and persists one exact normalized snapshot", async () => {
    const transport = { request: vi.fn()
      .mockResolvedValueOnce(response({ data: [{ id: "model-1" }] }))
      .mockResolvedValueOnce(response({ choices: [{ message: { content: "{\"probe\":true}" } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }))
      .mockResolvedValueOnce(response({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 1, total_tokens: 1 } })), };
    const saved: CapabilitySnapshot[] = [];
    const repository: CapabilityRepository = { save: async (_providerId, _model, value) => { saved.push(value); } };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: repository, now: () => new Date("2026-08-01T00:00:00.000Z"), operationId: () => "operation" });

    const result = await adapter.probe(new AbortController().signal);
    expect(result).toMatchObject({ chat: true, embeddings: true, structuredOutput: true, embeddingDimensions: 3 });
    expect(result.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved).toEqual([result]);
  });

  it("returns strict chat JSON and exact finite embeddings", async () => {
    const transport = { request: vi.fn()
      .mockResolvedValueOnce(response({ choices: [{ message: { content: "{\"answer\":\"yes\"}" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }))
      .mockResolvedValueOnce(response({ data: [{ index: 0, embedding: [1, 2, 3] }, { index: 1, embedding: [4, 5, 6] }], usage: { prompt_tokens: 2, total_tokens: 2 } })), };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: { save: async () => undefined }, operationId: () => "operation" });
    await expect(adapter.chat({ messages: [{ role: "user", content: "question" }], schema: { type: "object" } }, new AbortController().signal))
      .resolves.toMatchObject({ output: { answer: "yes" }, usage: { inputTokens: 3, outputTokens: 2 } });
    await expect(adapter.embed({ inputs: ["one", "two"], dimensions: 3 }, new AbortController().signal))
      .resolves.toMatchObject({ embeddings: [[1, 2, 3], [4, 5, 6]] });
  });

  it.each([
    { body: { choices: [] }, code: "OCC-AI-PROVIDER-MALFORMED" },
    { body: { choices: [{ message: { content: "not json" } }] }, code: "OCC-AI-PROVIDER-MALFORMED" },
    { body: { choices: [{ message: { content: "{}" }, extra: true }] }, code: "OCC-AI-PROVIDER-MALFORMED" },
    { body: { choices: [{ message: { content: "{}" } }], unknown: true }, code: "OCC-AI-PROVIDER-MALFORMED" },
  ])("rejects malformed or unknown chat payloads", async ({ body, code }) => {
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response(body) }, capabilityRepository: { save: async () => undefined }, operationId: () => "operation" });
    await expect(adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal)).rejects.toMatchObject({ code });
  });

  it.each([
    { data: [{ index: 0, embedding: [1, 2] }] },
    { data: [{ index: 0, embedding: [1, Number.NaN, 3] }] },
    { data: [{ index: 1, embedding: [1, 2, 3] }] },
    { data: [{ index: 0, embedding: [1, 2, 3], extra: true }] },
  ])("rejects embedding count, index, shape, dimension, and finite-value mismatch", async (body) => {
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response(body) }, capabilityRepository: { save: async () => undefined }, operationId: () => "operation" });
    await expect(adapter.embed({ inputs: ["x"], dimensions: 3 }, new AbortController().signal)).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CAPABILITY" });
  });

  it("fails closed when the configured model or required dimensions do not match the probe", async () => {
    const missingModel = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response({ data: [{ id: "other" }] }) }, capabilityRepository: { save: async () => undefined }, operationId: () => "operation" });
    await expect(missingModel.probe(new AbortController().signal)).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CAPABILITY" });
  });

  it("accounts each retry against rate limits, keeps the operation ID stable, and emits sanitized accounting", async () => {
    const release = vi.fn();
    const limiter = { acquire: vi.fn(async () => release) };
    const accounting: unknown[] = [];
    const transport = { request: vi.fn()
      .mockResolvedValueOnce(response({ error: "busy" }, 503, { "content-type": "application/json" }))
      .mockResolvedValueOnce(response({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })), };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport, capabilityRepository: { save: async () => undefined }, operationId: () => "stable-operation", sleep: async () => undefined, limiter, accountingSink: async (event) => { accounting.push(event); } });

    await adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal);
    expect(transport.request.mock.calls.map(([input]) => input.operationId)).toEqual(["stable-operation", "stable-operation"]);
    expect(limiter.acquire).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(accounting).toEqual([expect.objectContaining({ operationId: "stable-operation", profileId: profile.id, model: profile.model, inputTokens: 1, outputTokens: 1, costMicros: expect.any(String) })]);
    expect(JSON.stringify(accounting)).not.toMatch(/question|credential|response|authorization/i);
  });

  it("honors a bounded Retry-After within the original deadline", async () => {
    const sleep = vi.fn(async () => undefined);
    const transport = { request: vi.fn()
      .mockResolvedValueOnce(response({ error: "busy" }, 429, { "content-type": "application/json", "retry-after": "1" }))
      .mockResolvedValueOnce(response({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })), };
    const adapter = new OpenAiCompatibleAdapter({ provider, profile: { ...profile, timeouts: { connectMs: 100, totalMs: 2_000 } }, transport, capabilityRepository: { save: async () => undefined }, operationId: () => "operation", sleep });
    await adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("rejects inconsistent provider usage rather than under-accounting", async () => {
    const adapter = new OpenAiCompatibleAdapter({ provider, profile, transport: { request: async () => response({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 6 } }) }, capabilityRepository: { save: async () => undefined }, operationId: () => "operation" });
    await expect(adapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-MALFORMED" });
  });

  it("sanitizes accounting and capability repository failures", async () => {
    const chatTransport = { request: async () => response({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    const accountingAdapter = new OpenAiCompatibleAdapter({ provider, profile, transport: chatTransport, capabilityRepository: { save: async () => undefined }, accountingSink: async () => { throw new Error("raw accounting secret"); } });
    const accountingError = await accountingAdapter.chat({ messages: [{ role: "user", content: "x" }], schema: { type: "object" } }, new AbortController().signal).catch((caught: unknown) => caught);
    expect(accountingError).toMatchObject({ code: "OCC-AI-PROVIDER-ACCOUNTING" });
    expect(JSON.stringify(accountingError)).not.toContain("raw accounting secret");

    const probeTransport = { request: vi.fn()
      .mockResolvedValueOnce(response({ data: [{ id: "model-1" }] }))
      .mockResolvedValueOnce(response({ choices: [{ message: { content: "{\"probe\":true}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
      .mockResolvedValueOnce(response({ data: [{ index: 0, embedding: [1, 2, 3] }], usage: { prompt_tokens: 1, total_tokens: 1 } })), };
    const capabilityAdapter = new OpenAiCompatibleAdapter({ provider, profile, transport: probeTransport, capabilityRepository: { save: async () => { throw new Error("raw repository secret"); } } });
    const capabilityError = await capabilityAdapter.probe(new AbortController().signal).catch((caught: unknown) => caught);
    expect(capabilityError).toMatchObject({ code: "OCC-AI-PROVIDER-CAPABILITY" });
    expect(JSON.stringify(capabilityError)).not.toContain("raw repository secret");
  });
});
