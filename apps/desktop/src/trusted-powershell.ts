import path from "node:path";

type StatLike = { isFile(): boolean; isSymbolicLink(): boolean };

export async function resolveTrustedPowerShell(input: {
  systemRoot: string | undefined;
  pathEnvironment: string | undefined;
  lstat(target: string): Promise<StatLike>;
  realpath(target: string): Promise<string>;
}): Promise<string> {
  const systemRoot = input.systemRoot ?? "";
  if (!path.win32.isAbsolute(systemRoot)) throw new Error("SystemRoot must be absolute");
  const candidate = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const expectedRoot = `${path.win32.resolve(systemRoot).replace(/[\\/]+$/u, "")}\\`;
  if (!path.win32.resolve(candidate).startsWith(expectedRoot)) throw new Error("PowerShell must remain under SystemRoot");
  const stat = await input.lstat(candidate).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error("PowerShell must be a regular non-reparse file");
  const physicalPath = await input.realpath(candidate).catch(() => undefined);
  if (!physicalPath || path.win32.resolve(physicalPath).toLowerCase() !== path.win32.resolve(candidate).toLowerCase()) {
    throw new Error("PowerShell must resolve exactly under SystemRoot");
  }
  return candidate;
}
