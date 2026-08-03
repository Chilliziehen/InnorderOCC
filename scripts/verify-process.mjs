import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
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
  let testcaseCount = 0;
  let observedSkipped = 0;
  let observedFailures = 0;
  let observedErrors = 0;
  let currentTestcaseHasOutcome = false;
  const elements = [];
  const parser = new SaxesParser({ fileName: path });
  parser.on("doctype", () => {
    throw new Error(`Docker integration JUnit result must not contain a doctype: ${path}`);
  });
  parser.on("opentag", (node) => {
    if (depth === 0) rootName = node.name;
    if (node.name === "testsuite") {
      suiteCount += 1;
      if (depth !== 0) {
        throw new Error(`Docker integration JUnit result contains ambiguous testsuites: ${path}`);
      }
      suiteAttributes = node.attributes;
    } else if (node.name === "testcase") {
      if (depth !== 1 || elements[0] !== "testsuite") {
        throw new Error(`Docker integration JUnit result contains a non-direct testcase: ${path}`);
      }
      testcaseCount += 1;
      currentTestcaseHasOutcome = false;
    } else if (["skipped", "failure", "error"].includes(node.name)) {
      if (depth !== 2 || elements[1] !== "testcase" || currentTestcaseHasOutcome) {
        throw new Error(`Docker integration JUnit result contains an ambiguous testcase outcome: ${path}`);
      }
      currentTestcaseHasOutcome = true;
      if (node.name === "skipped") observedSkipped += 1;
      if (node.name === "failure") observedFailures += 1;
      if (node.name === "error") observedErrors += 1;
    }
    elements.push(node.name);
    depth += 1;
  });
  parser.on("closetag", () => {
    depth -= 1;
    const closed = elements.pop();
    if (closed === "testcase") currentTestcaseHasOutcome = false;
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
  if (tests !== testcaseCount || skipped !== observedSkipped || failures !== observedFailures || errors !== observedErrors) {
    throw new Error(`Docker integration JUnit summary does not match testcase outcomes: tests ${tests}/${testcaseCount}, skipped ${skipped}/${observedSkipped}, failures ${failures}/${observedFailures}, errors ${errors}/${observedErrors}`);
  }
  if (tests <= 0 || skipped !== 0 || failures !== 0 || errors !== 0) {
    throw new Error(`Docker integration JUnit suite did not fully execute: tests ${tests}, skipped ${skipped}, failures ${failures}, errors ${errors}`);
  }
}

function maskKotlinNonCode(source, path) {
  const output = source.split("");
  const mask = (index) => {
    if (output[index] !== "\r" && output[index] !== "\n") output[index] = " ";
  };
  let index = 0;
  const lineComment = () => {
    while (index < source.length && source[index] !== "\n") mask(index++);
  };
  const blockComment = () => {
    let nesting = 0;
    do {
      if (source.startsWith("/*", index)) {
        mask(index++); mask(index++); nesting += 1;
      } else if (source.startsWith("*/", index)) {
        mask(index++); mask(index++); nesting -= 1;
      } else {
        mask(index++);
      }
    } while (index < source.length && nesting > 0);
    if (nesting !== 0) throw new Error(`Core Kotlin test source has an unterminated block comment: ${path}`);
  };
  const rawString = () => {
    mask(index++); mask(index++); mask(index++);
    while (index < source.length && !source.startsWith('"""', index)) mask(index++);
    if (index >= source.length) throw new Error(`Core Kotlin test source has an unterminated raw string: ${path}`);
    mask(index++); mask(index++); mask(index++);
  };
  const character = () => {
    mask(index++);
    let closed = false;
    while (index < source.length) {
      if (source[index] === "\\") {
        mask(index++);
        if (index < source.length) mask(index++);
      } else if (source[index] === "'") {
        mask(index++); closed = true; break;
      } else {
        mask(index++);
      }
    }
    if (!closed) throw new Error(`Core Kotlin test source has an unterminated character literal: ${path}`);
  };
  const backtickIdentifier = () => {
    mask(index++);
    while (index < source.length && source[index] !== "`") mask(index++);
    if (index >= source.length) throw new Error(`Core Kotlin test source has an unterminated backtick identifier: ${path}`);
    mask(index++);
  };
  let quotedString;
  const interpolation = () => {
    mask(index++); mask(index++);
    let nesting = 1;
    while (index < source.length && nesting > 0) {
      if (source.startsWith("//", index)) lineComment();
      else if (source.startsWith("/*", index)) blockComment();
      else if (source.startsWith('"""', index)) rawString();
      else if (source[index] === '"') quotedString();
      else if (source[index] === "'") character();
      else if (source[index] === "`") backtickIdentifier();
      else if (source[index] === "{") { mask(index++); nesting += 1; }
      else if (source[index] === "}") { mask(index++); nesting -= 1; }
      else mask(index++);
    }
    if (nesting !== 0) throw new Error(`Core Kotlin test source has an unterminated string interpolation: ${path}`);
  };
  quotedString = () => {
    mask(index++);
    let closed = false;
    while (index < source.length) {
      if (source[index] === "\\") {
        mask(index++);
        if (index < source.length) mask(index++);
      } else if (source.startsWith("${", index)) {
        interpolation();
      } else if (source[index] === '"') {
        mask(index++); closed = true; break;
      } else {
        mask(index++);
      }
    }
    if (!closed) throw new Error(`Core Kotlin test source has an unterminated string literal: ${path}`);
  };
  while (index < source.length) {
    if (source.startsWith("//", index)) lineComment();
    else if (source.startsWith("/*", index)) blockComment();
    else if (source.startsWith('"""', index)) rawString();
    else if (source[index] === '"') quotedString();
    else if (source[index] === "'") character();
    else if (source[index] === "`") backtickIdentifier();
    else index += 1;
  }
  return output.join("");
}

function topLevelKotlinClasses(source) {
  const tokens = [];
  let depth = 0;
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === "{") {
      depth += 1; index += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth < 0) throw new Error(`unbalanced closing brace at line ${source.slice(0, index).split(/\r?\n/u).length}`);
      index += 1;
    } else if (/[A-Za-z_]/u.test(character)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_]/u.test(source[index])) index += 1;
      tokens.push({ value: source.slice(start, index), start, end: index, depth });
    } else {
      index += 1;
    }
  }
  if (depth !== 0) throw new Error("unbalanced opening brace");

  const classes = [];
  const modifiers = new Set(["public", "private", "internal", "protected", "open", "final", "sealed", "data", "value", "enum", "annotation", "expect", "actual", "abstract"]);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    const name = tokens[index + 1];
    if (token.depth !== 0 || token.value !== "class" || name.depth !== 0 || source.slice(token.end, name.start).trim() !== "") continue;
    const applied = [];
    for (let previous = index - 1; previous >= 0 && tokens[previous].depth === 0 && modifiers.has(tokens[previous].value) && source.slice(tokens[previous].end, tokens[previous + 1].start).trim() === ""; previous -= 1) {
      applied.push(tokens[previous].value);
    }
    classes.push({ name: name.value, concrete: !applied.some((modifier) => ["abstract", "sealed", "annotation"].includes(modifier)) });
  }
  return classes;
}

export function discoverConcreteKotlinTestSuites(sourceRoot) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith("Test.kt")) files.push(path);
    }
  }
  visit(sourceRoot);

  const suites = [];
  for (const path of files) {
    const source = maskKotlinNonCode(readFileSync(path, "utf8"), path);
    const packageName = source.match(/^\s*package\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*$/mu)?.[1];
    if (!packageName) throw new Error(`Core Kotlin test source has no package: ${path}`);
    const expectedClass = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1, -3);
    let classes;
    try {
      classes = topLevelKotlinClasses(source);
    } catch (error) {
      throw new Error(`Core Kotlin test source has invalid lexical structure: ${path}`, { cause: error });
    }
    if (!classes.some((declaration) => declaration.name === expectedClass && declaration.concrete)) {
      throw new Error(`Core Kotlin test source ${expectedClass} must declare a concrete top-level class named ${expectedClass}`);
    }
    suites.push(`${packageName}.${expectedClass}`);
  }
  return suites.sort();
}

export function assertCompleteCoreJUnitResults(sourceRoot, resultsRoot) {
  const expectedSuites = discoverConcreteKotlinTestSuites(sourceRoot);
  const resultFiles = readdirSync(resultsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^TEST-.+[.]xml$/u.test(entry.name))
    .map((entry) => join(resultsRoot, entry.name));
  for (const path of resultFiles) assertJUnitSuiteExecuted(path);
  const emitted = new Set(resultFiles.map((path) => path.slice(path.lastIndexOf("TEST-") + 5, -4)));
  for (const suite of expectedSuites) {
    if (!emitted.has(suite)) throw new Error(`Core JUnit suite ${suite} is missing`);
  }
}
