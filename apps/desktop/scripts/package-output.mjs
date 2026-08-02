import { rm } from "node:fs/promises";
import path from "node:path";

const OBSOLETE_OUTPUT_DIRECTORY = "@innorder-desktop-win32-x64";

export async function removeObsoletePackageOutput(root = process.cwd()) {
  await rm(path.resolve(root, "out", OBSOLETE_OUTPUT_DIRECTORY), {
    recursive: true,
    force: true,
  });
}
