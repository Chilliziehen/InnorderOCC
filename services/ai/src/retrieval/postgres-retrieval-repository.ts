import type { QueryResult } from "pg";

export type Classification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";

export type RetrievalCandidate = Readonly<{
  chunkId: string;
  documentVersionId: string;
  documentVersion: number;
  content: string;
  contentHash: string;
  classification: Classification;
  lexicalScore: number | null;
  vectorScore: number | null;
  fusedScore: number;
  rank: number;
}>;

export type PersistedRetrievalHit = RetrievalCandidate & Readonly<{
  retrievalHitId: string;
  traceId: string;
  excerptHash: string;
  injectionDetected: boolean;
}>;

export type PersistRetrievalInput = Readonly<{
  traceId: string;
  runId: string;
  spaceId: string;
  queryHash: string;
  authorizedSetDigest: string;
  authorizedDocumentCount: number;
  classificationCeiling: Classification;
  lexicalCandidateCount: number;
  vectorCandidateCount: number;
  rankingConfig: Readonly<Record<string, unknown>>;
  hits: readonly (RetrievalCandidate & Readonly<{ excerptHash: string; injectionDetected: boolean }>)[];
}>;

type Queryable = { query(text: string, values?: unknown[]): Promise<QueryResult> };
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CLASSIFICATIONS = new Set<Classification>(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]);

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("OCC-AI-CANCELLED");
}

function finiteScore(value: unknown, nullable: boolean): number | null {
  if (value === null && nullable) return null;
  const score = Number(value);
  if (!Number.isFinite(score)) throw new Error("OCC-AI-RETRIEVAL-DATABASE");
  return score;
}

export class PostgresRetrievalRepository {
  constructor(private readonly database: Queryable) {}

  async search(input: Readonly<{
    runId: string; spaceId: string; query: string; queryEmbedding: readonly number[]; dimensions: number;
    lexicalLimit: number; vectorLimit: number; resultLimit: number;
  }>, signal: AbortSignal): Promise<RetrievalCandidate[]> {
    cancelled(signal);
    if (!UUID.test(input.runId) || !UUID.test(input.spaceId) || Buffer.byteLength(input.query, "utf8") < 1 || Buffer.byteLength(input.query, "utf8") > 8192 ||
      !Number.isSafeInteger(input.dimensions) || input.dimensions < 1 || input.dimensions > 2000 ||
      input.queryEmbedding.length !== input.dimensions || input.queryEmbedding.some((value) => !Number.isFinite(value)) ||
      !Number.isSafeInteger(input.lexicalLimit) || input.lexicalLimit < 1 || input.lexicalLimit > 200 ||
      !Number.isSafeInteger(input.vectorLimit) || input.vectorLimit < 1 || input.vectorLimit > 200 ||
      !Number.isSafeInteger(input.resultLimit) || input.resultLimit < 1 || input.resultLimit > 100) {
      throw new Error("OCC-AI-RETRIEVAL-BOUNDS");
    }
    try {
      const vector = `[${input.queryEmbedding.join(",")}]`;
      const result = await this.database.query(
        "SELECT * FROM ai.authorized_hybrid_retrieval($1,$2,$3,$4::public.vector,$5,$6,$7)",
        [input.runId, input.spaceId, input.query, vector, input.lexicalLimit, input.vectorLimit, input.resultLimit],
      );
      cancelled(signal);
      return result.rows.map((row, index) => {
        const classification = String(row.data_classification) as Classification;
        const candidate: RetrievalCandidate = {
          chunkId: String(row.chunk_id), documentVersionId: String(row.document_version_id),
          documentVersion: Number(row.document_version), content: String(row.content), contentHash: String(row.content_hash),
          classification, lexicalScore: finiteScore(row.lexical_score, true), vectorScore: finiteScore(row.vector_score, true),
          fusedScore: finiteScore(row.fused_score, false)!, rank: Number(row.rank),
        };
        if (!UUID.test(candidate.chunkId) || !UUID.test(candidate.documentVersionId) || !Number.isSafeInteger(candidate.documentVersion) || candidate.documentVersion < 1 ||
          candidate.content.length < 1 || !HASH.test(candidate.contentHash) || !CLASSIFICATIONS.has(classification) || candidate.rank !== index + 1) {
          throw new Error("OCC-AI-RETRIEVAL-DATABASE");
        }
        return candidate;
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("OCC-AI-")) throw error;
      throw new Error("OCC-AI-RETRIEVAL-DATABASE");
    }
  }

  async persist(input: PersistRetrievalInput, signal: AbortSignal): Promise<Readonly<{ traceId: string; hits: PersistedRetrievalHit[] }>> {
    cancelled(signal);
    if (!UUID.test(input.traceId) || !UUID.test(input.runId) || !UUID.test(input.spaceId) || !HASH.test(input.queryHash) ||
      !HASH.test(input.authorizedSetDigest) || !Number.isSafeInteger(input.authorizedDocumentCount) || input.authorizedDocumentCount < 0 || input.authorizedDocumentCount > 500 ||
      input.hits.length > 100 || input.hits.some((hit, index) => hit.rank !== index + 1 || !HASH.test(hit.excerptHash))) {
      throw new Error("OCC-AI-RETRIEVAL-BOUNDS");
    }
    try {
      const bundle = input.hits.map(({ content: _content, ...hit }) => hit);
      const result = await this.database.query("SELECT * FROM ai.persist_retrieval_bundle($1,$2,$3,$4,$5,$6,$7,$8)", [
        input.traceId, input.runId, input.spaceId, input.queryHash, input.lexicalCandidateCount,
        input.vectorCandidateCount, input.rankingConfig, JSON.stringify(bundle),
      ]);
      cancelled(signal);
      const persisted = result.rows.filter((row) => row.retrieval_hit_id !== null);
      if (result.rows.length < 1 || result.rows.some((row) => String(row.trace_id) !== input.traceId) || persisted.length !== input.hits.length) throw new Error();
      const hits = persisted.map((row, index) => {
        const hit = input.hits[index];
        if (hit === undefined || Number(row.rank) !== hit.rank || String(row.retrieval_hit_id) !== hit.chunkId) throw new Error();
        return { ...hit, retrievalHitId: hit.chunkId, traceId: input.traceId };
      });
      return { traceId: input.traceId, hits };
    } catch (error) {
      if (error instanceof Error && error.message === "OCC-AI-CANCELLED") throw error;
      throw new Error("OCC-AI-RETRIEVAL-PERSISTENCE");
    }
  }
}
