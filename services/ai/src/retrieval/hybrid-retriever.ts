import { createHash, randomUUID } from "node:crypto";

import { DATA_CLASSIFICATION_ORDER, type DataClassification } from "@innorder/contracts";

import type { OpenAiCompatibleProvider } from "../provider/openai-compatible.js";
import type { PersistRetrievalInput, PersistedRetrievalHit, PostgresRetrievalRepository, RetrievalCandidate } from "./postgres-retrieval-repository.js";

const HASH = /^[a-f0-9]{64}$/u;
const rank = (classification: DataClassification): number => DATA_CLASSIFICATION_ORDER.indexOf(classification);
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const PROHIBITED = [
  /ignore\s+(?:all\s+)?(?:previous|prior|system)\s+instructions?/iu,
  /override\s+(?:all\s+)?(?:previous|prior|system)\s+instructions?/iu,
  /(?:reveal|show|leak|expose)\s+(?:the\s+)?(?:credentials?|passwords?|secrets?|system\s+prompt)/iu,
  /(?:bypass|disable|override|change)\s+(?:authorization|authentication|controls?|polic(?:y|ies)|safeguards?)/iu,
  /(?:execute|call|invoke|run)\s+(?:a\s+)?tools?/iu,
  /(?:忽略|无视).{0,16}(?:之前|先前|系统).{0,8}(?:指令|提示)/u,
  /(?:显示|泄露|透露|获取).{0,16}(?:凭据|密码|密钥|系统提示)/u,
  /(?:绕过|禁用|关闭|更改).{0,16}(?:授权|认证|控制|策略)/u,
  /(?:执行|调用|运行).{0,8}(?:工具|命令)/u,
];

export function containsProhibitedIntent(value: string): boolean {
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ");
  return PROHIBITED.some((pattern) => pattern.test(normalized));
}

type Repository = Pick<PostgresRetrievalRepository, "search" | "persist">;
type Dependencies = Readonly<{
  provider: Pick<OpenAiCompatibleProvider, "embed">;
  repository: Repository;
  traceId?: () => string;
}>;

export type RetrievalResult = Readonly<{ traceId: string; queryHash: string; hits: readonly PersistedRetrievalHit[] }>;

export class HybridRetriever {
  constructor(private readonly dependencies: Dependencies) {}

  async retrieve(input: Readonly<{
    runId: string;
    query: string;
    authorizedSetDigest: string;
    authorizedDocumentCount: number;
    classificationCeiling: DataClassification;
    providerMaxClassification: DataClassification;
    space: Readonly<{ id: string; dimensions: number; manifestDigest: string; embeddingProfileId: string }>;
  }>, signal: AbortSignal): Promise<RetrievalResult> {
    if (signal.aborted) throw new Error("OCC-AI-CANCELLED");
    if (!HASH.test(input.authorizedSetDigest) || !HASH.test(input.space.manifestDigest) || !Number.isSafeInteger(input.authorizedDocumentCount) ||
      input.authorizedDocumentCount < 0 || input.authorizedDocumentCount > 500 || input.authorizedDocumentCount === 0 ||
      Buffer.byteLength(input.query, "utf8") < 1 || Buffer.byteLength(input.query, "utf8") > 8192) {
      throw new Error(input.authorizedDocumentCount === 0 ? "OCC-AI-RETRIEVAL-EMPTY" : "OCC-AI-RETRIEVAL-BOUNDS");
    }
    const embedded = await this.dependencies.provider.embed({ inputs: [input.query], dimensions: input.space.dimensions }, signal);
    const queryEmbedding = embedded.embeddings[0];
    if (embedded.embeddings.length !== 1 || queryEmbedding === undefined || queryEmbedding.length !== input.space.dimensions) {
      throw new Error("OCC-AI-EMBEDDING-MISMATCH");
    }
    const candidates = await this.dependencies.repository.search({
      runId: input.runId, spaceId: input.space.id, query: input.query, queryEmbedding,
      dimensions: input.space.dimensions, lexicalLimit: 50, vectorLimit: 50, resultLimit: 20,
    }, signal);
    const bounded = candidates.map((candidate) => this.validateCandidate(candidate, input.classificationCeiling, input.providerMaxClassification));
    const traceId = this.dependencies.traceId?.() ?? randomUUID();
    const queryHash = digest(input.query);
    const hits: PersistRetrievalInput["hits"] = bounded.map((candidate) => ({
      ...candidate, excerptHash: digest(candidate.content), injectionDetected: containsProhibitedIntent(candidate.content),
    }));
    const persisted = await this.dependencies.repository.persist({
      traceId, runId: input.runId, spaceId: input.space.id, queryHash,
      authorizedSetDigest: input.authorizedSetDigest, authorizedDocumentCount: input.authorizedDocumentCount,
      classificationCeiling: input.classificationCeiling,
      lexicalCandidateCount: hits.filter(({ lexicalScore }) => lexicalScore !== null).length,
      vectorCandidateCount: hits.filter(({ vectorScore }) => vectorScore !== null).length,
      rankingConfig: { version: "hybrid-rrf-v1", rrfK: 60, lexicalLimit: 50, vectorLimit: 50, resultLimit: 20 }, hits,
    }, signal);
    if (hits.some(({ injectionDetected }) => injectionDetected)) throw new Error("OCC-AI-PROMPT-INJECTION");
    if (persisted.hits.length === 0) throw new Error("OCC-AI-RETRIEVAL-EMPTY");
    return { traceId: persisted.traceId, queryHash, hits: persisted.hits };
  }

  private validateCandidate(candidate: RetrievalCandidate, ceiling: DataClassification, providerMaximum: DataClassification): RetrievalCandidate {
    if (digest(candidate.content) !== candidate.contentHash) throw new Error("OCC-AI-RETRIEVAL-INTEGRITY");
    if (rank(candidate.classification) > rank(ceiling) || rank(candidate.classification) > rank(providerMaximum)) {
      throw new Error("OCC-AI-CLASSIFICATION-DENIED");
    }
    return candidate;
  }
}
