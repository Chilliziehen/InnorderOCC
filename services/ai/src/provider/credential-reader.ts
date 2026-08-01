import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

import { ProviderError } from "./provider-policy.js";

export type CredentialReaderOptions = Readonly<{ maxBytes?: number; enforcePermissions?: boolean }>;

export async function readCredentialFile(path: string, options: CredentialReaderOptions = {}): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? 8192;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) throw new ProviderError("OCC-AI-PROVIDER-CREDENTIAL");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let raw: Buffer | undefined;
  try {
    const absolute = resolve(path);
    const root = parse(absolute).root;
    const parents: string[] = [];
    for (let current = dirname(absolute); current !== root; current = dirname(current)) parents.push(current);
    for (const parent of parents.reverse()) {
      if ((await lstat(parent)).isSymbolicLink()) throw new Error("symlink traversal");
    }
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes) throw new Error("invalid metadata");
    if (options.enforcePermissions ?? process.platform !== "win32") {
      if ((before.mode & 0o077) !== 0) throw new Error("permissions");
      if (typeof process.getuid === "function" && before.uid !== process.getuid()) throw new Error("ownership");
    }
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) throw new Error("changed metadata");
    raw = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(raw, 0, raw.length, 0);
    if (bytesRead < 1 || bytesRead > maxBytes) throw new Error("invalid size");
    let end = bytesRead;
    if (raw[end - 1] === 0x0a) {
      end -= 1;
      if (end > 0 && raw[end - 1] === 0x0d) end -= 1;
    }
    if (end < 1) throw new Error("empty");
    const value = Buffer.from(raw.subarray(0, end));
    if ([...value].some((byte) => byte < 0x20 || byte === 0x7f)) {
      value.fill(0);
      throw new Error("control character");
    }
    return value;
  } catch {
    throw new ProviderError("OCC-AI-PROVIDER-CREDENTIAL");
  } finally {
    raw?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}
