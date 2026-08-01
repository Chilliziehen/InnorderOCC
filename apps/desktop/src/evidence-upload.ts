import { createHash, randomUUID, type Hash } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  evidenceUploadMetadataSchema,
  uploadAppendInputSchema,
  uploadReceiptSchema,
  uploadTransportResponseSchema,
  type EvidenceUploadMetadata,
  type UploadAppendInput,
  type UploadAppendReceipt,
  type UploadProgress,
  type UploadReceipt,
} from "./desktop-contract";
import { mainUnavailableEvidenceUpload } from "./main-operation-registry";
import type { ReadCacheScope } from "./read-cache";

export interface EvidenceTransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly metadata: Omit<EvidenceUploadMetadata, "intentHandle">;
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly signal: AbortSignal;
}

export type EvidenceTransport = (request: EvidenceTransportRequest) => Promise<unknown>;

interface EvidenceUploadServiceOptions {
  readonly spoolDirectory: string;
  readonly getProfile: () => { origin: string; endpointAvailable: boolean };
  readonly getAccessToken?: () => string | null;
  readonly getScope?: () => ReadCacheScope | null;
  readonly isOnline?: () => boolean;
  readonly transport: EvidenceTransport;
  readonly createUploadId?: () => string;
  readonly createIdempotencyKey?: () => string;
  readonly onProgress?: (progress: UploadProgress) => void;
  readonly now?: () => number;
  readonly maxIntents?: number;
  readonly intentTtlMs?: number;
  readonly maxSessions?: number;
  readonly maxBufferedBytes?: number;
  readonly staleSpoolAgeMs?: number;
}

interface IntentBinding {
  readonly metadataHash: string;
  readonly idempotencyKey: string;
  touchedAt: number;
  terminal?: { readonly contentHash: string; readonly receipt: UploadReceipt };
}

interface UploadSession {
  readonly uploadId: string;
  readonly metadata: EvidenceUploadMetadata;
  readonly binding: IntentBinding;
  readonly filePath: string;
  readonly file: FileHandle;
  readonly fileIdentity: { readonly dev: number; readonly ino: number };
  readonly hash: Hash;
  readonly controller: AbortController;
  readonly scope: ReadCacheScope | null;
  appendTail: Promise<void>;
  nextSequence: number;
  receivedBytes: number;
  finishing: boolean;
  closed: boolean;
  cleanupFlight?: Promise<void>;
}

const MEDIA_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "text/plain": ["txt"],
  "text/csv": ["csv"],
  "video/mp4": ["mp4"],
  "video/webm": ["webm"],
};
const UPLOAD_WORKSPACES = new Set(["my-work", "domain-design"]);
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_CHUNK_BYTES = 1024 * 1024;
const OWNED_SPOOL_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.occ-upload$/i;

function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || value !== url.origin) {
    throw new Error("Invalid evidence origin");
  }
  return url.origin;
}

function sameScope(left: ReadCacheScope | null, right: ReadCacheScope): boolean {
  return left !== null && left.profileId === right.profileId && left.customerInstanceId === right.customerInstanceId && left.principalId === right.principalId;
}

function metadataHash(metadata: EvidenceUploadMetadata, scope: ReadCacheScope | null): string {
  return createHash("sha256").update(JSON.stringify([
    scope ? [scope.profileId, scope.customerInstanceId, scope.principalId] : null,
    metadata.workspace, metadata.taskId, metadata.fileName, metadata.mediaType, metadata.size,
  ])).digest("hex");
}

export function validateEvidenceUpload(input: unknown): EvidenceUploadMetadata {
  const parsed = evidenceUploadMetadataSchema.parse(input);
  if (!UPLOAD_WORKSPACES.has(parsed.workspace)) throw new Error("Evidence upload workspace is not allowed");
  if (parsed.fileName.includes("/") || parsed.fileName.includes("\\") || parsed.fileName === "." || parsed.fileName === "..") {
    throw new Error("Evidence file name must not contain a path");
  }
  const extension = parsed.fileName.includes(".") ? parsed.fileName.split(".").at(-1)!.toLowerCase() : "";
  const allowed = parsed.workspace === "domain-design"
    ? parsed.mediaType === "application/zip" && extension === "zip"
    : parsed.workspace === "my-work" && MEDIA_EXTENSIONS[parsed.mediaType]?.includes(extension) === true;
  if (!allowed) throw new Error("Evidence media type or extension is not allowed");
  return parsed;
}

export const validateEvidenceMetadata = validateEvidenceUpload;

export function createEvidenceUploadService(options: EvidenceUploadServiceOptions) {
  const sessions = new Map<string, UploadSession>();
  const activeIntents = new Map<string, string>();
  const intents = new Map<string, IntentBinding>();
  const createUploadId = options.createUploadId ?? randomUUID;
  const createIdempotencyKey = options.createIdempotencyKey ?? randomUUID;
  const now = options.now ?? Date.now;
  const maxIntents = options.maxIntents ?? 1_000;
  const intentTtlMs = options.intentTtlMs ?? 15 * 60_000;
  const maxSessions = options.maxSessions ?? 4;
  const maxBufferedBytes = options.maxBufferedBytes ?? 4 * MAX_UPLOAD_CHUNK_BYTES;
  const staleSpoolAgeMs = options.staleSpoolAgeMs ?? 24 * 60 * 60_000;
  let bufferedBytes = 0;
  let disposed = false;
  let assignedScope: ReadCacheScope | null = null;
  const currentScope = () => options.getScope?.() ?? assignedScope;

  const emit = (session: UploadSession, percent: number) => options.onProgress?.({ uploadId: session.uploadId, intentHandle: session.metadata.intentHandle, percent });
  const cleanupIntents = () => {
    const time = now();
    for (const [handle, binding] of intents) {
      if (!activeIntents.has(handle) && time - binding.touchedAt >= intentTtlMs) intents.delete(handle);
    }
  };
  const closeSession = (session: UploadSession): Promise<void> => {
    if (session.cleanupFlight) return session.cleanupFlight;
    session.cleanupFlight = (async () => {
      sessions.delete(session.uploadId);
      if (activeIntents.get(session.metadata.intentHandle) === session.uploadId) activeIntents.delete(session.metadata.intentHandle);
      session.controller.abort();
      await session.appendTail.catch(() => undefined);
      if (!session.closed) {
        session.closed = true;
        await session.file.close().catch(() => undefined);
      }
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          const current = await lstat(session.filePath);
          if (current.dev !== session.fileIdentity.dev || current.ino !== session.fileIdentity.ino) return;
          await unlink(session.filePath);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return;
          if ((code !== "EPERM" && code !== "EBUSY") || attempt === 9) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      }
    })();
    return session.cleanupFlight;
  };
  const preflight = async (input: unknown) => {
    validateEvidenceUpload(input);
    if (disposed) throw new Error("Evidence upload service disposed");
    if (options.isOnline?.() === false) throw new Error("Evidence upload rejected while offline");
    const profile = options.getProfile();
    exactHttpsOrigin(profile.origin);
    return profile.endpointAvailable
      ? { state: "available" as const, maxBytes: MAX_UPLOAD_BYTES as typeof MAX_UPLOAD_BYTES }
      : mainUnavailableEvidenceUpload();
  };

  const begin = async (input: unknown): Promise<UploadReceipt> => {
    const metadata = validateEvidenceUpload(input);
    const availability = await preflight(metadata);
    if (availability.state === "unavailable") return availability;
    if (!options.getAccessToken?.()) throw new Error("Evidence upload requires an authenticated session");
    cleanupIntents();
    const sessionScope = currentScope();
    const hash = metadataHash(metadata, sessionScope);
    let binding = intents.get(metadata.intentHandle);
    if (binding && binding.metadataHash !== hash) throw new Error("Evidence upload intent mismatch");
    if (activeIntents.has(metadata.intentHandle)) throw new Error("Evidence upload intent already active");
    if (sessions.size >= maxSessions) throw new Error("Evidence upload session capacity exceeded");
    if (!binding) {
      if (intents.size >= maxIntents) throw new Error("Evidence upload intent capacity exceeded");
      binding = { metadataHash: hash, idempotencyKey: z.uuid().parse(createIdempotencyKey()), touchedAt: now() };
      intents.set(metadata.intentHandle, binding);
    }
    binding.touchedAt = now();
    const uploadId = z.uuid().parse(createUploadId());
    await mkdir(options.spoolDirectory, { recursive: true, mode: 0o700 });
    await chmod(options.spoolDirectory, 0o700);
    const filePath = path.join(options.spoolDirectory, `${uploadId}.occ-upload`);
    const file = await open(filePath, "wx+", 0o600);
    const fileStats = await file.stat();
    const session: UploadSession = {
      uploadId, metadata, binding, filePath, file, fileIdentity: { dev: fileStats.dev, ino: fileStats.ino }, hash: createHash("sha256"), controller: new AbortController(),
      scope: sessionScope, appendTail: Promise.resolve(), nextSequence: 0, receivedBytes: 0, finishing: false, closed: false,
    };
    sessions.set(uploadId, session);
    activeIntents.set(metadata.intentHandle, uploadId);
    emit(session, 0);
    return { state: "started", uploadId };
  };

  const append = async (input: UploadAppendInput): Promise<UploadAppendReceipt> => {
    const parsed = uploadAppendInputSchema.parse(input);
    const session = sessions.get(parsed.uploadId);
    if (!session || session.finishing || session.controller.signal.aborted) return Promise.reject(new Error("Evidence upload session unavailable"));
    const data = Buffer.from(parsed.data);
    if (bufferedBytes + data.byteLength > maxBufferedBytes) return Promise.reject(new Error("Evidence upload buffered byte capacity exceeded"));
    bufferedBytes += data.byteLength;
    let accepted!: UploadAppendReceipt;
    const operation = session.appendTail.then(async () => {
      if (session.controller.signal.aborted) throw new Error("Evidence upload cancelled");
      if (parsed.sequence !== session.nextSequence) throw new Error("Evidence upload sequence mismatch");
      if (session.receivedBytes + data.byteLength > session.metadata.size) throw new Error("Evidence upload exceeds declared size");
      const position = session.receivedBytes;
      const result = await session.file.write(data, 0, data.byteLength, position);
      if (result.bytesWritten !== data.byteLength) throw new Error("Evidence spool write incomplete");
      session.hash.update(data);
      session.nextSequence += 1;
      session.receivedBytes += data.byteLength;
      accepted = { acceptedBytes: data.byteLength, receivedBytes: session.receivedBytes };
      emit(session, Math.floor((session.receivedBytes / session.metadata.size) * 100));
    });
    session.appendTail = operation.then(() => undefined, () => undefined);
    return operation.then(() => accepted).finally(() => { bufferedBytes -= data.byteLength; });
  };

  const finish = async (uploadId: string): Promise<UploadReceipt> => {
    const parsedId = z.uuid().parse(uploadId);
    const session = sessions.get(parsedId);
    if (!session || session.finishing) throw new Error("Evidence upload session unavailable");
    session.finishing = true;
    let contentHash: string | undefined;
    try {
      await session.appendTail;
      if (session.controller.signal.aborted) throw new Error("Evidence upload cancelled");
      if (session.receivedBytes !== session.metadata.size) throw new Error("Evidence upload size mismatch");
      const finalStats = await session.file.stat();
      if (finalStats.size !== session.metadata.size) throw new Error("Evidence upload final size mismatch");
      contentHash = session.hash.digest("hex");
      const verifyHash = createHash("sha256");
      let verifiedBytes = 0;
      while (verifiedBytes < session.metadata.size) {
        const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, session.metadata.size - verifiedBytes));
        const { bytesRead } = await session.file.read(buffer, 0, buffer.byteLength, verifiedBytes);
        if (bytesRead <= 0) throw new Error("Evidence upload verification read incomplete");
        verifyHash.update(buffer.subarray(0, bytesRead));
        verifiedBytes += bytesRead;
      }
      if (verifiedBytes !== session.metadata.size || verifyHash.digest("hex") !== contentHash) throw new Error("Evidence upload final hash mismatch");
      if (session.binding.terminal) {
        if (session.binding.terminal.contentHash !== contentHash) throw new Error("Evidence upload content mismatch");
        session.binding.touchedAt = now();
        return session.binding.terminal.receipt;
      }
      if (options.isOnline?.() === false) throw new Error("Evidence upload rejected while offline");
      const profile = options.getProfile();
      const origin = exactHttpsOrigin(profile.origin);
      if (!profile.endpointAvailable) return mainUnavailableEvidenceUpload();
      if (session.scope && !sameScope(currentScope(), session.scope)) throw new Error("Evidence upload scope changed");
      const token = options.getAccessToken?.();
      if (!token) throw new Error("Evidence upload requires an authenticated session");
      const { intentHandle: _intentHandle, ...transportMetadata } = session.metadata;
      let transportedBytes = 0;
      const chunks = async function* () {
        while (transportedBytes < session.metadata.size) {
          if (session.controller.signal.aborted) throw new Error("Evidence upload cancelled");
          const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, session.metadata.size - transportedBytes));
          const { bytesRead } = await session.file.read(buffer, 0, buffer.byteLength, transportedBytes);
          if (bytesRead <= 0) throw new Error("Evidence upload transport read incomplete");
          transportedBytes += bytesRead;
          yield new Uint8Array(buffer.subarray(0, bytesRead));
        }
      };
      const raw = await options.transport({
        url: `${origin}/api/v1/evidence/uploads`,
        headers: { accept: "application/json", "content-type": session.metadata.mediaType, "idempotency-key": session.binding.idempotencyKey, authorization: `Bearer ${token}` },
        metadata: transportMetadata,
        chunks: chunks(),
        signal: session.controller.signal,
      });
      if (transportedBytes !== session.metadata.size) throw new Error("Evidence upload transport did not consume spool");
      const response = uploadTransportResponseSchema.parse(raw);
      if (response.kind === "archive" && response.sha256 !== contentHash) throw new Error("Archive content hash mismatch");
      const receipt = uploadReceiptSchema.parse({ state: "completed", uploadId: session.uploadId, ...response });
      session.binding.terminal = { contentHash, receipt };
      session.binding.touchedAt = now();
      return receipt;
    } catch (error) {
      if (session.controller.signal.aborted) {
        const receipt = uploadReceiptSchema.parse({ state: "problem", problem: { title: "Upload cancelled", code: "UPLOAD_CANCELLED", status: 499, retryable: true } });
        session.binding.touchedAt = now();
        return receipt;
      }
      throw error;
    } finally {
      await closeSession(session);
    }
  };

  const cancel = async (uploadId: string): Promise<void> => {
    const session = sessions.get(z.uuid().parse(uploadId));
    if (session) await closeSession(session);
  };
  const abortScope = async (scope: ReadCacheScope): Promise<void> => {
    const parsed = z.object({ profileId: z.uuid(), customerInstanceId: z.uuid(), principalId: z.uuid() }).strict().parse(scope);
    await Promise.all([...sessions.values()].filter((session) => sameScope(session.scope, parsed)).map(closeSession));
  };
  const abortAll = async (): Promise<void> => Promise.all([...sessions.values()].map(closeSession)).then(() => undefined);
  const cleanupStaleSpools = async (): Promise<void> => {
    await mkdir(options.spoolDirectory, { recursive: true, mode: 0o700 });
    await chmod(options.spoolDirectory, 0o700);
    const entries = await readdir(options.spoolDirectory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!OWNED_SPOOL_NAME.test(entry.name) || !entry.isFile()) return;
      const candidate = path.join(options.spoolDirectory, entry.name);
      const details = await lstat(candidate);
      if (!details.isFile() || details.isSymbolicLink() || now() - details.mtimeMs < staleSpoolAgeMs) return;
      await unlink(candidate);
    }));
  };

  return {
    preflight, begin, append, finish, cancel, abortScope, abortAll, cleanupStaleSpools,
    setScope(scope: ReadCacheScope | null): void { assignedScope = scope; },
    async dispose(): Promise<void> { disposed = true; await abortAll(); },
  };
}
