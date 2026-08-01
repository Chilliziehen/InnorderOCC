import path from "node:path";

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import { z as schema } from "zod";

import {
  commandReceiptSchema, DESKTOP_CHANNELS, evidenceUploadMetadataSchema,
  idInputSchema, loginInputSchema, noInputSchema, notificationListResultSchema,
  notificationEventSchema, notificationConnectionStateSchema,
  optionalCursorSchema, profileInputSchema, selectedServerProfileSchema, serverProfileSchema,
  sessionSnapshotSchema, systemStatusesSchema, uploadAvailabilitySchema, uploadReceiptSchema,
  uploadAppendInputSchema, uploadAppendReceiptSchema, uploadProgressSchema,
  voidOutputSchema, workspaceCommandSchema, workspaceQuerySchema,
  workspaceResultSchema, type OccApi,
} from "./ipc-contract";
import type { ProfileStore } from "./profile-store";
import type { CredentialVault, SessionManager, VaultCredential } from "./session-manager";
import { serializedSize } from "./serialized-size";
import { createCommandIntentRegistry, type CommandIntentRegistry, type InternalWorkspaceCommand } from "./command-intents";
import type { CommandReceipt } from "./desktop-contract";
import type { ReadCacheScope } from "./read-cache";
import { mainUnavailableOperation } from "./main-operation-registry";

export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_UPLOAD_REQUEST_BYTES = 1024 * 1024 + 64 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const profileListSchema = serverProfileSchema.array();
type InvokeApi = Omit<OccApi, "notifications" | "commands" | "uploads"> & {
  commands: { execute(input: InternalWorkspaceCommand): Promise<CommandReceipt> };
  uploads: Pick<OccApi["uploads"], "preflight" | "begin" | "append" | "finish" | "cancel">;
  notifications: Pick<OccApi["notifications"], "list">;
};

interface HandlerDefinition<I, O> {
  channel: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  invoke(input: I): Promise<O>;
  maxRequestBytes?: number;
}

let activeRegistration: (() => void) | undefined;

interface NotificationTarget {
  send(channel: string, event: unknown): void;
}

export function sendDesktopNotification(
  target: NotificationTarget,
  input: unknown,
): boolean {
  try {
    if (serializedSize(input) > MAX_OUTPUT_BYTES) return false;
    const parsed = notificationEventSchema.safeParse(input);
    if (!parsed.success) return false;
    target.send(DESKTOP_CHANNELS.notifications.event, parsed.data);
    return true;
  } catch {
    return false;
  }
}

export function sendDesktopNotificationState(target: NotificationTarget, input: unknown): boolean {
  try {
    const parsed = notificationConnectionStateSchema.safeParse(input);
    if (!parsed.success) return false;
    target.send(DESKTOP_CHANNELS.notifications.state, parsed.data);
    return true;
  } catch {
    return false;
  }
}

interface UploadProgressSenderOptions {
  readonly now?: () => number;
  readonly maxEntries?: number;
  readonly ttlMs?: number;
}

export function createDesktopUploadProgressSender(options: UploadProgressSenderOptions = {}) {
  const progressByTarget = new WeakMap<NotificationTarget, Map<string, { percent: number; touchedAt: number }>>();
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 1_000;
  const ttlMs = options.ttlMs ?? 15 * 60_000;
  return (target: NotificationTarget, input: unknown): boolean => {
    const parsed = uploadProgressSchema.safeParse(input);
    if (!parsed.success || serializedSize(parsed.data) > MAX_OUTPUT_BYTES) return false;
    const progress = progressByTarget.get(target) ?? new Map<string, { percent: number; touchedAt: number }>();
    const time = now();
    for (const [id, entry] of progress) if (time - entry.touchedAt > ttlMs) progress.delete(id);
    const previous = progress.get(parsed.data.uploadId);
    if (previous && parsed.data.percent < previous.percent) return false;
    if (!previous && progress.size >= maxEntries) return false;
    try {
      target.send(DESKTOP_CHANNELS.uploads.progress, parsed.data);
    } catch {
      return false;
    }
    if (parsed.data.percent === 100) progress.delete(parsed.data.uploadId);
    else progress.set(parsed.data.uploadId, { percent: parsed.data.percent, touchedAt: time });
    progressByTarget.set(target, progress);
    return true;
  };
}

const defaultUploadProgressSender = createDesktopUploadProgressSender();

export function sendDesktopUploadProgress(
  target: NotificationTarget,
  input: unknown,
): boolean {
  return defaultUploadProgressSender(target, input);
}

interface JsonPersistence {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

interface JsonFileSystem {
  mkdir(directory: string, options: { recursive: true; mode: number }): Promise<unknown>;
  readFile(file: string, encoding: "utf8"): Promise<string>;
  writeFile(
    file: string,
    value: string,
    options: { encoding: "utf8"; mode: number },
  ): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  unlink(file: string): Promise<unknown>;
}

export function createAtomicJsonPersistence(
  file: string,
  fs: JsonFileSystem,
): JsonPersistence {
  return {
    async read() {
      try {
        return JSON.parse(await fs.readFile(file, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async write(value) {
      const directory = path.dirname(file);
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        await fs.writeFile(temporary, JSON.stringify(value), {
          encoding: "utf8",
          mode: 0o600,
        });
        await fs.rename(temporary, file);
      } catch (error) {
        await fs.unlink(temporary).catch(() => undefined);
        throw error;
      }
    },
  };
}

interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

const vaultCredentialSchema = schema.object({
  refreshToken: schema.string().min(1),
  version: schema.string().min(1),
}).strict();
const vaultFileSchema = schema.object({
  version: schema.literal(1),
  records: schema.record(schema.string(), schema.string()),
}).strict();

export function createSafeStorageVault(
  safeStorage: SafeStorageAdapter,
  persistence: JsonPersistence,
): CredentialVault {
  let mutationQueue = Promise.resolve();
  const assertAvailable = () => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Credential encryption unavailable");
    }
  };
  const load = async () => {
    const stored = await persistence.read();
    return stored === undefined
      ? { version: 1 as const, records: {} as Record<string, string> }
      : vaultFileSchema.parse(stored);
  };
  const decryptRecord = (record: string): VaultCredential =>
    vaultCredentialSchema.parse(
      JSON.parse(safeStorage.decryptString(Buffer.from(record, "base64"))),
    );
  const mutate = <T>(operation: () => Promise<T>) => {
    const result = mutationQueue.then(operation);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    async decrypt(profileId) {
      assertAvailable();
      const record = (await load()).records[profileId];
      return record === undefined ? null : decryptRecord(record);
    },
    encrypt(profileId, credential) {
      const parsed = vaultCredentialSchema.parse(credential);
      return mutate(async () => {
        assertAvailable();
        const stored = await load();
        const encrypted = safeStorage.encryptString(JSON.stringify(parsed)).toString("base64");
        await persistence.write({
          version: 1,
          records: { ...stored.records, [profileId]: encrypted },
        });
      });
    },
    remove(profileId, version) {
      return mutate(async () => {
        assertAvailable();
        const stored = await load();
        const record = stored.records[profileId];
        if (record === undefined || decryptRecord(record).version !== version) return;
        const records = { ...stored.records };
        delete records[profileId];
        await persistence.write({ version: 1, records });
      });
    },
  };
}

export interface DesktopApiDependencies {
  profiles: ProfileStore;
  session: Pick<SessionManager, "restore" | "login" | "logout" | "profileSwitched">;
  statuses: OccApi["runtime"]["statuses"];
  clearProfile(profileId: string): Promise<void>;
  readCache?: {
    query(scope: ReadCacheScope, input: Parameters<OccApi["workspaces"]["query"]>[0], authenticatedScope: ReadCacheScope | null, remote: () => ReturnType<OccApi["workspaces"]["query"]>, isCurrent?: () => boolean): ReturnType<OccApi["workspaces"]["query"]>;
    get?(scope: ReadCacheScope, input: Parameters<OccApi["workspaces"]["query"]>[0], authenticatedScope: ReadCacheScope | null): Promise<Awaited<ReturnType<OccApi["workspaces"]["query"]>> | undefined>;
    purgeAccount(scope: ReadCacheScope): Promise<void>;
  };
  getCacheScope?: (principalId: string) => ReadCacheScope | null;
  workspaceQuery?: OccApi["workspaces"]["query"];
  executeCommand?: (input: InternalWorkspaceCommand) => Promise<CommandReceipt>;
  isOnline?: () => boolean;
  uploads?: Pick<OccApi["uploads"], "preflight" | "begin" | "append" | "finish" | "cancel">;
  uploadLifecycle?: {
    setScope(scope: ReadCacheScope | null): void;
    abortScope(scope: ReadCacheScope): Promise<void>;
    abortAll(): Promise<void>;
  };
  notifications?: Pick<OccApi["notifications"], "list">;
  onSessionScopeChanged?: (scope: ReadCacheScope | null, generation: number) => void;
}

interface BoundedTextFileSystem extends JsonFileSystem {
  stat(file: string): Promise<{ size: number }>;
}

export function createAtomicTextPersistence(
  file: string,
  fs: BoundedTextFileSystem,
  maxBytes: number,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Text persistence byte limit is invalid");
  const writer = createAtomicJsonPersistence(file, fs);
  return {
    async read(): Promise<{ text: string; byteLength: number } | undefined> {
      try {
        const { size } = await fs.stat(file);
        if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) return undefined;
        const text = await fs.readFile(file, "utf8");
        const byteLength = Buffer.byteLength(text, "utf8");
        if (byteLength !== size || byteLength > maxBytes) return undefined;
        return { text, byteLength };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    write: writer.write,
  };
}

export function createDesktopApi(dependencies: DesktopApiDependencies): InvokeApi {
  let transitionTail = Promise.resolve();
  const transition = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = transitionTail.then(operation);
    transitionTail = result.then(() => undefined, () => undefined);
    return result;
  };
  let authenticatedCacheScope: ReadCacheScope | null = null;
  let sessionGeneration = 0;
  const invalidateSessionScope = () => {
    const previous = authenticatedCacheScope;
    authenticatedCacheScope = null;
    dependencies.uploadLifecycle?.setScope(null);
    sessionGeneration += 1;
    dependencies.onSessionScopeChanged?.(null, sessionGeneration);
    return previous;
  };
  const settle = async (operations: ReadonlyArray<() => Promise<unknown>>): Promise<unknown[]> => {
    const results = await Promise.allSettled(operations.map((operation) => Promise.resolve().then(operation)));
    return results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  };
  const throwTransitionFailures = (failures: unknown[]) => {
    if (failures.length > 0) throw new AggregateError(failures, "Desktop session transition cleanup failed");
  };
  const cleanup = (profileId: string) => settle([
    () => dependencies.session.profileSwitched(profileId),
    () => dependencies.clearProfile(profileId),
  ]);
  const acceptSession = (snapshot: Awaited<ReturnType<SessionManager["login"]>>) => {
    const candidate = snapshot.state === "authenticated" ? dependencies.getCacheScope?.(snapshot.user.id) : null;
    authenticatedCacheScope = candidate && snapshot.state === "authenticated" && candidate.principalId === snapshot.user.id
      ? candidate
      : null;
    dependencies.uploadLifecycle?.setScope(authenticatedCacheScope);
    sessionGeneration += 1;
    dependencies.onSessionScopeChanged?.(authenticatedCacheScope, sessionGeneration);
    return snapshot;
  };
  return {
    profiles: {
      list: () => dependencies.profiles.list(),
      current: async () => dependencies.profiles.selected() ?? null,
      save: (input) => transition(async () => {
        const candidate = input.id === undefined
          ? undefined
          : dependencies.profiles.validate(input);
        const previous = input.id === undefined
          ? undefined
          : (await dependencies.profiles.list()).find(({ id }) => id === input.id);
        if (previous && candidate && previous.origin !== candidate.origin) {
          const failures: unknown[] = [];
          const invalidated = dependencies.profiles.selected()?.id === previous.id ? invalidateSessionScope() : null;
          if (invalidated && dependencies.uploadLifecycle) failures.push(...await settle([() => dependencies.uploadLifecycle!.abortScope(invalidated)]));
          failures.push(...await cleanup(previous.id));
          let saved: Awaited<ReturnType<ProfileStore["save"]>> | undefined;
          const saveFailures = await settle([async () => { saved = await dependencies.profiles.save(input); }]);
          failures.push(...saveFailures);
          throwTransitionFailures(failures);
          return saved!;
        }
        return dependencies.profiles.save(input);
      }),
      select: (id) => {
        const previous = dependencies.profiles.selected();
        const changing = previous !== undefined && previous.id !== id;
        const scopes = changing ? [invalidateSessionScope()].filter((scope): scope is ReadCacheScope => scope !== null) : [];
        return transition(async () => {
          if (changing && authenticatedCacheScope) {
            const lateScope = invalidateSessionScope();
            if (lateScope) scopes.push(lateScope);
          }
          const failures = dependencies.uploadLifecycle
            ? await settle(scopes.map((scope) => () => dependencies.uploadLifecycle!.abortScope(scope)))
            : [];
          failures.push(...await settle([() => dependencies.profiles.select(id)]));
          if (changing) failures.push(...await cleanup(previous.id));
          throwTransitionFailures(failures);
        });
      },
      remove: (id) => {
        const selected = dependencies.profiles.selected()?.id === id;
        const scopes = selected ? [invalidateSessionScope()].filter((scope): scope is ReadCacheScope => scope !== null) : [];
        return transition(async () => {
          if (selected && authenticatedCacheScope) {
            const lateScope = invalidateSessionScope();
            if (lateScope) scopes.push(lateScope);
          }
          const failures = dependencies.uploadLifecycle
            ? await settle(scopes.map((scope) => () => dependencies.uploadLifecycle!.abortScope(scope)))
            : [];
          failures.push(...await cleanup(id));
          failures.push(...await settle([() => dependencies.profiles.remove(id)]));
          throwTransitionFailures(failures);
        });
      },
    },
    session: {
      restore: () => transition(async () => acceptSession(await dependencies.session.restore())),
      login: (input) => transition(async () => acceptSession(await dependencies.session.login(input))),
      logout: () => {
        const scopes = [invalidateSessionScope()].filter((scope): scope is ReadCacheScope => scope !== null);
        return transition(async () => {
          const lateScope = authenticatedCacheScope;
          if (lateScope) {
            invalidateSessionScope();
            if (!scopes.some((scope) => scope.profileId === lateScope.profileId && scope.customerInstanceId === lateScope.customerInstanceId && scope.principalId === lateScope.principalId)) scopes.push(lateScope);
          }
          const failures = dependencies.uploadLifecycle
            ? await settle([() => dependencies.uploadLifecycle!.abortAll()])
            : [];
          const cleanupOperations: Array<() => Promise<unknown>> = [() => dependencies.session.logout()];
          if (dependencies.readCache) cleanupOperations.push(...scopes.map((scope) => () => dependencies.readCache!.purgeAccount(scope)));
          failures.push(...await settle(cleanupOperations));
          throwTransitionFailures(failures);
        });
      },
    },
    runtime: { statuses: dependencies.statuses },
    workspaces: {
      query: async (input) => {
        const scope = authenticatedCacheScope;
        const generation = sessionGeneration;
        const isCurrent = () => generation === sessionGeneration && authenticatedCacheScope === scope;
        if (dependencies.isOnline?.() === false) {
          const cached = scope ? await dependencies.readCache?.get?.(scope, input, scope) : undefined;
          if (!isCurrent()) throw new Error("Session scope changed");
          if (cached?.state === "ready" || cached?.state === "offline") return { ...cached, state: "stale" };
          if (cached?.state === "empty") return { state: "stale", items: [], count: 0, fetchedAt: cached.fetchedAt };
          if (cached?.state === "stale") return cached;
          return { state: "error", problem: { title: "Offline cache unavailable", code: "OFFLINE_NO_CACHE", status: 503 } };
        }
        if (!dependencies.workspaceQuery) return mainUnavailableOperation(input.workspace, input.operation, "/workspaces");
        if (dependencies.readCache && scope) {
          return dependencies.readCache.query(scope, input, scope, () => dependencies.workspaceQuery!(input), isCurrent);
        }
        const result = await dependencies.workspaceQuery(input);
        if (!isCurrent()) throw new Error("Session scope changed");
        return result;
      },
    },
    commands: {
      execute: async (input) => {
        if (dependencies.isOnline?.() === false) throw new Error("Command rejected while offline");
        return dependencies.executeCommand
          ? dependencies.executeCommand(input)
          : mainUnavailableOperation(input.workspace, input.operation, "/commands");
      },
    },
    uploads: dependencies.uploads ?? {
      preflight: async () => mainUnavailableOperation("my-work", "submitEvidence", "/commands"),
      begin: async () => ({
        state: "problem",
        problem: { title: "Upload unavailable", status: 501 },
      }),
      append: async () => { throw new Error("Upload unavailable"); },
      finish: async () => ({ state: "problem", problem: { title: "Upload unavailable", status: 501 } }),
      cancel: async () => undefined,
    },
    notifications: dependencies.notifications ?? { list: async () => ({ items: [] }) },
  };
}

function createHandler<I, O>(
  rendererUrl: string,
  definition: HandlerDefinition<I, O>,
  sizeOf: (value: unknown) => number,
) {
  return async (
    event: IpcMainInvokeEvent,
    ...rawArguments: unknown[]
  ): Promise<O> => {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null || frame.url !== rendererUrl) {
      throw new Error("IPC request rejected");
    }
    let input: I;
    try {
      const maxRequestBytes = definition.maxRequestBytes ?? MAX_REQUEST_BYTES;
      if (sizeOf(rawArguments) > maxRequestBytes) throw new Error();
      if (rawArguments.length !== 1) throw new Error();
      input = definition.input.parse(rawArguments[0]);
    } catch {
      throw new Error("IPC request rejected");
    }
    try {
      const output = definition.output.parse(await definition.invoke(input));
      if (serializedSize(output) > MAX_OUTPUT_BYTES) throw new Error();
      return output;
    } catch {
      throw new Error("IPC request failed");
    }
  };
}

interface DesktopIpcOptions {
  sizeOf?: (value: unknown) => number;
  commandIntents?: CommandIntentRegistry;
}

export function registerDesktopIpc(
  rendererUrl: string,
  api: InvokeApi,
  options: DesktopIpcOptions = {},
): () => void {
  activeRegistration?.();
  const commandIntents = options.commandIntents ?? createCommandIntentRegistry();
  const definitions: HandlerDefinition<any, any>[] = [
    { channel: DESKTOP_CHANNELS.profiles.list, input: noInputSchema, output: profileListSchema, invoke: () => api.profiles.list() },
    { channel: DESKTOP_CHANNELS.profiles.current, input: noInputSchema, output: selectedServerProfileSchema, invoke: () => api.profiles.current() },
    { channel: DESKTOP_CHANNELS.profiles.save, input: profileInputSchema.strict(), output: serverProfileSchema, invoke: (input) => api.profiles.save(input) },
    { channel: DESKTOP_CHANNELS.profiles.select, input: idInputSchema, output: voidOutputSchema, invoke: (id) => api.profiles.select(id) },
    { channel: DESKTOP_CHANNELS.profiles.remove, input: idInputSchema, output: voidOutputSchema, invoke: (id) => api.profiles.remove(id) },
    { channel: DESKTOP_CHANNELS.session.restore, input: noInputSchema, output: sessionSnapshotSchema, invoke: () => api.session.restore() },
    { channel: DESKTOP_CHANNELS.session.login, input: loginInputSchema, output: sessionSnapshotSchema, invoke: (input) => api.session.login(input) },
    { channel: DESKTOP_CHANNELS.session.logout, input: noInputSchema, output: voidOutputSchema, invoke: () => api.session.logout() },
    { channel: DESKTOP_CHANNELS.runtime.statuses, input: noInputSchema, output: systemStatusesSchema, invoke: () => api.runtime.statuses() },
    { channel: DESKTOP_CHANNELS.workspaces.query, input: workspaceQuerySchema, output: workspaceResultSchema, invoke: (input) => api.workspaces.query(input) },
    { channel: DESKTOP_CHANNELS.commands.execute, input: workspaceCommandSchema, output: commandReceiptSchema, invoke: (input) => commandIntents.execute(input, (command) => api.commands.execute(command)) },
    { channel: DESKTOP_CHANNELS.uploads.preflight, input: evidenceUploadMetadataSchema, output: uploadAvailabilitySchema, invoke: (input) => api.uploads.preflight(input) },
    { channel: DESKTOP_CHANNELS.uploads.begin, input: evidenceUploadMetadataSchema, output: uploadReceiptSchema, invoke: (input) => api.uploads.begin(input) },
    { channel: DESKTOP_CHANNELS.uploads.append, input: uploadAppendInputSchema, output: uploadAppendReceiptSchema, invoke: (input) => api.uploads.append(input), maxRequestBytes: MAX_UPLOAD_REQUEST_BYTES },
    { channel: DESKTOP_CHANNELS.uploads.finish, input: idInputSchema, output: uploadReceiptSchema, invoke: (id) => api.uploads.finish(id) },
    { channel: DESKTOP_CHANNELS.uploads.cancel, input: idInputSchema, output: voidOutputSchema, invoke: (id) => api.uploads.cancel(id) },
    { channel: DESKTOP_CHANNELS.notifications.list, input: optionalCursorSchema, output: notificationListResultSchema, invoke: (cursor) => api.notifications.list(cursor) },
  ];
  for (const definition of definitions) {
    ipcMain.handle(
      definition.channel,
      createHandler(rendererUrl, definition, options.sizeOf ?? serializedSize),
    );
  }
  let current = true;
  const dispose = () => {
    if (!current) return;
    current = false;
    for (const { channel } of definitions) ipcMain.removeHandler(channel);
    if (activeRegistration === dispose) activeRegistration = undefined;
  };
  activeRegistration = dispose;
  return dispose;
}
