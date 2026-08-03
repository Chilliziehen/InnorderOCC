import { createHash } from "node:crypto";

import { DATA_CLASSIFICATION_ORDER, type DataClassification } from "@innorder/contracts";

import { validateRecommendationSubmission } from "../core/core-client.js";

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COST = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const ENVELOPE_KEYS = ["artifact", "classification", "cost", "envelopeHash", "inputTokens", "invocationId", "latencyMs", "operationId", "outputTokens", "payload", "providerRequestIdHash", "responseHash", "runId", "version"];
const ARTIFACT_KEYS = ["hash", "id", "objectKey"];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");

export type GuidanceRecoveryEnvelope = Readonly<{
  version: 1; runId: string; operationId: string; invocationId: string;
  payload: Readonly<Record<string, unknown>>; responseHash: string; providerRequestIdHash: string | null;
  inputTokens: number; outputTokens: number; cost: string; latencyMs: number; classification: DataClassification;
  artifact: Readonly<{ id: string; objectKey: string; hash: string }>;
  envelopeHash: string;
}>;

export type GuidanceRecoveryInput = Omit<GuidanceRecoveryEnvelope, "version" | "envelopeHash">;

function validate(value: unknown, runId: string, operationId: string): GuidanceRecoveryEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !exactKeys(value as Record<string, unknown>, ENVELOPE_KEYS)) throw new Error("OCC-AI-RECOVERY-INVALID");
  const envelope = value as unknown as GuidanceRecoveryEnvelope;
  const artifact = envelope.artifact;
  if (envelope.version !== 1 || envelope.runId !== runId || envelope.operationId !== operationId || runId !== operationId ||
    !UUID.test(envelope.runId) || !UUID.test(envelope.invocationId) || !HASH.test(envelope.responseHash) ||
    (envelope.providerRequestIdHash !== null && !HASH.test(envelope.providerRequestIdHash)) ||
    !Number.isSafeInteger(envelope.inputTokens) || envelope.inputTokens < 0 || !Number.isSafeInteger(envelope.outputTokens) || envelope.outputTokens < 0 ||
    !Number.isSafeInteger(envelope.latencyMs) || envelope.latencyMs < 0 || typeof envelope.cost !== "string" || !COST.test(envelope.cost) ||
    !DATA_CLASSIFICATION_ORDER.includes(envelope.classification) || artifact === null || typeof artifact !== "object" || Array.isArray(artifact) ||
    !exactKeys(artifact as unknown as Record<string, unknown>, ARTIFACT_KEYS) || !UUID.test(artifact.id) || !HASH.test(artifact.hash) ||
    artifact.objectKey !== `trace/${runId}/${artifact.id}.json` || !HASH.test(envelope.envelopeHash)) throw new Error("OCC-AI-RECOVERY-INVALID");
  try {
    const payload = validateRecommendationSubmission(envelope.payload);
    if (payload.runId !== runId || payload.operationId !== operationId) throw new Error();
  } catch { throw new Error("OCC-AI-RECOVERY-INVALID"); }
  const { envelopeHash: _retainedHash, ...body } = envelope;
  if (digest(canonical(body)) !== envelope.envelopeHash) throw new Error("OCC-AI-RECOVERY-INVALID");
  return envelope;
}

export function createGuidanceRecoveryEnvelope(input: GuidanceRecoveryInput): Readonly<{
  objectKey: string; bytes: Buffer; hash: string; value: GuidanceRecoveryEnvelope;
}> {
  const body = { version: 1 as const, ...input };
  const value = validate({ ...body, envelopeHash: digest(canonical(body)) }, input.runId, input.operationId);
  const bytes = Buffer.from(canonical(value), "utf8");
  return { objectKey: `recovery/${input.runId}/${input.operationId}.json`, bytes, hash: digest(bytes), value };
}

export function parseGuidanceRecoveryEnvelope(bytes: Uint8Array, runId: string, operationId: string): GuidanceRecoveryEnvelope {
  if (bytes.length < 2 || bytes.length > 1024 * 1024) throw new Error("OCC-AI-RECOVERY-INVALID");
  try {
    const value = validate(JSON.parse(Buffer.from(bytes).toString("utf8")), runId, operationId);
    if (canonical(value) !== Buffer.from(bytes).toString("utf8")) throw new Error();
    return value;
  } catch { throw new Error("OCC-AI-RECOVERY-INVALID"); }
}
