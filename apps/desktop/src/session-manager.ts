import {
  currentUserSchema,
  tokenResponseSchema,
  type LoginRequest,
  type TokenResponse,
} from "@innorder/contracts";

import type { SessionSnapshot } from "./desktop-contract";
import type { CoreClient } from "./core-client";

export interface VaultCredential {
  refreshToken: string;
  version: string;
}

export interface CredentialVault {
  decrypt(profileId: string): Promise<VaultCredential | null>;
  encrypt(profileId: string, credential: VaultCredential): Promise<void>;
  remove(profileId: string, version: string): Promise<void>;
}

interface SessionManagerOptions {
  core: CoreClient;
  vault: CredentialVault;
  getProfileId: () => string;
  setAccessToken: (accessToken: string | null) => void;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  onBackgroundError?: (error: unknown) => void;
}

export interface SessionManager {
  snapshot(): SessionSnapshot;
  login(input: LoginRequest): Promise<SessionSnapshot>;
  restore(): Promise<SessionSnapshot>;
  refresh(): Promise<SessionSnapshot>;
  profileSwitched(previousProfileId: string): Promise<void>;
  logout(): Promise<void>;
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_SNAPSHOT_TIME_MS = Date.parse("9999-12-31T23:59:59.999Z");

interface RefreshFlight {
  profileId: string;
  generation: number;
  promise: Promise<SessionSnapshot>;
}

type RevocableTokens = Pick<TokenResponse, "accessToken" | "refreshToken">;

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  let current: SessionSnapshot = { state: "anonymous" };
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshInFlight: RefreshFlight | null = null;
  let activeProfileId: string | null = null;
  let activeCredentialVersion: string | null = null;
  let activeAccessToken: string | null = null;
  let generation = 0;
  const vaultTails = new Map<string, Promise<void>>();

  function withVault<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const result = (vaultTails.get(profileId) ?? Promise.resolve()).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    vaultTails.set(profileId, tail);
    void tail.then(() => {
      if (vaultTails.get(profileId) === tail) vaultTails.delete(profileId);
    });
    return result;
  }

  function readCredential(profileId: string): Promise<VaultCredential | null> {
    return withVault(profileId, () => options.vault.decrypt(profileId));
  }

  function writeCredential(profileId: string, credential: VaultCredential): Promise<void> {
    return withVault(profileId, () => options.vault.encrypt(profileId, credential));
  }

  function removeCredential(profileId: string, version: string): Promise<void> {
    return withVault(profileId, () => options.vault.remove(profileId, version));
  }

  function removeCurrentCredential(profileId: string): Promise<void> {
    return withVault(profileId, async () => {
      const credential = await options.vault.decrypt(profileId);
      if (credential) await options.vault.remove(profileId, credential.version);
    });
  }

  function runBestEffort(operation: Promise<void>): void {
    void operation.catch((error: unknown) => {
      try {
        options.onBackgroundError?.(error);
      } catch {
        // Background cleanup and reporting must never reject without an observer.
      }
    });
  }

  function clearMemory(): void {
    if (expiryTimer !== undefined) cancel(expiryTimer);
    expiryTimer = undefined;
    options.setAccessToken(null);
    current = { state: "anonymous" };
    activeProfileId = null;
    activeCredentialVersion = null;
    activeAccessToken = null;
    generation += 1;
  }

  async function clear(profileId: string): Promise<void> {
    const version = activeProfileId === profileId ? activeCredentialVersion : null;
    if (activeProfileId === null || activeProfileId === profileId) clearMemory();
    if (version) await removeCredential(profileId, version);
    else await removeCurrentCredential(profileId);
  }

  async function clearOwned(
    profileId: string,
    expectedGeneration: number,
    credentialVersion: string | null,
  ): Promise<void> {
    let version = credentialVersion;
    if (
      generation === expectedGeneration &&
      (activeProfileId === null || activeProfileId === profileId)
    ) {
      version ??= activeCredentialVersion;
      clearMemory();
    }
    if (version) await removeCredential(profileId, version);
  }

  function armExpiry(
    profileId: string,
    expectedGeneration: number,
    credentialVersion: string,
    expiresAtMs: number,
  ): void {
    if (generation !== expectedGeneration || activeProfileId !== profileId) return;
    const remaining = expiresAtMs - now();
    if (remaining <= 0) {
      runBestEffort(clearOwned(profileId, expectedGeneration, credentialVersion));
      return;
    }
    expiryTimer = schedule(() => {
      expiryTimer = undefined;
      armExpiry(profileId, expectedGeneration, credentialVersion, expiresAtMs);
    }, Math.min(remaining, MAX_TIMEOUT_MS));
  }

  function claimGeneration(): number {
    generation += 1;
    if (
      current.state === "authenticated" &&
      activeProfileId !== null &&
      activeCredentialVersion !== null
    ) {
      if (expiryTimer !== undefined) cancel(expiryTimer);
      expiryTimer = undefined;
      armExpiry(
        activeProfileId,
        generation,
        activeCredentialVersion,
        Date.parse(current.expiresAt),
      );
    }
    return generation;
  }

  function activate(
    profileId: string,
    credentialVersion: string,
    rawTokens: TokenResponse,
    rawUser = rawTokens.user,
  ): SessionSnapshot {
    const tokens = tokenResponseSchema.parse(rawTokens);
    const user = currentUserSchema.parse(rawUser);
    const nowMs = now();
    const maxSeconds = Math.max(0, (MAX_SNAPSHOT_TIME_MS - nowMs) / 1_000);
    const expiresAtMs = tokens.expiresIn > maxSeconds
      ? MAX_SNAPSHOT_TIME_MS
      : nowMs + tokens.expiresIn * 1_000;
    options.setAccessToken(tokens.accessToken);
    activeProfileId = profileId;
    activeCredentialVersion = credentialVersion;
    activeAccessToken = tokens.accessToken;
    current = {
      state: "authenticated",
      user,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    if (expiryTimer !== undefined) cancel(expiryTimer);
    armExpiry(profileId, generation, credentialVersion, expiresAtMs);
    return current;
  }

  async function accept(
    profileId: string,
    rawTokens: TokenResponse,
    verifyMe: boolean,
    expectedGeneration: number,
  ) {
    const tokens = tokenResponseSchema.parse(rawTokens);
    const credential: VaultCredential = {
      refreshToken: tokens.refreshToken,
      version: crypto.randomUUID(),
    };
    if (generation !== expectedGeneration) {
      await revoke(tokens);
      return current;
    }
    try {
      await writeCredential(profileId, credential);
    } catch (error) {
      await settleCleanupAndRevoke(
        clearOwned(profileId, expectedGeneration, credential.version),
        tokens,
      );
      throw error;
    }
    if (generation !== expectedGeneration) {
      await cleanupAndRevoke(
        removeCredential(profileId, credential.version),
        tokens,
      );
      return current;
    }
    options.setAccessToken(tokens.accessToken);
    let verifiedUser: TokenResponse["user"];
    try {
      verifiedUser = verifyMe ? await options.core.me() : tokens.user;
    } catch (error) {
      await settleCleanupAndRevoke(
        clearOwned(profileId, expectedGeneration, credential.version),
        tokens,
      );
      throw error;
    }
    if (generation !== expectedGeneration) {
      await cleanupAndRevoke(
        removeCredential(profileId, credential.version),
        tokens,
      );
      return current;
    }
    return activate(profileId, credential.version, tokens, verifiedUser);
  }

  async function revoke(tokens: RevocableTokens): Promise<void> {
    try {
      await options.core.logout(tokens.refreshToken, tokens.accessToken);
    } catch {
      // Discarded server sessions are revoked on a best-effort basis.
    }
  }

  async function cleanupAndRevoke(
    cleanup: Promise<void>,
    tokens: RevocableTokens,
  ): Promise<void> {
    const [cleanupResult] = await Promise.allSettled([cleanup, revoke(tokens)]);
    if (cleanupResult.status === "rejected") throw cleanupResult.reason;
  }

  async function settleCleanupAndRevoke(
    cleanup: Promise<void>,
    tokens: RevocableTokens,
  ): Promise<void> {
    await Promise.allSettled([cleanup, revoke(tokens)]);
  }

  async function doRefresh(
    profileId: string,
    expectedGeneration: number,
  ): Promise<SessionSnapshot> {
    let credential: VaultCredential | null = null;
    try {
      credential = await readCredential(profileId);
      if (generation !== expectedGeneration) return current;
      if (!credential) {
        clearMemory();
        return current;
      }
      const tokens = await options.core.refresh(credential.refreshToken);
      if (generation !== expectedGeneration) {
        await revoke(tokens);
        return current;
      }
      return await accept(profileId, tokens, true, expectedGeneration);
    } catch (error) {
      await clearOwned(profileId, expectedGeneration, credential?.version ?? null);
      throw error;
    }
  }

  const manager: SessionManager = {
    snapshot() {
      if (current.state === "authenticated" && Date.parse(current.expiresAt) <= now()) {
        const profileId = activeProfileId ?? options.getProfileId();
        const credentialVersion = activeCredentialVersion;
        clearMemory();
        if (credentialVersion) {
          runBestEffort(removeCredential(profileId, credentialVersion));
        }
      }
      return current;
    },
    async login(input) {
      const profileId = options.getProfileId();
      const expectedGeneration = claimGeneration();
      const tokens = await options.core.login(input);
      return await accept(profileId, tokens, false, expectedGeneration);
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
    async profileSwitched(previousProfileId) {
      await clear(previousProfileId);
    },
    async logout() {
      const profileId = activeProfileId ?? options.getProfileId();
      const expectedGeneration = generation;
      const accessToken = activeAccessToken;
      const credentialPromise = readCredential(profileId).catch(() => null);
      if (
        generation === expectedGeneration &&
        (activeProfileId === null || activeProfileId === profileId)
      ) {
        clearMemory();
      }
      const credential = await credentialPromise;
      if (!credential) return;
      const cleanup = removeCredential(profileId, credential.version);
      if (!accessToken) return await cleanup;
      await cleanupAndRevoke(cleanup, {
        refreshToken: credential.refreshToken,
        accessToken,
      });
    },
  };

  return manager;
}
