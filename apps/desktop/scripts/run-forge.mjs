import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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
if (operation !== "start" && operation !== "package" && operation !== "make") {
  throw new Error(`Unsupported Forge operation: ${operation ?? "<missing>"}`);
}
if (operation === "package" || operation === "make") {
  await removeObsoletePackageOutput();
}
const { api } = await import("@electron-forge/core");
const options = operation === "package" || operation === "make"
  ? { dir: process.cwd(), platform: "win32", arch: "x64" }
  : { dir: process.cwd() };
await api[operation](options);
