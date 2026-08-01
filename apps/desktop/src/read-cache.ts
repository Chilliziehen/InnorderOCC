import { createHash } from "node:crypto";

import { z } from "zod";

import {
  workspaceQuerySchema,
  workspaceResultSchema,
  type WorkspaceQuery,
  type WorkspaceResult,
} from "./desktop-contract";
import { canonicalizeCommandPayload } from "./command-payload";
import { CoreClientError } from "./core-client";

export interface ReadCachePersistence {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

export interface ReadCacheScope {
  readonly profileId: string;
  readonly customerInstanceId: string;
  readonly principalId: string;
}

interface ReadCacheOptions {
  readonly persistence: ReadCachePersistence;
  readonly now?: () => number;
  readonly freshTtlMs?: number;
  readonly maxStaleMs?: number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly isNetworkFailure?: (error: unknown) => boolean;
}

interface CacheEntry extends ReadCacheScope {
  readonly key: string;
  readonly workspace: string;
  readonly result: WorkspaceResult;
  readonly storedAt: number;
}

const CACHEABLE_WORKSPACES = new Set([
  "overview",
  "my-work",
  "processes",
  "risks",
  "resources",
  "domain-design",
]);
const SENSITIVE_KEYS = /(?:secret|token|password|credential|apiKey)$/i;
const scopeSchema = z.object({
  profileId: z.uuid(),
  customerInstanceId: z.uuid(),
  principalId: z.uuid(),
}).strict();
const cacheEntrySchema = scopeSchema.extend({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  workspace: z.string().min(1).max(128),
  result: workspaceResultSchema,
  storedAt: z.number().int().nonnegative(),
}).strict();
const cacheFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(cacheEntrySchema),
}).strict();

function containsSensitiveValue(value: unknown, ancestors: readonly string[] = []): boolean {
  if (Array.isArray(value)) return value.some((child) => containsSensitiveValue(child, ancestors));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.replace(/[^a-z]/gi, "");
    const underEvidence = ancestors.some((ancestor) => ancestor.toLowerCase().includes("evidence"));
    return SENSITIVE_KEYS.test(normalized) ||
      /^(?:auditPayload|providerConfig|providerConfiguration|evidenceContent)$/i.test(normalized) ||
      (underEvidence && normalized.toLowerCase() === "content") ||
      containsSensitiveValue(child, [...ancestors, key]);
  });
}

function sameScope(left: ReadCacheScope, right: ReadCacheScope): boolean {
  return left.profileId === right.profileId &&
    left.customerInstanceId === right.customerInstanceId &&
    left.principalId === right.principalId;
}

function queryKey(scope: ReadCacheScope, query: WorkspaceQuery): string {
  const parsedScope = scopeSchema.parse(scope);
  const parsedQuery = workspaceQuerySchema.parse(query);
  const signature = canonicalizeCommandPayload(parsedQuery as never);
  return createHash("sha256").update(canonicalizeCommandPayload({
    ...parsedScope,
    workspace: parsedQuery.workspace,
    signature,
  })).digest("hex");
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function staleResult(result: WorkspaceResult): WorkspaceResult | undefined {
  if (result.state === "ready" || result.state === "stale" || result.state === "offline") {
    return workspaceResultSchema.parse({ ...result, state: "stale" });
  }
  if (result.state === "empty") {
    return workspaceResultSchema.parse({
      state: "stale",
      items: [],
      count: 0,
      fetchedAt: result.fetchedAt,
    });
  }
  return undefined;
}

export function createReadCache(options: ReadCacheOptions) {
  const now = options.now ?? Date.now;
  const freshTtlMs = options.freshTtlMs ?? 5 * 60_000;
  const maxStaleMs = options.maxStaleMs ?? 24 * 60 * 60_000;
  const maxEntries = options.maxEntries ?? 500;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const isNetworkFailure = options.isNetworkFailure ?? ((error: unknown) =>
    error instanceof CoreClientError && ["NETWORK_ERROR", "TIMEOUT"].includes(error.problem.code)
  );
  let mutationQueue = Promise.resolve();

  const load = async (): Promise<CacheEntry[]> => {
    try {
      const raw = await options.persistence.read();
      if (raw === undefined) return [];
      return cacheFileSchema.parse(raw).entries;
    } catch {
      return [];
    }
  };
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const persist = async (entries: CacheEntry[]) => {
    const file = cacheFileSchema.parse({ version: 1, entries });
    if (byteLength(file) > maxBytes) throw new Error("Read cache byte limit exceeded");
    await options.persistence.write(file);
  };
  const validateCacheable = (query: WorkspaceQuery, result: WorkspaceResult) => {
    const parsedQuery = workspaceQuerySchema.parse(query);
    const parsedResult = workspaceResultSchema.parse(result);
    if (!CACHEABLE_WORKSPACES.has(parsedQuery.workspace) || containsSensitiveValue(parsedResult)) {
      throw new Error("Workspace projection is not cacheable");
    }
    if (!["ready", "empty", "stale"].includes(parsedResult.state)) {
      throw new Error("Workspace result is not cacheable");
    }
    return { query: parsedQuery, result: parsedResult };
  };

  const api = {
    async put(scope: ReadCacheScope, query: WorkspaceQuery, result: WorkspaceResult): Promise<void> {
      const parsedScope = scopeSchema.parse(scope);
      const validated = validateCacheable(query, result);
      await mutate(async () => {
        const key = queryKey(parsedScope, validated.query);
        const existing = (await load()).filter((entry) => entry.key !== key);
        const next: CacheEntry[] = [...existing, {
          ...parsedScope,
          key,
          workspace: validated.query.workspace,
          result: validated.result,
          storedAt: now(),
        }];
        while (next.length > maxEntries) next.shift();
        await persist(next);
      });
    },
    async get(
      scope: ReadCacheScope,
      query: WorkspaceQuery,
      authenticatedScope: ReadCacheScope | null,
    ): Promise<WorkspaceResult | undefined> {
      const parsedScope = scopeSchema.parse(scope);
      if (authenticatedScope === null) return undefined;
      const parsedAuthenticated = scopeSchema.parse(authenticatedScope);
      if (!sameScope(parsedScope, parsedAuthenticated)) return undefined;
      const entry = (await load()).find(({ key }) => key === queryKey(parsedScope, query));
      if (!entry) return undefined;
      const result = workspaceResultSchema.safeParse(entry.result);
      if (!result.success || !CACHEABLE_WORKSPACES.has(entry.workspace) || containsSensitiveValue(result.data)) return undefined;
      const age = Math.max(0, now() - Date.parse(
        "fetchedAt" in result.data ? result.data.fetchedAt : new Date(entry.storedAt).toISOString(),
      ));
      if (age > maxStaleMs) return undefined;
      return age > freshTtlMs ? staleResult(result.data) : result.data;
    },
    purgeProfile(profileId: string): Promise<void> {
      const parsed = z.uuid().parse(profileId);
      return mutate(async () => persist((await load()).filter((entry) => entry.profileId !== parsed)));
    },
    purgeAccount(scope: ReadCacheScope): Promise<void> {
      const parsed = scopeSchema.parse(scope);
      return mutate(async () => persist((await load()).filter((entry) => !sameScope(entry, parsed))));
    },
    async query(
      scope: ReadCacheScope,
      query: WorkspaceQuery,
      authenticatedScope: ReadCacheScope | null,
      remote: () => Promise<WorkspaceResult>,
    ): Promise<WorkspaceResult> {
      try {
        const result = workspaceResultSchema.parse(await remote());
        if (["ready", "empty", "stale"].includes(result.state)) {
          await api.put(scope, query, result).catch(() => undefined);
        }
        return result;
      } catch (error) {
        if (!isNetworkFailure(error)) throw error;
        const cached = await api.get(scope, query, authenticatedScope);
        const stale = cached && staleResult(cached);
        if (stale) return stale;
        throw error;
      }
    },
  };
  return api;
}
