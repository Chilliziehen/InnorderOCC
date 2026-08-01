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

function harness(initial: string | null = null) {
  let stored = initial === null ? null : `encrypted:${btoa(initial)}`;
  const vault: CredentialVault = {
    decrypt: vi.fn(async () => stored === null ? null : atob(stored.slice("encrypted:".length))),
    encrypt: vi.fn(async (_profileId, value) => { stored = `encrypted:${btoa(value)}`; }),
    remove: vi.fn(async () => { stored = null; }),
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
  });
  return {
    manager,
    core,
    vault,
    get stored() { return stored; },
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

  it("attempts logout revocation but always clears local credentials", async () => {
    const h = harness("R".repeat(43));
    vi.mocked(h.core.logout).mockRejectedValue(new Error("offline"));

    await expect(h.manager.logout()).resolves.toBeUndefined();

    expect(h.core.logout).toHaveBeenCalledWith("R".repeat(43));
    expect(h.stored).toBeNull();
    expect(h.accessToken).toBeNull();
    expect(h.manager.snapshot()).toEqual({ state: "anonymous" });
  });
});
