import { createHash, randomUUID } from "node:crypto";

import { capabilitySnapshotSchema, DATA_CLASSIFICATION_ORDER, type DataClassification } from "@innorder/contracts";

import type { CoreClient } from "../core/core-client.js";
import type { OpenAiCompatibleProvider } from "../provider/openai-compatible.js";
import type { HybridRetriever } from "../retrieval/hybrid-retriever.js";
import { buildGuidancePrompt } from "./prompt-builder.js";
import type { GuidanceConfiguration, PostgresGuidanceRepository, TerminalGuidanceResult } from "./guidance-repository.js";
import { validateGuidanceOutput } from "./output-validator.js";

const HASH = /^[a-f0-9]{64}$/u;
const STABLE = /^OCC-AI-[A-Z0-9-]{1,112}$/u;
const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function postgresJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(postgresJson).join(", ")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}: ${postgresJson(item)}`).join(", ")}}`;
  return JSON.stringify(value);
}

export type ConsumedGuidanceGrant = Readonly<{
  runId: string; operationId: string; operation: string; targetEntityId: string;
  agentVersionId: string; modelProfileId: string; promptVersionId: string; packageVersionId: string; embeddingSpaceId: string;
  policyReleaseDigest: string; authorizedSetDigest: string; classificationCeiling: DataClassification;
  authorizedDocumentVersionIds: readonly string[]; boundedContext: Readonly<Record<string, unknown>>; replayed: boolean;
}>;

type Repository = Pick<PostgresGuidanceRepository, "loadConfiguration" | "terminalResult" | "transition" | "startInvocation" | "finalizeInvocation" | "persistArtifact">;
type ArtifactStore = { upload(objectKey: string, bytes: Uint8Array, expectedHash: string, signal: AbortSignal): Promise<void> };
type Dependencies = Readonly<{
  repository: Repository;
  retriever: Pick<HybridRetriever, "retrieve">;
  provider: Pick<OpenAiCompatibleProvider, "chat">;
  artifactStore: ArtifactStore;
  core: Pick<CoreClient, "submitRecommendation">;
  grantConsumer?: { consume(token: string, signal?: AbortSignal): Promise<ConsumedGuidanceGrant> };
  invocationId?: () => string; artifactId?: () => string; now?: () => Date;
}>;

export type GuidanceRunResult = TerminalGuidanceResult;

export class GuidanceRunner {
  constructor(private readonly dependencies: Dependencies) {}

  async run(input: Readonly<{ operationId: string; grant: string | ConsumedGuidanceGrant }>, signal: AbortSignal): Promise<GuidanceRunResult> {
    if (signal.aborted) throw new Error("OCC-AI-CANCELLED");
    const grant = typeof input.grant === "string" ? await this.consume(input.grant, signal) : input.grant;
    if (grant.operationId !== input.operationId || grant.runId !== input.operationId || grant.operation !== "PARTICIPANT_GUIDANCE") throw new Error("OCC-AI-GRANT-MISMATCH");
    if (grant.replayed) {
      const terminal = await this.dependencies.repository.terminalResult(grant.runId, signal);
      if (terminal === undefined) throw new Error("OCC-AI-GRANT-REPLAY");
      return terminal;
    }
    const configuration = await this.dependencies.repository.loadConfiguration({
      runId: grant.runId, agentVersionId: grant.agentVersionId, modelProfileId: grant.modelProfileId,
      promptVersionId: grant.promptVersionId, packageVersionId: grant.packageVersionId,
      embeddingSpaceId: grant.embeddingSpaceId, policyReleaseDigest: grant.policyReleaseDigest,
    }, signal);
    this.validateConfiguration(grant, configuration);
    if (DATA_CLASSIFICATION_ORDER.indexOf(grant.classificationCeiling) > DATA_CLASSIFICATION_ORDER.indexOf(configuration.profile.maxClassification)) {
      throw new Error("OCC-AI-CLASSIFICATION-DENIED");
    }
    await this.dependencies.repository.transition({ runId: grant.runId, status: "RUNNING" }, signal);
    let invocationId: string | undefined;
    const started = (this.dependencies.now?.() ?? new Date()).getTime();
    try {
      const query = grant.boundedContext.query;
      if (typeof query !== "string" || Buffer.byteLength(query, "utf8") < 1 || Buffer.byteLength(query, "utf8") > 8192) throw new Error("OCC-AI-CONTEXT-INVALID");
      const retrieval = await this.dependencies.retriever.retrieve({
        runId: grant.runId, query, authorizedSetDigest: grant.authorizedSetDigest,
        authorizedDocumentCount: grant.authorizedDocumentVersionIds.length, classificationCeiling: grant.classificationCeiling,
        providerMaxClassification: configuration.profile.maxClassification,
        space: { id: configuration.embeddingSpaceId, dimensions: configuration.space.dimensions,
          manifestDigest: configuration.space.manifestDigest, embeddingProfileId: configuration.space.embeddingProfileId },
      }, signal);
      const prompt = buildGuidancePrompt({ template: configuration.prompt.template, templateHash: configuration.prompt.hash,
        taskContext: grant.boundedContext, hits: retrieval.hits, maxInputBytes: configuration.profile.maxInputBytes });
      invocationId = this.dependencies.invocationId?.() ?? randomUUID();
      await this.dependencies.repository.startInvocation({ id: invocationId, runId: grant.runId, profileId: grant.modelProfileId,
        operation: grant.operationId, requestHash: prompt.promptHash, capabilityHash: configuration.profile.capabilityHash }, signal);
      const response = await this.dependencies.provider.chat({ messages: prompt.messages, schema: prompt.schema }, signal);
      const responseHash = digest(canonical(response.output));
      await this.dependencies.repository.finalizeInvocation({ id: invocationId, status: "COMPLETED", responseHash,
        inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
        cost: response.accounting.costMicros.toString(), latencyMs: Math.max(0, (this.dependencies.now?.() ?? new Date()).getTime() - started), errorCode: null }, signal);
      invocationId = undefined;
      const validated = validateGuidanceOutput(response.output, { runId: grant.runId, traceId: retrieval.traceId, hits: retrieval.hits });
      const artifactId = this.dependencies.artifactId?.() ?? randomUUID();
      const artifact = {
        generatedContent: true, runId: grant.runId, traceId: retrieval.traceId, queryHash: retrieval.queryHash,
        configuration: { agentVersionId: grant.agentVersionId, modelProfileId: grant.modelProfileId, promptVersionId: grant.promptVersionId,
          packageVersionId: grant.packageVersionId, policyReleaseDigest: grant.policyReleaseDigest, embeddingSpaceId: grant.embeddingSpaceId,
          promptHash: prompt.promptHash, schemaHash: prompt.schemaHash, capabilityHash: configuration.profile.capabilityHash },
        validation: { status: "PASSED", citationCount: validated.citations.length }, output: validated,
      };
      const bytes = Buffer.from(canonical(artifact), "utf8");
      const artifactHash = digest(bytes);
      const objectKey = `trace/${grant.runId}/${artifactId}.json`;
      await this.dependencies.artifactStore.upload(objectKey, bytes, artifactHash, signal);
      await this.dependencies.repository.persistArtifact({ id: artifactId, runId: grant.runId, artifactKind: "TRACE", objectKey, hash: artifactHash, classification: grant.classificationCeiling }, signal);
      const expectedTargetVersion = grant.boundedContext.expectedTargetVersion;
      if (!Number.isSafeInteger(expectedTargetVersion) || (expectedTargetVersion as number) < 0) throw new Error("OCC-AI-CONTEXT-INVALID");
      const idempotencyKey = digest(`${grant.operationId}:${grant.runId}:recommendation`);
      const coreResult = await this.dependencies.core.submitRecommendation({ operationId: grant.operationId, runId: grant.runId,
        targetEntityId: grant.targetEntityId, expectedTargetVersion: expectedTargetVersion as number, output: validated }, idempotencyKey, signal);
      const recommendationId = this.recommendationId(coreResult);
      await this.dependencies.repository.transition({ runId: grant.runId, status: "COMPLETED", recommendationId }, signal);
      return { operationId: grant.operationId, runId: grant.runId, status: "SUCCEEDED", recommendationId };
    } catch (error) {
      const code = this.errorCode(error, signal);
      if (invocationId !== undefined) {
        await this.dependencies.repository.finalizeInvocation({ id: invocationId, status: code === "OCC-AI-CANCELLED" ? "CANCELLED" : "FAILED",
          responseHash: null, inputTokens: 0, outputTokens: 0, cost: "0", latencyMs: Math.max(0, (this.dependencies.now?.() ?? new Date()).getTime() - started), errorCode: code }, new AbortController().signal).catch(() => undefined);
      }
      await this.dependencies.repository.transition({ runId: grant.runId, status: code === "OCC-AI-CANCELLED" ? "CANCELLED" : "FAILED", errorCode: code }, new AbortController().signal).catch(() => undefined);
      throw new Error(code);
    }
  }

  private async consume(token: string, signal: AbortSignal): Promise<ConsumedGuidanceGrant> {
    if (this.dependencies.grantConsumer === undefined) throw new Error("OCC-AI-GRANT-MISSING");
    return this.dependencies.grantConsumer.consume(token, signal);
  }

  private validateConfiguration(grant: ConsumedGuidanceGrant, config: GuidanceConfiguration): void {
    const exact = config.runId === grant.runId && config.operation === grant.operation && config.targetEntityId === grant.targetEntityId &&
      config.agentVersionId === grant.agentVersionId && config.modelProfileId === grant.modelProfileId && config.promptVersionId === grant.promptVersionId &&
      config.packageVersionId === grant.packageVersionId && config.embeddingSpaceId === grant.embeddingSpaceId && config.policyReleaseDigest === grant.policyReleaseDigest;
    const schemas = digest(postgresJson(config.agent.inputSchema)) === config.agent.inputSchemaHash && digest(postgresJson(config.agent.outputSchema)) === config.agent.outputSchemaHash;
    const snapshot = capabilitySnapshotSchema.safeParse(config.profile.capabilitySnapshot);
    const snapshotMatches = snapshot.success && snapshot.data.snapshotHash === config.profile.capabilityHash &&
      digest(canonical(Object.fromEntries(Object.entries(snapshot.data).filter(([key]) => key !== "snapshotHash")))) === config.profile.capabilityHash &&
      snapshot.data.maxInputTokens === config.profile.maxInputBytes && snapshot.data.embeddingDimensions === config.space.dimensions;
    if (!exact || config.status !== "QUEUED" || config.prompt.status !== "PUBLISHED" || config.packageStatus !== "PUBLISHED" || config.providerState !== "ACTIVE" ||
      config.profileState !== "ACTIVE" || config.space.status !== "ACTIVE" || config.space.embeddingProfileId !== grant.modelProfileId ||
      !DATA_CLASSIFICATION_ORDER.includes(config.profile.maxClassification) ||
      !Number.isSafeInteger(config.space.dimensions) || config.space.dimensions < 1 || !HASH.test(config.space.manifestDigest) ||
      !HASH.test(config.profile.capabilityHash) || !snapshotMatches || !schemas || !HASH.test(config.agent.contentHash)) throw new Error("OCC-AI-CONFIG-MISMATCH");
  }

  private errorCode(error: unknown, signal: AbortSignal): string {
    if (signal.aborted) return "OCC-AI-CANCELLED";
    const message = error instanceof Error ? error.message : "";
    return STABLE.test(message) ? message : "OCC-AI-GUIDANCE-FAILED";
  }

  private recommendationId(value: unknown): string {
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || typeof (value as { recommendationId?: unknown }).recommendationId !== "string") {
      throw new Error("OCC-AI-CORE-RESPONSE");
    }
    return (value as { recommendationId: string }).recommendationId;
  }
}
