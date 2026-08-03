import { describe, expect, it, vi } from "vitest";

import { createConnectivityTracker } from "../src/connectivity";
import { createCoreClient } from "../src/core-client";
import { createMainReliabilityApi } from "../src/main-reliability-composition";
import { createEvidenceUploadService } from "../src/evidence-upload";

const profile = { id: "11111111-1111-4111-8111-111111111111", name: "Pilot", origin: "https://core.example.test", environment: "pilot" as const };
const principalId = "22222222-2222-4222-8222-222222222222";
const customerInstanceId = "33333333-3333-4333-8333-333333333333";
const checkedAt = "2026-08-02T00:00:00.000Z";

function status(state: "READY" | "UNREACHABLE") {
  return { service: "occ-core", version: state === "READY" ? "1.0.0" : "unknown", state, checkedAt, components: [] } as const;
}

describe("main-owned Core connectivity", () => {
  it("starts authenticated sessions conservatively and follows fresh Core runtime status", async () => {
    const connectivity = createConnectivityTracker();
    const authenticated = { state: "authenticated" as const, user: { id: principalId, username: "user", displayName: "User", status: "ACTIVE" as const, capabilities: [] }, expiresAt: "2026-08-03T00:00:00.000Z" };
    const statuses = vi.fn()
      .mockResolvedValueOnce([status("READY")])
      .mockResolvedValueOnce([status("UNREACHABLE")]);
    const transport = vi.fn();
    const uploads = createEvidenceUploadService({
      spoolDirectory: "D:\\occ-connectivity-test-spool",
      getProfile: () => ({ origin: profile.origin, endpointAvailable: true }), getAccessToken: () => "token",
      isOnline: connectivity.isOnline, transport,
    });
    const api = createMainReliabilityApi({
      profiles: { list: vi.fn(), selected: () => profile, save: vi.fn(), select: vi.fn(), remove: vi.fn(), validate: vi.fn() } as never,
      session: { restore: vi.fn().mockResolvedValue(authenticated), login: vi.fn(), logout: vi.fn(async () => connectivity.recordRequestOutcome("success")), profileSwitched: vi.fn() },
      statuses,
      clearProfile: vi.fn(),
      readCache: { query: vi.fn(), purgeAccount: vi.fn() },
      notificationStream: { setSession: vi.fn() },
      uploads,
      getCustomerInstanceId: () => customerInstanceId,
      connectivity,
    });
    await api.session.restore();
    await expect(api.commands.execute({ workspace: "risks", operation: "acknowledge", targetId: "risk-1", payload: {}, idempotencyKey: profile.id })).rejects.toThrow("offline");
    await expect(api.uploads.preflight({ workspace: "my-work", taskId: "task-1", fileName: "evidence.pdf", mediaType: "application/pdf", size: 4, intentHandle: profile.id })).rejects.toThrow("offline");
    expect(connectivity.isOnline()).toBe(false);

    await api.runtime.statuses();
    expect(connectivity.isOnline()).toBe(true);
    await expect(api.uploads.preflight({ workspace: "my-work", taskId: "task-1", fileName: "evidence.pdf", mediaType: "application/pdf", size: 4, intentHandle: profile.id })).resolves.toMatchObject({ state: "available" });
    await expect(api.commands.execute({ workspace: "risks", operation: "acknowledge", targetId: "risk-1", payload: {}, idempotencyKey: profile.id })).resolves.toMatchObject({ state: "unavailable" });
    await api.session.logout();
    expect(connectivity.isOnline()).toBe(false);
    await api.runtime.statuses();
    expect(connectivity.isOnline()).toBe(false);
    await expect(api.uploads.preflight({ workspace: "my-work", taskId: "task-1", fileName: "evidence.pdf", mediaType: "application/pdf", size: 4, intentHandle: profile.id })).rejects.toThrow("offline");
    expect(transport).not.toHaveBeenCalled();
  });

  it("records only validated Core successes and network failures", async () => {
    const connectivity = createConnectivityTracker();
    const valid = new Response(JSON.stringify({ service: "occ-core", version: "1.0.0", state: "READY", checkedAt, components: [] }), { status: 200, headers: { "content-type": "application/json" } });
    const fetchImpl = vi.fn().mockResolvedValueOnce(valid).mockRejectedValueOnce(new TypeError("network"));
    const core = createCoreClient({ fetch: fetchImpl, getOrigin: () => profile.origin, getAccessToken: () => null, timeoutMs: 1_000, onConnectivityChange: connectivity.recordRequestOutcome });
    await core.systemStatus();
    expect(connectivity.isOnline()).toBe(true);
    await expect(core.systemStatus()).rejects.toMatchObject({ problem: { code: "NETWORK_ERROR" } });
    expect(connectivity.isOnline()).toBe(false);
  });
});
