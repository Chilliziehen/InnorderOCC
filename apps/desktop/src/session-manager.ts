import {
  currentUserSchema,
  tokenResponseSchema,
  type LoginRequest,
  type TokenResponse,
} from "@innorder/contracts";

import type { SessionSnapshot } from "./desktop-contract";
import type { CoreClient } from "./core-client";

export interface CredentialVault {
  decrypt(profileId: string): Promise<string | null>;
  encrypt(profileId: string, refreshToken: string): Promise<void>;
  remove(profileId: string): Promise<void>;
}

interface SessionManagerOptions {
  core: CoreClient;
  vault: CredentialVault;
  getProfileId: () => string;
  setAccessToken: (accessToken: string | null) => void;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export interface SessionManager {
  snapshot(): SessionSnapshot;
  login(input: LoginRequest): Promise<SessionSnapshot>;
  restore(): Promise<SessionSnapshot>;
  refresh(): Promise<SessionSnapshot>;
  profileSwitched(): Promise<void>;
  logout(): Promise<void>;
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  let current: SessionSnapshot = { state: "anonymous" };
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshInFlight: Promise<SessionSnapshot> | null = null;
  let activeProfileId: string | null = null;
  let generation = 0;

  function clearMemory(): void {
    if (expiryTimer !== undefined) cancel(expiryTimer);
    expiryTimer = undefined;
    options.setAccessToken(null);
    current = { state: "anonymous" };
    activeProfileId = null;
    generation += 1;
  }

  async function clear(profileId: string): Promise<void> {
    clearMemory();
    await options.vault.remove(profileId);
  }

  function activate(profileId: string, rawTokens: TokenResponse, rawUser = rawTokens.user): SessionSnapshot {
    const tokens = tokenResponseSchema.parse(rawTokens);
    const user = currentUserSchema.parse(rawUser);
    const expiresAtMs = now() + tokens.expiresIn * 1_000;
    options.setAccessToken(tokens.accessToken);
    activeProfileId = profileId;
    current = {
      state: "authenticated",
      user,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    if (expiryTimer !== undefined) cancel(expiryTimer);
    expiryTimer = schedule(() => {
      clearMemory();
      void options.vault.remove(profileId);
    }, Math.max(0, expiresAtMs - now()));
    return current;
  }

  async function accept(
    profileId: string,
    rawTokens: TokenResponse,
    verifyMe: boolean,
    expectedGeneration: number,
  ) {
    const tokens = tokenResponseSchema.parse(rawTokens);
    if (generation !== expectedGeneration) return current;
    await options.vault.encrypt(profileId, tokens.refreshToken);
    if (generation !== expectedGeneration) {
      await options.vault.remove(profileId);
      return current;
    }
    try {
      options.setAccessToken(tokens.accessToken);
      const verifiedUser = verifyMe ? await options.core.me() : tokens.user;
      if (generation !== expectedGeneration) {
        await options.vault.remove(profileId);
        return current;
      }
      return activate(profileId, tokens, verifiedUser);
    } catch (error) {
      await clear(profileId);
      throw error;
    }
  }

  async function doRefresh(): Promise<SessionSnapshot> {
    const profileId = options.getProfileId();
    const expectedGeneration = generation;
    try {
      const refreshToken = await options.vault.decrypt(profileId);
      if (generation !== expectedGeneration) return current;
      if (!refreshToken) {
        clearMemory();
        return current;
      }
      const tokens = await options.core.refresh(refreshToken);
      if (generation !== expectedGeneration) return current;
      return await accept(profileId, tokens, true, expectedGeneration);
    } catch (error) {
      await clear(profileId);
      throw error;
    }
  }

  const manager: SessionManager = {
    snapshot() {
      if (current.state === "authenticated" && Date.parse(current.expiresAt) <= now()) {
        const profileId = activeProfileId ?? options.getProfileId();
        clearMemory();
        void options.vault.remove(profileId);
      }
      return current;
    },
    async login(input) {
      const profileId = options.getProfileId();
      const expectedGeneration = generation;
      const tokens = await options.core.login(input);
      try {
        return await accept(profileId, tokens, false, expectedGeneration);
      } catch (error) {
        await clear(profileId);
        throw error;
      }
    },
    restore() {
      return manager.refresh();
    },
    refresh() {
      if (!refreshInFlight) {
        refreshInFlight = doRefresh().finally(() => {
          refreshInFlight = null;
        });
      }
      return refreshInFlight;
    },
    async profileSwitched() {
      await clear(activeProfileId ?? options.getProfileId());
    },
    async logout() {
      const profileId = activeProfileId ?? options.getProfileId();
      try {
        const refreshToken = await options.vault.decrypt(profileId);
        if (refreshToken) await options.core.logout(refreshToken);
      } catch {
        // Local logout must succeed even when revocation cannot reach Core.
      } finally {
        await clear(profileId);
      }
    },
  };

  return manager;
}
