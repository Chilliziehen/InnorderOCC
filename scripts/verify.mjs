import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { assertJUnitSuiteExecuted, commandForPlatform, runChild, verificationExitCode } from "./verify-process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

async function main() {
  const options = new Set(process.argv.slice(2));
  const supportedOptions = new Set(["--dry-run", "--full", "--local", "--pglite", "--tests"]);

  for (const option of options) {
    if (!supportedOptions.has(option)) {
      throw new Error(`Unknown verification option: ${option}`);
    }
  }

  const modes = ["--full", "--local", "--pglite", "--tests"].filter((mode) => options.has(mode));
  if (modes.length > 1) {
    throw new Error(`Verification modes are mutually exclusive: ${modes.join(", ")}`);
  }

  const dryRun = options.has("--dry-run");
  const full = options.has("--full");
  const local = options.has("--local");
  const extended = full || local;
  const pgliteOnly = options.has("--pglite");
  const testsOnly = options.has("--tests");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const gradle = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
  const npmAuditCache = join(tmpdir(), "innorder-occ-npm-audit-cache");
  const integrationResults = [
    "TEST-com.innorder.occ.PlatformSecurityKernelIntegrationTest.xml",
    "TEST-com.innorder.occ.PostgreSqlFlowableIntegrationTest.xml",
    "TEST-com.innorder.occ.auth.AccessTokenSecurityTest.xml",
    "TEST-com.innorder.occ.auth.AuthServicePasswordWorkTest.xml",
    "TEST-com.innorder.occ.auth.SessionRepositoryIntegrationTest.xml",
    "TEST-com.innorder.occ.auth.AuthControllerIntegrationTest.xml",
    "TEST-com.innorder.occ.auth.PasswordServiceTest.xml",
    "TEST-com.innorder.occ.iam.BootstrapAdministratorIntegrationTest.xml",
    "TEST-com.innorder.occ.iam.BootstrapAdministratorStartupIntegrationTest.xml",
    "TEST-com.innorder.occ.iam.BootstrapSecretReaderTest.xml",
    "TEST-com.innorder.occ.authz.AuditDataSourceConfigurationTest.xml",
    "TEST-com.innorder.occ.authz.AuthorizationDecisionValidatorTest.xml",
    "TEST-com.innorder.occ.authz.AuthorizationServiceIntegrationTest.xml",
    "TEST-com.innorder.occ.authz.AuthorizationSnapshotIntegrityIntegrationTest.xml",
    "TEST-com.innorder.occ.authz.PolicyReleaseIntegrityTest.xml",
    "TEST-com.innorder.occ.command.CanonicalJsonObjectTest.xml",
    "TEST-com.innorder.occ.command.CommandExecutorIntegrationTest.xml",
    "TEST-com.innorder.occ.config.FlowableDatabaseInitializationDependencyDetectorTest.xml",
    "TEST-com.innorder.occ.events.EventEnvelopeTest.xml",
    "TEST-com.innorder.occ.events.KafkaOutboxEventSenderTest.xml",
    "TEST-com.innorder.occ.events.OutboxConfigurationTest.xml",
    "TEST-com.innorder.occ.events.OutboxPublisherIntegrationTest.xml",
    "TEST-com.innorder.occ.events.OutboxPropertiesTest.xml",
    "TEST-com.innorder.occ.events.KafkaOutboxEventSenderProtocolIntegrationTest.xml",
  ].map((file) => join(root, "services", "core", "build", "test-results", "test", file));

  function printable(command, args) {
    return [command, ...args].join(" ");
  }

  async function run(label, command, args, environment = process.env) {
    console.log(`\n[verify] ${label}`);
    console.log(`$ ${printable(command, args)}`);
    if (dryRun) return;

    await runChild({
      label,
      command,
      args,
      cwd: root,
      environment,
    });
  }

  function probe(command, args) {
    const invocation = commandForPlatform(command, args);
    return spawnSync(invocation.executable, invocation.args, { encoding: "utf8" });
  }

  function findOpa() {
    if (dryRun) return undefined;
    const candidate = process.env.OPA_PATH ?? (process.platform === "win32" ? "opa.exe" : "opa");
    const result = probe(candidate, ["version"]);
    return result.status === 0 && /(?:^|\n)Version:\s+1\.5\.1\s*(?:\r?\n|$)/u.test(`${result.stdout}${result.stderr}`)
      ? candidate : undefined;
  }

  function strictPreflight() {
    const docker = process.env.DOCKER_PATH ?? (process.platform === "win32" ? "docker.exe" : "docker");
    if (probe(docker, ["info", "--format", "{{.ServerVersion}}"]).status !== 0) {
      throw new Error("Docker engine unavailable; strict full verification requires a responding Docker daemon");
    }
    const candidate = process.env.OPA_PATH ?? (process.platform === "win32" ? "opa.exe" : "opa");
    const result = probe(candidate, ["version"]);
    if (result.status !== 0) throw new Error("OPA executable unavailable; strict full verification requires `opa version` to succeed");
    if (!/(?:^|\n)Version:\s+1\.5\.1\s*(?:\r?\n|$)/u.test(`${result.stdout}${result.stderr}`)) {
      throw new Error("OPA 1.5.1 is required for strict full verification");
    }
    return candidate;
  }

  function pgliteModuleRoot() {
    if (process.env.PGLITE_MODULE_ROOT) return process.env.PGLITE_MODULE_ROOT;
    const entrypoint = require.resolve("@electric-sql/pglite");
    return dirname(dirname(entrypoint));
  }

  async function runPglite() {
    const moduleRoot = dryRun ? "<installed @electric-sql/pglite>" : pgliteModuleRoot();
    await run(
      "database PGlite smoke tests",
      process.execPath,
      ["database/tests/pglite-smoke.mjs"],
      { ...process.env, PGLITE_MODULE_ROOT: moduleRoot },
    );
  }

  if (pgliteOnly) {
    await runPglite();
    return;
  }

  const requiredOpa = full && !dryRun ? strictPreflight() : undefined;

  if (!testsOnly) {
    await run("contracts build", npm, ["run", "build", "--workspace", "@innorder/contracts"]);
  }

  await run("Electron provenance guard", process.execPath, ["scripts/electron-provenance.mjs"]);
  await run("verification orchestrator tests", npm, ["run", "test:verify"]);
  await run("dependency provenance contracts", npm, ["run", "test:provenance"]);
  await run("Electron provenance contracts", npm, ["run", "test:electron-provenance"]);
  await run("deployment documentation contracts", npm, ["run", "test:deployment-docs"]);
  await run("TypeScript workspace tests", npm, ["run", "test:workspaces"]);
  if (full) {
    await run(
      "authorization Zod/OPA parity",
      npm,
      ["run", "test:authz-parity"],
      dryRun ? process.env : { ...process.env, OPA_PATH: requiredOpa },
    );
  }

  const opa = requiredOpa ?? findOpa();
  if (opa) {
    console.log("[verify] real OPA checks enabled");
  } else {
    console.log("[verify] OPA binary unavailable; running static Rego contracts");
  }
  await run(
    "infrastructure and OPA contracts",
    npm,
    ["run", "test:infra"],
    opa ? { ...process.env, OPA_PATH: opa } : process.env,
  );
  await run("database static contracts", npm, ["run", "test:database"]);

  if (testsOnly) {
    await run("Core Kotlin tests", gradle, [
      ":services:core:test", "--dependency-verification", "strict", "-PexcludeStrictAuthz=true",
    ]);
    return;
  }

  if (extended) {
    await runPglite();
    await run("npm high-severity vulnerability audit", npm, [
      "audit", "--audit-level", "high", "--registry", "https://registry.npmjs.org", "--cache", npmAuditCache,
    ]);
    await run("npm registry signature audit", npm, [
      "audit", "signatures", "--registry", "https://registry.npmjs.org", "--cache", npmAuditCache,
    ]);
  }

  await run("Core Gradle build and tests", gradle, [
    ":services:core:build", "--dependency-verification", "strict", "-PexcludeStrictAuthz=true",
  ]);
  await run("TypeScript workspace typechecks", npm, ["run", "typecheck", "--workspaces", "--if-present"]);
  await run("AI service build", npm, ["run", "build", "--workspace", "@innorder/ai-service"]);
  if (full) {
    await run("parser sandbox container integration", process.execPath, ["--test", "services/ai/test/parser-container.test.mjs"]);
    await run("MinIO and ClamAV ingestion integration", process.execPath, ["--test", "services/ai/test/ingestion-container.test.mjs"]);
  }
  await run("Electron package build", npm, ["run", "build", "--workspace", "@innorder/desktop"]);

  if (extended && process.platform === "win32") {
    await run("packaged Electron smoke tests", npm, ["run", "smoke", "--workspace", "@innorder/desktop"]);
  }

  if (full) {
    if (dryRun) console.log("[verify] strict environment keys: OPA_PATH, INNORDER_STRICT_AUTHZ_TESTS");
    await run("strict Core authorization and real OPA integration", gradle, [
      ":services:core:test",
      "--tests", "com.innorder.occ.PlatformSecurityKernelIntegrationTest",
      "--tests", "com.innorder.occ.PostgreSqlFlowableIntegrationTest",
      "--tests", "com.innorder.occ.auth.AccessTokenSecurityTest",
      "--tests", "com.innorder.occ.auth.AuthServicePasswordWorkTest",
      "--tests", "com.innorder.occ.auth.SessionRepositoryIntegrationTest",
      "--tests", "com.innorder.occ.auth.AuthControllerIntegrationTest",
      "--tests", "com.innorder.occ.auth.PasswordServiceTest",
      "--tests", "com.innorder.occ.iam.BootstrapAdministratorIntegrationTest",
      "--tests", "com.innorder.occ.iam.BootstrapAdministratorStartupIntegrationTest",
      "--tests", "com.innorder.occ.iam.BootstrapSecretReaderTest",
      "--tests", "com.innorder.occ.authz.AuditDataSourceConfigurationTest",
      "--tests", "com.innorder.occ.authz.AuthorizationDecisionValidatorTest",
      "--tests", "com.innorder.occ.authz.AuthorizationServiceIntegrationTest",
      "--tests", "com.innorder.occ.authz.AuthorizationSnapshotIntegrityIntegrationTest",
      "--tests", "com.innorder.occ.authz.PolicyReleaseIntegrityTest",
      "--tests", "com.innorder.occ.command.CanonicalJsonObjectTest",
      "--tests", "com.innorder.occ.command.CommandExecutorIntegrationTest",
      "--tests", "com.innorder.occ.config.FlowableDatabaseInitializationDependencyDetectorTest",
      "--tests", "com.innorder.occ.events.EventEnvelopeTest",
      "--tests", "com.innorder.occ.events.KafkaOutboxEventSenderTest",
      "--tests", "com.innorder.occ.events.OutboxConfigurationTest",
      "--tests", "com.innorder.occ.events.OutboxPublisherIntegrationTest",
      "--tests", "com.innorder.occ.events.OutboxPropertiesTest",
      "--tests", "com.innorder.occ.events.KafkaOutboxEventSenderProtocolIntegrationTest",
      "--rerun-tasks",
      "--dependency-verification", "strict",
    ], dryRun ? process.env : {
      ...process.env,
      OPA_PATH: requiredOpa,
      INNORDER_STRICT_AUTHZ_TESTS: "1",
    });
    console.log("\n[verify] enforce Docker integration JUnit results");
    if (!dryRun) integrationResults.forEach((result) => assertJUnitSuiteExecuted(result));
  }

  const label = full ? "full" : local ? "local" : "quick";
  console.log(`\n[verify] ${label} verification passed`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = verificationExitCode(error);
}
