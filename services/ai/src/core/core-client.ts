import { readFile } from "node:fs/promises";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";

import { verifyServiceIdentity } from "../security/service-identity.js";

export function validateInternalOrigin(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== value) throw new Error();
    return url;
  } catch {
    throw new Error("Invalid internal origin");
  }
}

export async function readBoundedFile(path: string, maximumBytes = 64 * 1024): Promise<Buffer> {
  try {
    const bytes = await readFile(path);
    if (bytes.length === 0 || bytes.length > maximumBytes || bytes.includes(0)) throw new Error();
    return bytes;
  } catch {
    throw new Error("Secret material is unavailable or invalid");
  }
}

export interface CoreClientOptions {
  origin: string;
  key: Buffer;
  cert: Buffer | Buffer[];
  ca: Buffer[];
  revokedSerials: ReadonlySet<string>;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
}

export class CoreClient {
  private readonly origin: URL;
  private readonly agent: Agent;
  private readonly totalTimeoutMs: number;

  constructor(options: CoreClientOptions) {
    this.origin = validateInternalOrigin(options.origin);
    const connectTimeout = options.connectTimeoutMs ?? 500;
    this.totalTimeoutMs = options.totalTimeoutMs ?? 2000;
    if (connectTimeout < 100 || connectTimeout > 2000 || this.totalTimeoutMs < connectTimeout || this.totalTimeoutMs > 30_000) {
      throw new Error("Invalid internal client timeouts");
    }
    this.agent = new Agent({
      keepAlive: true, maxSockets: 16, timeout: connectTimeout,
      key: options.key, cert: options.cert, ca: options.ca, minVersion: "TLSv1.3", rejectUnauthorized: true,
      checkServerIdentity: (_host, cert) => verifyServiceIdentity(cert, true, "spiffe://innorder/core", options.revokedSerials, Date.now(), "server")
        ? undefined : new Error("Service identity is invalid"),
    });
  }

  claimGrant(operationId: string, idempotencyKey: string, signal?: AbortSignal): Promise<unknown> {
    return this.send("POST", "/internal/v1/ai/grants/claim", { operationId }, idempotencyKey, signal);
  }

  submit(path: string, body: unknown, idempotencyKey: string, signal?: AbortSignal): Promise<unknown> {
    if (!path.startsWith("/internal/v1/ai/")) return Promise.reject(new Error("Invalid Core route"));
    return this.send("POST", path, body, idempotencyKey, signal);
  }

  close(): void { this.agent.destroy(); }

  private send(method: string, path: string, body: unknown, idempotencyKey: string, signal?: AbortSignal): Promise<unknown> {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    return new Promise((resolve, reject) => {
      const options: RequestOptions = {
        protocol: "https:", hostname: this.origin.hostname, port: this.origin.port || 443, method, path,
        agent: this.agent, signal, timeout: this.totalTimeoutMs,
        headers: { accept: "application/json", "content-type": "application/json", "content-length": payload.length,
          "idempotency-key": idempotencyKey },
      };
      const request = httpsRequest(options, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 256 * 1024) request.destroy(new Error("Core response exceeds limit")); else chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) return reject(new Error("Core service request failed"));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("Core service response is invalid")); }
        });
      });
      request.once("timeout", () => request.destroy(new Error("Core service request timed out")));
      request.once("error", () => reject(new Error("Core service request failed")));
      request.end(payload);
    });
  }
}
