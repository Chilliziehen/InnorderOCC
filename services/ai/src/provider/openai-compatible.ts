import { createHash, randomUUID } from "node:crypto";

import type { CapabilitySnapshot, ProviderConfig, ProviderProfile } from "@innorder/contracts";
import Ajv2020, { type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import { z } from "zod";

import { calculateAccounting, type AccountingResult } from "./accounting.js";
import { ProviderError } from "./provider-policy.js";
import { ProfileRateLimiter } from "./rate-limiter.js";
import { createOperationDeadline, executeWithRetry, type OperationDeadline } from "./retry-policy.js";
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
  accountingSink?: (event: InvocationAccounting) => void | Promise<void>;
}>;

const chatUsageSchema = z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative().optional() }).strict()
  .refine(({ prompt_tokens, completion_tokens, total_tokens }) => total_tokens === undefined || total_tokens === prompt_tokens + completion_tokens);
const embeddingUsageSchema = z.object({ prompt_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() }).strict()
  .refine(({ prompt_tokens, total_tokens }) => total_tokens === prompt_tokens);
const modelMetadataSchema = z.object({
  id: z.string().min(1).max(256),
  capabilities: z.object({ chat: z.boolean(), embeddings: z.boolean(), structured_output: z.boolean() }).strict(),
  max_input_tokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  max_output_tokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  embedding_dimensions: z.number().int().min(1).max(1_000_000),
}).strict();
const modelsSchema = z.object({ data: z.array(modelMetadataSchema).min(1).max(10_000) }).strict();
const chatSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().min(1).max(1_048_576) }).strict() }).strict()).length(1), usage: chatUsageSchema.optional() }).strict();
const embeddingItemSchema = z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()).min(1).max(1_000_000) }).strict();
const embeddingSchema = z.object({ data: z.array(embeddingItemSchema).min(1).max(1024), usage: embeddingUsageSchema.optional() }).strict();

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

  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.operationId = dependencies.operationId ?? randomUUID;
    this.limiter = dependencies.limiter ?? new ProfileRateLimiter(dependencies.profile.rateLimit, () => this.now().getTime());
  }

  async probe(signal: AbortSignal): Promise<CapabilitySnapshot> {
    return this.withOperation(signal, async (operation) => this.probeWithin(operation));
  }

  private async probeWithin(operation: AdapterOperation): Promise<CapabilitySnapshot> {
    const models = modelsSchema.safeParse(parseJson((await this.call("GET", "/models", undefined, operation)).body));
    const matches = models.success ? models.data.data.filter(({ id }) => id === this.dependencies.profile.model) : [];
    const metadata = matches.length === 1 ? matches[0] : undefined;
    const expectedDimensions = this.activeDimensions();
    if (metadata === undefined || !metadata.capabilities.chat || !metadata.capabilities.embeddings || !metadata.capabilities.structured_output || metadata.embedding_dimensions !== expectedDimensions) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    const chat = await this.chatWithin({ messages: [{ role: "user", content: "Return the probe object." }], schema: { type: "object", required: ["probe"], properties: { probe: { const: true } }, additionalProperties: false } }, operation);
    if (typeof chat.output !== "object" || chat.output === null || (chat.output as { probe?: unknown }).probe !== true) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    await this.embedWithin({ inputs: ["capability probe"], dimensions: expectedDimensions }, operation);
    const base = {
      chat: true, embeddings: true, structuredOutput: true, embeddingDimensions: expectedDimensions,
      maxInputTokens: metadata.max_input_tokens,
      maxOutputTokens: metadata.max_output_tokens,
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
    return this.withOperation(signal, async (operation) => this.chatWithin(input, operation));
  }

  private async chatWithin(input: ChatRequest, operation: AdapterOperation): Promise<ChatResult> {
    this.activeDimensions();
    if (!this.dependencies.profile.capabilitySnapshot.chat || !this.dependencies.profile.capabilitySnapshot.structuredOutput) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    if (input.messages.length < 1 || input.messages.length > 100 || input.messages.some(({ content }) => content.length < 1 || content.length > 1_000_000)) throw new ProviderError("OCC-AI-PROVIDER-LIMIT");
    const validateOutput = compileOutputSchema(input.schema);
    const body = Buffer.from(JSON.stringify({ model: this.dependencies.profile.model, messages: input.messages, response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema: input.schema } }, max_tokens: this.dependencies.profile.capabilitySnapshot.maxOutputTokens }));
    const startedAt = this.now().getTime();
    const response = await this.call("POST", "/chat/completions", body, operation);
    const parsed = chatSchema.safeParse(parseJson(response.body));
    if (!parsed.success) throw new ProviderError("OCC-AI-PROVIDER-MALFORMED");
    let output: unknown;
    try { output = JSON.parse(parsed.data.choices[0]!.message.content); } catch { throw new ProviderError("OCC-AI-PROVIDER-MALFORMED"); }
    if (output === null || typeof output !== "object" || Array.isArray(output) || !validateOutput(output)) throw new ProviderError("OCC-AI-PROVIDER-MALFORMED");
    const providerUsage = parsed.data.usage === undefined ? undefined : { inputTokens: parsed.data.usage.prompt_tokens, outputTokens: parsed.data.usage.completion_tokens };
    const accounting = calculateAccounting({ requestBytes: body.byteLength, responseBytes: response.body.byteLength, ...(providerUsage === undefined ? {} : { usage: providerUsage }), cost: this.dependencies.profile.cost });
    const usage = { inputTokens: accounting.inputTokens, outputTokens: accounting.outputTokens };
    await this.emitAccounting(operation.operationId, accounting, startedAt);
    return { output, usage, accounting };
  }

  async embed(input: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResult> {
    return this.withOperation(signal, async (operation) => this.embedWithin(input, operation));
  }

  private async embedWithin(input: EmbeddingRequest, operation: AdapterOperation): Promise<EmbeddingResult> {
    const activeDimensions = this.activeDimensions();
    if (!this.dependencies.profile.capabilitySnapshot.embeddings || input.dimensions !== activeDimensions) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    if (input.inputs.length < 1 || input.inputs.length > 1024 || !Number.isSafeInteger(input.dimensions) || input.dimensions < 1 || input.inputs.some((value) => value.length < 1 || value.length > 1_000_000)) throw new ProviderError("OCC-AI-PROVIDER-LIMIT");
    const body = Buffer.from(JSON.stringify({ model: this.dependencies.profile.model, input: input.inputs, dimensions: input.dimensions }));
    const startedAt = this.now().getTime();
    const response = await this.call("POST", "/embeddings", body, operation);
    const parsed = embeddingSchema.safeParse(parseJson(response.body));
    if (!parsed.success || parsed.data.data.length !== input.inputs.length || parsed.data.data.some((item, index) => item.index !== index || item.embedding.length !== input.dimensions || item.embedding.some((value) => !Number.isFinite(value)))) {
      throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    }
    const embeddings = [...parsed.data.data].sort((left, right) => left.index - right.index).map(({ embedding }) => embedding);
    const providerUsage = parsed.data.usage === undefined ? undefined : { inputTokens: parsed.data.usage.prompt_tokens, outputTokens: 0 };
    const accounting = calculateAccounting({ requestBytes: body.byteLength, responseBytes: response.body.byteLength, ...(providerUsage === undefined ? {} : { usage: providerUsage }), cost: this.dependencies.profile.cost });
    const usage = { inputTokens: accounting.inputTokens, outputTokens: accounting.outputTokens };
    await this.emitAccounting(operation.operationId, accounting, startedAt);
    return { embeddings, usage, accounting };
  }

  private async call(method: "GET" | "POST", suffix: string, body: Buffer | undefined, operation: AdapterOperation): Promise<ProviderTransportResponse> {
    return executeWithRetry({ operationId: operation.operationId, deadline: operation.deadline.expiresAt, now: () => this.now().getTime(), signal: operation.deadline.signal, ...(this.dependencies.sleep === undefined ? {} : { sleep: this.dependencies.sleep }) }, async ({ operationId: stableId }) => {
      const estimatedTokens = (body?.byteLength ?? 0) + (suffix === "/chat/completions" ? this.dependencies.profile.capabilitySnapshot.maxOutputTokens : 0);
      const release = await this.limiter.acquire(estimatedTokens, operation.deadline.signal);
      try {
        const remaining = Math.max(1, operation.deadline.expiresAt - this.now().getTime());
        const response = await this.dependencies.transport.request({
          operationId: stableId, profileId: this.dependencies.profile.id, model: this.dependencies.profile.model,
          path: `${this.dependencies.provider.apiPrefix}${suffix}`, method,
          connectMs: Math.min(this.dependencies.profile.timeouts.connectMs, remaining),
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

  private activeDimensions(): number {
    const snapshot = this.dependencies.profile.capabilitySnapshot;
    const required = this.dependencies.profile.requiredCapabilities.embeddingDimensions;
    if (!snapshot.embeddings || snapshot.embeddingDimensions === undefined || (required !== undefined && required !== snapshot.embeddingDimensions)) throw new ProviderError("OCC-AI-PROVIDER-CAPABILITY");
    return snapshot.embeddingDimensions;
  }

  private async withOperation<T>(signal: AbortSignal, action: (operation: AdapterOperation) => Promise<T>): Promise<T> {
    const deadline = createOperationDeadline(this.dependencies.profile.timeouts.totalMs, signal, () => this.now().getTime());
    try {
      return await action({ operationId: this.operationId(), deadline });
    } finally {
      deadline.dispose();
    }
  }
}
