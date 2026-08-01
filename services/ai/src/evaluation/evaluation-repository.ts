import type { QueryResult } from "pg";

type Queryable = { query(text: string, values?: unknown[]): Promise<QueryResult> };
export type BeginGate = Readonly<{ evaluationId: string; datasetVersionId: string; candidateSpaceId: string; corpusManifestDigest: string; expectedActiveSpaceId: string; evidenceHash: string }>;
export type GateCase = Readonly<{ evaluationId: string; caseId: string; citationNumerator: number; citationDenominator: number; recallAt10: number; evidenceHash: string }>;

function stale(error: unknown): never {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  throw new Error(code === "55000" ? "OCC-AI-EVALUATION-STALE" : "OCC-AI-EVALUATION-DATABASE");
}

export class PostgresEvaluationRepository {
  constructor(private readonly database: Queryable) {}

  async begin(input: BeginGate, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error("OCC-AI-EVALUATION-CANCELLED");
    try {
      const result = await this.database.query("SELECT ai.begin_embedding_space_gate($1,$2,$3,$4,$5,$6) AS id", [input.evaluationId, input.datasetVersionId, input.candidateSpaceId, input.corpusManifestDigest, input.expectedActiveSpaceId, input.evidenceHash]);
      if (result.rows.length !== 1) throw new Error();
      return String(result.rows[0]!.id);
    } catch (error) { return stale(error); }
  }

  async recordCase(input: GateCase, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("OCC-AI-EVALUATION-CANCELLED");
    try { await this.database.query("SELECT ai.record_embedding_gate_case($1,$2,$3,$4,$5,$6) AS id", [input.evaluationId, input.caseId, input.citationNumerator, input.citationDenominator, input.recallAt10, input.evidenceHash]); }
    catch (error) { stale(error); }
  }

  async finalize(evaluationId: string, signal: AbortSignal): Promise<"PASS" | "FAIL"> {
    if (signal.aborted) throw new Error("OCC-AI-EVALUATION-CANCELLED");
    try {
      const result = await this.database.query("SELECT ai.finalize_embedding_space_gate($1) AS decision", [evaluationId]);
      const decision = result.rows[0]?.decision;
      if (result.rows.length !== 1 || (decision !== "PASS" && decision !== "FAIL")) throw new Error();
      return decision;
    } catch (error) { return stale(error); }
  }
}
