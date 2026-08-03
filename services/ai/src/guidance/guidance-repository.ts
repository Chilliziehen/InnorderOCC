import type { QueryResult } from "pg";

import type { CapabilitySnapshot, DataClassification } from "@innorder/contracts";

export type GuidanceConfiguration = Readonly<{
  runId: string; status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED"; operation: string; targetEntityId: string;
  agentVersionId: string; modelProfileId: string; promptVersionId: string; packageVersionId: string;
  policyReleaseDigest: string; embeddingSpaceId: string;
  prompt: Readonly<{ status: string; template: string; hash: string }>;
  agent: Readonly<{ inputSchema: Readonly<Record<string, unknown>>; outputSchema: Readonly<Record<string, unknown>>; inputSchemaHash: string; outputSchemaHash: string; contentHash: string }>;
  packageStatus: string; packageManifest: Readonly<Record<string, unknown>>; packageContentHash: string; providerState: string; profileState: string;
  profile: Readonly<{ maxClassification: DataClassification; maxInputBytes: number; capabilityHash: string; capabilitySnapshot: CapabilitySnapshot }>;
  space: Readonly<{ status: string; dimensions: number; manifestDigest: string; embeddingProfileId: string }>;
}>;

export type TerminalGuidanceResult =
  | Readonly<{ operationId: string; runId: string; status: "SUCCEEDED"; recommendationId: string }>
  | Readonly<{ operationId: string; runId: string; status: "FAILED"; errorCode: string }>
  | Readonly<{ operationId: string; runId: string; status: "CANCELLED" }>
  | Readonly<{ operationId: string; runId: string; status: "RECONCILIATION_PENDING" }>;
export type PreparedRecommendationSubmission = Readonly<{
  runId: string; operationId: string; invocationId: string; status: "PREPARED";
  idempotencyKey: string; payloadHash: string; payload: Readonly<Record<string, unknown>>; attempts: number;
  artifact: Readonly<{ id: string; objectKey: string; hash: string }>;
  classification: DataClassification;
}>;
type Queryable = { query(text: string, values?: unknown[]): Promise<QueryResult> };

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("OCC-AI-CANCELLED");
}

function databaseError(error: unknown): never {
  if (error instanceof Error && error.message === "OCC-AI-CANCELLED") throw error;
  throw new Error("OCC-AI-GUIDANCE-DATABASE");
}

function prepared(row: Record<string, unknown>): PreparedRecommendationSubmission {
  if (row.status !== "PREPARED" || row.payload === null || typeof row.payload !== "object" || Array.isArray(row.payload)) throw new Error();
  return { runId: String(row.run_id), operationId: String(row.operation_id), invocationId: String(row.invocation_id),
    status: "PREPARED", idempotencyKey: String(row.idempotency_key), payloadHash: String(row.payload_hash),
    payload: row.payload as Record<string, unknown>, attempts: Number(row.attempts),
    artifact: { id: String(row.artifact_id), objectKey: String(row.artifact_object_key), hash: String(row.artifact_hash) },
    classification: String(row.data_classification) as DataClassification };
}

export class PostgresGuidanceRepository {
  constructor(private readonly database: Queryable) {}

  async loadConfiguration(expected: Readonly<Record<string, string>>, signal: AbortSignal): Promise<GuidanceConfiguration> {
    abort(signal);
    try {
      const result = await this.database.query("SELECT * FROM ai.get_guidance_run_configuration($1,$2,$3,$4,$5,$6,$7)", [
        expected.runId, expected.agentVersionId, expected.modelProfileId, expected.promptVersionId,
        expected.packageVersionId, expected.embeddingSpaceId, expected.policyReleaseDigest,
      ]);
      abort(signal);
      if (result.rows.length !== 1) throw new Error();
      const row = result.rows[0]!;
      return {
        runId: String(row.run_id), status: String(row.run_status) as GuidanceConfiguration["status"], operation: String(row.operation), targetEntityId: String(row.target_entity_id),
        agentVersionId: String(row.agent_version_id), modelProfileId: String(row.model_profile_id), promptVersionId: String(row.prompt_version_id), packageVersionId: String(row.package_version_id),
        policyReleaseDigest: String(row.policy_release_digest), embeddingSpaceId: String(row.embedding_space_id),
        prompt: { status: String(row.prompt_status), template: String(row.prompt_template), hash: String(row.prompt_hash) },
        agent: { inputSchema: row.input_schema as Record<string, unknown>, outputSchema: row.output_schema as Record<string, unknown>, inputSchemaHash: String(row.input_schema_hash), outputSchemaHash: String(row.output_schema_hash), contentHash: String(row.agent_hash) },
        packageStatus: String(row.package_status), packageManifest: row.package_manifest as Record<string, unknown>, packageContentHash: String(row.package_hash),
        providerState: String(row.provider_state), profileState: String(row.profile_state),
        profile: { maxClassification: String(row.max_classification) as DataClassification, maxInputBytes: Number(row.max_input_bytes), capabilityHash: String(row.capability_hash), capabilitySnapshot: row.capability_snapshot as CapabilitySnapshot },
        space: { status: String(row.space_status), dimensions: Number(row.dimensions), manifestDigest: String(row.manifest_digest), embeddingProfileId: String(row.embedding_profile_id) },
      };
    } catch (error) { return databaseError(error); }
  }

  async terminalResult(runId: string, signal: AbortSignal): Promise<TerminalGuidanceResult | undefined> {
    abort(signal);
    try {
      const result = await this.database.query("SELECT * FROM ai.get_guidance_terminal_result($1)", [runId]);
      abort(signal);
      if (result.rows.length === 0) return undefined;
      if (result.rows.length !== 1) throw new Error();
      const row = result.rows[0]!;
      const operationId = String(row.operation_id);
      const status = String(row.run_status);
      if (operationId !== runId) throw new Error();
      if (status === "RUNNING" && row.recommendation_id === null && row.error_code === null) {
        return { operationId, runId, status: "RECONCILIATION_PENDING" };
      }
      if (status === "COMPLETED" && row.recommendation_id !== null && row.error_code === null) {
        return { operationId, runId, status: "SUCCEEDED", recommendationId: String(row.recommendation_id) };
      }
      if (status === "FAILED" && typeof row.error_code === "string" && row.recommendation_id === null) {
        return { operationId, runId, status: "FAILED", errorCode: row.error_code };
      }
      if (status === "CANCELLED" && row.error_code === "OCC-AI-CANCELLED" && row.recommendation_id === null) {
        return { operationId, runId, status: "CANCELLED" };
      }
      throw new Error();
    } catch (error) { return databaseError(error); }
  }

  async transition(input: Readonly<{ runId: string; status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED"; errorCode?: string; recommendationId?: string }>, signal: AbortSignal): Promise<void> {
    abort(signal);
    try {
      const result = await this.database.query("SELECT ai.finalize_guidance_run($1,$2,$3,$4) AS status", [input.runId, input.status, input.errorCode ?? null, input.recommendationId ?? null]);
      if (result.rows.length !== 1 || result.rows[0]?.status !== input.status) throw new Error();
    } catch (error) { databaseError(error); }
  }

  async startInvocation(input: Readonly<{ id: string; runId: string; profileId: string; operation: string; requestHash: string; capabilityHash: string }>, signal: AbortSignal): Promise<string> {
    abort(signal);
    try {
      const result = await this.database.query("SELECT ai.start_model_invocation($1,$2,$3,$4,$5,$6) AS id", [input.id, input.runId, input.profileId, input.operation, input.requestHash, input.capabilityHash]);
      if (result.rows.length !== 1 || String(result.rows[0]?.id) !== input.id) throw new Error();
      return input.id;
    } catch (error) { return databaseError(error); }
  }

  async finalizeInvocation(input: Readonly<{ id: string; status: "COMPLETED" | "FAILED" | "CANCELLED"; responseHash: string | null; providerRequestIdHash?: string; inputTokens: number; outputTokens: number; cost: string; latencyMs: number; errorCode: string | null }>, signal: AbortSignal): Promise<void> {
    abort(signal);
    try {
      await this.database.query("SELECT ai.finalize_model_invocation($1,$2,$3,$4,$5,$6,$7,$8,$9)", [input.id, input.status, input.responseHash, input.providerRequestIdHash ?? null, input.inputTokens, input.outputTokens, input.cost, input.latencyMs, input.errorCode]);
    } catch (error) { databaseError(error); }
  }

  async loadPreparedSubmission(runId: string, signal: AbortSignal): Promise<PreparedRecommendationSubmission | undefined> {
    abort(signal);
    try {
      const result = await this.database.query("SELECT * FROM ai.get_guidance_recommendation_submission($1)", [runId]);
      abort(signal);
      if (result.rows.length === 0) return undefined;
      if (result.rows.length !== 1) throw new Error();
      const row = result.rows[0]!;
      if (row.status !== "PREPARED") return undefined;
      return prepared(row);
    } catch (error) { return databaseError(error); }
  }

  async completeProviderAndPrepare(input: Readonly<{
    runId: string; operationId: string; invocationId: string; payload: Readonly<Record<string, unknown>>;
    responseHash: string; providerRequestIdHash?: string; inputTokens: number; outputTokens: number;
    cost: string; latencyMs: number; classification: DataClassification;
    artifact: Readonly<{ id: string; objectKey: string; hash: string }>;
  }>, signal: AbortSignal): Promise<PreparedRecommendationSubmission> {
    abort(signal);
    try {
      const result = await this.database.query("SELECT * FROM ai.prepare_guidance_recommendation_submission($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [
        input.runId, input.operationId, input.invocationId, JSON.stringify(input.payload),
        input.responseHash, input.providerRequestIdHash ?? null, input.inputTokens, input.outputTokens,
        input.cost, input.latencyMs, input.classification, input.artifact.id, input.artifact.objectKey, input.artifact.hash,
      ]);
      abort(signal);
      if (result.rows.length !== 1) throw new Error();
      return prepared(result.rows[0]!);
    } catch (error) { return databaseError(error); }
  }

  async markSubmissionDispatched(input: Readonly<{ runId: string; idempotencyKey: string; payloadHash: string }>, signal: AbortSignal): Promise<number> {
    abort(signal);
    try {
      const result = await this.database.query("SELECT ai.mark_guidance_recommendation_dispatched($1,$2,$3) AS attempts", [input.runId, input.idempotencyKey, input.payloadHash]);
      if (result.rows.length !== 1 || !Number.isSafeInteger(Number(result.rows[0]?.attempts))) throw new Error();
      return Number(result.rows[0]!.attempts);
    } catch (error) { return databaseError(error); }
  }

  async acknowledgeSubmission(input: Readonly<{ runId: string; idempotencyKey: string; payloadHash: string; recommendationId: string; receiptHash: string }>, signal: AbortSignal): Promise<string> {
    abort(signal);
    try {
      const result = await this.database.query("SELECT ai.acknowledge_guidance_recommendation($1,$2,$3,$4,$5) AS id", [
        input.runId, input.idempotencyKey, input.payloadHash, input.recommendationId, input.receiptHash,
      ]);
      if (result.rows.length !== 1 || String(result.rows[0]?.id) !== input.recommendationId) throw new Error();
      return input.recommendationId;
    } catch (error) { return databaseError(error); }
  }

  async persistArtifact(input: Readonly<{ id: string; runId: string; artifactKind: "TRACE"; objectKey: string; hash: string; classification: DataClassification }>, signal: AbortSignal): Promise<string> {
    abort(signal);
    try {
      const result = await this.database.query("SELECT ai.persist_run_artifact($1,$2,$3,$4,$5,$6) AS id", [input.id, input.runId, input.artifactKind, input.objectKey, input.hash, input.classification]);
      if (result.rows.length !== 1 || String(result.rows[0]?.id) !== input.id) throw new Error();
      return input.id;
    } catch (error) { return databaseError(error); }
  }
}
