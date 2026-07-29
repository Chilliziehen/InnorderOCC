import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertElectronProvenance } from "./electron-provenance.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = join(root, ".cache", "npm");

try {
  await assertElectronProvenance({ root, environment: process.env });
  await mkdir(cache, { recursive: true });

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["ci", "--registry", "https://registry.npmjs.org", "--cache", cache];
  const executable = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : npm;
  const executableArgs = process.platform === "win32" ? ["/d", "/s", "/c", npm, ...args] : args;
  const result = spawnSync(executable, executableArgs, { cwd: root, env: process.env, stdio: "inherit" });

  if (result.error) throw result.error;
  if (Number.isInteger(result.status)) {
    process.exitCode = result.status;
  } else {
    const signalNumber = result.signal ? constants.signals[result.signal] : undefined;
    process.exitCode = Number.isInteger(signalNumber) ? 128 + signalNumber : 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
