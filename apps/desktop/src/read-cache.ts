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
  read(): Promise<{ readonly text: string; readonly byteLength: number } | undefined>;
  write(value: unknown): Promise<void>;
}

export const READ_CACHE_MAX_BYTES = 16 * 1024 * 1024;

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

const boundedText = z.string().min(1).max(2_048);
const identifier = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const boundedItems = <T extends z.ZodType>(schema: T) => z.array(schema).max(200);
const namedState = z.object({ id: boundedText, name: boundedText, state: boundedText }).strict();
const overviewItem = z.discriminatedUnion("type", [
  z.object({ item: z.string().max(2_048), type: z.literal("attention"), status: z.string().max(2_048), dueAt: z.iso.datetime({ offset: true }).optional() }).strict(),
  z.object({ item: z.string().max(2_048), type: z.literal("deadline"), status: z.string().max(2_048), dueAt: z.iso.datetime({ offset: true }).optional() }).strict(),
  z.object({ item: z.string().max(2_048), type: z.literal("risk"), status: z.string().max(2_048), dueAt: z.iso.datetime({ offset: true }).optional() }).strict(),
  z.object({ item: z.string().max(2_048), type: z.literal("process"), status: z.enum(["RUNNING", "SUSPENDED", "COMPLETED", "CANCELLED", "FAILED"]), dueAt: z.iso.datetime({ offset: true }).optional() }).strict(),
]);
const taskItem = z.object({
  id: boundedText, task: boundedText, process: boundedText,
  state: z.enum(["AVAILABLE", "CLAIMED", "BLOCKED", "PENDING_REVIEW", "RETURNED", "COMPLETED"]),
  dueAt: boundedText,
  evidenceRequirements: boundedItems(boundedText),
  acceptedMediaTypes: boundedItems(z.string().min(1).max(255)),
  reservation: boundedText.optional(),
  reviewHistory: boundedItems(z.object({ id: boundedText, outcome: boundedText, occurredAt: boundedText, note: z.string().max(2_048).optional() }).strict()),
}).strict();
const processItem = z.object({
  id: boundedText, process: boundedText, cohort: boundedText, owner: boundedText, status: boundedText,
  expectedVersion: z.number().int().min(0), progress: z.number().finite().min(0).max(100),
  participants: boundedItems(z.object({ id: boundedText, name: boundedText, role: boundedText }).strict()),
  tasks: boundedItems(namedState), evidence: boundedItems(namedState),
  risks: boundedItems(z.object({ id: boundedText, name: boundedText, severity: boundedText }).strict()),
  timeline: boundedItems(z.object({ id: boundedText, occurredAt: boundedText, label: boundedText }).strict()),
}).strict();
const riskItem = z.object({
  id: boundedText, risk: boundedText, severity: z.enum(["critical", "high", "medium", "low"]),
  owner: boundedText.nullable(), status: boundedText, deadline: z.iso.datetime({ offset: true }),
  sla: z.enum(["on-track", "due-soon", "overdue"]), version: z.number().int().min(0),
}).strict();
const reservation = z.object({ id: identifier, start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }), capacity: z.number().finite().positive(), state: z.string().min(1).max(64) }).strict().refine(({ start, end }) => Date.parse(start) < Date.parse(end));
const conflict = z.object({ kind: z.enum(["exclusive", "capacity"]), start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }), capacity: z.number().finite().positive().optional() }).strict().refine(({ start, end }) => Date.parse(start) < Date.parse(end));
const resourceItem = z.object({
  id: identifier, name: z.string().min(1).max(128), type: identifier, state: z.string().min(1).max(64),
  capacity: z.number().finite().positive(), availableCapacity: z.number().finite().nonnegative(),
  reservations: boundedItems(reservation), conflicts: boundedItems(conflict),
}).strict().refine(({ capacity, availableCapacity }) => availableCapacity <= capacity);
const packageItem = z.object({
  id: identifier, name: z.string().trim().min(2).max(128).regex(/^[a-z][a-z0-9-]*$/), version: z.string().trim().max(64).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/), status: z.string().trim().min(1).max(64),
  assets: boundedItems(z.object({ name: z.string().trim().min(1).max(255), kind: z.string().trim().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9-]*$/), digest: z.string().trim().min(1).max(256) }).strict()),
  validation: z.object({ state: z.string().max(2_048), summary: z.string().max(2_048) }).strict().optional(),
  diff: z.object({ baseVersion: z.string().max(2_048), summary: z.string().max(2_048) }).strict().optional(),
  approval: z.object({ state: z.string().max(2_048) }).strict().optional(),
}).strict();
const CACHE_ITEM_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  overview: overviewItem,
  "my-work": taskItem,
  processes: processItem,
  risks: riskItem,
  resources: resourceItem,
  "domain-design": packageItem,
};
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
const cacheFileSchema = (maxEntries: number) => z.object({ version: z.literal(1), entries: z.array(cacheEntrySchema).max(maxEntries) }).strict();

function cacheSafeResult(workspace: string, input: WorkspaceResult): WorkspaceResult {
  const itemSchema = CACHE_ITEM_SCHEMAS[workspace];
  if (!itemSchema) throw new Error("Workspace projection is not cacheable");
  if (input.state === "empty") return workspaceResultSchema.parse(input);
  if (input.state !== "ready" && input.state !== "stale") throw new Error("Workspace projection is not cacheable");
  const parsedItems = boundedItems(itemSchema).safeParse(input.items);
  if (!parsedItems.success) throw new Error("Workspace projection is not cacheable");
  return workspaceResultSchema.parse({ ...input, items: parsedItems.data });
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
  const maxBytes = options.maxBytes ?? READ_CACHE_MAX_BYTES;
  const isNetworkFailure = options.isNetworkFailure ?? ((error: unknown) =>
    error instanceof CoreClientError && ["NETWORK_ERROR", "TIMEOUT"].includes(error.problem.code)
  );
  let mutationQueue = Promise.resolve();

  const load = async (): Promise<CacheEntry[]> => {
    try {
      const raw = await options.persistence.read();
      if (raw === undefined) return [];
      if (raw.byteLength > maxBytes) return [];
      const actualBytes = Buffer.byteLength(raw.text, "utf8");
      if (actualBytes !== raw.byteLength || actualBytes > maxBytes) return [];
      const file = cacheFileSchema(maxEntries).parse(JSON.parse(raw.text));
      return file.entries.map((entry) => ({ ...entry, result: cacheSafeResult(entry.workspace, entry.result) }));
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
    const file = cacheFileSchema(maxEntries).parse({ version: 1, entries });
    if (byteLength(file) > maxBytes) throw new Error("Read cache byte limit exceeded");
    await options.persistence.write(file);
  };
  const validateCacheable = (query: WorkspaceQuery, result: WorkspaceResult) => {
    const parsedQuery = workspaceQuerySchema.parse(query);
    const parsedResult = workspaceResultSchema.parse(result);
    return { query: parsedQuery, result: cacheSafeResult(parsedQuery.workspace, parsedResult) };
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
      if (!result.success) return undefined;
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
      isCurrent: () => boolean = () => true,
    ): Promise<WorkspaceResult> {
      try {
        const result = workspaceResultSchema.parse(await remote());
        if (!isCurrent()) throw new Error("Session scope changed");
        if (["ready", "empty", "stale"].includes(result.state)) {
          await api.put(scope, query, result).catch(() => undefined);
        }
        if (!isCurrent()) throw new Error("Session scope changed");
        return result;
      } catch (error) {
        if (!isCurrent()) throw new Error("Session scope changed");
        if (!isNetworkFailure(error)) throw error;
        const cached = await api.get(scope, query, authenticatedScope);
        if (!isCurrent()) throw new Error("Session scope changed");
        const stale = cached && staleResult(cached);
        if (stale) return stale;
        throw error;
      }
    },
  };
  return api;
}
