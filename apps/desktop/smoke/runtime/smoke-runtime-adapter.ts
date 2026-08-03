import { commandReceiptSchema, notificationPageSchema, workspaceResultSchema, type ProblemReceipt } from "../../src/desktop-contract";
import { createMainOperationPolicy } from "../../src/main-operation-policy";
import type { RuntimeAdapterDependencies, RuntimeBuildAdapter } from "../../src/runtime-adapter-contract";

const MAX_BYTES = 2 * 1024 * 1024;

async function readJson(response: Response): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new Error("Smoke response exceeds byte limit");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function headers(dependencies: RuntimeAdapterDependencies, extra: Record<string, string> = {}): Headers {
  const value = new Headers({ accept: "application/json", ...extra });
  const token = dependencies.getAccessToken();
  if (token) value.set("authorization", `Bearer ${token}`);
  return value;
}

function problem(raw: unknown, status: number): ProblemReceipt {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    title: "Request failed",
    status,
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.correlationId === "string" ? { correlationId: value.correlationId } : {}),
    ...(typeof value.currentVersion === "number" ? { currentVersion: value.currentVersion } : {}),
  };
}

function createServices(dependencies: RuntimeAdapterDependencies) {
  const request = async (path: string, init: RequestInit = {}) => dependencies.fetch(new URL(path, dependencies.getOrigin()), { redirect: "error", ...init });
  return {
    async workspaceQuery(input) {
      const response = await request(`/api/v1/workspaces/${encodeURIComponent(input.workspace)}/query`, { method: "POST", headers: headers(dependencies, { "content-type": "application/json" }), body: JSON.stringify(input) });
      const raw = await readJson(response);
      return response.ok ? workspaceResultSchema.parse(raw) : workspaceResultSchema.parse({ state: "error", problem: problem(raw, response.status) });
    },
    async executeCommand(input) {
      const response = await request(`/api/v1/commands/${encodeURIComponent(input.workspace)}/${encodeURIComponent(input.operation)}`, { method: "POST", headers: headers(dependencies, { "content-type": "application/json", "idempotency-key": input.idempotencyKey }), body: JSON.stringify(input) });
      const raw = await readJson(response);
      if (response.ok) return commandReceiptSchema.parse(raw);
      const receipt = problem(raw, response.status);
      return commandReceiptSchema.parse(response.status === 409 && receipt.currentVersion !== undefined
        ? { state: "conflict", correlationId: receipt.correlationId, currentVersion: receipt.currentVersion }
        : { state: "problem", problem: receipt });
    },
    notifications: {
      async list(cursor?: string) {
        const response = await request(`/api/v1/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: headers(dependencies) });
        return notificationPageSchema.parse(await readJson(response));
      },
    },
    notificationConnector(request) {
      const controller = new AbortController();
      void dependencies.fetch(new URL(request.url), { headers: request.headers, signal: controller.signal }).then(async (response) => {
        if (!response.ok || !response.body) throw new Error("Notification stream unavailable");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          for (let boundary = buffered.indexOf("\n\n"); boundary >= 0; boundary = buffered.indexOf("\n\n")) {
            const frame = buffered.slice(0, boundary);
            buffered = buffered.slice(boundary + 2);
            const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            const id = frame.split("\n").find((line) => line.startsWith("id:"))?.slice(3).trim();
            if (data) await request.onMessage({ data, ...(id ? { lastEventId: id } : {}) });
          }
        }
      }).catch(() => { if (!controller.signal.aborted) request.onError(); });
      return { close: () => controller.abort() };
    },
    notificationEndpointAvailable: true,
    async evidenceTransport(request) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of request.chunks) { size += chunk.byteLength; if (size > 100 * 1024 * 1024) throw new Error("Upload exceeds byte limit"); chunks.push(chunk); }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      const response = await dependencies.fetch(new URL("/api/v1/evidence/uploads", dependencies.getOrigin()), {
        method: "POST", signal: request.signal, headers: { ...request.headers, "x-occ-upload-metadata": Buffer.from(JSON.stringify(request.metadata)).toString("base64url") }, body,
      });
      if (!response.ok) throw new Error("Upload transport failed");
      return readJson(response);
    },
    evidenceEndpointAvailable: true,
  } satisfies ReturnType<RuntimeBuildAdapter["createServices"]>;
}

export const runtimeBuild: RuntimeBuildAdapter = {
  operationPolicy: createMainOperationPolicy(true),
  verifyCertificate(profile, request) {
    const expected = profile.caFingerprint?.replaceAll(":", "").toUpperCase();
    const actual = request.certificate.fingerprint?.replaceAll(":", "").toUpperCase();
    return expected?.length === 64 && actual === expected && request.hostname.toLowerCase() === new URL(profile.origin).hostname.toLowerCase()
      && request.verificationResult === "net::ERR_CERT_AUTHORITY_INVALID" && request.errorCode === -202;
  },
  createServices,
};
