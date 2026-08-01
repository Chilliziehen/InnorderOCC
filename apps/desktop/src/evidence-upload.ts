import { createHash } from "node:crypto";

import { z } from "zod";

import {
  evidenceUploadInputSchema,
  uploadTransportResponseSchema,
  type EvidenceUploadInput,
  type UploadProgress,
  type UploadReceipt,
} from "./desktop-contract";
import { mainUnavailableEvidenceUpload } from "./main-operation-registry";

export interface EvidenceTransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly metadata: Omit<EvidenceUploadInput, "data">;
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly signal: AbortSignal;
}

export type EvidenceTransport = (request: EvidenceTransportRequest) => Promise<unknown>;

interface EvidenceUploadServiceOptions {
  readonly getProfile: () => { origin: string; endpointAvailable: boolean };
  readonly getAccessToken?: () => string | null;
  readonly isOnline?: () => boolean;
  readonly transport: EvidenceTransport;
  readonly createUploadId?: () => string;
  readonly chunkBytes?: number;
  readonly onProgress?: (progress: UploadProgress) => void;
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

function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || value !== url.origin) {
    throw new Error("Invalid evidence origin");
  }
  return url.origin;
}

export function validateEvidenceUpload(input: unknown): EvidenceUploadInput {
  const parsed = evidenceUploadInputSchema.parse(input);
  if (parsed.fileName.includes("/") || parsed.fileName.includes("\\") || parsed.fileName === "." || parsed.fileName === "..") {
    throw new Error("Evidence file name must not contain a path");
  }
  const extension = parsed.fileName.includes(".") ? parsed.fileName.split(".").at(-1)!.toLowerCase() : "";
  if (!MEDIA_EXTENSIONS[parsed.mediaType]?.includes(extension)) {
    throw new Error("Evidence media type or extension is not allowed");
  }
  return parsed;
}

export function createEvidenceUploadService(options: EvidenceUploadServiceOptions) {
  const active = new Map<string, AbortController>();
  const intents = new Map<string, string>();
  const createUploadId = options.createUploadId ?? (() => crypto.randomUUID());
  const chunkBytes = options.chunkBytes ?? 256 * 1024;
  const emit = (update: UploadProgress) => options.onProgress?.(update);

  return {
    async start(input: unknown): Promise<UploadReceipt> {
      const upload = validateEvidenceUpload(input);
      if (!UPLOAD_WORKSPACES.has(upload.workspace)) throw new Error("Evidence upload workspace is not allowed");
      if (options.isOnline?.() === false) throw new Error("Evidence upload rejected while offline");
      const profile = options.getProfile();
      const origin = exactHttpsOrigin(profile.origin);
      if (!profile.endpointAvailable) {
        return mainUnavailableEvidenceUpload();
      }
      const token = options.getAccessToken?.();
      if (!token) throw new Error("Evidence upload requires an authenticated session");
      const hash = createHash("sha256")
        .update(JSON.stringify([upload.workspace, upload.taskId, upload.fileName, upload.mediaType, upload.size]))
        .update(upload.data)
        .digest("hex");
      const existing = intents.get(upload.intentHandle);
      if (existing && existing !== hash) throw new Error("Evidence upload intent mismatch");
      intents.set(upload.intentHandle, hash);
      const uploadId = z.uuid().parse(createUploadId());
      const controller = new AbortController();
      active.set(uploadId, controller);
      let sent = 0;
      const progress = (percent: number) => emit({ uploadId, intentHandle: upload.intentHandle, percent });
      progress(0);
      const chunks = async function* () {
        for (let offset = 0; offset < upload.data.byteLength; offset += chunkBytes) {
          if (controller.signal.aborted) throw new Error("Upload cancelled");
          const chunk = upload.data.subarray(offset, Math.min(upload.data.byteLength, offset + chunkBytes));
          sent += chunk.byteLength;
          yield chunk;
          progress(Math.floor((sent / upload.size) * 100));
        }
      };
      try {
        const raw = await options.transport({
          url: `${origin}/api/v1/evidence/uploads`,
          headers: {
            accept: "application/json",
            "content-type": upload.mediaType,
            "idempotency-key": upload.intentHandle,
            authorization: `Bearer ${token}`,
          },
          metadata: {
            workspace: upload.workspace,
            taskId: upload.taskId,
            fileName: upload.fileName,
            mediaType: upload.mediaType,
            size: upload.size,
            intentHandle: upload.intentHandle,
          },
          chunks: chunks(),
          signal: controller.signal,
        });
        const response = uploadTransportResponseSchema.parse(raw);
        intents.delete(upload.intentHandle);
        return { state: "completed", uploadId, ...response };
      } catch (error) {
        if (controller.signal.aborted) {
          return {
            state: "problem",
            problem: { title: "Upload cancelled", code: "UPLOAD_CANCELLED", status: 499, retryable: true },
          };
        }
        throw error;
      } finally {
        active.delete(uploadId);
      }
    },
    async cancel(uploadId: string): Promise<void> {
      active.get(z.uuid().parse(uploadId))?.abort();
    },
  };
}
