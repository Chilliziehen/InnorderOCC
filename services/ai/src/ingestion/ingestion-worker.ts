import { createHash } from "node:crypto";

import type { QueryResult } from "pg";

import type { ParsedDocument } from "./parser.js";
import type { Chunk } from "./chunker.js";

type Job = Readonly<{ id: string; stage: string; checkpoint: Record<string, unknown>; sourceObjectHash: string; normalizedContentHash: string; candidateEmbeddingSpaceId: string; corpusManifestDigest: string; fileName?: string; mimeType?: string; objectKey?: string; documentVersionId?: string; documentVersion?: number; dataClassification?: string }>;
type Repository = Readonly<{
  claim(workerId: string, limit: number, leaseMs: number, signal: AbortSignal): Promise<readonly Job[]>;
  checkpoint(jobId: string, workerId: string, stage: string, checkpoint: Record<string, unknown>, signal: AbortSignal): Promise<void>;
  persistDocument(...args: unknown[]): Promise<void>;
  persistChunkEmbedding(...args: unknown[]): Promise<void>;
  finalize(jobId: string, workerId: string, checkpoint: Record<string, unknown>, signal: AbortSignal): Promise<void>;
  fail(jobId: string, workerId: string, code: string, retryAfterMs: number, signal?: AbortSignal): Promise<void>;
}>;
type Dependencies = Readonly<{
  workerId: string; repository: Repository;
  objectStore: { readObject(key: string, expectedHash: string, signal: AbortSignal): Promise<Uint8Array> };
  scanner: { scan(bytes: Uint8Array, signal: AbortSignal): Promise<Readonly<{ clean: true; signatureVersion: string }>> };
  parser: { parse(input: { bytes: Uint8Array; fileName: string; mimeType: string }, signal: AbortSignal): Promise<ParsedDocument> };
  chunker: { chunk(document: ParsedDocument): readonly Chunk[]; version: string };
  embedder: { dimensions: number; maxBatchSize: number; embed(inputs: readonly string[], signal: AbortSignal): Promise<readonly (readonly number[])[]> };
  leaseMs?: number;
}>;

const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const checkpoint = (job: Job, extra: Record<string, unknown>) => ({ ...job.checkpoint, ...extra, sourceObjectHash: job.sourceObjectHash, normalizedContentHash: job.normalizedContentHash, candidateEmbeddingSpaceId: job.candidateEmbeddingSpaceId, corpusManifestDigest: job.corpusManifestDigest });

type Queryable = { query(text: string, values?: unknown[]): Promise<QueryResult> };

export class PostgresIngestionRepository {
  constructor(private readonly database: Queryable) {}

  async claim(workerId: string, limit: number, leaseMs: number, signal: AbortSignal): Promise<readonly Job[]> {
    this.active(signal);
    const result = await this.database.query("SELECT * FROM ai.claim_ingestion_jobs($1,$2,($3 * interval '1 millisecond'))", [workerId, limit, leaseMs]);
    return result.rows.map((row) => ({
      id: String(row.id), stage: String(row.stage), checkpoint: row.checkpoint as Record<string, unknown>,
      sourceObjectHash: String(row.source_object_hash), normalizedContentHash: String(row.normalized_content_hash),
      candidateEmbeddingSpaceId: String(row.candidate_embedding_space_id), corpusManifestDigest: String(row.corpus_manifest_digest),
      objectKey: String((row.checkpoint as Record<string, unknown>)?.objectKey ?? row.id),
      fileName: String((row.checkpoint as Record<string, unknown>)?.fileName ?? "source.txt"),
      mimeType: String((row.checkpoint as Record<string, unknown>)?.mimeType ?? "text/plain"),
      documentVersionId: row.produced_document_version_id === null || row.produced_document_version_id === undefined ? String((row.checkpoint as Record<string, unknown>)?.documentVersionId ?? "") : String(row.produced_document_version_id),
      documentVersion: Number((row.checkpoint as Record<string, unknown>)?.documentVersion ?? 0),
      dataClassification: String((row.checkpoint as Record<string, unknown>)?.dataClassification ?? "INTERNAL"),
      leaseOwner: String(row.lease_owner),
    } as Job & { leaseOwner: string }));
  }

  async checkpoint(jobId: string, workerId: string, stage: string, value: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    this.active(signal);
    await this.database.query("SELECT ai.checkpoint_ingestion_attempt($1,$2,$3,$4::jsonb)", [jobId, workerId, stage, JSON.stringify(value)]);
  }

  async persistDocument(job: Record<string, unknown>, parsed: { parserVersion?: string }, signal: AbortSignal): Promise<void> {
    this.active(signal);
    const checkpointValue = (job.checkpoint ?? {}) as Record<string, unknown>;
    await this.database.query("SELECT ai.persist_ingestion_document_version($1,$2,$3,$4,$5,$6,$7,$8)", [
      job.id, job.leaseOwner ?? checkpointValue.workerId, job.documentVersionId ?? checkpointValue.documentVersionId,
      job.documentVersion ?? checkpointValue.documentVersion, job.objectKey ?? checkpointValue.objectKey,
      job.normalizedContentHash, job.mimeType ?? checkpointValue.mimeType, job.dataClassification ?? checkpointValue.dataClassification,
    ]);
    if (typeof parsed.parserVersion !== "string") throw new Error("OCC-AI-INGESTION-PARSER");
  }

  async persistChunkEmbedding(job: Record<string, unknown>, chunk: Chunk, vector: readonly number[], signal: AbortSignal): Promise<void> {
    this.active(signal);
    const checkpointValue = (job.checkpoint ?? {}) as Record<string, unknown>;
    await this.database.query("SELECT ai.persist_ingestion_chunk_embedding($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::public.vector)", [
      job.id, job.leaseOwner ?? checkpointValue.workerId, job.documentVersionId ?? checkpointValue.documentVersionId,
      deterministicUuid(`${String(job.documentVersionId ?? checkpointValue.documentVersionId)}:${chunk.ordinal}`), chunk.ordinal,
      chunk.content, chunk.contentHash, chunk.tokenCount, JSON.stringify(chunk.metadata), job.candidateEmbeddingSpaceId,
      `[${vector.join(",")}]`,
    ]);
  }

  async finalize(jobId: string, workerId: string, value: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    this.active(signal);
    await this.database.query("SELECT ai.finalize_ingestion_job($1,$2,$3::jsonb)", [jobId, workerId, JSON.stringify(value)]);
  }

  async fail(jobId: string, workerId: string, code: string, retryAfterMs: number, signal?: AbortSignal): Promise<void> {
    if (signal !== undefined) this.active(signal);
    await this.database.query("SELECT ai.fail_ingestion_job($1,$2,$3,($4 * interval '1 millisecond'))", [jobId, workerId, code, retryAfterMs]);
  }

  private active(signal: AbortSignal): void { if (signal.aborted) throw new Error("OCC-AI-INGESTION-CANCELLED"); }
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class IngestionWorker {
  private readonly leaseMs: number;
  constructor(private readonly dependencies: Dependencies) {
    if (!dependencies.workerId.trim() || dependencies.embedder.maxBatchSize < 1 || dependencies.embedder.maxBatchSize > 1024 || dependencies.embedder.dimensions < 1) throw new Error("OCC-AI-INGESTION-CONFIG");
    this.leaseMs = dependencies.leaseMs ?? 60_000;
  }

  async runOnce(signal: AbortSignal): Promise<number> {
    const jobs = await this.dependencies.repository.claim(this.dependencies.workerId, 1, this.leaseMs, signal);
    for (const job of jobs) await this.process(job, signal);
    return jobs.length;
  }

  private async process(job: Job, signal: AbortSignal): Promise<void> {
    let failure = "OCC-AI-INGESTION-FETCH";
    try {
      const bytes = await this.dependencies.objectStore.readObject(job.objectKey ?? job.id, job.sourceObjectHash, signal);
      if (hash(bytes) !== job.sourceObjectHash) throw new Error("source hash mismatch");
      failure = "OCC-AI-INGESTION-MALWARE";
      const scan = await this.dependencies.scanner.scan(bytes, signal);
      await this.dependencies.repository.checkpoint(job.id, this.dependencies.workerId, "PARSE", checkpoint(job, { scannerSignatureVersion: scan.signatureVersion }), signal);
      failure = "OCC-AI-INGESTION-PARSER";
      const parsed = await this.dependencies.parser.parse({ bytes, fileName: job.fileName ?? "source.txt", mimeType: job.mimeType ?? "text/plain" }, signal);
      if (hash(parsed.text) !== job.normalizedContentHash) throw new Error("normalized hash mismatch");
      await this.dependencies.repository.checkpoint(job.id, this.dependencies.workerId, "CHUNK", checkpoint(job, { parserVersion: parsed.parserVersion }), signal);
      const chunks = this.dependencies.chunker.chunk(parsed);
      if (chunks.length < 1) throw new Error("empty chunks");
      await this.dependencies.repository.checkpoint(job.id, this.dependencies.workerId, "EMBED", checkpoint(job, { chunkerVersion: this.dependencies.chunker.version, chunkCount: chunks.length }), signal);
      failure = "OCC-AI-INGESTION-EMBEDDING";
      const vectors: (readonly number[])[] = [];
      for (let offset = 0; offset < chunks.length; offset += this.dependencies.embedder.maxBatchSize) {
        const batch = chunks.slice(offset, offset + this.dependencies.embedder.maxBatchSize);
        const output = await this.dependencies.embedder.embed(batch.map(({ content }) => content), signal);
        if (output.length !== batch.length || output.some((vector) => vector.length !== this.dependencies.embedder.dimensions || vector.some((value) => !Number.isFinite(value)))) throw new Error("embedding shape mismatch");
        vectors.push(...output);
      }
      await this.dependencies.repository.persistDocument(job, parsed, signal);
      for (let index = 0; index < chunks.length; index += 1) await this.dependencies.repository.persistChunkEmbedding(job, chunks[index], vectors[index], signal);
      await this.dependencies.repository.finalize(job.id, this.dependencies.workerId, checkpoint(job, { chunkCount: chunks.length, parserVersion: parsed.parserVersion, chunkerVersion: this.dependencies.chunker.version }), signal);
    } catch {
      await this.dependencies.repository.fail(job.id, this.dependencies.workerId, signal.aborted ? "OCC-AI-INGESTION-CANCELLED" : failure, 30_000);
    }
  }
}
