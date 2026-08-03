import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helperPath = fileURLToPath(new URL("./verify-process.mjs", import.meta.url));
const approvedTempRoot = resolve(process.env.OPENCODE_TEMP_DIR ?? join(tmpdir(), "opencode"));

async function helpers() {
  assert.ok(existsSync(helperPath), "verification process helper must exist");
  return import(new URL("./verify-process.mjs", import.meta.url));
}

async function temporaryCwd(t) {
  const fromSystemTemp = relative(resolve(tmpdir()), approvedTempRoot);
  assert.ok(fromSystemTemp && !fromSystemTemp.startsWith("..") && !isAbsolute(fromSystemTemp));
  await mkdir(approvedTempRoot, { recursive: true });
  const cwd = await mkdtemp(join(approvedTempRoot, "verify cwd with spaces-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function temporaryToolCwd(t) {
  await mkdir(approvedTempRoot, { recursive: true });
  const cwd = await mkdtemp(join(approvedTempRoot, "verify-tools-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("executes a relative wrapper from a repository path containing spaces", async (t) => {
  const { runChild } = await helpers();
  const cwd = await temporaryCwd(t);
  await writeFile(join(cwd, "space-marker.txt"), "marker\n", "utf8");

  const wrapper = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
  const script = process.platform === "win32"
    ? '@echo off\r\nif not "%~1"=="expected argument" exit /b 9\r\nif not exist "space-marker.txt" exit /b 10\r\nexit /b 0\r\n'
    : '#!/bin/sh\n[ "$1" = "expected argument" ] || exit 9\n[ -f space-marker.txt ] || exit 10\n';
  const wrapperPath = join(cwd, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  await writeFile(wrapperPath, script, "utf8");
  if (process.platform !== "win32") await chmod(wrapperPath, 0o755);

  await runChild({
    label: "space-path wrapper",
    command: wrapper,
    args: ["expected argument"],
    cwd,
    environment: process.env,
    stdio: "ignore",
  });
});

test("preserves a child nonzero exit code", async (t) => {
  const { runChild, verificationExitCode } = await helpers();
  const cwd = await temporaryCwd(t);

  await assert.rejects(
    runChild({
      label: "failing child",
      command: process.execPath,
      args: ["-e", "process.exit(23)"],
      cwd,
      environment: process.env,
      stdio: "ignore",
    }),
    (error) => {
      assert.equal(error.exitCode, 23);
      assert.equal(verificationExitCode(error), 23);
      return true;
    },
  );
});

test("maps signals to conventional process exit statuses", async () => {
  const { childExitCode, verificationExitCode } = await helpers();

  assert.equal(childExitCode(null, "SIGINT"), 130);
  assert.equal(childExitCode(null, "SIGTERM"), 143);
  assert.equal(childExitCode(17, null), 17);
  assert.equal(verificationExitCode(new Error("unexpected")), 1);
});

test("full verification audits official npm provenance and enforces strict Gradle verification", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["scripts/verify.mjs", "--full", "--dry-run"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npm(?:\.cmd)? audit --audit-level high --registry https:\/\/registry\.npmjs\.org --cache /u);
  assert.match(result.stdout, /npm(?:\.cmd)? audit signatures --registry https:\/\/registry\.npmjs\.org --cache /u);
  assert.match(result.stdout, /test:electron-provenance/u);
  assert.match(result.stdout, /test:deployment-docs/u);
  assert.match(result.stdout, /authorization Zod\/OPA parity/u);
  assert.match(result.stdout, /test:authz-parity/u);
  const guardIndex = result.stdout.indexOf("scripts/electron-provenance.mjs");
  const packageIndex = result.stdout.indexOf("build --workspace @innorder/desktop");
  const smokeIndex = result.stdout.indexOf("smoke --workspace @innorder/desktop");
  assert.ok(guardIndex >= 0 && guardIndex < packageIndex);
  if (process.platform === "win32") assert.ok(smokeIndex > guardIndex);
  else assert.equal(smokeIndex, -1, "Linux backend verification must not launch packaged Windows Electron smoke");
  assert.match(result.stdout, /gradlew(?:\.bat)? :services:core:build --dependency-verification strict/u);
  assert.match(result.stdout, /PostgreSqlFlowableIntegrationTest/u);
  assert.match(result.stdout, /PlatformSecurityKernelIntegrationTest/u);
  assert.match(result.stdout, /SessionRepositoryIntegrationTest/u);
  assert.match(result.stdout, /AuthControllerIntegrationTest/u);
  assert.match(result.stdout, /BootstrapAdministratorIntegrationTest/u);
  assert.match(result.stdout, /BootstrapAdministratorStartupIntegrationTest/u);
  assert.match(result.stdout, /BootstrapSecretReaderTest/u);
  assert.match(result.stdout, /AuthorizationServiceIntegrationTest/u);
  assert.match(result.stdout, /AuthorizationSnapshotIntegrityIntegrationTest/u);
  assert.match(result.stdout, /CommandExecutorIntegrationTest/u);
  assert.match(result.stdout, /OutboxPublisherIntegrationTest/u);
  assert.match(result.stdout, /KafkaOutboxEventSenderProtocolIntegrationTest/u);
  assert.match(result.stdout, /strict complete Core tests with Docker and real OPA/u);
  assert.match(result.stdout, /real PostgreSQL governed AI integration/u);
  assert.match(result.stdout, /database\/tests\/postgresql-governed-ai\.test\.mjs/u);
  assert.match(result.stdout, /services\/ai\/test\/parser-compose-container\.test\.mjs/u);
  assert.match(result.stdout, /enforce complete Core and mandatory integration JUnit results/u);
});

test("quick verification excludes the strict OPA integration gate", () => {
  const result = spawnSync(process.execPath, ["scripts/verify.mjs", "--dry-run"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /gradlew(?:\.bat)? :services:core:build --dependency-verification strict -PexcludeStrictAuthz=true/u,
  );
  assert.doesNotMatch(result.stdout, /database\/tests\/postgresql-governed-ai\.test\.mjs/u);
});

test("full verification runs the strict OPA test and prints only strict environment key names", () => {
  const opaSecret = "C:\\secret\\opa-value.exe";
  const strictSecret = "strict-secret-value";
  const result = spawnSync(process.execPath, ["scripts/verify.mjs", "--full", "--dry-run"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
    env: { ...process.env, OPA_PATH: opaSecret, INNORDER_STRICT_AUTHZ_TESTS: strictSecret },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /strict Core authorization and real OPA integration[\s\S]*--tests com\.innorder\.occ\.PlatformSecurityKernelIntegrationTest/u,
  );
  assert.match(result.stdout, /strict environment keys: OPA_PATH, INNORDER_STRICT_AUTHZ_TESTS/u);
  assert.doesNotMatch(result.stdout, new RegExp(opaSecret.replaceAll("\\", "\\\\"), "u"));
  assert.doesNotMatch(result.stdout, new RegExp(strictSecret, "u"));
});

async function fakeTool(t, cwd, name, exitCode, output = name.startsWith("opa-available") ? "Version: 1.5.1" : "") {
  const path = join(cwd, process.platform === "win32" ? `${name}.cmd` : name);
  const content = process.platform === "win32"
    ? `@echo off\r\n${output ? `echo ${output}\r\n` : ""}exit /b ${exitCode}\r\n`
    : `#!/bin/sh\n${output ? `printf '%s\\n' '${output}'\n` : ""}exit ${exitCode}\n`;
  await writeFile(path, content, "utf8");
  if (process.platform !== "win32") await chmod(path, 0o755);
  t.after(() => rm(path, { force: true }));
  return path;
}

async function fakeNpmStoppingBeforeGradle(t, cwd) {
  const path = join(cwd, process.platform === "win32" ? "npm.cmd" : "npm");
  const content = process.platform === "win32"
    ? '@echo off\r\nif "%~1 %~2"=="run test:database" exit /b 19\r\nexit /b 0\r\n'
    : '#!/bin/sh\n[ "$1 $2" = "run test:database" ] && exit 19\nexit 0\n';
  await writeFile(path, content, "utf8");
  if (process.platform !== "win32") await chmod(path, 0o755);
  t.after(() => rm(path, { force: true }));
  return path;
}

test("real OPA status logging does not disclose the configured executable path", async (t) => {
  const cwd = await temporaryToolCwd(t);
  const opa = await fakeTool(t, cwd, "opa-available-secret-sentinel", 0);
  await fakeNpmStoppingBeforeGradle(t, cwd);

  const result = spawnSync(process.execPath, ["scripts/verify.mjs", "--tests"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
    env: { ...process.env, PATH: `${cwd}${delimiter}${process.env.PATH ?? ""}`, OPA_PATH: opa },
  });

  assert.equal(result.status, 19, result.stderr);
  assert.match(result.stdout, /real OPA checks enabled/u);
  assert.doesNotMatch(result.stdout, /opa-available-secret-sentinel/u);
});

function runStrictFull(environment) {
  return spawnSync(process.execPath, ["scripts/verify.mjs", "--full"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
    env: environment,
  });
}

test("strict full fails preflight when the Docker engine is unavailable", async (t) => {
  const cwd = await temporaryToolCwd(t);
  const docker = await fakeTool(t, cwd, "docker-unavailable", 1);
  const opa = await fakeTool(t, cwd, "opa-available", 0);

  const result = runStrictFull({ ...process.env, PATH: cwd, DOCKER_PATH: docker, OPA_PATH: opa });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Docker engine unavailable/u);
  assert.doesNotMatch(result.stdout, /full verification passed/u);
});

test("strict full fails preflight when a real OPA executable is unavailable", async (t) => {
  const cwd = await temporaryToolCwd(t);
  const docker = await fakeTool(t, cwd, "docker-available", 0);
  const opa = await fakeTool(t, cwd, "opa-unavailable", 1);

  const result = runStrictFull({ ...process.env, PATH: cwd, DOCKER_PATH: docker, OPA_PATH: opa });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OPA executable unavailable/u);
  assert.doesNotMatch(result.stdout, /full verification passed/u);
});

test("strict full rejects an OPA executable that is not version 1.5.1", async (t) => {
  const cwd = await temporaryToolCwd(t);
  const docker = await fakeTool(t, cwd, "docker-available", 0);
  const opa = await fakeTool(t, cwd, "opa-wrong-version", 0, "Version: 1.6.0");

  const result = runStrictFull({ ...process.env, PATH: cwd, DOCKER_PATH: docker, OPA_PATH: opa });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OPA 1\.5\.1/u);
});

test("local verification has explicit non-full success semantics", () => {
  const result = spawnSync(process.execPath, ["scripts/verify.mjs", "--local", "--dry-run"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local verification passed/u);
  assert.doesNotMatch(result.stdout, /full verification passed/u);
  assert.match(result.stdout, /database\/tests\/pglite-smoke\.mjs/u);
  assert.match(result.stdout, /smoke --workspace @innorder\/desktop/u);
});

test("tests mode reruns Core without requiring OPA or applying strict JUnit enforcement", () => {
  const environment = { ...process.env };
  delete environment.OPA_PATH;
  const result = spawnSync(process.execPath, ["scripts/verify.mjs", "--tests", "--dry-run"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
    env: environment,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OPA binary unavailable/u);
  assert.match(result.stdout, /:services:core:test --rerun-tasks --dependency-verification strict/u);
  assert.doesNotMatch(result.stdout, /strict complete Core tests|enforce complete Core/u);
});

test("rejects missing or skipped Docker integration JUnit results", async (t) => {
  const module = await helpers();
  assert.equal(typeof module.assertJUnitSuiteExecuted, "function");
  const cwd = await temporaryCwd(t);
  const missing = join(cwd, "missing.xml");
  const skipped = join(cwd, "skipped.xml");
  const passed = join(cwd, "passed.xml");
  await writeFile(skipped, '<testsuite tests="1" skipped="1" failures="0" errors="0"><testcase name="skip"><skipped/></testcase></testsuite>', "utf8");
  await writeFile(passed, '<testsuite tests="1" skipped="0" failures="0" errors="0"><testcase name="pass"/></testsuite>', "utf8");

  assert.throws(() => module.assertJUnitSuiteExecuted(missing), /missing/u);
  assert.throws(() => module.assertJUnitSuiteExecuted(skipped), /skipped 1/u);
  assert.doesNotThrow(() => module.assertJUnitSuiteExecuted(passed));
});

test("rejects malformed ambiguous or invalid Docker integration JUnit XML", async (t) => {
  const { assertJUnitSuiteExecuted } = await helpers();
  const cwd = await temporaryCwd(t);
  const invalidDocuments = {
    truncated: '<testsuite tests="3" skipped="0" failures="0" errors="0">',
    malformed: '<testsuite tests="3" skipped="0" failures="0" errors="0"><testcase></testsuite>',
    missing: '<testsuite tests="3" skipped="0" failures="0"/>',
    nonInteger: '<testsuite tests="three" skipped="0" failures="0" errors="0"/>',
    decimal: '<testsuite tests="3.5" skipped="0" failures="0" errors="0"/>',
    negative: '<testsuite tests="3" skipped="-1" failures="0" errors="0"/>',
    zero: '<testsuite tests="0" skipped="0" failures="0" errors="0"></testsuite>',
    forgedSelfClosing: '<testsuite tests="3" skipped="0" failures="0" errors="0"/>',
    duplicateRoot: '<testsuite tests="3" skipped="0" failures="0" errors="0"/><testsuite tests="3" skipped="0" failures="0" errors="0"/>',
    ambiguousSuites: '<testsuites><testsuite tests="2" skipped="0" failures="0" errors="0"/><testsuite tests="1" skipped="0" failures="0" errors="0"/></testsuites>',
  };

  for (const [name, xml] of Object.entries(invalidDocuments)) {
    const path = join(cwd, `${name}.xml`);
    await writeFile(path, xml, "utf8");
    assert.throws(
      () => assertJUnitSuiteExecuted(path),
      undefined,
      `${name} JUnit XML must be rejected`,
    );
  }
});

test("reconciles JUnit summaries with direct testcase outcomes", async (t) => {
  const { assertJUnitSuiteExecuted } = await helpers();
  const cwd = await temporaryCwd(t);
  const valid = join(cwd, "valid.xml");
  await writeFile(valid, '<testsuite tests="2" skipped="0" failures="0" errors="0"><properties/><testcase name="one"/><testcase name="two"></testcase><system-out>safe &amp; valid</system-out><system-err></system-err></testsuite>', "utf8");
  assert.doesNotThrow(() => assertJUnitSuiteExecuted(valid));

  const invalidDocuments = {
    forgedPass: '<testsuite tests="1" skipped="0" failures="0" errors="0"><testcase name="bad"><failure>boom</failure></testcase></testsuite>',
    childFailure: '<testsuite tests="1" skipped="0" failures="1" errors="0"><testcase name="bad"><failure/></testcase></testsuite>',
    childError: '<testsuite tests="1" skipped="0" failures="0" errors="1"><testcase name="bad"><error/></testcase></testsuite>',
    childSkipped: '<testsuite tests="1" skipped="1" failures="0" errors="0"><testcase name="skip"><skipped/></testcase></testsuite>',
    testCountMismatch: '<testsuite tests="2" skipped="0" failures="0" errors="0"><testcase name="one"/></testsuite>',
    outcomeMismatch: '<testsuite tests="1" skipped="0" failures="1" errors="0"><testcase name="bad"><error/></testcase></testsuite>',
    nestedTestcase: '<testsuite tests="1" skipped="0" failures="0" errors="0"><properties><testcase name="fake"/></properties></testsuite>',
    nestedSuite: '<testsuite tests="1" skipped="0" failures="0" errors="0"><testsuite tests="1" skipped="0" failures="0" errors="0"><testcase name="fake"/></testsuite></testsuite>',
  };
  for (const [name, xml] of Object.entries(invalidDocuments)) {
    const path = join(cwd, `${name}.xml`);
    await writeFile(path, xml, "utf8");
    assert.throws(() => assertJUnitSuiteExecuted(path), undefined, `${name} must be rejected`);
  }
});

test("complete Core JUnit guard discovers every concrete top-level Kotlin test suite", async (t) => {
  const { assertCompleteCoreJUnitResults, discoverConcreteKotlinTestSuites } = await helpers();
  const cwd = await temporaryCwd(t);
  const sourceRoot = join(cwd, "src", "test", "kotlin");
  const packageRoot = join(sourceRoot, "com", "example");
  const resultsRoot = join(cwd, "results");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(resultsRoot, { recursive: true });
  await writeFile(join(packageRoot, "AlphaTest.kt"), "  package com.example\n    class AlphaTest {\n fun `brace } decoy`() {}\n}\n", "utf8");
  await writeFile(join(packageRoot, "BetaTest.kt"), "package com.example\npublic\nfinal\nclass BetaTest\n", "utf8");
  await writeFile(join(packageRoot, "InternalTest.kt"), "package com.example\n@SpringBootTest\ninternal\nclass InternalTest\n", "utf8");
  await writeFile(
    join(resultsRoot, "TEST-com.example.AlphaTest.xml"),
    '<testsuite tests="1" skipped="0" failures="0" errors="0"><testcase name="pass"/></testsuite>',
    "utf8",
  );
  await writeFile(
    join(resultsRoot, "TEST-com.example.InternalTest.xml"),
    '<testsuite tests="1" skipped="0" failures="0" errors="0"><testcase name="pass"/></testsuite>',
    "utf8",
  );

  assert.deepEqual(discoverConcreteKotlinTestSuites(sourceRoot), [
    "com.example.AlphaTest",
    "com.example.BetaTest",
    "com.example.InternalTest",
  ]);
  assert.throws(
    () => assertCompleteCoreJUnitResults(sourceRoot, resultsRoot),
    /BetaTest.*missing/u,
  );

  await writeFile(
    join(resultsRoot, "TEST-com.example.BetaTest.xml"),
    '<testsuite tests="1" skipped="0" failures="0" errors="0"><testcase name="pass"/></testsuite>',
    "utf8",
  );
  assert.doesNotThrow(() => assertCompleteCoreJUnitResults(sourceRoot, resultsRoot));
});

test("Kotlin discovery rejects abstract nested comment and string decoys", async (t) => {
  const { discoverConcreteKotlinTestSuites } = await helpers();
  const cwd = await temporaryCwd(t);
  const cases = {
    AbstractTest: "package com.example\npublic abstract class AbstractTest\n",
    NestedTest: "package com.example\nclass Container {\n class NestedTest\n}\n",
    CommentTest: "package com.example\n/* class CommentTest */\nval text = \"class CommentTest\"\n",
    RawStringTest: 'package com.example\nval text = """\nclass RawStringTest\n"""\n',
    MismatchTest: "package com.example\nclass DifferentTest\n",
  };
  for (const [name, source] of Object.entries(cases)) {
    const root = join(cwd, name, "com", "example");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, `${name}.kt`), source, "utf8");
    assert.throws(() => discoverConcreteKotlinTestSuites(join(cwd, name)), new RegExp(`${name}.*concrete top-level class`, "u"));
  }
});

test("complete Core JUnit guard rejects malformed or skipped arbitrary emitted suites", async (t) => {
  const { assertCompleteCoreJUnitResults } = await helpers();
  const cwd = await temporaryCwd(t);
  const sourceRoot = join(cwd, "src", "test", "kotlin");
  const packageRoot = join(sourceRoot, "com", "example");
  const resultsRoot = join(cwd, "results");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(resultsRoot, { recursive: true });
  await writeFile(join(packageRoot, "AlphaTest.kt"), "package com.example\nclass AlphaTest\n", "utf8");
  await writeFile(
    join(resultsRoot, "TEST-com.example.AlphaTest.xml"),
    '<testsuite tests="1" skipped="0" failures="0" errors="0"><testcase name="pass"/></testsuite>',
    "utf8",
  );
  const arbitrary = join(resultsRoot, "TEST-com.example.ArbitraryTest.xml");
  await writeFile(arbitrary, '<testsuite tests="1" skipped="1" failures="0" errors="0"><testcase name="skip"><skipped/></testcase></testsuite>', "utf8");
  assert.throws(() => assertCompleteCoreJUnitResults(sourceRoot, resultsRoot), /skipped 1/u);

  await writeFile(arbitrary, '<testsuite tests="1" skipped="0" failures="0" errors="0">', "utf8");
  assert.throws(() => assertCompleteCoreJUnitResults(sourceRoot, resultsRoot), /malformed/u);
});
