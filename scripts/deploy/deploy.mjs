#!/usr/bin/env node
/**
 * Bring the Compose stack up and wait for the deployment to be serviceable.
 *
 * Runs preflight, builds and starts the stack, waits for the one-shot
 * initializers to exit zero, then polls the published readiness endpoints.
 * Exits non-zero if any gate fails so callers can stop a release.
 *
 * Usage: node scripts/deploy/deploy.mjs [--compose-env PATH] [--timeout SECONDS]
 *                                       [--no-build] [--skip-preflight]
 */
import { spawnSync } from "node:child_process";
import process from "node:process";

const COMPOSE_FILE = "infra/compose/compose.yml";
const DEFAULT_ENV_FILE = "infra/compose/.env";
const ONE_SHOT_SERVICES = ["postgres-init", "flowable-init", "minio-init", "parser-volume-init"];

function parseArguments(argv) {
  const value = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  return {
    envFile: value("--compose-env", DEFAULT_ENV_FILE),
    timeoutSeconds: Number(value("--timeout", "900")),
    build: !argv.includes("--no-build"),
    preflight: !argv.includes("--skip-preflight"),
  };
}

function compose(envFile, args, options = {}) {
  return spawnSync(
    "docker",
    ["compose", "--env-file", envFile, "-f", COMPOSE_FILE, ...args],
    { encoding: "utf8", stdio: options.inherit ? "inherit" : "pipe" },
  );
}

function step(label) {
  console.log(`\n[deploy] ${label}`);
}

function fail(message) {
  console.error(`[deploy] ${message}`);
  process.exit(1);
}

async function waitFor(label, deadline, probe) {
  process.stdout.write(`[deploy] waiting for ${label} `);
  for (;;) {
    const outcome = probe();
    if (outcome.ready) {
      process.stdout.write(" ok\n");
      return;
    }
    if (Date.now() > deadline) {
      process.stdout.write(" timeout\n");
      fail(`${label} did not become ready: ${outcome.detail}`);
    }
    process.stdout.write(".");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

function oneShotOutcome(envFile, service) {
  const result = compose(envFile, ["ps", "--all", "--format", "json", service]);
  if (result.status !== 0) return { ready: false, detail: result.stderr.trim() };
  const lines = result.stdout.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length === 0) return { ready: false, detail: "not created yet" };
  const entry = JSON.parse(lines[lines.length - 1]);
  if (entry.State !== "exited") return { ready: false, detail: `state=${entry.State}` };
  // A one-shot task that exited non-zero is a hard failure, not a retry.
  if (entry.ExitCode !== 0) fail(`${service} exited with code ${entry.ExitCode}`);
  return { ready: true, detail: "exited 0" };
}

function healthyOutcome(envFile, service) {
  const result = compose(envFile, ["ps", "--format", "json", service]);
  if (result.status !== 0) return { ready: false, detail: result.stderr.trim() };
  const lines = result.stdout.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length === 0) return { ready: false, detail: "not running" };
  const entry = JSON.parse(lines[lines.length - 1]);
  const health = entry.Health ?? "";
  if (entry.State === "exited") fail(`${service} exited unexpectedly (code ${entry.ExitCode})`);
  return { ready: health === "healthy", detail: `state=${entry.State} health=${health || "none"}` };
}

async function probeEndpoint(label, url, deadline) {
  await waitFor(label, deadline, () => {
    // Node's fetch is async; poll it synchronously through a short-lived child
    // so the shared waitFor contract stays uniform.
    const result = spawnSync(process.execPath, [
      "-e",
      "fetch(process.argv[1],{signal:AbortSignal.timeout(4000)})" +
        ".then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      url,
    ], { encoding: "utf8" });
    return { ready: result.status === 0, detail: `${url} not answering` };
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    fail("--timeout must be a positive number of seconds");
  }
  const deadline = Date.now() + options.timeoutSeconds * 1000;

  if (options.preflight) {
    step("running preflight");
    const preflight = spawnSync(
      process.execPath,
      ["scripts/deploy/preflight.mjs", "--compose-env", options.envFile],
      { stdio: "inherit" },
    );
    if (preflight.status !== 0) fail("preflight failed; nothing was started");
  }

  step(options.build ? "building and starting the stack" : "starting the stack");
  const up = compose(
    options.envFile,
    ["up", "--detach", ...(options.build ? ["--build"] : [])],
    { inherit: true },
  );
  if (up.status !== 0) fail("docker compose up failed");

  step("waiting for one-shot initializers");
  for (const service of ONE_SHOT_SERVICES) {
    await waitFor(service, deadline, () => oneShotOutcome(options.envFile, service));
  }

  step("waiting for long-running services");
  for (const service of ["postgres", "kafka", "redis", "minio", "opa", "ai", "core", "host-gateway"]) {
    await waitFor(service, deadline, () => healthyOutcome(options.envFile, service));
  }

  step("probing published endpoints");
  await probeEndpoint("Core readiness", "http://127.0.0.1:8080/actuator/health/readiness", deadline);
  await probeEndpoint("Core status", "http://127.0.0.1:8080/api/v1/system/status", deadline);
  await probeEndpoint("AI health", "http://127.0.0.1:3100/health", deadline);
  await probeEndpoint("OPA health", "http://127.0.0.1:8181/health", deadline);
  await probeEndpoint("MinIO readiness", "http://127.0.0.1:9000/minio/health/ready", deadline);

  console.log("\n[deploy] deployment is up and serviceable");
}

main().catch((error) => fail(error.message));
