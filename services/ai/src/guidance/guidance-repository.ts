import type { QueryResult } from "pg";

import type { CapabilitySnapshot, DataClassification } from "@innorder/contracts";

export type GuidanceConfiguration = Readonly<{
  runId: string; status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED"; operation: string; targetEntityId: string;
  agentVersionId: string; modelProfileId: string; promptVersionId: string; packageVersionId: string;
  policyReleaseDigest: string; embeddingSpaceId: string;
  prompt: Readonly<{ status: string; template: string; hash: string }>;
  agent: Readonly<{ inputSchema: Readonly<Record<string, unknown>>; outputSchema: Readonly<Record<string, unknown>>; inputSchemaHash: string; outputSchemaHash: string; contentHash: string }>;
  packageStatus: string; providerState: string; profileState: string;
  profile: Readonly<{ maxClassification: DataClassification; maxInputBytes: number; capabilityHash: string; capabilitySnapshot: CapabilitySnapshot }>;
  space: Readonly<{ status: string; dimensions: number; manifestDigest: string; embeddingProfileId: string }>;
}>;

export type TerminalGuidanceResult = Readonly<{ operationId: string; runId: string; status: "SUCCEEDED"; recommendationId: string }>;
type Queryable = { query(text: string, values?: unknown[]): Promise<QueryResult> };

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("OCC-AI-CANCELLED");
}

function databaseError(error: unknown): never {
  if (error instanceof Error && error.message === "OCC-AI-CANCELLED") throw error;
  throw new Error("OCC-AI-GUIDANCE-DATABASE");
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
        packageStatus: String(row.package_status), providerState: String(row.provider_state), profileState: String(row.profile_state),
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
      return { operationId: String(result.rows[0]!.operation_id), runId, status: "SUCCEEDED", recommendationId: String(result.rows[0]!.recommendation_id) };
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

  async finalizeInvocation(input: Readonly<{ id: string; status: "COMPLETED" | "FAILED" | "CANCELLED"; responseHash: string | null; inputTokens: number; outputTokens: number; cost: string; latencyMs: number; errorCode: string | null }>, signal: AbortSignal): Promise<void> {
    abort(signal);
    try {
      await this.database.query("SELECT ai.finalize_model_invocation($1,$2,$3,NULL,$4,$5,$6,$7,$8)", [input.id, input.status, input.responseHash, input.inputTokens, input.outputTokens, input.cost, input.latencyMs, input.errorCode]);
    } catch (error) { databaseError(error); }
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
