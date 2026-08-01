import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createEvidenceUploadService, validateEvidenceUpload, type EvidenceTransport } from "../src/evidence-upload";

const intentHandle = "44444444-4444-4444-8444-444444444444";
const uploadId = "66666666-6666-4666-8666-666666666666";
const scope = { profileId: "11111111-1111-4111-8111-111111111111", customerInstanceId: "22222222-2222-4222-8222-222222222222", principalId: "33333333-3333-4333-8333-333333333333" };
const metadata = (overrides: Record<string, unknown> = {}) => ({ workspace: "my-work", taskId: "task-1", fileName: "evidence.pdf", mediaType: "application/pdf", size: 4, intentHandle, ...overrides });
const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "occ-upload-test-"));
  roots.push(value);
  return value;
}

afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))));

describe("chunked evidence upload sessions", () => {
  it("validates metadata without accepting renderer paths or bytes", () => {
    expect(validateEvidenceUpload(metadata())).toMatchObject({ taskId: "task-1", size: 4 });
    for (const invalid of [metadata({ fileName: "../evidence.pdf" }), metadata({ size: 100 * 1024 * 1024 + 1 }), { ...metadata(), path: "C:\\secret.pdf" }, { ...metadata(), data: new Uint8Array(4) }]) {
      expect(() => validateEvidenceUpload(invalid)).toThrow();
    }
  });

  it("spools chunks with backpressure and transports only on finish", async () => {
    const spoolDirectory = await root();
    const progress: number[] = [];
    const transport: EvidenceTransport = vi.fn(async (request) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request.chunks) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(request.headers["idempotency-key"]).not.toBe(intentHandle);
      return { kind: "evidence", evidenceId: "evidence-1", uploadReference: "ref-1", quarantineStatus: "released", processingStatus: "ready", reviewStatus: "pending" };
    });
    const service = createEvidenceUploadService({ spoolDirectory, getProfile: () => ({ origin: "https://core.example.test", endpointAvailable: true }), getAccessToken: () => "token", transport, createUploadId: () => uploadId, onProgress: ({ percent }) => progress.push(percent) });

    await expect(service.begin(metadata())).resolves.toEqual({ state: "started", uploadId });
    await service.append({ uploadId, sequence: 0, data: new Uint8Array([1, 2]) });
    await service.append({ uploadId, sequence: 1, data: new Uint8Array([3, 4]) });
    expect(transport).not.toHaveBeenCalled();
    expect(await readFile(path.join(spoolDirectory, `${uploadId}.occ-upload`))).toEqual(Buffer.from([1, 2, 3, 4]));
    await expect(service.finish(uploadId)).resolves.toMatchObject({ state: "completed", uploadId, uploadReference: "ref-1" });
    expect(progress).toEqual([0, 50, 100]);
    expect(await readdir(spoolDirectory)).toEqual([]);
  });

  it("enforces sequence, chunk, declared total, session, and total buffered bounds", async () => {
    const service = createEvidenceUploadService({ spoolDirectory: await root(), getProfile: () => ({ origin: "https://core.example.test", endpointAvailable: true }), getAccessToken: () => "token", transport: vi.fn(), createUploadId: () => uploadId, maxSessions: 1, maxBufferedBytes: 1024 * 1024 });
    await service.begin(metadata());
    await expect(service.begin(metadata({ intentHandle: "88888888-8888-4888-8888-888888888888" }))).rejects.toThrow("session capacity");
    await expect(service.append({ uploadId, sequence: 1, data: new Uint8Array(1) })).rejects.toThrow("sequence");
    await expect(service.append({ uploadId, sequence: 0, data: new Uint8Array(1024 * 1024 + 1) })).rejects.toThrow("chunk");
    await expect(service.append({ uploadId, sequence: 0, data: new Uint8Array(5) })).rejects.toThrow("declared size");
  });

  it("replays exact terminal content without a second transport", async () => {
    const response = { kind: "evidence" as const, evidenceId: "evidence-1", uploadReference: "ref-1", quarantineStatus: "released" as const, processingStatus: "ready" as const, reviewStatus: "pending" as const };
    const transport: EvidenceTransport = vi.fn().mockResolvedValue(response);
    const ids = [uploadId, "77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888"];
    const service = createEvidenceUploadService({ spoolDirectory: await root(), getProfile: () => ({ origin: "https://core.example.test", endpointAvailable: true }), getAccessToken: () => "token", transport, createUploadId: () => ids.shift()! });
    const complete = async (id: string, data: Uint8Array) => { await service.append({ uploadId: id, sequence: 0, data: new Uint8Array(data) }); return service.finish(id); };
    await service.begin(metadata());
    const receipt = await complete(uploadId, new Uint8Array([1, 2, 3, 4]));
    await service.begin(metadata());
    await expect(complete("77777777-7777-4777-8777-777777777777", new Uint8Array([1, 2, 3, 4]))).resolves.toEqual(receipt);
    expect(transport).toHaveBeenCalledOnce();
    await expect(service.begin(metadata({ fileName: "changed.pdf" }))).rejects.toThrow("intent mismatch");
    await service.begin(metadata());
    await expect(complete("88888888-8888-4888-8888-888888888888", new Uint8Array([4, 3, 2, 1]))).rejects.toThrow("content mismatch");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("binds retained terminal receipts to the authenticated scope", async () => {
    let activeScope = scope;
    const transport: EvidenceTransport = vi.fn().mockResolvedValue({ kind: "evidence", evidenceId: "evidence-1", uploadReference: "ref-1", quarantineStatus: "released", processingStatus: "ready", reviewStatus: "pending" });
    const ids = [uploadId, "77777777-7777-4777-8777-777777777777"];
    const service = createEvidenceUploadService({ spoolDirectory: await root(), getProfile: () => ({ origin: "https://core.example.test", endpointAvailable: true }), getAccessToken: () => "token", getScope: () => activeScope, transport, createUploadId: () => ids.shift()! });
    await service.begin(metadata());
    await service.append({ uploadId, sequence: 0, data: new Uint8Array([1, 2, 3, 4]) });
    await service.finish(uploadId);
    activeScope = { ...scope, principalId: "55555555-5555-4555-8555-555555555555" };
    await expect(service.begin(metadata())).rejects.toThrow("intent mismatch");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("replays a fully received terminal cancellation without another transport", async () => {
    let transportRequest!: Parameters<EvidenceTransport>[0];
    const transport: EvidenceTransport = vi.fn((request) => {
      transportRequest = request;
      return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const ids = [uploadId, "77777777-7777-4777-8777-777777777777"];
    const service = createEvidenceUploadService({ spoolDirectory: await root(), getProfile: () => ({ origin: "https://core.example.test", endpointAvailable: true }), getAccessToken: () => "token", transport, createUploadId: () => ids.shift()! });
    await service.begin(metadata());
    await service.append({ uploadId, sequence: 0, data: new Uint8Array([1, 2, 3, 4]) });
    const finishing = service.finish(uploadId);
    await vi.waitFor(() => expect(transportRequest).toBeDefined());
    await service.cancel(uploadId);
    const cancelled = await finishing;
    expect(cancelled).toMatchObject({ state: "problem", problem: { code: "UPLOAD_CANCELLED" } });
    const replayId = "77777777-7777-4777-8777-777777777777";
    await service.begin(metadata());
    await service.append({ uploadId: replayId, sequence: 0, data: new Uint8Array([1, 2, 3, 4]) });
    await expect(service.finish(replayId)).resolves.toEqual(cancelled);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("cancels and aborts scope before deleting every active spool", async () => {
    const spoolDirectory = await root();
    let activeScope = scope;
    const ids = [uploadId, "77777777-7777-4777-8777-777777777777"];
    const service = createEvidenceUploadService({ spoolDirectory, getProfile: () => ({ origin: "https://core.example.test", endpointAvailable: true }), getAccessToken: () => "token", getScope: () => activeScope, transport: vi.fn(), createUploadId: () => ids.shift()! });
    await service.begin(metadata());
    await service.append({ uploadId, sequence: 0, data: new Uint8Array([1, 2]) });
    await service.cancel(uploadId);
    activeScope = { ...scope, principalId: "55555555-5555-4555-8555-555555555555" };
    await service.begin(metadata({ intentHandle: "88888888-8888-4888-8888-888888888888" }));
    await service.abortScope(activeScope);
    expect(await readdir(spoolDirectory)).toEqual([]);
  });

  it("crash cleanup deletes only old regular owned spool names", async () => {
    const spoolDirectory = await root();
    const owned = path.join(spoolDirectory, `${uploadId}.occ-upload`);
    const recent = path.join(spoolDirectory, "77777777-7777-4777-8777-777777777777.occ-upload");
    const unrelated = path.join(spoolDirectory, "keep.txt");
    await Promise.all([writeFile(owned, "old"), writeFile(recent, "new"), writeFile(unrelated, "keep")]);
    await utimes(owned, new Date(0), new Date(0));
    const service = createEvidenceUploadService({ spoolDirectory, getProfile: () => ({ origin: "https://core.example.test", endpointAvailable: true }), transport: vi.fn(), now: () => 100_000, staleSpoolAgeMs: 10_000 });
    await service.cleanupStaleSpools();
    await expect(stat(owned)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(recent, "utf8")).resolves.toBe("new");
    await expect(readFile(unrelated, "utf8")).resolves.toBe("keep");
  });
});
