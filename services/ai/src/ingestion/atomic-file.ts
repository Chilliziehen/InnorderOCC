import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type AtomicHandle = { writeFile(bytes: Uint8Array): Promise<unknown>; sync(): Promise<unknown>; close(): Promise<unknown> };
type AtomicDirectoryEntry = { name: string; isFile(): boolean; isSymbolicLink(): boolean };
type AtomicMetadata = { mtimeMs: number; isFile(): boolean; isSymbolicLink(): boolean };
export type AtomicFileSystem = {
  open(path: string, flags: number, mode?: number): Promise<AtomicHandle>;
  rename(from: string, to: string): Promise<unknown>;
  rm(path: string, options?: { force?: boolean }): Promise<unknown>;
  readdir(path: string, options: { withFileTypes: true }): Promise<AtomicDirectoryEntry[]>;
  lstat(path: string): Promise<AtomicMetadata>;
};

const nodeFileSystem: AtomicFileSystem = { open, rename, rm, readdir: readdir as AtomicFileSystem["readdir"], lstat };
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const RANDOM = "[a-f0-9]{32}";
const OWNED_TEMP_PATTERNS = {
  "client-input": new RegExp(`^${UUID}\\.[a-f0-9]{64}\\.bin\\.atomic-client-${RANDOM}\\.tmp$`, "u"),
  "client-request": new RegExp(`^${UUID}\\.request\\.json\\.atomic-client-${RANDOM}\\.tmp$`, "u"),
  "worker-output": new RegExp(`^(?:\\.parser-heartbeat\\.json|${UUID}\\.result\\.json)\\.atomic-worker-${RANDOM}\\.tmp$`, "u"),
} as const;

export type AtomicOwner = "client" | "worker";
export type AtomicTempScope = keyof typeof OWNED_TEMP_PATTERNS;
type WriteOptions = Readonly<{ owner: AtomicOwner; randomBytes?: () => Uint8Array; fileSystem?: AtomicFileSystem }>;
type CleanupOptions = Readonly<{ now?: () => number; maxAgeMs?: number; fileSystem?: AtomicFileSystem }>;
const writeQueues = new Map<string, Promise<void>>();

function temporaryPath(path: string, owner: AtomicOwner, randomBytes: () => Uint8Array): string {
  const suffix = Buffer.from(randomBytes()).toString("hex");
  if (!/^[a-f0-9]{32}$/u.test(suffix)) throw new Error("OCC-AI-PARSER-ATOMIC-RANDOM");
  return join(dirname(path), `${basename(path)}.atomic-${owner}-${suffix}.tmp`);
}

async function syncDirectory(path: string, fileSystem: AtomicFileSystem): Promise<void> {
  let handle: AtomicHandle | undefined;
  try {
    handle = await fileSystem.open(dirname(path), constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (process.platform !== "win32" || !["EACCES", "EINVAL", "EISDIR", "EPERM"].includes(String(code))) throw error;
  } finally { await handle?.close(); }
}

async function writeAtomically(path: string, bytes: Uint8Array, options: WriteOptions): Promise<void> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const temporary = temporaryPath(path, options.owner, options.randomBytes ?? (() => cryptoRandomBytes(16)));
  let handle: AtomicHandle | undefined;
  let created = false;
  try {
    handle = await fileSystem.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fileSystem.rename(temporary, path);
    await syncDirectory(path, fileSystem);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    if (created) await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function atomicWrite(path: string, bytes: Uint8Array, options: WriteOptions): Promise<void> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => writeAtomically(path, bytes, options));
  writeQueues.set(path, operation);
  try { await operation; }
  finally { if (writeQueues.get(path) === operation) writeQueues.delete(path); }
}

export async function removeStaleAtomicTemps(root: string, scope: AtomicTempScope, options: CleanupOptions = {}): Promise<void> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const maxAgeMs = options.maxAgeMs ?? 5 * 60_000;
  const now = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1_000 || maxAgeMs > 24 * 60 * 60_000) throw new Error("OCC-AI-PARSER-CONFIG");
  for (const entry of await fileSystem.readdir(root, { withFileTypes: true })) {
    if (!OWNED_TEMP_PATTERNS[scope].test(entry.name)) continue;
    const path = join(root, entry.name);
    let metadata: AtomicMetadata;
    try { metadata = await fileSystem.lstat(path); }
    catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue; throw error; }
    if (metadata.isSymbolicLink() || !metadata.isFile() || now - metadata.mtimeMs < maxAgeMs) continue;
    await fileSystem.rm(path).catch((error: unknown) => {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
    });
  }
}
