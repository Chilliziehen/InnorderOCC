import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import {
  assertElectronProvenance,
  assertInstalledElectronVersion,
} from "../../../scripts/electron-provenance.mjs";
import { removeObsoletePackageOutput } from "./package-output.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
await assertElectronProvenance({ root, environment: process.env });
const require = createRequire(import.meta.url);
await assertInstalledElectronVersion(require.resolve("electron/package.json"));

const operation = process.argv[2];
if (operation !== "start" && operation !== "package" && operation !== "package:smoke" && operation !== "make") {
  throw new Error(`Unsupported Forge operation: ${operation ?? "<missing>"}`);
}
if (operation === "package" || operation === "package:smoke" || operation === "make") {
  await removeObsoletePackageOutput();
}
const { api } = await import("@electron-forge/core");
if (operation === "package:smoke") {
  const forgeApiPath = require.resolve("@electron-forge/core");
  const forgeConfigModule = path.resolve(path.dirname(forgeApiPath), "..", "util", "forge-config.js");
  const { registerForgeConfigForDirectory } = await import(pathToFileURL(forgeConfigModule).href);
  const { default: smokeConfig } = await import("../forge.smoke.config.ts");
  registerForgeConfigForDirectory(process.cwd(), smokeConfig);
  await api.package({ dir: process.cwd(), platform: "win32", arch: "x64", outDir: "out-smoke" });
  process.exit(0);
}
const options = operation === "package" || operation === "make"
  ? { dir: process.cwd(), platform: "win32", arch: "x64" }
  : { dir: process.cwd() };
await api[operation](options);
