import { describe, expect, it, vi } from "vitest";

import {
  createNotificationStream,
  type NotificationConnection,
  type NotificationConnector,
  type NotificationStreamPersistence,
} from "../src/notification-stream";
import {
  createEvidenceUploadService,
  validateEvidenceUpload,
  type EvidenceTransport,
} from "../src/evidence-upload";

const profileId = "11111111-1111-4111-8111-111111111111";
const customerInstanceId = "22222222-2222-4222-8222-222222222222";
const principalId = "33333333-3333-4333-8333-333333333333";
const intentHandle = "44444444-4444-4444-8444-444444444444";
const notificationId = "55555555-5555-4555-8555-555555555555";
const uploadId = "66666666-6666-4666-8666-666666666666";
const scope = { profileId, customerInstanceId, principalId };
const event = (cursor = "cursor-1") => ({
  id: notificationId,
  cursor,
  type: "task.updated",
  occurredAt: "2026-08-02T01:00:00.000Z",
  title: "Task updated",
  read: false,
});

function notificationPersistence(initial?: unknown): NotificationStreamPersistence & { value: unknown } {
  return {
    value: initial,
    async read() { return structuredClone(this.value); },
    async write(value) { this.value = structuredClone(value); },
  };
}

function connectorHarness() {
  const connections: Array<{
    request: Parameters<NotificationConnector>[0];
    connection: NotificationConnection;
  }> = [];
  const connector: NotificationConnector = vi.fn((request) => {
    const connection = { close: vi.fn() };
    connections.push({ request, connection });
    return connection;
  });
  return { connector, connections };
}

describe("notification stream", () => {
  it("connects once to the exact HTTPS Core endpoint with main-owned bearer and isolated cursor", async () => {
    const persistence = notificationPersistence({
      version: 1,
      cursors: { [`${profileId}:${customerInstanceId}:${principalId}`]: "cursor-0" },
    });
    const harness = connectorHarness();
    const stream = createNotificationStream({ connector: harness.connector, persistence, getAccessToken: () => "main-token" });
    await stream.setSession({ scope, origin: "https://core.example.test", endpointAvailable: true });
    const disposeA = stream.subscribe(vi.fn());
    const disposeB = stream.subscribe(vi.fn());
    await stream.idle();

    expect(harness.connector).toHaveBeenCalledOnce();
    expect(harness.connections[0]!.request.url).toBe("https://core.example.test/api/v1/notifications/stream");
    expect(harness.connections[0]!.request.headers).toEqual({ authorization: "Bearer main-token", "last-event-id": "cursor-0" });
    expect(JSON.stringify(harness.connections[0]!.request)).not.toContain("minio");
    disposeA();
    expect(harness.connections[0]!.connection.close).not.toHaveBeenCalled();
    disposeB();
    expect(harness.connections[0]!.connection.close).toHaveBeenCalledOnce();
  });

  it("validates and bounds events, persists cursor before emit, and settles matching intents", async () => {
    const persistence = notificationPersistence();
    const harness = connectorHarness();
    const order: string[] = [];
    persistence.write = vi.fn(async (value) => { persistence.value = structuredClone(value); order.push("persist"); });
    const settle = vi.fn(() => { order.push("settle"); return true; });
    const listener = vi.fn(() => order.push("emit"));
    const stream = createNotificationStream({ connector: harness.connector, persistence, getAccessToken: () => "token", settleCommand: settle });
    await stream.setSession({ scope, origin: "https://core.example.test", endpointAvailable: true });
    stream.subscribe(listener);
    await stream.idle();
    const accepted = { ...event(), intentHandle, correlationId: notificationId, commandState: "completed" as const };

    await harness.connections[0]!.request.onMessage({ data: JSON.stringify(accepted), lastEventId: "cursor-1" });
    await harness.connections[0]!.request.onMessage({ data: JSON.stringify({ invalid: true }), lastEventId: "cursor-bad" });
    await harness.connections[0]!.request.onMessage({ data: "x".repeat(2 * 1024 * 1024 + 1), lastEventId: "cursor-large" });

    expect(order).toEqual(["persist", "settle", "emit"]);
    expect(settle).toHaveBeenCalledWith(intentHandle, notificationId);
    expect(listener).toHaveBeenCalledOnce();
    expect(persistence.value).toEqual({ version: 1, cursors: { [`${profileId}:${customerInstanceId}:${principalId}`]: "cursor-1" } });
  });

  it("uses bounded exponential backoff with jitter and queries missed notifications after reconnect", async () => {
    const harness = connectorHarness();
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const listFallback = vi.fn().mockResolvedValue({ items: [event("cursor-2")] });
    const listener = vi.fn();
    const stream = createNotificationStream({
      connector: harness.connector,
      persistence: notificationPersistence(),
      getAccessToken: () => "token",
      listFallback,
      random: () => 0.5,
      setTimeout: (callback: () => void, delay: number) => { scheduled.push({ callback, delay }); return scheduled.length; },
      clearTimeout: vi.fn(),
      baseDelayMs: 1_000,
      maxDelayMs: 4_000,
    });
    await stream.setSession({ scope, origin: "https://core.example.test", endpointAvailable: true });
    stream.subscribe(listener);
    await stream.idle();

    harness.connections[0]!.request.onError();
    expect(scheduled[0]!.delay).toBe(1_000);
    scheduled[0]!.callback();
    await stream.idle();
    expect(harness.connector).toHaveBeenCalledTimes(2);
    expect(listFallback).toHaveBeenCalledWith(undefined);
    expect(listener).toHaveBeenCalledWith(event("cursor-2"));
    harness.connections[1]!.request.onError();
    expect(scheduled[1]!.delay).toBe(2_000);
  });

  it("isolates cursors and disposes connections on logout/profile switch without unavailable loops", async () => {
    const harness = connectorHarness();
    const schedule = vi.fn();
    const stream = createNotificationStream({
      connector: harness.connector,
      persistence: notificationPersistence(),
      getAccessToken: () => "token",
      setTimeout: schedule,
      clearTimeout: vi.fn(),
    });
    stream.subscribe(vi.fn());
    await stream.setSession({ scope, origin: "https://core.example.test", endpointAvailable: false });
    await stream.idle();
    expect(harness.connector).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();

    await stream.setSession({ scope, origin: "https://core.example.test", endpointAvailable: true });
    await stream.idle();
    await harness.connections[0]!.request.onMessage({ data: JSON.stringify(event()), lastEventId: "cursor-1" });
    await stream.setSession({ scope: { ...scope, principalId: notificationId }, origin: "https://core.example.test", endpointAvailable: true });
    await stream.idle();
    expect(harness.connections[0]!.connection.close).toHaveBeenCalledOnce();
    expect(harness.connections[1]!.request.headers).not.toHaveProperty("last-event-id");
    await stream.setSession(null);
    expect(harness.connections[1]!.connection.close).toHaveBeenCalledOnce();
    stream.dispose();
  });

  it("rejects non-HTTPS, credentialed, and non-root selected origins", async () => {
    const harness = connectorHarness();
    const stream = createNotificationStream({ connector: harness.connector, persistence: notificationPersistence(), getAccessToken: () => "token" });
    stream.subscribe(vi.fn());
    for (const origin of ["http://core.example.test", "https://user@core.example.test", "https://core.example.test/path"]) {
      await expect(stream.setSession({ scope, origin, endpointAvailable: true })).rejects.toThrow("origin");
    }
    expect(harness.connector).not.toHaveBeenCalled();
  });

  it("connects the newest scope after a rapid session switch during cursor loading", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => void (release = resolve));
    const persistence = notificationPersistence();
    persistence.read = vi.fn(async () => { await blocked; return undefined; });
    const harness = connectorHarness();
    const stream = createNotificationStream({ connector: harness.connector, persistence, getAccessToken: () => "token" });
    stream.subscribe(vi.fn());
    const first = stream.setSession({ scope, origin: "https://first.example.test", endpointAvailable: true });
    const nextScope = { ...scope, principalId: notificationId };
    const second = stream.setSession({ scope: nextScope, origin: "https://second.example.test", endpointAvailable: true });
    release();
    await Promise.all([first, second]);
    await stream.idle();

    expect(harness.connector).toHaveBeenCalledOnce();
    expect(harness.connections[0]!.request.url).toBe("https://second.example.test/api/v1/notifications/stream");
  });
});

const uploadInput = (overrides: Record<string, unknown> = {}) => ({
  workspace: "my-work",
  taskId: "task-1",
  fileName: "evidence.pdf",
  mediaType: "application/pdf",
  size: 4,
  data: new Uint8Array([1, 2, 3, 4]),
  intentHandle,
  ...overrides,
});

describe("evidence upload boundary", () => {
  it("strictly validates task metadata, names, media, extension, and 100 MiB bounds", () => {
    expect(validateEvidenceUpload(uploadInput())).toMatchObject({ taskId: "task-1", size: 4 });
    for (const invalid of [
      uploadInput({ taskId: "" }),
      uploadInput({ fileName: "../evidence.pdf" }),
      uploadInput({ fileName: "folder\\evidence.pdf" }),
      uploadInput({ fileName: "evidence.exe", mediaType: "application/octet-stream" }),
      uploadInput({ fileName: "evidence.png", mediaType: "application/pdf" }),
      uploadInput({ size: 100 * 1024 * 1024 + 1, data: new Uint8Array(1) }),
      uploadInput({ size: 3 }),
      { ...uploadInput(), path: "C:\\secret.pdf" },
    ]) expect(() => validateEvidenceUpload(invalid)).toThrow();
  });

  it("returns exact unavailable after validation without transport or file access", async () => {
    const transport = vi.fn();
    const service = createEvidenceUploadService({ getProfile: () => ({ origin: "https://core.example.test", endpointAvailable: false }), transport });

    await expect(service.start(uploadInput())).resolves.toEqual({
      state: "unavailable",
      reason: "UNAVAILABLE_CONTRACT",
      resourceGroups: ["/evidence"],
      message: "证据提交 API 合同尚未集成",
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("streams chunks only to the named Core endpoint with monotonic progress and validated statuses", async () => {
    const progress: number[] = [];
    const transport: EvidenceTransport = vi.fn(async (request) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request.chunks) chunks.push(chunk);
      expect(request.url).toBe("https://core.example.test/api/v1/evidence/uploads");
      expect(request.url).not.toMatch(/minio/i);
      expect(request.headers.authorization).toBe("Bearer main-token");
      expect(Buffer.concat(chunks).equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
      return {
        evidenceId: "evidence-1",
        uploadReference: "upload-ref-1",
        quarantineStatus: "quarantined",
        processingStatus: "scanning",
        reviewStatus: "pending",
      };
    });
    const service = createEvidenceUploadService({
      getProfile: () => ({ origin: "https://core.example.test", endpointAvailable: true }),
      getAccessToken: () => "main-token",
      transport,
      createUploadId: () => uploadId,
      chunkBytes: 2,
      onProgress: (update) => progress.push(update.percent),
    });

    await expect(service.start(uploadInput())).resolves.toEqual({
      state: "completed",
      uploadId,
      evidenceId: "evidence-1",
      uploadReference: "upload-ref-1",
      quarantineStatus: "quarantined",
      processingStatus: "scanning",
      reviewStatus: "pending",
    });
    expect(progress).toEqual([0, 50, 100]);
  });

  it("cancels active uploads and retains an exact intent only for retry", async () => {
    let reject!: (error: unknown) => void;
    const transport: EvidenceTransport = vi.fn((request) => new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise;
      request.signal.addEventListener("abort", () => rejectPromise(new Error("aborted")));
    }));
    const service = createEvidenceUploadService({
      getProfile: () => ({ origin: "https://core.example.test", endpointAvailable: true }),
      getAccessToken: () => "token",
      transport,
      createUploadId: () => uploadId,
    });
    const pending = service.start(uploadInput());
    await Promise.resolve();
    await service.cancel(uploadId);
    await expect(pending).resolves.toMatchObject({ state: "problem", problem: { code: "UPLOAD_CANCELLED", retryable: true } });
    await expect(service.start(uploadInput({ fileName: "changed.pdf" }))).rejects.toThrow("intent mismatch");
    reject(new Error("unused"));
  });

  it("rejects offline before upload dependencies and rejects untrusted profile origins", async () => {
    const transport = vi.fn();
    const offline = createEvidenceUploadService({
      getProfile: () => ({ origin: "https://core.example.test", endpointAvailable: true }),
      isOnline: () => false,
      getAccessToken: vi.fn(() => "token"),
      transport,
    });
    await expect(offline.start(uploadInput())).rejects.toThrow("offline");
    expect(transport).not.toHaveBeenCalled();

    const untrusted = createEvidenceUploadService({ getProfile: () => ({ origin: "https://minio.example.test/path", endpointAvailable: true }), transport });
    await expect(untrusted.start(uploadInput())).rejects.toThrow("origin");
    expect(transport).not.toHaveBeenCalled();
  });

  it("requires a main-owned bearer before transport and rejects unrelated workspaces", async () => {
    const transport = vi.fn();
    const service = createEvidenceUploadService({
      getProfile: () => ({ origin: "https://core.example.test", endpointAvailable: true }),
      getAccessToken: () => null,
      transport,
    });
    await expect(service.start(uploadInput())).rejects.toThrow("authenticated session");
    await expect(service.start(uploadInput({ workspace: "administration" }))).rejects.toThrow("workspace");
    expect(transport).not.toHaveBeenCalled();
  });
});
