import { createHash } from "node:crypto";

import type { QueryResult } from "pg";
import { z } from "zod";

import type { ParsedDocument } from "./parser.js";
import type { Chunk } from "./chunker.js";
import type { ParserSidecarClient } from "./parser-sidecar.js";
import { ParsedDocumentSchema } from "./parser-protocol.js";

type Job = Readonly<{ id: string; stage: string; checkpoint: Record<string, unknown>; sourceObjectHash: string; normalizedContentHash: string; candidateEmbeddingSpaceId: string; corpusManifestDigest: string; fileName?: string; mimeType?: string; objectKey?: string; documentVersionId?: string; documentVersion?: number; dataClassification?: string }>;
type Repository = Readonly<{
  claim(workerId: string, limit: number, leaseMs: number, signal: AbortSignal): Promise<readonly Job[]>;
  heartbeat(jobId: string, workerId: string, leaseMs: number, signal: AbortSignal): Promise<void>;
  checkpoint(jobId: string, workerId: string, stage: string, checkpoint: Record<string, unknown>, signal: AbortSignal): Promise<void>;
  persistDocument(...args: unknown[]): Promise<void>;
  persistChunkEmbedding(...args: unknown[]): Promise<void>;
  persistEmbeddingBatch(...args: unknown[]): Promise<void>;
  finalize(jobId: string, workerId: string, checkpoint: Record<string, unknown>, signal: AbortSignal): Promise<void>;
  fail(jobId: string, workerId: string, code: string, retryAfterMs: number, signal?: AbortSignal): Promise<void>;
}>;
type Dependencies = Readonly<{
  workerId: string; repository: Repository;
  objectStore: { readObject(key: string, expectedHash: string, signal: AbortSignal): Promise<Uint8Array>; upload(key: string, bytes: Uint8Array, expectedHash: string, signal: AbortSignal): Promise<void> };
  scanner: { scan(bytes: Uint8Array, signal: AbortSignal): Promise<Readonly<{ clean: true; signatureVersion: string }>> };
  parser: Pick<ParserSidecarClient, "parse">;
  chunker: { chunk(document: ParsedDocument): readonly Chunk[]; version: string };
  embedder: { dimensions: number; maxBatchSize: number; embed(inputs: readonly string[], signal: AbortSignal): Promise<readonly (readonly number[])[]> };
  leaseMs?: number;
}>;

const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const checkpoint = (job: Job, extra: Record<string, unknown>) => ({ ...job.checkpoint, ...extra, sourceObjectHash: job.sourceObjectHash, normalizedContentHash: job.normalizedContentHash, candidateEmbeddingSpaceId: job.candidateEmbeddingSpaceId, corpusManifestDigest: job.corpusManifestDigest });
const artifact = (jobId: string, kind: string, bytes: Uint8Array) => { const digest = hash(bytes); return { key: `artifacts/${jobId}/${kind}-${digest}.json`, hash: digest }; };
const ChunkArtifactSchema = z.array(z.object({ ordinal: z.number().int().nonnegative(), content: z.string().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/u), tokenCount: z.number().int().positive(), metadata: z.record(z.string(), z.unknown()) }).strict()).min(1).max(100_000);
const VectorArtifactSchema = z.array(z.array(z.number().finite()).min(1).max(16_384)).min(1).max(1_024);

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

  async heartbeat(jobId: string, workerId: string, leaseMs: number, signal: AbortSignal): Promise<void> {
    this.active(signal);
    await this.database.query("SELECT ai.heartbeat_ingestion_job($1,$2,($3 * interval '1 millisecond'))", [jobId, workerId, leaseMs]);
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

  async persistEmbeddingBatch(job: Record<string, unknown>, entries: readonly Readonly<{ chunk: Chunk; vector: readonly number[] }>[], value: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    this.active(signal);
    const checkpointValue = (job.checkpoint ?? {}) as Record<string, unknown>;
    const documentVersionId = String(job.documentVersionId ?? checkpointValue.documentVersionId);
    const chunks = entries.map(({ chunk, vector }) => ({
      id: deterministicUuid(`${documentVersionId}:${chunk.ordinal}`), ordinal: chunk.ordinal, content: chunk.content,
      contentHash: chunk.contentHash, tokenCount: chunk.tokenCount, metadata: chunk.metadata, embedding: vector,
    }));
    await this.database.query("SELECT ai.persist_ingestion_embedding_batch($1,$2,$3,$4,$5::jsonb,$6::jsonb)", [
      job.id, job.leaseOwner ?? checkpointValue.workerId, documentVersionId, job.candidateEmbeddingSpaceId,
      JSON.stringify(chunks), JSON.stringify(value),
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
    if (!dependencies.workerId.trim() || dependencies.embedder.maxBatchSize < 1 || dependencies.embedder.maxBatchSize > 100 || dependencies.embedder.dimensions < 1) throw new Error("OCC-AI-INGESTION-CONFIG");
    this.leaseMs = dependencies.leaseMs ?? 60_000;
  }

  async runOnce(signal: AbortSignal): Promise<number> {
    const jobs = await this.dependencies.repository.claim(this.dependencies.workerId, 1, this.leaseMs, signal);
    for (const job of jobs) await this.process(job, signal);
    return jobs.length;
  }

  private async process(job: Job, signal: AbortSignal): Promise<void> {
    let failure = "OCC-AI-INGESTION-FETCH";
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const activeSignal = AbortSignal.any([signal, controller.signal]);
    let heartbeatRunning: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning !== undefined) return;
      heartbeatRunning = this.dependencies.repository.heartbeat(job.id, this.dependencies.workerId, this.leaseMs, activeSignal)
        .catch(() => controller.abort()).finally(() => { heartbeatRunning = undefined; });
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    try {
      let state: Record<string, unknown> = checkpoint(job, {});
      let bytes: Uint8Array | undefined;
      let parsed: ParsedDocument | undefined;
      let chunks: readonly Chunk[];
      if (job.stage === "FETCH") {
        bytes = await this.dependencies.objectStore.readObject(job.objectKey ?? job.id, job.sourceObjectHash, activeSignal);
        if (hash(bytes) !== job.sourceObjectHash) throw new Error("source hash mismatch");
        failure = "OCC-AI-INGESTION-MALWARE";
        const scan = await this.dependencies.scanner.scan(bytes, activeSignal);
        state = { ...state, scannerSignatureVersion: scan.signatureVersion };
        await this.dependencies.repository.checkpoint(job.id, this.dependencies.workerId, "PARSE", state, activeSignal);
      }
      if (job.stage === "FETCH" || job.stage === "PARSE") {
        bytes ??= await this.dependencies.objectStore.readObject(job.objectKey ?? job.id, job.sourceObjectHash, activeSignal);
        failure = "OCC-AI-INGESTION-PARSER";
        parsed = await this.dependencies.parser.parse({ bytes, fileName: job.fileName ?? "source.txt", mimeType: job.mimeType ?? "text/plain" }, activeSignal);
        if (hash(parsed.text) !== job.normalizedContentHash) throw new Error("normalized hash mismatch");
        const parsedBytes = Buffer.from(JSON.stringify(parsed)); const location = artifact(job.id, "parsed", parsedBytes);
        await this.storeArtifact(location.key, parsedBytes, location.hash, activeSignal);
        state = { ...state, parserVersion: parsed.parserVersion, parsedArtifact: location };
        await this.dependencies.repository.checkpoint(job.id, this.dependencies.workerId, "CHUNK", state, activeSignal);
      }
      if (job.stage === "FETCH" || job.stage === "PARSE" || job.stage === "CHUNK") {
        if (job.stage === "CHUNK") parsed = await this.loadArtifact(state.parsedArtifact, ParsedDocumentSchema, activeSignal);
        if (parsed === undefined) throw new Error("OCC-AI-INGESTION-CHECKPOINT");
        chunks = this.dependencies.chunker.chunk(parsed);
        if (chunks.length < 1) throw new Error("empty chunks");
        const chunkBytes = Buffer.from(JSON.stringify(chunks)); const location = artifact(job.id, "chunks", chunkBytes);
        await this.storeArtifact(location.key, chunkBytes, location.hash, activeSignal);
        await this.dependencies.repository.persistDocument({ ...job, checkpoint: state, leaseOwner: this.dependencies.workerId }, parsed, activeSignal);
        state = { ...state, chunkerVersion: this.dependencies.chunker.version, chunkCount: chunks.length, chunksArtifact: location, embeddedThrough: 0 };
        await this.dependencies.repository.checkpoint(job.id, this.dependencies.workerId, "EMBED", state, activeSignal);
      } else chunks = await this.loadArtifact(state.chunksArtifact, ChunkArtifactSchema, activeSignal);
      failure = "OCC-AI-INGESTION-EMBEDDING";
      let offset = Number(state.embeddedThrough ?? 0);
      while (offset < chunks.length) {
        const batch = chunks.slice(offset, offset + this.dependencies.embedder.maxBatchSize);
        const pending = state.pendingBatch as { offset: number; count: number; key: string; hash: string } | undefined;
        let output: readonly (readonly number[])[];
        if (pending !== undefined) {
          if (pending.offset !== offset || pending.count !== batch.length) throw new Error("pending embedding batch mismatch");
          output = await this.loadArtifact(pending, VectorArtifactSchema, activeSignal);
        } else {
          output = await this.dependencies.embedder.embed(batch.map(({ content }) => content), activeSignal);
          const vectorBytes = Buffer.from(JSON.stringify(output)); const location = artifact(job.id, `vectors-${offset}`, vectorBytes);
          await this.storeArtifact(location.key, vectorBytes, location.hash, activeSignal);
          state = { ...state, pendingBatch: { ...location, offset, count: batch.length } };
          await this.dependencies.repository.checkpoint(job.id, this.dependencies.workerId, "EMBED", state, activeSignal);
        }
        if (output.length !== batch.length || output.some((vector) => vector.length !== this.dependencies.embedder.dimensions || vector.some((value) => !Number.isFinite(value)))) throw new Error("embedding shape mismatch");
        const nextState: Record<string, unknown> = { ...state, embeddedThrough: offset + batch.length };
        delete nextState.pendingBatch;
        await this.dependencies.repository.persistEmbeddingBatch({ ...job, checkpoint: state, leaseOwner: this.dependencies.workerId }, batch.map((chunk, index) => ({ chunk, vector: output[index]! })), nextState, activeSignal);
        state = nextState;
        offset += batch.length;
      }
      await this.dependencies.repository.finalize(job.id, this.dependencies.workerId, state, activeSignal);
    } catch {
      try { await this.dependencies.repository.fail(job.id, this.dependencies.workerId, activeSignal.aborted ? "OCC-AI-INGESTION-CANCELLED" : failure, 30_000); } catch { /* A lost lease cannot be terminalized by this worker. */ }
    } finally {
      clearInterval(heartbeat); signal.removeEventListener("abort", abort); await heartbeatRunning?.catch(() => undefined);
    }
  }

  private async storeArtifact(key: string, bytes: Uint8Array, expectedHash: string, signal: AbortSignal): Promise<void> {
    try { await this.dependencies.objectStore.upload(key, bytes, expectedHash, signal); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "OCC-AI-OBJECT-STORE-CONFLICT") throw error;
      await this.dependencies.objectStore.readObject(key, expectedHash, signal);
    }
  }

  private async loadArtifact<T>(value: unknown, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    if (typeof value !== "object" || value === null || !("key" in value) || !("hash" in value) || typeof value.key !== "string" || typeof value.hash !== "string") throw new Error("OCC-AI-INGESTION-CHECKPOINT");
    const bytes = await this.dependencies.objectStore.readObject(value.key, value.hash, signal);
    if (hash(bytes) !== value.hash || bytes.length > 32 * 1024 * 1024) throw new Error("OCC-AI-INGESTION-CHECKPOINT");
    try { return schema.parse(JSON.parse(Buffer.from(bytes).toString("utf8"))); } catch { throw new Error("OCC-AI-INGESTION-CHECKPOINT"); }
  }
}
