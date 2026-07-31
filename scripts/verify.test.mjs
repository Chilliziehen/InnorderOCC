import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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
  assert.ok(guardIndex >= 0 && guardIndex < packageIndex && guardIndex < smokeIndex);
  assert.match(result.stdout, /gradlew(?:\.bat)? :services:core:build --dependency-verification strict/u);
  assert.match(result.stdout, /PostgreSqlFlowableIntegrationTest/u);
  assert.match(result.stdout, /SessionRepositoryIntegrationTest/u);
  assert.match(result.stdout, /AuthControllerIntegrationTest/u);
  assert.match(result.stdout, /BootstrapAdministratorIntegrationTest/u);
  assert.match(result.stdout, /BootstrapAdministratorStartupIntegrationTest/u);
  assert.match(result.stdout, /BootstrapSecretReaderTest/u);
  assert.match(result.stdout, /AuthorizationServiceIntegrationTest/u);
  assert.match(result.stdout, /AuthorizationSnapshotIntegrityIntegrationTest/u);
  assert.match(result.stdout, /strict Core authorization and real OPA integration/u);
  assert.match(result.stdout, /enforce Docker integration JUnit results/u);
});

async function fakeTool(t, cwd, name, exitCode) {
  const path = join(cwd, process.platform === "win32" ? `${name}.cmd` : name);
  const content = process.platform === "win32"
    ? `@echo off\r\nexit /b ${exitCode}\r\n`
    : `#!/bin/sh\nexit ${exitCode}\n`;
  await writeFile(path, content, "utf8");
  if (process.platform !== "win32") await chmod(path, 0o755);
  t.after(() => rm(path, { force: true }));
  return path;
}

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

test("rejects missing or skipped Docker integration JUnit results", async (t) => {
  const module = await helpers();
  assert.equal(typeof module.assertJUnitSuiteExecuted, "function");
  const cwd = await temporaryCwd(t);
  const missing = join(cwd, "missing.xml");
  const skipped = join(cwd, "skipped.xml");
  const passed = join(cwd, "passed.xml");
  await writeFile(skipped, '<testsuite tests="3" skipped="1" failures="0" errors="0"/>', "utf8");
  await writeFile(passed, '<testsuite tests="3" skipped="0" failures="0" errors="0"/>', "utf8");

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
    zero: '<testsuite tests="0" skipped="0" failures="0" errors="0"/>',
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
