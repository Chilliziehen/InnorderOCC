import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { Electron } from "playwright";

const PRODUCT_NAME = "Innorder OCC";
const OUTPUT_DIRECTORY = `${PRODUCT_NAME}-win32-x64`;
const EXECUTABLE_NAME = "InnorderOCC.exe";

export async function preflightPackagedExecutable(root = process.cwd()): Promise<string> {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (packageJson.productName !== PRODUCT_NAME) {
    throw new Error(`Packaged product identity is ${packageJson.productName ?? "missing"}; expected ${PRODUCT_NAME}`);
  }

  const executablePath = path.resolve(root, "out", OUTPUT_DIRECTORY, EXECUTABLE_NAME);
  if (path.basename(executablePath) !== EXECUTABLE_NAME || path.basename(path.dirname(executablePath)) !== OUTPUT_DIRECTORY) {
    throw new Error(`Unexpected packaged executable identity: ${executablePath}`);
  }

  try {
    if (!(await stat(executablePath)).isFile()) {
      throw new Error("path is not a file");
    }
  } catch (error) {
    throw new Error(`Packaged executable ${executablePath} does not exist or is not a file`, { cause: error });
  }
  return executablePath;
}

export function packagedSmokeLaunchOptions(
  executablePath: string,
  args: string[] = [],
): Parameters<Electron["launch"]>[0] {
  const token = randomBytes(32).toString("hex");
  return {
    executablePath,
    args: [`--occ-packaged-smoke-token=${token}`, ...args],
    env: {
      ...process.env,
      OCC_PACKAGED_SMOKE_TOKEN: token,
    },
  };
}
