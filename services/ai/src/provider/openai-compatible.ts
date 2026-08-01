import { createHash, randomUUID } from "node:crypto";

import type { CapabilitySnapshot, ProviderConfig, ProviderProfile } from "@innorder/contracts";
import { z } from "zod";

import { calculateAccounting, type AccountingResult } from "./accounting.js";
import { ProviderError } from "./provider-policy.js";
import { ProfileRateLimiter } from "./rate-limiter.js";
import { executeWithRetry } from "./retry-policy.js";
import type { ProviderTransport, ProviderTransportResponse } from "./secure-transport.js";

export interface CapabilityRepository {
  save(providerId: string, model: string, snapshot: CapabilitySnapshot): Promise<void>;
}
export type ChatRequest = Readonly<{ messages: readonly Readonly<{ role: "system" | "user" | "assistant"; content: string }>[]; schema: Readonly<Record<string, unknown>> }>;
export type ChatResult = Readonly<{ output: unknown; usage: Readonly<{ inputTokens: number; outputTokens: number }>; accounting: AccountingResult }>;
export type EmbeddingRequest = Readonly<{ inputs: readonly string[]; dimensions: number }>;
export type EmbeddingResult = Readonly<{ embeddings: readonly (readonly number[])[]; usage: Readonly<{ inputTokens: number; outputTokens: number }>; accounting: AccountingResult }>;
export interface OpenAiCompatibleProvider {
  probe(signal: AbortSignal): Promise<CapabilitySnapshot>;
  chat(input: ChatRequest, signal: AbortSignal): Promise<ChatResult>;
  embed(input: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResult>;
}

export type InvocationAccounting = Readonly<{
  operationId: string;
  profileId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: string;
  currency: string;
  estimated: boolean;
  durationMs: number;
  status: "SUCCEEDED";
  code: "OK";
}>;

type Limiter = Readonly<{ acquire(tokens: number, signal: AbortSignal): Promise<() => void> }>;

type Dependencies = Readonly<{
  provider: ProviderConfig;
  profile: ProviderProfile;
  transport: ProviderTransport;
  capabilityRepository: CapabilityRepository;
  now?: () => Date;
  operationId?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  limiter?: Limiter;
  accountingSink?: (event: InvocationAccounting) => void | Promise<void>;
}>;

const chatUsageSchema = z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative().optional() }).strict()
  .refine(({ prompt_tokens, completion_tokens, total_tokens }) => total_tokens === undefined || total_tokens === prompt_tokens + completion_tokens);
const embeddingUsageSchema = z.object({ prompt_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() }).strict()
  .refine(({ prompt_tokens, total_tokens }) => total_tokens === prompt_tokens);
const modelsSchema = z.object({ data: z.array(z.object({ id: z.string().min(1).max(256) }).strict()).min(1).max(10_000) }).strict();
const chatSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().min(1).max(1_048_576) }).strict() }).strict()).length(1), usage: chatUsageSchema.optional() }).strict();
const embeddingItemSchema = z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()).min(1).max(1_000_000) }).strict();
const embeddingSchema = z.object({ data: z.array(embeddingItemSchema).min(1).max(1024), usage: embeddingUsageSchema.optional() }).strict();

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new ProviderError("OCC-AI-PROVIDER-MALFORMED");
  }
}

function retryAfter(response: ProviderTransportResponse): number | undefined {
  const value = response.headers["retry-after"];
  if (value === undefined) return undefined;
  const milliseconds = Number(value) * 1000;
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 30_000 ? milliseconds : undefined;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export class OpenAiCompatibleAdapter implements OpenAiCompatibleProvider {
  private readonly now: () => Date;
  private readonly operationId: () => string;
  private readonly limiter: Limiter;

  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.operationId = dependencies.operationId ?? randomUUID;
    this.limiter = dependencies.limiter ?? new ProfileRateLimiter(dependencies.profile.rateLimit, () => this.now().getTime());
  }

  async probe(signal: AbortSignal): Promise<CapabilitySnapshot> {
    const models = modelsSchema.safeParse(parseJson((await this.call("GET", "/models", undefined, signal, this.operationId())).body));
    if (!models.success || !models.data.data.some(({ id }) => id === this.dependencies.profile.model)) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    const chat = await this.chat({ messages: [{ role: "user", content: "Return the probe object." }], schema: { type: "object", required: ["probe"], properties: { probe: { const: true } }, additionalProperties: false } }, signal);
    if (typeof chat.output !== "object" || chat.output === null || (chat.output as { probe?: unknown }).probe !== true) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    const expectedDimensions = this.dependencies.profile.requiredCapabilities.embeddingDimensions ?? this.dependencies.profile.capabilitySnapshot.embeddingDimensions;
    if (expectedDimensions === undefined) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    await this.embed({ inputs: ["capability probe"], dimensions: expectedDimensions }, signal);
    const base = {
      chat: true, embeddings: true, structuredOutput: true, embeddingDimensions: expectedDimensions,
      maxInputTokens: this.dependencies.profile.capabilitySnapshot.maxInputTokens,
      maxOutputTokens: this.dependencies.profile.capabilitySnapshot.maxOutputTokens,
      probedAt: this.now().toISOString(),
    };
    const result: CapabilitySnapshot = { ...base, snapshotHash: createHash("sha256").update(canonical(base)).digest("hex") };
    try {
      await this.dependencies.capabilityRepository.save(this.dependencies.provider.id, this.dependencies.profile.model, result);
    } catch {
      throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    }
    return result;
  }

  async chat(input: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
    if (input.messages.length < 1 || input.messages.length > 100 || input.messages.some(({ content }) => content.length < 1 || content.length > 1_000_000)) throw new ProviderError("OCC-AI-PROVIDER-LIMIT");
    const body = Buffer.from(JSON.stringify({ model: this.dependencies.profile.model, messages: input.messages, response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema: input.schema } }, max_tokens: this.dependencies.profile.capabilitySnapshot.maxOutputTokens }));
    const operationId = this.operationId();
    const startedAt = this.now().getTime();
    const response = await this.call("POST", "/chat/completions", body, signal, operationId);
    const parsed = chatSchema.safeParse(parseJson(response.body));
    if (!parsed.success) throw new ProviderError("OCC-AI-PROVIDER-MALFORMED");
    let output: unknown;
    try { output = JSON.parse(parsed.data.choices[0]!.message.content); } catch { throw new ProviderError("OCC-AI-PROVIDER-MALFORMED"); }
    if (output === null || typeof output !== "object" || Array.isArray(output)) throw new ProviderError("OCC-AI-PROVIDER-MALFORMED");
    const usage = { inputTokens: parsed.data.usage?.prompt_tokens ?? Math.ceil(body.byteLength / 4), outputTokens: parsed.data.usage?.completion_tokens ?? Math.ceil(response.body.byteLength / 4) };
    const accounting = calculateAccounting({ requestBytes: body.byteLength, responseBytes: response.body.byteLength, usage, cost: this.dependencies.profile.cost });
    await this.emitAccounting(operationId, accounting, startedAt);
    return { output, usage, accounting };
  }

  async embed(input: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResult> {
    if (input.inputs.length < 1 || input.inputs.length > 1024 || !Number.isSafeInteger(input.dimensions) || input.dimensions < 1 || input.inputs.some((value) => value.length < 1 || value.length > 1_000_000)) throw new ProviderError("OCC-AI-PROVIDER-LIMIT");
    const body = Buffer.from(JSON.stringify({ model: this.dependencies.profile.model, input: input.inputs, dimensions: input.dimensions }));
    const operationId = this.operationId();
    const startedAt = this.now().getTime();
    const response = await this.call("POST", "/embeddings", body, signal, operationId);
    const parsed = embeddingSchema.safeParse(parseJson(response.body));
    if (!parsed.success || parsed.data.data.length !== input.inputs.length || parsed.data.data.some((item, index) => item.index !== index || item.embedding.length !== input.dimensions || item.embedding.some((value) => !Number.isFinite(value)))) {
      throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    }
    const embeddings = [...parsed.data.data].sort((left, right) => left.index - right.index).map(({ embedding }) => embedding);
    const inputTokens = parsed.data.usage?.prompt_tokens ?? Math.ceil(body.byteLength / 4);
    const usage = { inputTokens, outputTokens: 0 };
    const accounting = calculateAccounting({ requestBytes: body.byteLength, responseBytes: response.body.byteLength, usage, cost: this.dependencies.profile.cost });
    await this.emitAccounting(operationId, accounting, startedAt);
    return { embeddings, usage, accounting };
  }

  private async call(method: "GET" | "POST", suffix: string, body: Buffer | undefined, signal: AbortSignal, operationId: string): Promise<ProviderTransportResponse> {
    const started = this.now().getTime();
    const deadline = started + this.dependencies.profile.timeouts.totalMs;
    return executeWithRetry({ operationId, deadline, now: () => this.now().getTime(), signal, ...(this.dependencies.sleep === undefined ? {} : { sleep: this.dependencies.sleep }) }, async ({ operationId: stableId }) => {
      const estimatedTokens = (body?.byteLength ?? 0) + (suffix === "/chat/completions" ? this.dependencies.profile.capabilitySnapshot.maxOutputTokens : 0);
      const release = await this.limiter.acquire(estimatedTokens, signal);
      try {
        const response = await this.dependencies.transport.request({
          operationId: stableId, profileId: this.dependencies.profile.id, model: this.dependencies.profile.model,
          path: `${this.dependencies.provider.apiPrefix}${suffix}`, method,
          connectMs: Math.min(this.dependencies.profile.timeouts.connectMs, Math.max(1, deadline - this.now().getTime())),
          totalMs: Math.max(1, deadline - this.now().getTime()), maxResponseBytes: 2 * 1024 * 1024, signal,
          ...(body === undefined ? {} : { body }),
        });
        if (response.status >= 200 && response.status < 300) return response;
        if (response.status === 429 || response.status === 502 || response.status === 503) {
          const delay = retryAfter(response);
          throw new ProviderError("OCC-AI-PROVIDER-TRANSIENT", true, delay === undefined ? undefined : { retryAfterMs: delay });
        }
        throw new ProviderError("OCC-AI-PROVIDER-STATUS");
      } finally {
        release();
      }
    });
  }

  private async emitAccounting(operationId: string, accounting: AccountingResult, startedAt: number): Promise<void> {
    try {
      await this.dependencies.accountingSink?.({
        operationId, profileId: this.dependencies.profile.id, model: this.dependencies.profile.model,
        inputTokens: accounting.inputTokens, outputTokens: accounting.outputTokens,
        costMicros: accounting.costMicros.toString(), currency: accounting.currency, estimated: accounting.estimated,
        durationMs: Math.max(0, this.now().getTime() - startedAt), status: "SUCCEEDED", code: "OK",
      });
    } catch {
      throw new ProviderError("OCC-AI-PROVIDER-ACCOUNTING");
    }
  }
}
