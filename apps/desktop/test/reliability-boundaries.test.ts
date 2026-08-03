import { describe, expect, it, vi } from "vitest";

import {
  createNotificationStream,
  type NotificationConnection,
  type NotificationConnector,
  type NotificationStreamPersistence,
} from "../src/notification-stream";

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

  it("completes catch-up before live connect and deduplicates exact IDs or cursors without ordering assumptions", async () => {
    const persistence = notificationPersistence({ version: 1, cursors: { [`${profileId}:${customerInstanceId}:${principalId}`]: "cursor-z" } });
    const harness = connectorHarness();
    let resolveFallback!: (page: { items: ReturnType<typeof event>[]; nextCursor?: string }) => void;
    const fallback = new Promise<{ items: ReturnType<typeof event>[]; nextCursor?: string }>((resolve) => void (resolveFallback = resolve));
    const listFallback = vi.fn()
      .mockImplementationOnce(() => fallback)
      .mockResolvedValueOnce({ items: [{ ...event("cursor-b"), id: "77777777-7777-4777-8777-777777777777" }] });
    const listener = vi.fn();
    const stream = createNotificationStream({ connector: harness.connector, persistence, getAccessToken: () => "token", listFallback });
    await stream.setSession({ scope, origin: "https://core.example.test", endpointAvailable: true });
    stream.subscribe(listener);
    await vi.waitFor(() => expect(listFallback).toHaveBeenCalledWith("cursor-z"));
    expect(harness.connector).not.toHaveBeenCalled();

    resolveFallback({
      items: [event("cursor-a"), { ...event("cursor-b"), id: notificationId }, { ...event("cursor-a"), id: "77777777-7777-4777-8777-777777777777" }],
      nextCursor: "page-token-2",
    });
    await stream.idle();

    expect(listFallback).toHaveBeenNthCalledWith(2, "page-token-2");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(persistence.value).toEqual({ version: 1, cursors: { [`${profileId}:${customerInstanceId}:${principalId}`]: "cursor-b" } });
    expect(harness.connector).toHaveBeenCalledOnce();
    expect(harness.connections[0]!.request.headers["last-event-id"]).toBe("cursor-b");
  });

  it("publishes validated connection state and event freshness", async () => {
    let now = Date.parse("2026-08-02T02:00:00.000Z");
    const harness = connectorHarness();
    const stream = createNotificationStream({ connector: harness.connector, persistence: notificationPersistence(), getAccessToken: () => "token", now: () => now });
    const states: unknown[] = [];
    const dispose = stream.subscribeState((value) => states.push(value));
    stream.subscribe(vi.fn());
    await stream.setSession({ scope, origin: "https://core.example.test", endpointAvailable: true });
    expect(states).toEqual([
      { state: "connecting", changedAt: "2026-08-02T02:00:00.000Z" },
      { state: "online", changedAt: "2026-08-02T02:00:00.000Z" },
    ]);
    now += 1_000;
    await harness.connections[0]!.request.onMessage({ data: JSON.stringify(event()), lastEventId: "cursor-1" });
    expect(states.at(-1)).toEqual({ state: "online", changedAt: "2026-08-02T02:00:01.000Z", lastEventAt: "2026-08-02T02:00:01.000Z" });
    harness.connections[0]!.request.onError();
    expect(states.at(-1)).toMatchObject({ state: "reconnecting", lastEventAt: "2026-08-02T02:00:01.000Z" });
    dispose();
  });

  it("bounds cursor persistence by least-recently-used scopes and serialized bytes", async () => {
    const persistence = notificationPersistence();
    const harness = connectorHarness();
    const stream = createNotificationStream({
      connector: harness.connector, persistence, getAccessToken: () => "token", maxCursorScopes: 2, maxCursorBytes: 190,
    });
    stream.subscribe(vi.fn());
    const scopes = [scope, { ...scope, principalId: notificationId }, { ...scope, principalId: uploadId }];
    for (let index = 0; index < scopes.length; index += 1) {
      await stream.setSession({ scope: scopes[index]!, origin: "https://core.example.test", endpointAvailable: true });
      await stream.idle();
      await harness.connections[index]!.request.onMessage({ data: JSON.stringify(event(`cursor-${index}`)), lastEventId: `cursor-${index}` });
    }
    expect(Buffer.byteLength(JSON.stringify(persistence.value), "utf8")).toBeLessThanOrEqual(190);
    const cursors = (persistence.value as { cursors: Record<string, string> }).cursors;
    expect(cursors[`${profileId}:${customerInstanceId}:${principalId}`]).toBeUndefined();
    expect(cursors[`${profileId}:${customerInstanceId}:${uploadId}`]).toBe("cursor-2");
  });

  it("validates and bounds events, persists cursor before emit, and settles completed intents", async () => {
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
    expect(settle).toHaveBeenCalledWith(intentHandle, { state: "completed", correlationId: notificationId });
    expect(listener).toHaveBeenCalledOnce();
    expect(persistence.value).toEqual({ version: 1, cursors: { [`${profileId}:${customerInstanceId}:${principalId}`]: "cursor-1" } });
  });

  it("maps validated asynchronous command failures without accepting mixed or incomplete states", async () => {
    const harness = connectorHarness();
    const settle = vi.fn().mockReturnValue(true);
    const listener = vi.fn();
    const stream = createNotificationStream({ connector: harness.connector, persistence: notificationPersistence(), getAccessToken: () => "token", settleCommand: settle });
    await stream.setSession({ scope, origin: "https://core.example.test", endpointAvailable: true });
    stream.subscribe(listener);
    await stream.idle();
    const commandProblem = { title: "Command rejected", detail: "Version changed", code: "VERSION_CONFLICT", status: 409, retryable: false, currentVersion: 7 };
    const failed = { ...event("cursor-problem"), id: "77777777-7777-4777-8777-777777777777", intentHandle, correlationId: notificationId, commandState: "problem" as const, commandProblem };

    await harness.connections[0]!.request.onMessage({ data: JSON.stringify(failed), lastEventId: "cursor-problem" });
    await harness.connections[0]!.request.onMessage({ data: JSON.stringify({ ...event("cursor-mixed"), id: "88888888-8888-4888-8888-888888888888", intentHandle, correlationId: notificationId, commandState: "completed", commandProblem }), lastEventId: "cursor-mixed" });
    await harness.connections[0]!.request.onMessage({ data: JSON.stringify({ ...event("cursor-incomplete"), id: "99999999-9999-4999-8999-999999999999", intentHandle, correlationId: notificationId, commandState: "problem" }), lastEventId: "cursor-incomplete" });
    await harness.connections[0]!.request.onMessage({ data: JSON.stringify({ ...failed, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", cursor: "cursor-unsafe", commandProblem: { ...commandProblem, title: "x".repeat(257) } }), lastEventId: "cursor-unsafe" });

    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(intentHandle, {
      state: "problem",
      correlationId: notificationId,
      problem: { ...commandProblem, correlationId: notificationId },
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(failed);
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
