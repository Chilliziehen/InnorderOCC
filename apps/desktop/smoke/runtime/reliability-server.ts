import { createHash, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { Agent } from "undici";

export const RELIABILITY_ACCESS_TOKEN = "header.eyJpbnN0YW5jZV9pZCI6IjIwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSJ9.signature";
export const RELIABILITY_REFRESH_TOKEN = "r".repeat(43);
export const RELIABILITY_USER = {
  id: "20000000-0000-4000-8000-000000000002",
  username: "smoke-operator",
  displayName: "Reliability Operator",
  status: "ACTIVE",
  capabilities: ["occ.read", "overview.query", "tasks.query", "tasks.claim", "evidence.submit"],
} as const;

const MAX_JSON_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_LOG_ENTRIES = 500;
const CORRELATION_ID = "30000000-0000-4000-8000-000000000003";

interface RequestLog {
  method: string;
  path: string;
  authorization?: string;
  idempotencyKey?: string;
  lastEventId?: string;
  bodyBytes: number;
}

interface SmokeNotification {
  id: string;
  cursor: string;
  type: string;
  occurredAt: string;
  title: string;
  body?: string;
  read: boolean;
}

export interface ReliabilityServerState {
  requests: RequestLog[];
  lastEventIds: Array<string | undefined>;
  upload?: { bytes: number; chunks: number; sha256: string };
  workspaceGeneration: number;
  notificationListCursors: Array<string | undefined>;
}

export interface ReliabilityServer {
  readonly origin: string;
  readonly fingerprint: string;
  readonly address: AddressInfo;
  readonly state: ReliabilityServerState;
  readonly testDispatcher: Agent;
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
  setWorkspaceGeneration(generation: number): void;
  queueNotification(input: { title: string; body?: string }): SmokeNotification;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": data.byteLength, "cache-control": "no-store" });
  response.end(data);
}

function problem(response: ServerResponse, status: number, code: string, extras: Record<string, unknown> = {}): void {
  json(response, status, { type: "about:blank", title: code, status, code, correlationId: CORRELATION_ID, ...extras });
}

function isExactBearer(value: string | undefined): boolean {
  return value === `Bearer ${RELIABILITY_ACCESS_TOKEN}`;
}

function isIdempotencyKey(value: string | undefined): boolean {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function readBounded(request: AsyncIterable<Uint8Array>, maximum: number): Promise<{ bytes: Buffer; chunks: number }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let count = 0;
  for await (const raw of request) {
    const chunk = Buffer.from(raw);
    size += chunk.byteLength;
    count += 1;
    if (size > maximum) throw Object.assign(new Error("request-too-large"), { status: 413 });
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks, size), chunks: count };
}

function parseJson(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

export async function startReliabilityServer(): Promise<ReliabilityServer> {
  const [certificate, key] = await Promise.all([
    readFile(path.join(__dirname, "fixtures", "localhost-cert.pem")),
    readFile(path.join(__dirname, "fixtures", "localhost-key.pem")),
  ]);
  const fingerprint = new X509Certificate(certificate).fingerprint256.replaceAll(":", "").toUpperCase();
  const state: ReliabilityServerState = { requests: [], lastEventIds: [], workspaceGeneration: 1, notificationListCursors: [] };
  const notifications: SmokeNotification[] = [];
  const streams = new Set<ServerResponse>();
  let server: Server | undefined;
  let port = 0;
  let currentAddress: AddressInfo | undefined;

  const create = () => createServer({ cert: certificate, key }, async (request, response) => {
    const url = new URL(request.url ?? "/", "https://localhost");
    const authorization = request.headers.authorization;
    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
    const lastEventId = request.headers["last-event-id"] as string | undefined;
    const log: RequestLog = { method: request.method ?? "GET", path: `${url.pathname}${url.search}`, bodyBytes: 0, ...(authorization ? { authorization } : {}), ...(idempotencyKey ? { idempotencyKey } : {}), ...(lastEventId ? { lastEventId } : {}) };
    state.requests.push(log);
    if (state.requests.length > MAX_LOG_ENTRIES) state.requests.shift();

    try {
      if (request.method === "POST" && url.pathname === "/api/v1/auth/login") {
        const body = await readBounded(request, MAX_JSON_BYTES);
        log.bodyBytes = body.bytes.byteLength;
        const input = parseJson(body.bytes);
        if (!input || !exactKeys(input, ["username", "password"]) || input.username !== RELIABILITY_USER.username || input.password !== "correct-horse-battery") return problem(response, 401, "AUTHENTICATION_FAILED");
        return json(response, 200, { tokenType: "Bearer", accessToken: RELIABILITY_ACCESS_TOKEN, refreshToken: RELIABILITY_REFRESH_TOKEN, expiresIn: 3600, user: RELIABILITY_USER });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/auth/refresh") {
        const body = await readBounded(request, MAX_JSON_BYTES);
        log.bodyBytes = body.bytes.byteLength;
        const input = parseJson(body.bytes);
        if (!input || !exactKeys(input, ["refreshToken"]) || input.refreshToken !== RELIABILITY_REFRESH_TOKEN) return problem(response, 401, "REFRESH_REJECTED");
        return json(response, 200, { tokenType: "Bearer", accessToken: RELIABILITY_ACCESS_TOKEN, refreshToken: RELIABILITY_REFRESH_TOKEN, expiresIn: 3600, user: RELIABILITY_USER });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/auth/logout") {
        if (!isExactBearer(authorization)) return problem(response, 401, "AUTH_REQUIRED");
        const body = await readBounded(request, MAX_JSON_BYTES);
        log.bodyBytes = body.bytes.byteLength;
        const input = parseJson(body.bytes);
        if (!input || !exactKeys(input, ["refreshToken"]) || input.refreshToken !== RELIABILITY_REFRESH_TOKEN) return problem(response, 400, "INVALID_REFRESH");
        response.writeHead(204);
        return response.end();
      }
      if (request.method === "GET" && url.pathname === "/api/v1/me") {
        return isExactBearer(authorization) ? json(response, 200, RELIABILITY_USER) : problem(response, 401, "AUTH_REQUIRED");
      }
      if (request.method === "GET" && url.pathname === "/api/v1/system/status") {
        return json(response, 200, { service: "occ-core", version: `smoke-${state.workspaceGeneration}`, state: "READY", checkedAt: new Date().toISOString(), components: [] });
      }
      if (request.method === "POST" && /^\/api\/v1\/workspaces\/[^/]+\/query$/.test(url.pathname)) {
        if (!isExactBearer(authorization)) return problem(response, 401, "AUTH_REQUIRED");
        const body = await readBounded(request, MAX_JSON_BYTES);
        log.bodyBytes = body.bytes.byteLength;
        const input = parseJson(body.bytes);
        if (!input || typeof input.workspace !== "string" || typeof input.operation !== "string") return problem(response, 400, "INVALID_QUERY");
        return json(response, 200, { state: "ready", items: [{ id: "task-1", task: `Reliability task v${state.workspaceGeneration}`, process: "Smoke process", state: "AVAILABLE", dueAt: "2026-08-04T12:00:00.000Z", evidenceRequirements: ["Upload deterministic evidence"], acceptedMediaTypes: ["text/plain"], reservation: "No reservation", reviewHistory: [] }], count: 1, fetchedAt: new Date().toISOString() });
      }
      if (request.method === "POST" && /^\/api\/v1\/commands\/[^/]+\/[^/]+$/.test(url.pathname)) {
        if (!isExactBearer(authorization)) return problem(response, 401, "AUTH_REQUIRED");
        if (!isIdempotencyKey(idempotencyKey)) return problem(response, 400, "IDEMPOTENCY_REQUIRED");
        const body = await readBounded(request, MAX_JSON_BYTES);
        log.bodyBytes = body.bytes.byteLength;
        if (!parseJson(body.bytes)) return problem(response, 400, "INVALID_COMMAND");
        return problem(response, 409, "VERSION_CONFLICT", { currentVersion: 7 });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/notifications") {
        if (!isExactBearer(authorization)) return problem(response, 401, "AUTH_REQUIRED");
        const cursor = url.searchParams.get("cursor") ?? undefined;
        state.notificationListCursors.push(cursor);
        const index = cursor?.match(/^cursor-(\d+)$/)?.[1];
        const offset = index === undefined ? 0 : Number(index);
        return json(response, 200, { items: notifications.slice(offset, offset + 50) });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/notifications/stream") {
        if (!isExactBearer(authorization)) return problem(response, 401, "AUTH_REQUIRED");
        state.lastEventIds.push(lastEventId);
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        response.write(": connected\n\n");
        streams.add(response);
        request.once("close", () => streams.delete(response));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/evidence/uploads") {
        if (!isExactBearer(authorization)) return problem(response, 401, "AUTH_REQUIRED");
        if (!isIdempotencyKey(idempotencyKey)) return problem(response, 400, "IDEMPOTENCY_REQUIRED");
        const encodedMetadata = request.headers["x-occ-upload-metadata"] as string | undefined;
        let metadata: Record<string, unknown> | null = null;
        try { metadata = encodedMetadata ? parseJson(Buffer.from(encodedMetadata, "base64url")) : null; } catch { metadata = null; }
        if (!metadata || !exactKeys(metadata, ["workspace", "taskId", "fileName", "mediaType", "size"]) || !Number.isSafeInteger(metadata.size) || Number(metadata.size) <= 0 || Number(metadata.size) > MAX_UPLOAD_BYTES || request.headers["content-type"] !== metadata.mediaType) return problem(response, 400, "INVALID_UPLOAD_METADATA");
        const body = await readBounded(request, MAX_UPLOAD_BYTES);
        log.bodyBytes = body.bytes.byteLength;
        if (body.bytes.byteLength !== metadata.size) return problem(response, 400, "UPLOAD_SIZE_MISMATCH");
        state.upload = { bytes: body.bytes.byteLength, chunks: Math.ceil(body.bytes.byteLength / (256 * 1024)), sha256: createHash("sha256").update(body.bytes).digest("hex") };
        return json(response, 200, { kind: "evidence", evidenceId: "40000000-0000-4000-8000-000000000001", uploadReference: "quarantine/reliability-evidence", quarantineStatus: "quarantined", processingStatus: "scanning", reviewStatus: "pending" });
      }
      problem(response, 404, "NOT_FOUND");
    } catch (error) {
      problem(response, (error as { status?: number }).status ?? 400, "INVALID_REQUEST");
    }
  });

  const control: ReliabilityServer = {
    get origin() { return `https://localhost:${port}`; },
    get address() {
      if (!currentAddress) throw new Error("Reliability server is stopped");
      return currentAddress;
    },
    fingerprint,
    state,
    testDispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
    async start() {
      if (server?.listening) return;
      server = create();
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(port, "127.0.0.1", () => {
          server!.off("error", reject);
          currentAddress = server!.address() as AddressInfo;
          port = currentAddress.port;
          resolve();
        });
      });
    },
    async stop() {
      if (!server?.listening) return;
      for (const stream of streams) stream.destroy();
      streams.clear();
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      currentAddress = undefined;
    },
    async close() {
      await control.stop();
      await control.testDispatcher.close();
    },
    setWorkspaceGeneration(generation) {
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Invalid workspace generation");
      state.workspaceGeneration = generation;
    },
    queueNotification(input) {
      const sequence = notifications.length + 1;
      const event: SmokeNotification = { id: `50000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`, cursor: `cursor-${sequence}`, type: "reliability.changed", occurredAt: new Date().toISOString(), title: input.title, ...(input.body ? { body: input.body } : {}), read: false };
      notifications.push(event);
      const frame = `id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const stream of streams) stream.write(frame);
      return event;
    },
  };
  await control.start();
  return control;
}
