import { createHash } from "node:crypto";
import { request as httpsRequest, type RequestOptions } from "node:https";

import { readCredentialFile } from "./credential-reader.js";
import { ProviderError, type ProviderPolicy, type ResolvedProviderTarget } from "./provider-policy.js";

export type ProviderTransportRequest = Readonly<{
  operationId: string;
  profileId: string;
  model: string;
  path: string;
  method: "GET" | "POST";
  body?: Uint8Array;
  connectMs: number;
  totalMs: number;
  maxResponseBytes: number;
  maxResponseHeaderBytes?: number;
  signal: AbortSignal;
}>;
export type ProviderTransportResponse = Readonly<{ status: number; headers: Readonly<Record<string, string>>; body: Buffer }>;
export interface ProviderTransport { request(input: ProviderTransportRequest): Promise<ProviderTransportResponse> }

export type RawRequest = Readonly<{
  url: URL;
  address: string;
  family: 4 | 6;
  servername: string;
  method: "GET" | "POST";
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
  connectMs: number;
  maxResponseBytes: number;
  maxResponseHeaderBytes: number;
  signal: AbortSignal;
}>;
export type RawResponse = Readonly<{ status: number; headers: Readonly<Record<string, string | string[] | undefined>>; body: Uint8Array }>;
export type RawRequestFactory = (request: RawRequest) => Promise<RawResponse>;
export type TransportTelemetry = Readonly<{
  operationId: string;
  profileId: string;
  model: string;
  requestHash: string;
  responseHash?: string;
  providerRequestIdHash?: string;
  durationMs: number;
  status?: number;
  code: string;
}>;

type PolicyPort = Pick<ProviderPolicy, "resolve">;
type SecureTransportDependencies = Readonly<{
  policy: PolicyPort;
  requestFactory?: RawRequestFactory;
  credentialReader?: (path: string) => Promise<Buffer>;
  credentialPath?: string;
  telemetry?: (event: TransportTelemetry) => void | Promise<void>;
  now?: () => number;
}>;

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

function singleHeader(headers: RawResponse["headers"], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
}

function sanitizeHeaders(headers: RawResponse["headers"]): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const contentType = singleHeader(headers, "content-type");
  const retryAfter = singleHeader(headers, "retry-after");
  const requestId = singleHeader(headers, "x-request-id") ?? singleHeader(headers, "request-id");
  if (contentType !== undefined) result["content-type"] = contentType;
  if (retryAfter !== undefined && /^\d{1,6}$/u.test(retryAfter)) result["retry-after"] = retryAfter;
  if (requestId !== undefined) result["x-request-id-hash"] = sha256(requestId);
  return result;
}

function defaultRawRequestFactory(input: RawRequest): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    const options: RequestOptions = {
      protocol: "https:", hostname: input.url.hostname, port: input.url.port, path: input.url.pathname,
      method: input.method, headers: input.headers, servername: input.servername, rejectUnauthorized: true,
      maxHeaderSize: input.maxResponseHeaderBytes,
      lookup: (_hostname, _options, callback) => callback(null, input.address, input.family),
      signal: input.signal,
    };
    const request = httpsRequest(options, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > input.maxResponseBytes) {
          request.destroy(new ProviderError("OCC-AI-PROVIDER-LIMIT"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        settled = true;
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks, length) });
      });
    });
    const connectTimer = setTimeout(() => request.destroy(new ProviderError("OCC-AI-PROVIDER-TIMEOUT")), input.connectMs);
    request.once("socket", (socket) => {
      const markConnected = () => { connected = true; clearTimeout(connectTimer); };
      if ((socket as { secureConnecting?: boolean }).secureConnecting === false) markConnected();
      else socket.once("secureConnect", markConnected);
    });
    request.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(connectTimer);
      if (settled) return;
      if (error instanceof ProviderError) return reject(error);
      if (input.signal.aborted) return reject(new ProviderError("OCC-AI-PROVIDER-CANCELLED", false, { cause: input.signal.reason }));
      if (error.code?.startsWith("ERR_TLS") || error.code?.startsWith("CERT_") || error.code === "DEPTH_ZERO_SELF_SIGNED_CERT") return reject(new ProviderError("OCC-AI-PROVIDER-TLS"));
      reject(new ProviderError(connected ? "OCC-AI-PROVIDER-DISPATCHED" : "OCC-AI-PROVIDER-TRANSIENT", !connected));
    });
    if (input.body !== undefined) request.end(input.body);
    else request.end();
  });
}

export class SecureTransport implements ProviderTransport {
  private readonly factory: RawRequestFactory;
  private readonly now: () => number;

  constructor(private readonly dependencies: SecureTransportDependencies) {
    this.factory = dependencies.requestFactory ?? defaultRawRequestFactory;
    this.now = dependencies.now ?? Date.now;
  }

  async request(input: ProviderTransportRequest): Promise<ProviderTransportResponse> {
    if ((input.method !== "GET" && input.method !== "POST") || !Number.isSafeInteger(input.totalMs) || input.totalMs < 1 || !Number.isSafeInteger(input.connectMs) || input.connectMs < 1 || input.connectMs > input.totalMs || !Number.isSafeInteger(input.maxResponseBytes) || input.maxResponseBytes < 1) {
      throw new ProviderError("OCC-AI-PROVIDER-POLICY");
    }
    const startedAt = this.now();
    const requestHash = sha256(input.body ?? new Uint8Array());
    let code = "OCC-AI-PROVIDER-FAILURE";
    let status: number | undefined;
    let responseHash: string | undefined;
    let providerRequestIdHash: string | undefined;
    let credential: Buffer | undefined;
    const controller = new AbortController();
    const cancel = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new ProviderError("OCC-AI-PROVIDER-TIMEOUT")), input.totalMs);
    const rejectOnAbort = (_resolve: (value: never) => void, reject: (reason: ProviderError) => void) => reject(this.abortError(input.signal, controller.signal));
    let abortReject: ((reason: ProviderError) => void) | undefined;
    const abortPromise = new Promise<never>((resolve, reject) => {
      abortReject = reject;
      if (controller.signal.aborted) rejectOnAbort(resolve, reject);
    });
    const onCombinedAbort = () => abortReject?.(this.abortError(input.signal, controller.signal));
    controller.signal.addEventListener("abort", onCombinedAbort, { once: true });
    try {
      if (input.signal.aborted) throw new ProviderError("OCC-AI-PROVIDER-CANCELLED", false, { cause: input.signal.reason });
      const target = await Promise.race([this.dependencies.policy.resolve(input.path), abortPromise]);
      credential = await Promise.race([(this.dependencies.credentialReader ?? readCredentialFile)(this.dependencies.credentialPath ?? ""), abortPromise]);
      const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${credential.toString("utf8")}`, host: target.hostHeader };
      if (input.body !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = String(input.body.byteLength);
      }
      const raw = await Promise.race([
        this.factory({ ...target, method: input.method, headers, connectMs: input.connectMs, maxResponseBytes: input.maxResponseBytes, maxResponseHeaderBytes: input.maxResponseHeaderBytes ?? 16_384, signal: controller.signal, ...(input.body === undefined ? {} : { body: input.body }) }),
        abortPromise,
      ]);
      status = raw.status;
      const headerBytes = Object.entries(raw.headers).reduce((total, [name, value]) => total + Buffer.byteLength(name) + (Array.isArray(value) ? value.reduce((sum, item) => sum + Buffer.byteLength(item), 0) : Buffer.byteLength(value ?? "")), 0);
      if (headerBytes > (input.maxResponseHeaderBytes ?? 16_384)) throw new ProviderError("OCC-AI-PROVIDER-LIMIT");
      if (raw.body.byteLength > input.maxResponseBytes) throw new ProviderError("OCC-AI-PROVIDER-LIMIT");
      if (status >= 300 && status < 400) throw new ProviderError("OCC-AI-PROVIDER-REDIRECT");
      const contentType = singleHeader(raw.headers, "content-type")?.toLowerCase();
      if (contentType === undefined || !/^application\/json(?:;\s*charset=utf-8)?$/u.test(contentType)) throw new ProviderError("OCC-AI-PROVIDER-CONTENT-TYPE");
      const sanitized = sanitizeHeaders(raw.headers);
      responseHash = sha256(raw.body);
      providerRequestIdHash = sanitized["x-request-id-hash"];
      code = "OK";
      return { status, headers: sanitized, body: Buffer.from(raw.body) };
    } catch (error) {
      const safe = error instanceof ProviderError ? error : new ProviderError("OCC-AI-PROVIDER-FAILURE");
      code = safe.code;
      throw safe;
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onCombinedAbort);
      credential?.fill(0);
      const event: TransportTelemetry = {
        operationId: input.operationId, profileId: input.profileId, model: input.model, requestHash,
        durationMs: Math.max(0, this.now() - startedAt), code,
        ...(status === undefined ? {} : { status }), ...(responseHash === undefined ? {} : { responseHash }),
        ...(providerRequestIdHash === undefined ? {} : { providerRequestIdHash }),
      };
      try {
        await this.dependencies.telemetry?.(event);
      } catch {
        if (code === "OK") throw new ProviderError("OCC-AI-PROVIDER-TELEMETRY");
      }
    }
  }

  private abortError(caller: AbortSignal, combined: AbortSignal): ProviderError {
    return caller.aborted
      ? new ProviderError("OCC-AI-PROVIDER-CANCELLED", false, { cause: caller.reason })
      : combined.reason instanceof ProviderError ? combined.reason : new ProviderError("OCC-AI-PROVIDER-TIMEOUT");
  }
}
