// @vitest-environment node

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { startReliabilityServer, type ReliabilityServer } from "./reliability-server";

const ACCESS_TOKEN = "header.eyJpbnN0YW5jZV9pZCI6IjIwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSJ9.signature";
const REFRESH_TOKEN = "r".repeat(43);

describe("reliability smoke HTTPS server", () => {
  let server: ReliabilityServer | undefined;

  afterEach(async () => {
    await server?.close();
  });

  it("uses an ephemeral loopback listener and deterministic localhost certificate", async () => {
    server = await startReliabilityServer();

    const origin = new URL(server.origin);
    expect(origin.hostname).toBe("localhost");
    expect(Number(origin.port)).toBeGreaterThan(0);
    expect(server.fingerprint).toMatch(/^[0-9A-F]{64}$/);
    expect(server.address).toMatchObject({ address: "127.0.0.1", port: Number(origin.port) });

    await server.stop();
    await server.start();
    expect(new URL(server.origin).port).toBe(origin.port);
  });

  it("serves strict auth, workspace, conflict, notification, and upload contracts", async () => {
    server = await startReliabilityServer();
    const request = (path: string, init: RequestInit = {}) => fetch(new URL(path, server!.origin), {
      ...init,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}`, ...init.headers },
      dispatcher: server!.testDispatcher,
    } as RequestInit);

    const login = await request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "smoke-operator", password: "correct-horse-battery" }),
    });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN });

    const query = await request("/api/v1/workspaces/my-work/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: "my-work", operation: "tasks.query" }),
    });
    expect(query.status).toBe(200);
    expect(await query.json()).toMatchObject({ state: "ready", count: 1, items: [{ task: "Reliability task v1" }] });

    const conflict = await request("/api/v1/commands/my-work/claim", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "30000000-0000-4000-8000-000000000001" },
      body: JSON.stringify({ workspace: "my-work", operation: "claim", payload: { taskId: "task-1" } }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ currentVersion: 7 });

    server.queueNotification({ title: "Missed while disconnected" });
    const page = await request("/api/v1/notifications?cursor=cursor-0");
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ items: [{ title: "Missed while disconnected", cursor: "cursor-1" }] });

    const bytes = Buffer.alloc(1024 * 1024 + 17, 0x61);
    const upload = await request("/api/v1/evidence/uploads", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "idempotency-key": "30000000-0000-4000-8000-000000000002",
        "x-occ-upload-metadata": Buffer.from(JSON.stringify({ workspace: "my-work", taskId: "task-1", fileName: "evidence.txt", mediaType: "text/plain", size: bytes.length })).toString("base64url"),
      },
      body: bytes,
      duplex: "half",
    } as RequestInit);
    expect(upload.status).toBe(200);
    expect(server.state.upload).toEqual({ bytes: bytes.length, chunks: 5, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(server.state.requests.every(({ authorization }) => authorization === `Bearer ${ACCESS_TOKEN}` || authorization === undefined)).toBe(true);
  });

  it("rejects missing auth, idempotency, invalid metadata, and oversized JSON", async () => {
    server = await startReliabilityServer();
    const insecure = (path: string, init: RequestInit = {}) => fetch(new URL(path, server!.origin), { ...init, dispatcher: server!.testDispatcher } as RequestInit);

    expect((await insecure("/api/v1/workspaces/my-work/query", { method: "POST" })).status).toBe(401);
    expect((await insecure("/api/v1/commands/my-work/claim", { method: "POST", headers: { authorization: `Bearer ${ACCESS_TOKEN}` } })).status).toBe(400);
    expect((await insecure("/api/v1/evidence/uploads", { method: "POST", headers: { authorization: `Bearer ${ACCESS_TOKEN}`, "idempotency-key": "30000000-0000-4000-8000-000000000002" } })).status).toBe(400);
    expect((await insecure("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(70 * 1024) }) })).status).toBe(413);
  });
});
