import { describe, expect, it, vi } from "vitest";

import { createCoreClient, type CoreClient } from "../src/core-client";
import {
  createSessionManager,
  customerInstanceIdFromAccessToken,
  type CredentialVault,
  type VaultCredential,
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
  onBackgroundError?: (error: unknown) => void,
) {
  const stored = new Map<string, string>();
  let removeGate: Promise<void> | null = null;
  let releaseRemove: (() => void) | null = null;
  const encode = (credential: VaultCredential) => `encrypted:${btoa(JSON.stringify(credential))}`;
  const decode = (value: string): VaultCredential => JSON.parse(atob(value.slice("encrypted:".length)));
  if (initial !== null) stored.set("profile-a", encode({ refreshToken: initial, version: "initial-a" }));
  const vault: CredentialVault = {
    decrypt: vi.fn(async (id) => {
      const value = stored.get(id);
      return value === undefined ? null : decode(value);
    }),
    encrypt: vi.fn(async (id, credential) => { stored.set(id, encode(credential)); }),
    remove: vi.fn(async (id, version) => {
      await removeGate;
      const value = stored.get(id);
      if (value !== undefined && decode(value).version === version) stored.delete(id);
    }),
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
    ...(onBackgroundError === undefined ? {} : { onBackgroundError }),
  });
  return {
    manager,
    core,
    vault,
    get stored() { return stored.get(profileId) ?? null; },
    storedFor(id: string) { return stored.get(id) ?? null; },
    seedProfile(id: string, value: string) {
      stored.set(id, encode({ refreshToken: value, version: `seed-${id}` }));
    },
    pauseNextRemove() {
      removeGate = new Promise((resolve) => { releaseRemove = resolve; });
      return () => {
        releaseRemove?.();
        removeGate = null;
        releaseRemove = null;
      };
    },
    get accessToken() { return accessToken; },
    advance(ms: number) { now += ms; },
    selectProfile(id: string) { profileId = id; },
  };
}

describe("Session manager", () => {
  it("extracts only a bounded UUID customer instance claim from a JWT payload", () => {
    const customerInstanceId = "22222222-2222-4222-8222-222222222222";
    const payload = Buffer.from(JSON.stringify({ instance_id: customerInstanceId })).toString("base64url");
    expect(customerInstanceIdFromAccessToken(`header.${payload}.signature`)).toBe(customerInstanceId);
    expect(customerInstanceIdFromAccessToken("opaque-token")).toBeNull();
    expect(customerInstanceIdFromAccessToken(`header.${Buffer.from(JSON.stringify({ instance_id: "not-uuid" })).toString("base64url")}.signature`)).toBeNull();
    expect(customerInstanceIdFromAccessToken(`header.${"a".repeat(16_385)}.signature`)).toBeNull();
  });

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
    expect(h.vault.encrypt).toHaveBeenCalledWith("profile-a", {
      refreshToken: "R".repeat(43),
      version: expect.any(String),
    });
  });

  it("does not persist or retain anything when login fails", async () => {
    const h = harness();
    vi.mocked(h.core.login).mockRejectedValue(new Error("denied"));

    await expect(h.manager.login({ username: "operator", password: "correct horse" })).rejects.toThrow("denied");

    expect(h.vault.encrypt).not.toHaveBeenCalled();
    expect(h.accessToken).toBeNull();
    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
  });

  it("a failed login cannot clear a restore started after it", async () => {
    const h = harness("O".repeat(43));
    let rejectLogin!: (error: Error) => void;
    vi.mocked(h.core.login).mockReturnValue(new Promise((_resolve, reject) => { rejectLogin = reject; }));
    vi.mocked(h.core.refresh).mockResolvedValue(token("N"));
    vi.mocked(h.core.me).mockResolvedValue(user);
    const login = h.manager.login({ username: "operator", password: "correct horse" });
    const loginFailure = expect(login).rejects.toThrow("denied");

    await expect(h.manager.restore()).resolves.toMatchObject({ state: "authenticated" });
    rejectLogin(new Error("denied"));
    await loginFailure;

    expect(h.manager.snapshot().state).toBe("authenticated");
    expect(h.accessToken).toBe("access-N");
    expect(h.storedFor("profile-a")).not.toBeNull();
  });

  it("a restore started before a successful login cannot overwrite that login", async () => {
    const h = harness("O".repeat(43));
    let resolveRestore!: (value: ReturnType<typeof token>) => void;
    vi.mocked(h.core.refresh).mockReturnValue(new Promise((resolve) => { resolveRestore = resolve; }));
    vi.mocked(h.core.me).mockResolvedValue(user);
    const restore = h.manager.restore();
    await vi.waitFor(() => expect(h.core.refresh).toHaveBeenCalledOnce());

    vi.mocked(h.core.login).mockResolvedValue(token("L"));
    await h.manager.login({ username: "operator", password: "correct horse" });
    resolveRestore(token("N"));
    await restore;

    expect(h.manager.snapshot().state).toBe("authenticated");
    expect(h.accessToken).toBe("access-L");
    expect(h.storedFor("profile-a")).not.toBeNull();
  });

  it("a successful same-profile login intentionally replaces the current session", async () => {
    const h = harness();
    vi.mocked(h.core.login).mockResolvedValueOnce(token("A")).mockResolvedValueOnce(token("L"));
    await h.manager.login({ username: "operator", password: "correct horse" });

    const replacement = await h.manager.login({
      username: "operator",
      password: "different horse",
    });

    expect(replacement.state).toBe("authenticated");
    expect(h.accessToken).toBe("access-L");
    expect(h.vault.encrypt).toHaveBeenCalledTimes(2);
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
    await vi.waitFor(() => expect(h.vault.remove).toHaveBeenCalledWith(
      "profile-a",
      expect.any(String),
    ));
  });

  it("handles rejected background expiry cleanup and permits a newer session", async () => {
    const onBackgroundError = vi.fn<(error: unknown) => void>();
    const h = harness(null, globalThis, onBackgroundError);
    vi.mocked(h.core.login).mockResolvedValueOnce(token("A", 1)).mockResolvedValueOnce(token("C"));
    await h.manager.login({ username: "operator", password: "correct horse" });
    vi.mocked(h.vault.remove).mockRejectedValueOnce(new Error("background remove failed"));
    h.advance(1_000);

    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
    await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "background remove failed" }),
    ));
    expect(h.accessToken).toBeNull();

    await h.manager.login({ username: "operator", password: "correct horse" });
    expect(h.manager.snapshot().state).toBe("authenticated");
    expect(h.accessToken).toBe("access-C");
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
    await h.manager.profileSwitched("profile-a");

    expect(h.vault.remove).toHaveBeenCalledWith("profile-a", expect.any(String));
    expect(h.accessToken).toBeNull();
    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
  });

  it("clears an explicit unrestored previous profile instead of the new selection", async () => {
    const h = harness("A".repeat(43));
    h.seedProfile("profile-b", "B".repeat(43));

    h.selectProfile("profile-b");
    await h.manager.profileSwitched("profile-a");

    expect(h.storedFor("profile-a")).toBeNull();
    expect(h.storedFor("profile-b")).not.toBeNull();
  });

  it("does not restore an old session when refresh finishes after a profile switch", async () => {
    const h = harness("O".repeat(43));
    let resolve!: (value: ReturnType<typeof token>) => void;
    vi.mocked(h.core.refresh).mockReturnValue(new Promise((done) => { resolve = done; }));
    vi.mocked(h.core.me).mockResolvedValue(user);
    const pending = h.manager.refresh();
    await vi.waitFor(() => expect(h.core.refresh).toHaveBeenCalledOnce());

    h.selectProfile("profile-b");
    await h.manager.profileSwitched("profile-a");
    resolve(token("N"));
    await pending;

    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
    expect(h.accessToken).toBeNull();
    expect(h.stored).toBeNull();
  });

  it("revokes a successful login discarded by a profile switch", async () => {
    const h = harness();
    let resolveLogin!: (value: ReturnType<typeof token>) => void;
    vi.mocked(h.core.login).mockReturnValue(new Promise((resolve) => { resolveLogin = resolve; }));
    vi.mocked(h.core.logout).mockResolvedValue();
    const login = h.manager.login({ username: "operator", password: "correct horse" });

    h.selectProfile("profile-b");
    await h.manager.profileSwitched("profile-a");
    resolveLogin(token("A"));
    await login;

    expect(h.core.logout).toHaveBeenCalledWith("A".repeat(43), "access-A");
    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
  });

  it("revokes a successful refresh discarded by logout", async () => {
    const h = harness("O".repeat(43));
    let resolveRefresh!: (value: ReturnType<typeof token>) => void;
    vi.mocked(h.core.refresh).mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve; }));
    vi.mocked(h.core.logout).mockResolvedValue();
    const restore = h.manager.restore();
    await vi.waitFor(() => expect(h.core.refresh).toHaveBeenCalledOnce());

    await h.manager.logout();
    resolveRefresh(token("N"));
    await restore;

    expect(h.core.logout).toHaveBeenCalledWith("N".repeat(43), "access-N");
    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
  });

  it("revokes a stale session even when its vault removal fails", async () => {
    const h = harness("O".repeat(43));
    let resolveMe!: (value: typeof user) => void;
    vi.mocked(h.core.refresh).mockResolvedValue(token("N"));
    vi.mocked(h.core.me).mockReturnValue(new Promise((resolve) => { resolveMe = resolve; }));
    vi.mocked(h.core.logout).mockResolvedValue();
    const restore = h.manager.restore();
    await vi.waitFor(() => expect(h.core.me).toHaveBeenCalledOnce());

    vi.mocked(h.core.login).mockResolvedValue(token("C"));
    await h.manager.login({ username: "operator", password: "correct horse" });
    vi.mocked(h.vault.remove).mockRejectedValue(new Error("vault remove failed"));
    const restoreFailure = expect(restore).rejects.toThrow("vault remove failed");
    resolveMe(user);
    await restoreFailure;

    expect(h.core.logout).toHaveBeenCalledWith("N".repeat(43), "access-N");
    expect(h.manager.snapshot().state).toBe("authenticated");
    expect(h.accessToken).toBe("access-C");
  });

  it("a rejecting refresh from profile A cannot clear authenticated profile B", async () => {
    const h = harness("A".repeat(43));
    let rejectA!: (error: Error) => void;
    vi.mocked(h.core.refresh).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectA = reject; }));
    const refreshA = h.manager.refresh();
    await vi.waitFor(() => expect(h.core.refresh).toHaveBeenCalledOnce());

    h.selectProfile("profile-b");
    await h.manager.profileSwitched("profile-a");
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
    await h.manager.profileSwitched("profile-a");
    vi.mocked(h.core.login).mockResolvedValue(token("B"));
    await h.manager.login({ username: "operator", password: "correct horse" });
    rejectMeA(new Error("A me failed"));

    await expect(refreshA).rejects.toThrow("A me failed");
    expect(h.manager.snapshot().state).toBe("authenticated");
    expect(h.accessToken).toBe("access-B");
    expect(h.storedFor("profile-a")).toBeNull();
    expect(h.storedFor("profile-b")).not.toBeNull();
  });

  it("a stale rejecting refresh cannot remove a newer profile A credential", async () => {
    const h = harness("A".repeat(43));
    let rejectOldA!: (error: Error) => void;
    vi.mocked(h.core.refresh).mockReturnValue(new Promise((_resolve, reject) => { rejectOldA = reject; }));
    const oldRefresh = h.manager.refresh();
    await vi.waitFor(() => expect(h.core.refresh).toHaveBeenCalledOnce());

    h.selectProfile("profile-b");
    await h.manager.profileSwitched("profile-a");
    h.selectProfile("profile-a");
    await h.manager.profileSwitched("profile-b");
    vi.mocked(h.core.login).mockResolvedValue(token("C"));
    await h.manager.login({ username: "operator", password: "correct horse" });
    rejectOldA(new Error("old A refresh failed"));

    await expect(oldRefresh).rejects.toThrow("old A refresh failed");
    expect(h.accessToken).toBe("access-C");
    expect(h.storedFor("profile-a")).not.toBeNull();
  });

  it("a stale rejecting /me cannot remove a newer profile A credential", async () => {
    const h = harness("A".repeat(43));
    let rejectOldMe!: (error: Error) => void;
    vi.mocked(h.core.refresh).mockResolvedValue(token("N"));
    vi.mocked(h.core.me).mockReturnValue(new Promise((_resolve, reject) => { rejectOldMe = reject; }));
    const oldRefresh = h.manager.refresh();
    await vi.waitFor(() => expect(h.core.me).toHaveBeenCalledOnce());

    h.selectProfile("profile-b");
    await h.manager.profileSwitched("profile-a");
    h.selectProfile("profile-a");
    await h.manager.profileSwitched("profile-b");
    vi.mocked(h.core.login).mockResolvedValue(token("C"));
    await h.manager.login({ username: "operator", password: "correct horse" });
    rejectOldMe(new Error("old A me failed"));

    await expect(oldRefresh).rejects.toThrow("old A me failed");
    expect(h.accessToken).toBe("access-C");
    expect(h.storedFor("profile-a")).not.toBeNull();
  });

  it("serializes expiry removal before a same-profile relogin write", async () => {
    const h = harness();
    vi.mocked(h.core.login).mockResolvedValueOnce(token("A", 1)).mockResolvedValueOnce(token("C"));
    await h.manager.login({ username: "operator", password: "correct horse" });
    const releaseRemove = h.pauseNextRemove();
    h.advance(1_000);

    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
    await vi.waitFor(() => expect(h.vault.remove).toHaveBeenCalledOnce());
    const relogin = h.manager.login({ username: "operator", password: "correct horse" });
    await Promise.resolve();
    expect(h.vault.encrypt).toHaveBeenCalledOnce();
    releaseRemove();
    await relogin;

    expect(h.vault.encrypt).toHaveBeenCalledTimes(2);
    expect(h.accessToken).toBe("access-C");
    expect(h.storedFor("profile-a")).not.toBeNull();
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
    await h.manager.profileSwitched("profile-a");
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
    const h = harness();
    vi.mocked(h.core.login).mockResolvedValue(token("R"));
    await h.manager.login({ username: "operator", password: "correct horse" });
    vi.mocked(h.core.logout).mockRejectedValue(new Error("offline"));

    await expect(h.manager.logout()).resolves.toBeUndefined();

    expect(h.core.logout).toHaveBeenCalledWith("R".repeat(43), "access-R");
    expect(h.stored).toBeNull();
    expect(h.accessToken).toBeNull();
    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
  });

  it("attempts logout revocation when vault removal fails", async () => {
    const h = harness();
    vi.mocked(h.core.login).mockResolvedValue(token("R"));
    await h.manager.login({ username: "operator", password: "correct horse" });
    vi.mocked(h.vault.remove).mockRejectedValue(new Error("vault remove failed"));
    vi.mocked(h.core.logout).mockResolvedValue();

    await expect(h.manager.logout()).rejects.toThrow("vault remove failed");

    expect(h.core.logout).toHaveBeenCalledWith("R".repeat(43), "access-R");
    expect(h.accessToken).toBeNull();
    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
  });

  it("sends the captured bearer while clearing local access before logout", async () => {
    let accessToken: string | null = null;
    let stored: VaultCredential | null = null;
    const vault: CredentialVault = {
      decrypt: vi.fn(async () => stored),
      encrypt: vi.fn(async (_profileId, credential) => { stored = credential; }),
      remove: vi.fn(async (_profileId, version) => {
        if (stored?.version === version) stored = null;
      }),
    };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(token("A")), {
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const core = createCoreClient({
      fetch: fetchImpl,
      getOrigin: () => "https://core.example.test",
      getAccessToken: () => accessToken,
      timeoutMs: 250,
    });
    const manager = createSessionManager({
      core,
      vault,
      getProfileId: () => "profile-a",
      setAccessToken: (value) => { accessToken = value; },
    });
    await manager.login({ username: "operator", password: "correct horse" });

    await manager.logout();

    expect(accessToken).toBeNull();
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer access-A",
    );
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
    await h.manager.profileSwitched("profile-a");
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

  it("disposes background timers and memory without deleting the encrypted credential", async () => {
    const timers = {
      setTimeout: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
      clearTimeout: vi.fn<typeof clearTimeout>(),
    };
    const h = harness(null, timers);
    vi.mocked(h.core.login).mockResolvedValue(token("dispose"));

    await h.manager.login({ username: "operator", password: "correct horse battery staple" });
    const encrypted = h.stored;
    h.manager.dispose();

    expect(timers.clearTimeout).toHaveBeenCalled();
    expect(h.accessToken).toBeNull();
    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
    expect(h.stored).toBe(encrypted);
  });
});
