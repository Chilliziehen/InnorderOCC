import { createHash, randomUUID } from "node:crypto";

import { providerConfigSchema, providerProfileSchema, type CapabilitySnapshot, type ProviderConfig, type ProviderProfile } from "@innorder/contracts";
import Ajv2020, { type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import { z } from "zod";

import { calculateAccounting, type AccountingResult } from "./accounting.js";
import { ProviderError } from "./provider-policy.js";
import { ProfileRateLimiter } from "./rate-limiter.js";
import { createOperationDeadline, executeWithRetry, raceWithSignal, type OperationDeadline } from "./retry-policy.js";
import type { ProviderTransport, ProviderTransportResponse } from "./secure-transport.js";

export interface CapabilityRepository {
  save(providerId: string, model: string, snapshot: CapabilitySnapshot, signal: AbortSignal): Promise<void>;
}
const chatMessageSchema = z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().min(1).max(1_000_000) }).strict();
const outputSchemaInputSchema = z.record(z.string().min(1).max(128), z.unknown()).refine((value) => Object.keys(value).length <= 256);
export const chatRequestSchema = z.object({ messages: z.array(chatMessageSchema).min(1).max(100), schema: outputSchemaInputSchema }).strict();
export const embeddingRequestSchema = z.object({ inputs: z.array(z.string().min(1).max(1_000_000)).min(1).max(1024), dimensions: z.number().int().min(1).max(1_000_000) }).strict();
export type ChatRequest = Readonly<z.infer<typeof chatRequestSchema>>;
export type ChatResult = Readonly<{ output: unknown; usage: Readonly<{ inputTokens: number; outputTokens: number }>; accounting: AccountingResult }>;
export type EmbeddingRequest = Readonly<z.infer<typeof embeddingRequestSchema>>;
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
type AdapterOperation = Readonly<{ operationId: string; deadline: OperationDeadline }>;

type Dependencies = Readonly<{
  provider: ProviderConfig;
  profile: ProviderProfile;
  transport: ProviderTransport;
  capabilityRepository: CapabilityRepository;
  now?: () => Date;
  operationId?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  limiter?: Limiter;
  accountingSink?: (event: InvocationAccounting, signal: AbortSignal) => void | Promise<void>;
  maxRequestBytes?: number;
}>;

const tokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const promptTokenDetailsSchema = z.object({ cached_tokens: tokenCountSchema.optional(), audio_tokens: tokenCountSchema.optional() }).strict();
const completionTokenDetailsSchema = z.object({
  reasoning_tokens: tokenCountSchema.optional(), audio_tokens: tokenCountSchema.optional(),
  accepted_prediction_tokens: tokenCountSchema.optional(), rejected_prediction_tokens: tokenCountSchema.optional(),
}).strict();
const chatUsageSchema = z.object({
  prompt_tokens: tokenCountSchema, completion_tokens: tokenCountSchema, total_tokens: tokenCountSchema.optional(),
  prompt_tokens_details: promptTokenDetailsSchema.optional(), completion_tokens_details: completionTokenDetailsSchema.optional(),
}).strict()
  .refine(({ prompt_tokens, completion_tokens, total_tokens }) => total_tokens === undefined || total_tokens === prompt_tokens + completion_tokens);
const embeddingUsageSchema = z.object({ prompt_tokens: tokenCountSchema, total_tokens: tokenCountSchema }).strict()
  .refine(({ prompt_tokens, total_tokens }) => total_tokens === prompt_tokens);
const modelMetadataSchema = z.object({
  id: z.string().min(1).max(256),
  object: z.literal("model").optional(),
  created: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  owned_by: z.string().min(1).max(256).optional(),
  capabilities: z.object({ chat: z.boolean().optional(), embeddings: z.boolean().optional(), structured_output: z.boolean().optional() }).strip().optional(),
  max_input_tokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  max_output_tokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  max_completion_tokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  context_length: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  embedding_dimensions: z.number().int().min(1).max(1_000_000).optional(),
}).strip();
const modelsSchema = z.object({ object: z.literal("list").optional(), data: z.array(modelMetadataSchema).min(1).max(10_000) }).strip();
const chatSchema = z.object({
  id: z.string().min(1).max(256), object: z.literal("chat.completion"), created: tokenCountSchema, model: z.string().min(1).max(256),
  choices: z.array(z.object({
    index: tokenCountSchema,
    finish_reason: z.literal("stop"),
    logprobs: z.null().optional(),
    message: z.object({
      role: z.literal("assistant"), content: z.string().min(1).max(1_048_576),
      refusal: z.string().max(1_048_576).nullable().optional(),
    }).strict(),
  }).strict()).length(1),
  service_tier: z.string().min(1).max(64).nullable().optional(),
  system_fingerprint: z.string().min(1).max(256).nullable().optional(),
  usage: chatUsageSchema.optional(),
}).strict();
const embeddingItemSchema = z.object({ object: z.literal("embedding"), index: tokenCountSchema, embedding: z.array(z.number()).min(1).max(1_000_000) }).strict();
const embeddingSchema = z.object({ object: z.literal("list"), model: z.string().min(1).max(256), data: z.array(embeddingItemSchema).min(1).max(1024), usage: embeddingUsageSchema.optional() }).strict();

const SAFE_SCHEMA_KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems",
  "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "multipleOf", "enum", "const", "description", "anyOf", "oneOf", "allOf", "not",
]);

function assertSafeSchema(schema: unknown, depth = 0): asserts schema is AnySchema {
  if (depth > 20 || schema === null || typeof schema !== "object" || Array.isArray(schema)) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
  const entries = Object.entries(schema);
  if (entries.length > 256 || entries.some(([key]) => !SAFE_SCHEMA_KEYWORDS.has(key))) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
  for (const [key, value] of entries) {
    if (key === "properties") {
      if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 256) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
      for (const child of Object.values(value)) assertSafeSchema(child, depth + 1);
    } else if (key === "items" || key === "not" || (key === "additionalProperties" && typeof value !== "boolean")) {
      assertSafeSchema(value, depth + 1);
    } else if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
      value.forEach((child) => assertSafeSchema(child, depth + 1));
    }
  }
}

function compileOutputSchema(schema: Readonly<Record<string, unknown>>): ValidateFunction {
  let serialized: string;
  try { serialized = JSON.stringify(schema); } catch { throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY"); }
  if (Buffer.byteLength(serialized) > 65_536) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
  assertSafeSchema(schema);
  try {
    return new Ajv2020({ strict: true, allErrors: false, coerceTypes: false, removeAdditional: false, useDefaults: false, validateFormats: false }).compile(schema);
  } catch {
    throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
  }
}

class InputBudget {
  private bytes = 0;
  private readonly ancestors = new WeakSet<object>();

  constructor(private readonly maxBytes: number, private readonly maxTokens: number) {}

  addJson(value: unknown, depth = 0): void {
    if (this.bytes > this.maxBytes || this.bytes > this.maxTokens) throw new ProviderError("OCC-AI-PROVIDER-LIMIT");
    if (value === null) return this.add(4);
    if (typeof value === "string") return this.addString(value);
    if (typeof value === "boolean") return this.add(value ? 4 : 5);
    if (typeof value === "number" && Number.isFinite(value)) return this.add(32);
    if (typeof value !== "object" || depth > 20) throw new ProviderError("OCC-AI-PROVIDER-INPUT");
    if (this.ancestors.has(value)) throw new ProviderError("OCC-AI-PROVIDER-INPUT");
    this.ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        this.add(2 + Math.max(0, value.length - 1));
        for (const item of value) this.addJson(item, depth + 1);
        return;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new ProviderError("OCC-AI-PROVIDER-INPUT");
      this.add(1);
      let first = true;
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (!first) this.add(1);
        first = false;
        this.addString(key);
        this.add(1);
        this.addJson((value as Record<string, unknown>)[key], depth + 1);
      }
      this.add(1);
    } finally {
      this.ancestors.delete(value);
    }
  }

  private addString(value: string): void {
    this.add(2);
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 0x1f || (code >= 0xd800 && code <= 0xdfff && !(code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff))) {
        this.add(6);
      } else if (code === 0x22 || code === 0x5c) {
        this.add(2);
      } else if (code <= 0x7f) {
        this.add(1);
      } else if (code <= 0x7ff) {
        this.add(2);
      } else if (code <= 0xdbff) {
        this.add(4);
        index += 1;
      } else {
        this.add(3);
      }
    }
  }

  private add(count: number): void {
    this.bytes += count;
    if (this.bytes > this.maxBytes || this.bytes > this.maxTokens) throw new ProviderError("OCC-AI-PROVIDER-LIMIT");
  }
}

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
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
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
  private readonly provider: ProviderConfig;
  private readonly profile: ProviderProfile;
  private readonly maxRequestBytes: number;

  constructor(private readonly dependencies: Dependencies) {
    const provider = providerConfigSchema.safeParse(dependencies.provider);
    const profile = providerProfileSchema.safeParse(dependencies.profile);
    const maxRequestBytes = z.number().int().min(1).max(16 * 1024 * 1024).safeParse(dependencies.maxRequestBytes ?? 1024 * 1024);
    if (!provider.success || !profile.success || !maxRequestBytes.success || profile.data.providerId !== provider.data.id) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    this.provider = provider.data;
    this.profile = profile.data;
    this.maxRequestBytes = maxRequestBytes.data;
    this.now = dependencies.now ?? (() => new Date());
    this.operationId = dependencies.operationId ?? randomUUID;
    this.limiter = dependencies.limiter ?? new ProfileRateLimiter(this.profile.rateLimit, () => this.now().getTime());
  }

  async probe(signal: AbortSignal): Promise<CapabilitySnapshot> {
    return this.withOperation(signal, async (operation) => this.probeWithin(operation));
  }

  private async probeWithin(operation: AdapterOperation): Promise<CapabilitySnapshot> {
    const models = modelsSchema.safeParse(parseJson((await this.call("GET", "/models", undefined, operation)).body));
    const matches = models.success ? models.data.data.filter(({ id }) => id === this.profile.model) : [];
    const metadata = matches.length === 1 ? matches[0] : undefined;
    const expectedDimensions = this.activeDimensions();
    const localInputLimit = this.profile.capabilitySnapshot.maxInputTokens;
    const localOutputLimit = this.profile.capabilitySnapshot.maxOutputTokens;
    if (
      metadata === undefined ||
      metadata.capabilities?.chat === false || metadata.capabilities?.embeddings === false || metadata.capabilities?.structured_output === false ||
      (metadata.embedding_dimensions !== undefined && metadata.embedding_dimensions !== expectedDimensions) ||
      (metadata.max_input_tokens !== undefined && metadata.max_input_tokens < localInputLimit) ||
      (metadata.max_output_tokens !== undefined && metadata.max_output_tokens < localOutputLimit) ||
      (metadata.max_completion_tokens !== undefined && metadata.max_completion_tokens < localOutputLimit) ||
      (metadata.context_length !== undefined && metadata.context_length < localInputLimit + localOutputLimit)
    ) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    const chat = await this.chatWithin({ messages: [{ role: "user", content: "Return the probe object." }], schema: { type: "object", required: ["probe"], properties: { probe: { const: true } }, additionalProperties: false } }, operation);
    if (typeof chat.output !== "object" || chat.output === null || (chat.output as { probe?: unknown }).probe !== true) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    await this.embedWithin({ inputs: ["capability probe"], dimensions: expectedDimensions }, operation);
    const base = {
      chat: true, embeddings: true, structuredOutput: true, embeddingDimensions: expectedDimensions,
      maxInputTokens: localInputLimit,
      maxOutputTokens: localOutputLimit,
      probedAt: this.now().toISOString(),
    };
    const result: CapabilitySnapshot = { ...base, snapshotHash: createHash("sha256").update(canonical(base)).digest("hex") };
    try {
      await raceWithSignal((signal) => this.dependencies.capabilityRepository.save(this.provider.id, this.profile.model, result, signal), operation.deadline.signal);
    } catch (error) {
      throw error instanceof ProviderError ? error : new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    }
    return result;
  }

  async chat(input: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
    const parsed = chatRequestSchema.safeParse(input);
    if (!parsed.success) throw new ProviderError("OCC-AI-PROVIDER-INPUT");
    return this.withOperation(signal, async (operation) => this.chatWithin(parsed.data, operation));
  }

  private async chatWithin(input: ChatRequest, operation: AdapterOperation): Promise<ChatResult> {
    if (!this.profile.capabilitySnapshot.chat || !this.profile.capabilitySnapshot.structuredOutput) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    const request = { model: this.profile.model, messages: input.messages, response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema: input.schema } }, max_tokens: this.profile.capabilitySnapshot.maxOutputTokens };
    new InputBudget(this.maxRequestBytes, this.profile.capabilitySnapshot.maxInputTokens).addJson(request);
    const validateOutput = compileOutputSchema(input.schema);
    const body = Buffer.from(JSON.stringify(request));
    const startedAt = this.now().getTime();
    const response = await this.call("POST", "/chat/completions", body, operation);
    const parsed = chatSchema.safeParse(parseJson(response.body));
    if (!parsed.success || parsed.data.model !== this.profile.model || parsed.data.choices[0]!.index !== 0 || (parsed.data.choices[0]!.message.refusal !== undefined && parsed.data.choices[0]!.message.refusal !== null)) throw new ProviderError("OCC-AI-PROVIDER-MALFORMED");
    let output: unknown;
    try { output = JSON.parse(parsed.data.choices[0]!.message.content); } catch { throw new ProviderError("OCC-AI-PROVIDER-MALFORMED"); }
    if (output === null || typeof output !== "object" || Array.isArray(output) || !validateOutput(output)) throw new ProviderError("OCC-AI-PROVIDER-MALFORMED");
    const providerUsage = parsed.data.usage === undefined ? undefined : { inputTokens: parsed.data.usage.prompt_tokens, outputTokens: parsed.data.usage.completion_tokens };
    const accounting = calculateAccounting({ requestBytes: body.byteLength, responseBytes: response.body.byteLength, ...(providerUsage === undefined ? {} : { usage: providerUsage }), cost: this.profile.cost });
    const usage = { inputTokens: accounting.inputTokens, outputTokens: accounting.outputTokens };
    await this.emitAccounting(operation, accounting, startedAt);
    return { output, usage, accounting };
  }

  async embed(input: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResult> {
    const parsed = embeddingRequestSchema.safeParse(input);
    if (!parsed.success) throw new ProviderError("OCC-AI-PROVIDER-INPUT");
    return this.withOperation(signal, async (operation) => this.embedWithin(parsed.data, operation));
  }

  private async embedWithin(input: EmbeddingRequest, operation: AdapterOperation): Promise<EmbeddingResult> {
    const activeDimensions = this.activeDimensions();
    if (!this.profile.capabilitySnapshot.embeddings || input.dimensions !== activeDimensions) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    const request = { model: this.profile.model, input: input.inputs, dimensions: input.dimensions };
    new InputBudget(this.maxRequestBytes, this.profile.capabilitySnapshot.maxInputTokens).addJson(request);
    const body = Buffer.from(JSON.stringify(request));
    const startedAt = this.now().getTime();
    const response = await this.call("POST", "/embeddings", body, operation);
    const parsed = embeddingSchema.safeParse(parseJson(response.body));
    if (!parsed.success || parsed.data.model !== this.profile.model || parsed.data.data.length !== input.inputs.length || parsed.data.data.some((item, index) => item.index !== index || item.embedding.length !== input.dimensions || item.embedding.some((value) => !Number.isFinite(value)))) {
      throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    }
    const embeddings = [...parsed.data.data].sort((left, right) => left.index - right.index).map(({ embedding }) => embedding);
    const providerUsage = parsed.data.usage === undefined ? undefined : { inputTokens: parsed.data.usage.prompt_tokens, outputTokens: 0 };
    const accounting = calculateAccounting({ requestBytes: body.byteLength, responseBytes: response.body.byteLength, ...(providerUsage === undefined ? {} : { usage: providerUsage }), cost: this.profile.cost });
    const usage = { inputTokens: accounting.inputTokens, outputTokens: accounting.outputTokens };
    await this.emitAccounting(operation, accounting, startedAt);
    return { embeddings, usage, accounting };
  }

  private async call(method: "GET" | "POST", suffix: string, body: Buffer | undefined, operation: AdapterOperation): Promise<ProviderTransportResponse> {
    return executeWithRetry({ operationId: operation.operationId, deadline: operation.deadline.expiresAt, now: () => this.now().getTime(), signal: operation.deadline.signal, ...(this.dependencies.sleep === undefined ? {} : { sleep: this.dependencies.sleep }) }, async ({ operationId: stableId }) => {
      const estimatedTokens = (body?.byteLength ?? 0) + (suffix === "/chat/completions" ? this.profile.capabilitySnapshot.maxOutputTokens : 0);
      const release = await this.limiter.acquire(estimatedTokens, operation.deadline.signal);
      try {
        const remaining = Math.max(1, operation.deadline.expiresAt - this.now().getTime());
        const response = await this.dependencies.transport.request({
          operationId: stableId, profileId: this.profile.id, model: this.profile.model,
          path: `${this.provider.apiPrefix}${suffix}`, method,
          connectMs: Math.min(this.profile.timeouts.connectMs, remaining),
          deadline: operation.deadline.expiresAt, maxResponseBytes: 2 * 1024 * 1024, signal: operation.deadline.signal,
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

  private async emitAccounting(operation: AdapterOperation, accounting: AccountingResult, startedAt: number): Promise<void> {
    try {
      if (this.dependencies.accountingSink === undefined) return;
      const event: InvocationAccounting = {
        operationId: operation.operationId, profileId: this.profile.id, model: this.profile.model,
        inputTokens: accounting.inputTokens, outputTokens: accounting.outputTokens,
        costMicros: accounting.costMicros.toString(), currency: accounting.currency, estimated: accounting.estimated,
        durationMs: Math.max(0, this.now().getTime() - startedAt), status: "SUCCEEDED", code: "OK",
      };
      await raceWithSignal((signal) => Promise.resolve(this.dependencies.accountingSink!(event, signal)), operation.deadline.signal);
    } catch (error) {
      throw error instanceof ProviderError ? error : new ProviderError("OCC-AI-PROVIDER-ACCOUNTING");
    }
  }

  private activeDimensions(): number {
    const snapshot = this.profile.capabilitySnapshot;
    const required = this.profile.requiredCapabilities.embeddingDimensions;
    if (!snapshot.embeddings || snapshot.embeddingDimensions === undefined || (required !== undefined && required !== snapshot.embeddingDimensions)) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    return snapshot.embeddingDimensions;
  }

  private async withOperation<T>(signal: AbortSignal, action: (operation: AdapterOperation) => Promise<T>): Promise<T> {
    const deadline = createOperationDeadline(this.profile.timeouts.totalMs, signal, () => this.now().getTime());
    try {
      return await action({ operationId: this.operationId(), deadline });
    } finally {
      deadline.dispose();
    }
  }
}
