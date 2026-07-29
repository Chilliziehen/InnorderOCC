import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { SaxesParser } from "saxes";

export class ChildProcessFailure extends Error {
  constructor(label, code, signal) {
    const exitCode = childExitCode(code, signal);
    super(`${label} failed (${signal ?? `exit ${code}`})`);
    this.name = "ChildProcessFailure";
    this.exitCode = exitCode;
    this.childCode = code;
    this.signal = signal;
  }
}

export function childExitCode(code, signal) {
  if (Number.isInteger(code)) return code;
  const signalNumber = signal ? constants.signals[signal] : undefined;
  return Number.isInteger(signalNumber) ? 128 + signalNumber : 1;
}

export function commandForPlatform(
  command,
  args,
  platform = process.platform,
  comspec = process.env.ComSpec,
) {
  const usesWindowsBatch = platform === "win32" && /\.(?:bat|cmd)$/iu.test(command);
  return usesWindowsBatch
    ? {
        executable: comspec ?? "cmd.exe",
        args: ["/d", "/s", "/c", command, ...args],
      }
    : { executable: command, args };
}

export async function runChild({
  label,
  command,
  args,
  cwd,
  environment,
  stdio = "inherit",
}) {
  const invocation = commandForPlatform(command, args);
  await new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: environment,
      stdio,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new ChildProcessFailure(label, code, signal));
      }
    });
  });
}

export function verificationExitCode(error) {
  return Number.isInteger(error?.exitCode) && error.exitCode !== 0
    ? error.exitCode
    : 1;
}

export function assertJUnitSuiteExecuted(path) {
  if (!existsSync(path)) {
    throw new Error(`Docker integration JUnit result is missing: ${path}`);
  }
  const xml = readFileSync(path, "utf8");
  let depth = 0;
  let rootName;
  let suiteCount = 0;
  let suiteAttributes;
  const parser = new SaxesParser({ fileName: path });
  parser.on("doctype", () => {
    throw new Error(`Docker integration JUnit result must not contain a doctype: ${path}`);
  });
  parser.on("opentag", (node) => {
    if (depth === 0) rootName = node.name;
    depth += 1;
    if (node.name === "testsuite") {
      suiteCount += 1;
      if (depth !== 1) {
        throw new Error(`Docker integration JUnit result contains ambiguous testsuites: ${path}`);
      }
      suiteAttributes = node.attributes;
    }
  });
  parser.on("closetag", () => {
    depth -= 1;
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    throw new Error(`Docker integration JUnit result is malformed: ${path}`, { cause: error });
  }
  if (rootName !== "testsuite" || suiteCount !== 1 || !suiteAttributes) {
    throw new Error(`Docker integration JUnit result must contain exactly one root testsuite: ${path}`);
  }
  const attribute = (name) => {
    const raw = suiteAttributes[name];
    if (typeof raw !== "string" || !/^(?:0|[1-9]\d*)$/u.test(raw)) {
      throw new Error(`Docker integration JUnit attribute ${name} must be a non-negative integer: ${path}`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Docker integration JUnit attribute ${name} exceeds the safe integer range: ${path}`);
    }
    return value;
  };
  const tests = attribute("tests");
  const skipped = attribute("skipped");
  const failures = attribute("failures");
  const errors = attribute("errors");
  if (tests <= 0 || skipped !== 0 || failures !== 0 || errors !== 0) {
    throw new Error(`Docker integration JUnit suite did not fully execute: tests ${tests}, skipped ${skipped}, failures ${failures}, errors ${errors}`);
  }
}
