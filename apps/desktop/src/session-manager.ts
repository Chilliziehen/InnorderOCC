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

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_SNAPSHOT_TIME_MS = Date.parse("9999-12-31T23:59:59.999Z");

interface RefreshFlight {
  profileId: string;
  generation: number;
  promise: Promise<SessionSnapshot>;
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  let current: SessionSnapshot = { state: "anonymous" };
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshInFlight: RefreshFlight | null = null;
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

  async function clearOwned(profileId: string, expectedGeneration: number): Promise<void> {
    if (
      generation === expectedGeneration &&
      (activeProfileId === null || activeProfileId === profileId)
    ) {
      clearMemory();
    }
    await options.vault.remove(profileId);
  }

  function armExpiry(
    profileId: string,
    expectedGeneration: number,
    expiresAtMs: number,
  ): void {
    if (generation !== expectedGeneration || activeProfileId !== profileId) return;
    const remaining = expiresAtMs - now();
    if (remaining <= 0) {
      void clearOwned(profileId, expectedGeneration);
      return;
    }
    expiryTimer = schedule(() => {
      expiryTimer = undefined;
      armExpiry(profileId, expectedGeneration, expiresAtMs);
    }, Math.min(remaining, MAX_TIMEOUT_MS));
  }

  function activate(profileId: string, rawTokens: TokenResponse, rawUser = rawTokens.user): SessionSnapshot {
    const tokens = tokenResponseSchema.parse(rawTokens);
    const user = currentUserSchema.parse(rawUser);
    const nowMs = now();
    const maxSeconds = Math.max(0, (MAX_SNAPSHOT_TIME_MS - nowMs) / 1_000);
    const expiresAtMs = tokens.expiresIn > maxSeconds
      ? MAX_SNAPSHOT_TIME_MS
      : nowMs + tokens.expiresIn * 1_000;
    options.setAccessToken(tokens.accessToken);
    activeProfileId = profileId;
    current = {
      state: "authenticated",
      user,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    if (expiryTimer !== undefined) cancel(expiryTimer);
    armExpiry(profileId, generation, expiresAtMs);
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
    options.setAccessToken(tokens.accessToken);
    const verifiedUser = verifyMe ? await options.core.me() : tokens.user;
    if (generation !== expectedGeneration) {
      await options.vault.remove(profileId);
      return current;
    }
    return activate(profileId, tokens, verifiedUser);
  }

  async function doRefresh(
    profileId: string,
    expectedGeneration: number,
  ): Promise<SessionSnapshot> {
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
      await clearOwned(profileId, expectedGeneration);
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
      try {
        const tokens = await options.core.login(input);
        return await accept(profileId, tokens, false, expectedGeneration);
      } catch (error) {
        await clearOwned(profileId, expectedGeneration);
        throw error;
      }
    },
    restore() {
      return manager.refresh();
    },
    refresh() {
      const profileId = options.getProfileId();
      const expectedGeneration = generation;
      if (
        refreshInFlight?.profileId === profileId &&
        refreshInFlight.generation === expectedGeneration
      ) {
        return refreshInFlight.promise;
      }
      const promise = doRefresh(profileId, expectedGeneration).finally(() => {
        if (refreshInFlight?.promise === promise) refreshInFlight = null;
      });
      refreshInFlight = { profileId, generation: expectedGeneration, promise };
      return promise;
    },
    async profileSwitched() {
      await clear(
        activeProfileId ?? refreshInFlight?.profileId ?? options.getProfileId(),
      );
    },
    async logout() {
      const profileId = activeProfileId ?? options.getProfileId();
      const expectedGeneration = generation;
      let refreshToken: string | null = null;
      try {
        refreshToken = await options.vault.decrypt(profileId);
      } catch {
        // Missing local credentials must not prevent logout.
      }
      await clearOwned(profileId, expectedGeneration);
      if (!refreshToken) return;
      try {
        await options.core.logout(refreshToken);
      } catch {
        // Local logout succeeds even when revocation cannot reach Core.
      }
    },
  };

  return manager;
}
