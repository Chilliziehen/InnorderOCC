import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { ProviderError } from "./provider-policy.js";

export type CredentialMetadata = Readonly<{
  type: "file" | "directory" | "symlink" | "other";
  mode: number;
  uid: number;
  dev: number;
  ino: number;
  size: number;
  trustedAcl: boolean;
}>;

export interface CredentialHandle {
  inspect(): Promise<CredentialMetadata>;
  read(buffer: Buffer): Promise<number>;
  close(): Promise<void>;
}

export interface CredentialFileSystem {
  readonly platform: "posix" | "windows-verified" | "windows-unverified";
  inspect(path: string): Promise<CredentialMetadata>;
  openNoFollow(path: string): Promise<CredentialHandle>;
}

export type CredentialReaderOptions = Readonly<{
  trustedRoot?: string;
  maxBytes?: number;
  fileSystem?: CredentialFileSystem;
  trustedOwnerIds?: readonly number[];
  serviceUid?: number;
}>;

function nodeMetadata(stat: Awaited<ReturnType<typeof lstat>>): CredentialMetadata {
  return {
    type: stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
    mode: Number(stat.mode),
    uid: Number(stat.uid),
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    size: Number(stat.size),
    trustedAcl: process.platform !== "win32",
  };
}

const nodeFileSystem: CredentialFileSystem = {
  platform: process.platform === "win32" ? "windows-unverified" : "posix",
  inspect: async (path) => nodeMetadata(await lstat(path)),
  openNoFollow: async (path) => {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    return {
      inspect: async () => nodeMetadata(await handle.stat()),
      read: async (buffer) => (await handle.read(buffer, 0, buffer.length, 0)).bytesRead,
      close: async () => handle.close(),
    };
  },
};

function sameIdentity(left: CredentialMetadata, right: CredentialMetadata): boolean {
  return left.type === right.type && left.mode === right.mode && left.uid === right.uid &&
    left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.trustedAcl === right.trustedAcl;
}

function validateMetadata(
  item: CredentialMetadata,
  expectedType: "file" | "directory",
  fileSystem: CredentialFileSystem,
  trustedOwners: ReadonlySet<number>,
  serviceUid: number | undefined,
): void {
  if (![item.mode, item.uid, item.dev, item.ino, item.size].every(Number.isSafeInteger)) throw new Error("invalid metadata");
  if (item.type !== expectedType) throw new Error("invalid type");
  if (fileSystem.platform === "windows-unverified" || (fileSystem.platform === "windows-verified" && !item.trustedAcl)) throw new Error("untrusted ACL");
  if (fileSystem.platform === "posix") {
    if (!trustedOwners.has(item.uid) || (serviceUid !== undefined && item.uid === serviceUid)) throw new Error("untrusted owner");
    const writableMask = expectedType === "file" ? 0o077 : 0o022;
    if ((item.mode & writableMask) !== 0) throw new Error("untrusted permissions");
  }
}

function trustedPaths(root: string, path: string): readonly string[] {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (normalizedRoot !== root || normalizedPath !== path) throw new Error("path is not normalized");
  const descendant = relative(normalizedRoot, normalizedPath);
  if (!isAbsolute(normalizedRoot) || descendant === "" || descendant === ".." || descendant.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(descendant)) throw new Error("outside trusted root");
  const segments = descendant.split(/[\\/]/u);
  const result = [normalizedRoot];
  let current = normalizedRoot;
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") throw new Error("ambiguous path");
    current = join(current, segment);
    result.push(current);
  }
  return result;
}

export async function readCredentialFile(path: string, options: CredentialReaderOptions = {}): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? 8192;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) throw new ProviderError("OCC-AI-PROVIDER-CREDENTIAL");
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const trustedOwners = new Set(options.trustedOwnerIds ?? [0]);
  const serviceUid = options.serviceUid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  let handle: CredentialHandle | undefined;
  let raw: Buffer | undefined;
  let value: Buffer | undefined;
  try {
    if (fileSystem.platform === "windows-unverified") throw new Error("unverified Windows ACLs");
    const paths = trustedPaths(options.trustedRoot ?? "/run/secrets", path);
    const before: CredentialMetadata[] = [];
    for (let index = 0; index < paths.length; index += 1) {
      const item = await fileSystem.inspect(paths[index]!);
      validateMetadata(item, index === paths.length - 1 ? "file" : "directory", fileSystem, trustedOwners, serviceUid);
      before.push(item);
    }
    const fileBefore = before[before.length - 1]!;
    if (fileBefore.size < 1 || fileBefore.size > maxBytes) throw new Error("invalid size");
    handle = await fileSystem.openNoFollow(paths[paths.length - 1]!);
    const descriptor = await handle.inspect();
    validateMetadata(descriptor, "file", fileSystem, trustedOwners, serviceUid);
    if (!sameIdentity(fileBefore, descriptor)) throw new Error("file changed before open");
    for (let index = 0; index < paths.length; index += 1) {
      const after = await fileSystem.inspect(paths[index]!);
      validateMetadata(after, index === paths.length - 1 ? "file" : "directory", fileSystem, trustedOwners, serviceUid);
      if (!sameIdentity(before[index]!, after)) throw new Error("trusted path changed");
    }
    raw = Buffer.alloc(maxBytes + 1);
    const bytesRead = await handle.read(raw);
    if (bytesRead < 1 || bytesRead > maxBytes) throw new Error("invalid size");
    let end = bytesRead;
    if (raw[end - 1] === 0x0a) {
      end -= 1;
      if (end > 0 && raw[end - 1] === 0x0d) end -= 1;
    }
    if (end < 1) throw new Error("empty");
    value = Buffer.from(raw.subarray(0, end));
    if ([...value].some((byte) => byte < 0x20 || byte === 0x7f)) throw new Error("control character");
    const result = value;
    value = undefined;
    return result;
  } catch {
    throw new ProviderError("OCC-AI-PROVIDER-CREDENTIAL");
  } finally {
    value?.fill(0);
    raw?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}
