import { createHash, randomUUID } from "node:crypto";

import { capabilitySnapshotSchema, DATA_CLASSIFICATION_ORDER, GUIDANCE_INPUT_JSON_SCHEMA, GUIDANCE_INPUT_JSON_SCHEMA_HASH,
  GUIDANCE_OUTPUT_JSON_SCHEMA, GUIDANCE_OUTPUT_JSON_SCHEMA_HASH, guidanceTaskContextSchema, type DataClassification } from "@innorder/contracts";

import type { CoreClient } from "../core/core-client.js";
import type { OpenAiCompatibleProvider } from "../provider/openai-compatible.js";
import type { HybridRetriever } from "../retrieval/hybrid-retriever.js";
import { buildGuidancePrompt } from "./prompt-builder.js";
import { createGuidanceRecoveryEnvelope, parseGuidanceRecoveryEnvelope } from "./recovery-envelope.js";
import type { GuidanceConfiguration, PostgresGuidanceRepository, PreparedRecommendationSubmission, TerminalGuidanceResult } from "./guidance-repository.js";
import { validateGuidanceOutput } from "./output-validator.js";

const HASH = /^[a-f0-9]{64}$/u;
const STABLE = /^OCC-AI-[A-Z0-9-]{1,112}$/u;
const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export type ConsumedGuidanceGrant = Readonly<{
  runId: string; operationId: string; operation: string; targetEntityId: string;
  agentVersionId: string; modelProfileId: string; promptVersionId: string; packageVersionId: string; embeddingSpaceId: string;
  policyReleaseDigest: string; authorizedSetDigest: string; classificationCeiling: DataClassification;
  authorizedDocumentVersionIds: readonly string[]; boundedContext: Readonly<Record<string, unknown>>; replayed: boolean;
}>;

type Repository = Pick<PostgresGuidanceRepository, "loadConfiguration" | "terminalResult" | "transition" | "startInvocation" |
  "finalizeInvocation" | "persistArtifact" | "loadPreparedSubmission" | "completeProviderAndPrepare" |
  "markSubmissionDispatched" | "acknowledgeSubmission">;
type ArtifactStore = {
  upload(objectKey: string, bytes: Uint8Array, expectedHash: string, signal: AbortSignal): Promise<void>;
  readRetained(objectKey: string, signal: AbortSignal): Promise<Uint8Array>;
};
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
    const grant = typeof input.grant === "string" ? await this.consume(input.grant, signal) : input.grant;
    let invocationId: string | undefined;
    let providerResult: Awaited<ReturnType<OpenAiCompatibleProvider["chat"]>> | undefined;
    let validatedProviderResult: ReturnType<typeof validateGuidanceOutput> | undefined;
    const started = (this.dependencies.now?.() ?? new Date()).getTime();
    try {
      if (grant.replayed) {
        if (grant.operationId !== input.operationId || grant.runId !== input.operationId || grant.operation !== "PARTICIPANT_GUIDANCE") throw new Error("OCC-AI-GRANT-MISMATCH");
        const status = await this.dependencies.repository.terminalResult(grant.runId, new AbortController().signal);
        if (status === undefined) throw new Error("OCC-AI-GRANT-REPLAY");
        if (status.status !== "RECONCILIATION_PENDING") return status;
        const retained = await this.recover(grant.runId, grant.operationId);
        return await this.reconcile(retained, signal);
      }
      if (signal.aborted) throw new Error("OCC-AI-CANCELLED");
      if (grant.operationId !== input.operationId || grant.runId !== input.operationId || grant.operation !== "PARTICIPANT_GUIDANCE") throw new Error("OCC-AI-GRANT-MISMATCH");
      const configuration = await this.dependencies.repository.loadConfiguration({
        runId: grant.runId, agentVersionId: grant.agentVersionId, modelProfileId: grant.modelProfileId,
        promptVersionId: grant.promptVersionId, packageVersionId: grant.packageVersionId,
        embeddingSpaceId: grant.embeddingSpaceId, policyReleaseDigest: grant.policyReleaseDigest,
      }, signal);
      this.validateConfiguration(grant, configuration);
      if (DATA_CLASSIFICATION_ORDER.indexOf(grant.classificationCeiling) > DATA_CLASSIFICATION_ORDER.indexOf(configuration.profile.maxClassification)) {
        throw new Error("OCC-AI-CLASSIFICATION-DENIED");
      }
      const context = guidanceTaskContextSchema.safeParse(grant.boundedContext);
      if (!context.success || Buffer.byteLength(context.data.query, "utf8") > 8192) throw new Error("OCC-AI-CONTEXT-INVALID");
      await this.dependencies.repository.transition({ runId: grant.runId, status: "RUNNING" }, signal);
      const query = context.data.query;
      const retrieval = await this.dependencies.retriever.retrieve({
        runId: grant.runId, query, authorizedSetDigest: grant.authorizedSetDigest,
        authorizedDocumentCount: grant.authorizedDocumentVersionIds.length, classificationCeiling: grant.classificationCeiling,
        providerMaxClassification: configuration.profile.maxClassification,
        space: { id: configuration.embeddingSpaceId, dimensions: configuration.space.dimensions,
          manifestDigest: configuration.space.manifestDigest, embeddingProfileId: configuration.space.embeddingProfileId },
      }, signal);
      const prompt = buildGuidancePrompt({ template: configuration.prompt.template, templateHash: configuration.prompt.hash,
        taskContext: context.data, hits: retrieval.hits, outputSchema: configuration.agent.outputSchema, maxInputBytes: configuration.profile.maxInputBytes });
      invocationId = this.dependencies.invocationId?.() ?? randomUUID();
      await this.dependencies.repository.startInvocation({ id: invocationId, runId: grant.runId, profileId: grant.modelProfileId,
        operation: grant.operation, requestHash: prompt.promptHash, capabilityHash: configuration.profile.capabilityHash }, signal);
      providerResult = await this.dependencies.provider.chat({ messages: prompt.messages, schema: prompt.schema }, signal);
      const responseHash = digest(canonical(providerResult.output));
      validatedProviderResult = validateGuidanceOutput(providerResult.output, { runId: grant.runId, traceId: retrieval.traceId, hits: retrieval.hits });
      const payload = { operationId: grant.operationId, runId: grant.runId, targetEntityId: grant.targetEntityId,
        expectedTargetVersion: context.data.expectedTargetVersion, output: validatedProviderResult };
      const artifactId = this.dependencies.artifactId?.() ?? randomUUID();
      const artifactBytes = Buffer.from(canonical(validatedProviderResult), "utf8");
      const artifact = { id: artifactId, objectKey: `trace/${grant.runId}/${artifactId}.json`, hash: digest(artifactBytes) };
      const latencyMs = Math.max(0, (this.dependencies.now?.() ?? new Date()).getTime() - started);
      const recovery = createGuidanceRecoveryEnvelope({
        runId: grant.runId, operationId: grant.operationId, invocationId, payload, responseHash,
        providerRequestIdHash: providerResult.providerRequestIdHash ?? null,
        inputTokens: providerResult.usage.inputTokens, outputTokens: providerResult.usage.outputTokens,
        cost: providerResult.accounting.costMicros.toString(), latencyMs, classification: grant.classificationCeiling, artifact,
      });
      let prepared: PreparedRecommendationSubmission;
      try {
        prepared = await this.dependencies.repository.completeProviderAndPrepare({
          runId: grant.runId, operationId: grant.operationId, invocationId, payload, responseHash,
          ...(providerResult.providerRequestIdHash === undefined ? {} : { providerRequestIdHash: providerResult.providerRequestIdHash }),
          inputTokens: providerResult.usage.inputTokens, outputTokens: providerResult.usage.outputTokens,
          cost: providerResult.accounting.costMicros.toString(), latencyMs, classification: grant.classificationCeiling, artifact,
        }, new AbortController().signal);
      } catch {
        try {
          await this.dependencies.artifactStore.upload(recovery.objectKey, recovery.bytes, recovery.hash, new AbortController().signal);
        } catch {
          await this.dependencies.repository.finalizeInvocation({ id: invocationId, status: "COMPLETED", responseHash,
            ...(providerResult.providerRequestIdHash === undefined ? {} : { providerRequestIdHash: providerResult.providerRequestIdHash }),
            inputTokens: providerResult.usage.inputTokens, outputTokens: providerResult.usage.outputTokens,
            cost: providerResult.accounting.costMicros.toString(), latencyMs, errorCode: null }, new AbortController().signal).catch(() => undefined);
        }
        throw new Error("OCC-AI-RECONCILIATION-PENDING");
      }
      invocationId = undefined;
      return await this.reconcile(prepared, signal);
    } catch (error) {
      const code = this.errorCode(error, signal);
      if (code === "OCC-AI-RECONCILIATION-PENDING" || validatedProviderResult !== undefined) throw new Error("OCC-AI-RECONCILIATION-PENDING");
      if (providerResult !== undefined && invocationId !== undefined) {
        const responseHash = digest(canonical(providerResult.output));
        await this.dependencies.repository.finalizeInvocation({ id: invocationId, status: "COMPLETED", responseHash,
          ...(providerResult.providerRequestIdHash === undefined ? {} : { providerRequestIdHash: providerResult.providerRequestIdHash }),
          inputTokens: providerResult.usage.inputTokens, outputTokens: providerResult.usage.outputTokens,
          cost: providerResult.accounting.costMicros.toString(), latencyMs: Math.max(0, (this.dependencies.now?.() ?? new Date()).getTime() - started), errorCode: null }, new AbortController().signal)
          .catch(() => { throw new Error("OCC-AI-RECONCILIATION-PENDING"); });
        invocationId = undefined;
      }
      if (invocationId !== undefined) {
        await this.dependencies.repository.finalizeInvocation({ id: invocationId, status: code === "OCC-AI-CANCELLED" ? "CANCELLED" : "FAILED",
          responseHash: null, inputTokens: 0, outputTokens: 0, cost: "0", latencyMs: Math.max(0, (this.dependencies.now?.() ?? new Date()).getTime() - started), errorCode: code }, new AbortController().signal).catch(() => undefined);
      }
      await this.dependencies.repository.transition({ runId: grant.runId, status: code === "OCC-AI-CANCELLED" ? "CANCELLED" : "FAILED", errorCode: code }, new AbortController().signal).catch(() => undefined);
      throw new Error(code);
    }
  }

  private async recover(runId: string, operationId: string): Promise<PreparedRecommendationSubmission> {
    const durableSignal = new AbortController().signal;
    let retained: PreparedRecommendationSubmission | undefined;
    try { retained = await this.dependencies.repository.loadPreparedSubmission(runId, durableSignal); } catch { retained = undefined; }
    if (retained !== undefined) return retained;
    try {
      const bytes = await this.dependencies.artifactStore.readRetained(`recovery/${runId}/${operationId}.json`, durableSignal);
      const recovery = parseGuidanceRecoveryEnvelope(bytes, runId, operationId);
      return await this.dependencies.repository.completeProviderAndPrepare({
        runId, operationId, invocationId: recovery.invocationId, payload: recovery.payload,
        responseHash: recovery.responseHash,
        ...(recovery.providerRequestIdHash === null ? {} : { providerRequestIdHash: recovery.providerRequestIdHash }),
        inputTokens: recovery.inputTokens, outputTokens: recovery.outputTokens, cost: recovery.cost,
        latencyMs: recovery.latencyMs, classification: recovery.classification, artifact: recovery.artifact,
      }, durableSignal);
    } catch { throw new Error("OCC-AI-RECONCILIATION-PENDING"); }
  }

  private async reconcile(submission: PreparedRecommendationSubmission, signal: AbortSignal): Promise<GuidanceRunResult> {
    if (signal.aborted) throw new Error("OCC-AI-RECONCILIATION-PENDING");
    const durableSignal = new AbortController().signal;
    try {
      const output = submission.payload.output;
      if (output === undefined) throw new Error();
      const artifactBytes = Buffer.from(canonical(output), "utf8");
      if (digest(artifactBytes) !== submission.artifact.hash) throw new Error();
      await this.dependencies.artifactStore.upload(submission.artifact.objectKey, artifactBytes, submission.artifact.hash, durableSignal);
      await this.dependencies.repository.persistArtifact({ id: submission.artifact.id, runId: submission.runId,
        artifactKind: "TRACE", objectKey: submission.artifact.objectKey, hash: submission.artifact.hash,
        classification: submission.classification }, durableSignal);
      await this.dependencies.repository.markSubmissionDispatched({ runId: submission.runId,
        idempotencyKey: submission.idempotencyKey, payloadHash: submission.payloadHash }, durableSignal);
      const coreResult = await this.dependencies.core.submitRecommendation(submission.payload, submission.idempotencyKey, durableSignal);
      const recommendationId = this.recommendationId(coreResult);
      const receiptHash = digest(canonical(coreResult));
      await this.dependencies.repository.acknowledgeSubmission({ runId: submission.runId,
        idempotencyKey: submission.idempotencyKey, payloadHash: submission.payloadHash,
        recommendationId, receiptHash }, durableSignal);
      return { operationId: submission.operationId, runId: submission.runId, status: "SUCCEEDED", recommendationId };
    } catch {
      throw new Error("OCC-AI-RECONCILIATION-PENDING");
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
    const schemas = canonical(config.agent.inputSchema) === canonical(GUIDANCE_INPUT_JSON_SCHEMA) &&
      canonical(config.agent.outputSchema) === canonical(GUIDANCE_OUTPUT_JSON_SCHEMA) &&
      config.agent.inputSchemaHash === GUIDANCE_INPUT_JSON_SCHEMA_HASH && config.agent.outputSchemaHash === GUIDANCE_OUTPUT_JSON_SCHEMA_HASH &&
      digest(canonical(config.agent.inputSchema)) === config.agent.inputSchemaHash && digest(canonical(config.agent.outputSchema)) === config.agent.outputSchemaHash;
    const guidanceManifest = config.packageManifest.aiGuidance;
    const manifestSchemas = guidanceManifest !== null && typeof guidanceManifest === "object" && !Array.isArray(guidanceManifest) &&
      Object.keys(guidanceManifest).length === 2 &&
      (guidanceManifest as Record<string, unknown>).inputSchemaHash === GUIDANCE_INPUT_JSON_SCHEMA_HASH &&
      (guidanceManifest as Record<string, unknown>).outputSchemaHash === GUIDANCE_OUTPUT_JSON_SCHEMA_HASH;
    const snapshot = capabilitySnapshotSchema.safeParse(config.profile.capabilitySnapshot);
    const snapshotMatches = snapshot.success && snapshot.data.snapshotHash === config.profile.capabilityHash &&
      digest(canonical(Object.fromEntries(Object.entries(snapshot.data).filter(([key]) => key !== "snapshotHash")))) === config.profile.capabilityHash &&
      snapshot.data.maxInputTokens === config.profile.maxInputBytes && snapshot.data.embeddingDimensions === config.space.dimensions;
    if (!exact || config.status !== "QUEUED" || config.prompt.status !== "PUBLISHED" || config.packageStatus !== "PUBLISHED" || config.providerState !== "ACTIVE" ||
      config.profileState !== "ACTIVE" || config.space.status !== "ACTIVE" || config.space.embeddingProfileId !== grant.modelProfileId ||
      !DATA_CLASSIFICATION_ORDER.includes(config.profile.maxClassification) ||
      !Number.isSafeInteger(config.space.dimensions) || config.space.dimensions < 1 || !HASH.test(config.space.manifestDigest) ||
      !HASH.test(config.profile.capabilityHash) || !snapshotMatches || !schemas || !manifestSchemas ||
      !HASH.test(config.packageContentHash) || !HASH.test(config.agent.contentHash)) throw new Error("OCC-AI-CONFIG-MISMATCH");
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
