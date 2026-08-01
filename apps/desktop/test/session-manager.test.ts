import { describe, expect, it, vi } from "vitest";

import type { CoreClient } from "../src/core-client";
import {
  createSessionManager,
  type CredentialVault,
} from "../src/session-manager";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "operator",
  displayName: "Operator",
  status: "ACTIVE" as const,
  capabilities: ["orders:read"],
};
const token = (suffix: string, expiresIn = 300) => ({
  tokenType: "Bearer" as const,
  accessToken: `access-${suffix}`,
  refreshToken: suffix.repeat(43).slice(0, 43),
  expiresIn,
  user,
});

function harness(
  initial: string | null = null,
  timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout"> = globalThis,
) {
  const stored = new Map<string, string>();
  if (initial !== null) stored.set("profile-a", `encrypted:${btoa(initial)}`);
  const vault: CredentialVault = {
    decrypt: vi.fn(async (id) => {
      const value = stored.get(id);
      return value === undefined ? null : atob(value.slice("encrypted:".length));
    }),
    encrypt: vi.fn(async (id, value) => { stored.set(id, `encrypted:${btoa(value)}`); }),
    remove: vi.fn(async (id) => { stored.delete(id); }),
  };
  let accessToken: string | null = null;
  const core: CoreClient = {
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
    systemStatus: vi.fn(),
  };
  let now = Date.parse("2026-08-01T12:00:00.000Z");
  let profileId = "profile-a";
  const manager = createSessionManager({
    core,
    vault,
    getProfileId: () => profileId,
    setAccessToken: (value) => { accessToken = value; },
    now: () => now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return {
    manager,
    core,
    vault,
    get stored() { return stored.get(profileId) ?? null; },
    storedFor(id: string) { return stored.get(id) ?? null; },
    seedProfile(id: string, value: string) { stored.set(id, `encrypted:${btoa(value)}`); },
    get accessToken() { return accessToken; },
    advance(ms: number) { now += ms; },
    selectProfile(id: string) { profileId = id; },
  };
}

describe("Session manager", () => {
  it("logs in, persists only the refresh token, and returns a secret-free snapshot", async () => {
    const h = harness();
    vi.mocked(h.core.login).mockResolvedValue(token("R"));

    const snapshot = await h.manager.login({ username: "operator", password: "correct horse" });

    expect(snapshot).toEqual({
      state: "authenticated",
      user,
      expiresAt: "2026-08-01T12:05:00.000Z",
    });
    expect(h.stored).not.toContain("R".repeat(43));
    expect(h.stored).not.toContain("access-R");
    expect(h.accessToken).toBe("access-R");
    expect(JSON.stringify(snapshot)).not.toMatch(/access-R|RRRR/);
    expect(h.vault.encrypt).toHaveBeenCalledWith("profile-a", "R".repeat(43));
  });

  it("does not persist or retain anything when login fails", async () => {
    const h = harness();
    vi.mocked(h.core.login).mockRejectedValue(new Error("denied"));

    await expect(h.manager.login({ username: "operator", password: "correct horse" })).rejects.toThrow("denied");

    expect(h.vault.encrypt).not.toHaveBeenCalled();
    expect(h.accessToken).toBeNull();
    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
  });

  it("restores with the encrypted vault refresh value, rotates it, and verifies /me", async () => {
    const h = harness("O".repeat(43));
    vi.mocked(h.core.refresh).mockResolvedValue(token("N"));
    vi.mocked(h.core.me).mockResolvedValue(user);

    const snapshot = await h.manager.restore();

    expect(h.core.refresh).toHaveBeenCalledWith("O".repeat(43));
    expect(h.core.me).toHaveBeenCalledOnce();
    expect(h.stored).not.toContain("N".repeat(43));
    expect(h.accessToken).toBe("access-N");
    expect(snapshot.state).toBe("authenticated");
  });

  it("serializes concurrent refreshes and rotates the vault once", async () => {
    const h = harness("O".repeat(43));
    let resolve!: (value: ReturnType<typeof token>) => void;
    vi.mocked(h.core.refresh).mockReturnValue(new Promise((done) => { resolve = done; }));
    vi.mocked(h.core.me).mockResolvedValue(user);

    const first = h.manager.refresh();
    const second = h.manager.refresh();
    resolve(token("N"));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ state: "authenticated" }),
      expect.objectContaining({ state: "authenticated" }),
    ]);
    expect(h.core.refresh).toHaveBeenCalledOnce();
    expect(h.vault.encrypt).toHaveBeenCalledOnce();
  });

  it("clears credentials after failed refresh", async () => {
    const h = harness("O".repeat(43));
    vi.mocked(h.core.refresh).mockRejectedValue(new Error("expired"));

    await expect(h.manager.refresh()).rejects.toThrow("expired");

    expect(h.stored).toBeNull();
    expect(h.accessToken).toBeNull();
    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
  });

  it("expires explicitly when the snapshot is observed past expiry", async () => {
    const h = harness();
    vi.mocked(h.core.login).mockResolvedValue(token("R", 1));
    await h.manager.login({ username: "operator", password: "correct horse" });

    h.advance(1_000);

    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
    expect(h.accessToken).toBeNull();
    await vi.waitFor(() => expect(h.vault.remove).toHaveBeenCalledWith("profile-a"));
  });

  it("proactively expires via an injected scheduler", async () => {
    vi.useFakeTimers();
    const h = harness();
    vi.mocked(h.core.login).mockResolvedValue(token("R", 1));
    await h.manager.login({ username: "operator", password: "correct horse" });

    h.advance(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
    expect(h.accessToken).toBeNull();
    vi.useRealTimers();
  });

  it("clears the old profile session on profile switch", async () => {
    const h = harness();
    vi.mocked(h.core.login).mockResolvedValue(token("R"));
    await h.manager.login({ username: "operator", password: "correct horse" });

    h.selectProfile("profile-b");
    await h.manager.profileSwitched();

    expect(h.vault.remove).toHaveBeenCalledWith("profile-a");
    expect(h.accessToken).toBeNull();
    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
  });

  it("does not restore an old session when refresh finishes after a profile switch", async () => {
    const h = harness("O".repeat(43));
    let resolve!: (value: ReturnType<typeof token>) => void;
    vi.mocked(h.core.refresh).mockReturnValue(new Promise((done) => { resolve = done; }));
    vi.mocked(h.core.me).mockResolvedValue(user);
    const pending = h.manager.refresh();
    await vi.waitFor(() => expect(h.core.refresh).toHaveBeenCalledOnce());

    h.selectProfile("profile-b");
    await h.manager.profileSwitched();
    resolve(token("N"));
    await pending;

    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
    expect(h.accessToken).toBeNull();
    expect(h.stored).toBeNull();
  });

  it("a rejecting refresh from profile A cannot clear authenticated profile B", async () => {
    const h = harness("A".repeat(43));
    let rejectA!: (error: Error) => void;
    vi.mocked(h.core.refresh).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectA = reject; }));
    const refreshA = h.manager.refresh();
    await vi.waitFor(() => expect(h.core.refresh).toHaveBeenCalledOnce());

    h.selectProfile("profile-b");
    await h.manager.profileSwitched();
    vi.mocked(h.core.login).mockResolvedValue(token("B"));
    await h.manager.login({ username: "operator", password: "correct horse" });
    rejectA(new Error("A refresh failed"));

    await expect(refreshA).rejects.toThrow("A refresh failed");
    expect(h.manager.snapshot().state).toBe("authenticated");
    expect(h.accessToken).toBe("access-B");
    expect(h.storedFor("profile-a")).toBeNull();
    expect(h.storedFor("profile-b")).not.toBeNull();
  });

  it("a rejecting /me from profile A cannot clear authenticated profile B", async () => {
    const h = harness("A".repeat(43));
    let rejectMeA!: (error: Error) => void;
    vi.mocked(h.core.refresh).mockResolvedValueOnce(token("N"));
    vi.mocked(h.core.me).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectMeA = reject; }));
    const refreshA = h.manager.refresh();
    await vi.waitFor(() => expect(h.core.me).toHaveBeenCalledOnce());

    h.selectProfile("profile-b");
    await h.manager.profileSwitched();
    vi.mocked(h.core.login).mockResolvedValue(token("B"));
    await h.manager.login({ username: "operator", password: "correct horse" });
    rejectMeA(new Error("A me failed"));

    await expect(refreshA).rejects.toThrow("A me failed");
    expect(h.manager.snapshot().state).toBe("authenticated");
    expect(h.accessToken).toBe("access-B");
    expect(h.storedFor("profile-a")).toBeNull();
    expect(h.storedFor("profile-b")).not.toBeNull();
  });

  it("scopes in-flight refresh by profile and generation", async () => {
    const h = harness("A".repeat(43));
    let resolveA!: (value: ReturnType<typeof token>) => void;
    vi.mocked(h.core.refresh)
      .mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve; }))
      .mockResolvedValueOnce(token("B"));
    vi.mocked(h.core.me).mockResolvedValue(user);
    const refreshA = h.manager.refresh();
    await vi.waitFor(() => expect(h.core.refresh).toHaveBeenCalledOnce());

    h.selectProfile("profile-b");
    await h.manager.profileSwitched();
    h.seedProfile("profile-b", "B".repeat(43));
    const restoreB = h.manager.restore();

    await expect(restoreB).resolves.toMatchObject({ state: "authenticated" });
    expect(h.core.refresh).toHaveBeenCalledTimes(2);
    expect(h.accessToken).toBe("access-B");
    resolveA(token("N"));
    await refreshA;
    expect(h.accessToken).toBe("access-B");
  });

  it("attempts logout revocation but always clears local credentials", async () => {
    const h = harness("R".repeat(43));
    vi.mocked(h.core.logout).mockRejectedValue(new Error("offline"));

    await expect(h.manager.logout()).resolves.toBeUndefined();

    expect(h.core.logout).toHaveBeenCalledWith("R".repeat(43));
    expect(h.stored).toBeNull();
    expect(h.accessToken).toBeNull();
    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
  });

  it("clears logout locally before revocation and cannot later clear profile B", async () => {
    const h = harness();
    vi.mocked(h.core.login).mockResolvedValueOnce(token("A")).mockResolvedValueOnce(token("B"));
    await h.manager.login({ username: "operator", password: "correct horse" });
    let rejectLogoutA!: (error: Error) => void;
    vi.mocked(h.core.logout).mockReturnValue(new Promise((_resolve, reject) => { rejectLogoutA = reject; }));

    const logoutA = h.manager.logout();
    await vi.waitFor(() => expect(h.core.logout).toHaveBeenCalledOnce());
    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
    expect(h.accessToken).toBeNull();

    h.selectProfile("profile-b");
    await h.manager.profileSwitched();
    await h.manager.login({ username: "operator", password: "correct horse" });
    rejectLogoutA(new Error("offline"));
    await logoutA;

    expect(h.manager.snapshot().state).toBe("authenticated");
    expect(h.accessToken).toBe("access-B");
    expect(h.storedFor("profile-b")).not.toBeNull();
  });

  it("chunks long expiry timers at the signed 32-bit timeout maximum", async () => {
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    const timers = {
      setTimeout: ((callback: () => void, delay?: number) => {
        callbacks.push(callback);
        delays.push(delay ?? 0);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeout: vi.fn<typeof clearTimeout>(),
    };
    const h = harness(null, timers);
    vi.mocked(h.core.login).mockResolvedValue(token("R", 2_147_484));

    await h.manager.login({ username: "operator", password: "correct horse" });
    expect(delays).toEqual([2_147_483_647]);

    h.advance(2_147_483_647);
    callbacks[0]?.();
    expect(delays).toEqual([2_147_483_647, 353]);
    expect(h.manager.snapshot().state).toBe("authenticated");
  });

  it("bounds maximum contract expiry to a representable snapshot date", async () => {
    const delays: number[] = [];
    const timers = {
      setTimeout: ((_callback: () => void, delay?: number) => {
        delays.push(delay ?? 0);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeout: vi.fn<typeof clearTimeout>(),
    };
    const h = harness(null, timers);
    vi.mocked(h.core.login).mockResolvedValue(token("R", Number.MAX_SAFE_INTEGER));

    await expect(h.manager.login({
      username: "operator",
      password: "correct horse",
    })).resolves.toMatchObject({
      state: "authenticated",
      expiresAt: "9999-12-31T23:59:59.999Z",
    });
    expect(delays).toEqual([2_147_483_647]);
  });
});
