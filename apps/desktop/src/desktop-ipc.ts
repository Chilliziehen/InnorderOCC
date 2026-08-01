import path from "node:path";

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import { z as schema } from "zod";

import {
  commandReceiptSchema, DESKTOP_CHANNELS, evidenceUploadInputSchema,
  idInputSchema, loginInputSchema, noInputSchema, notificationPageSchema,
  notificationEventSchema,
  optionalCursorSchema, profileInputSchema, selectedServerProfileSchema, serverProfileSchema,
  sessionSnapshotSchema, systemStatusesSchema, uploadReceiptSchema,
  voidOutputSchema, workspaceCommandSchema, workspaceQuerySchema,
  workspaceResultSchema, type OccApi,
} from "./ipc-contract";
import type { ProfileStore } from "./profile-store";
import type { CredentialVault, SessionManager, VaultCredential } from "./session-manager";
import { serializedSize } from "./serialized-size";
import { createCommandIntentRegistry, type CommandIntentRegistry, type InternalWorkspaceCommand } from "./command-intents";
import type { CommandReceipt } from "./desktop-contract";
import { mainUnavailableOperation } from "./main-operation-registry";

export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_UPLOAD_REQUEST_BYTES = 100 * 1024 * 1024 + 64 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const profileListSchema = serverProfileSchema.array();
type InvokeApi = Omit<OccApi, "notifications" | "commands"> & {
  commands: { execute(input: InternalWorkspaceCommand): Promise<CommandReceipt> };
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

interface DesktopApiDependencies {
  profiles: ProfileStore;
  session: Pick<SessionManager, "restore" | "login" | "logout" | "profileSwitched">;
  statuses: OccApi["runtime"]["statuses"];
  clearProfile(profileId: string): Promise<void>;
}

export function createDesktopApi(dependencies: DesktopApiDependencies): InvokeApi {
  let transitionTail = Promise.resolve();
  const transition = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = transitionTail.then(operation);
    transitionTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const cleanup = async (profileId: string) => {
    await Promise.all([
      dependencies.session.profileSwitched(profileId),
      dependencies.clearProfile(profileId),
    ]);
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
          await cleanup(previous.id);
        }
        return dependencies.profiles.save(input);
      }),
      select: (id) => transition(async () => {
        const previous = dependencies.profiles.selected();
        await dependencies.profiles.select(id);
        if (previous && previous.id !== id) await cleanup(previous.id);
      }),
      remove: (id) => transition(async () => {
        await cleanup(id);
        await dependencies.profiles.remove(id);
      }),
    },
    session: {
      restore: () => transition(() => dependencies.session.restore()),
      login: (input) => transition(() => dependencies.session.login(input)),
      logout: () => transition(() => dependencies.session.logout()),
    },
    runtime: { statuses: dependencies.statuses },
    workspaces: {
      query: async (input) => mainUnavailableOperation(input.workspace, input.operation, "/workspaces"),
    },
    commands: {
      execute: async (input) => mainUnavailableOperation(input.workspace, input.operation, "/commands"),
    },
    uploads: {
      start: async () => ({
        state: "problem",
        problem: { title: "Upload unavailable", status: 501 },
      }),
      cancel: async () => undefined,
    },
    notifications: { list: async () => ({ items: [] }) },
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
    { channel: DESKTOP_CHANNELS.uploads.start, input: evidenceUploadInputSchema, output: uploadReceiptSchema, invoke: (input) => api.uploads.start(input), maxRequestBytes: MAX_UPLOAD_REQUEST_BYTES },
    { channel: DESKTOP_CHANNELS.uploads.cancel, input: idInputSchema, output: voidOutputSchema, invoke: (id) => api.uploads.cancel(id) },
    { channel: DESKTOP_CHANNELS.notifications.list, input: optionalCursorSchema, output: notificationPageSchema, invoke: (cursor) => api.notifications.list(cursor) },
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
