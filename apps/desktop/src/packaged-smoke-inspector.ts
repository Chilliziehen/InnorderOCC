import path from "node:path";

const TOKEN_ARGUMENT = "--occ-packaged-smoke-token=";
const OUTPUT_DIRECTORY = "Innorder OCC-win32-x64";
const EXECUTABLE_NAME = "InnorderOCC.exe";

interface PackagedSmokeInspectorOptions {
  execPath: string;
  argv: string[];
  environmentToken: string | undefined;
  openInspector: (port: number, host: string, wait: boolean) => void;
}

export function enablePackagedSmokeInspector({
  execPath,
  argv,
  environmentToken,
  openInspector,
}: PackagedSmokeInspectorOptions): boolean {
  const outputDirectory = path.dirname(path.resolve(execPath));
  const isGeneratedPackage = path.basename(execPath) === EXECUTABLE_NAME
    && path.basename(outputDirectory) === OUTPUT_DIRECTORY
    && path.basename(path.dirname(outputDirectory)) === "out";
  const argumentToken = argv.find((argument) => argument.startsWith(TOKEN_ARGUMENT))
    ?.slice(TOKEN_ARGUMENT.length);
  const validToken = environmentToken !== undefined
    && /^[a-f0-9]{64}$/.test(environmentToken)
    && argumentToken === environmentToken;

  if (!isGeneratedPackage || !validToken) return false;
  openInspector(0, "127.0.0.1", false);
  return true;
}
