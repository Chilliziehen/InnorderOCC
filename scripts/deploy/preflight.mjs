#!/usr/bin/env node
/**
 * Deployment preflight: verifies the host and the operator-supplied secret set
 * before anything is built or started. Reports every problem it finds instead
 * of stopping at the first, and never prints a secret value or its contents.
 *
 * Usage: node scripts/deploy/preflight.mjs [--compose-env infra/compose/.env]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import process from "node:process";

import YAML from "yaml";

const COMPOSE_FILE = "infra/compose/compose.yml";
const DEFAULT_ENV_FILE = "infra/compose/.env";

// Scalar credential files must each hold one unique non-empty value; the RSA
// pair is PEM and therefore multi-line and exempt from the uniqueness scan.
const PEM_VARIABLES = new Set(["OCC_JWT_PRIVATE_KEY_FILE", "OCC_JWT_PUBLIC_KEY_FILE"]);
const MINIMUM_PASSWORD_LENGTH = 32;
const MINIMUM_USERNAME_LENGTH = 16;
const USERNAME_VARIABLES = new Set(["MINIO_ROOT_USER_FILE", "MINIO_APP_USER_FILE"]);
const CURSOR_KEY_PATTERN = /^[0-9a-f]{64}$/u;

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function parseArguments(argv) {
  const envFileIndex = argv.indexOf("--compose-env");
  return {
    envFile: envFileIndex >= 0 ? argv[envFileIndex + 1] : DEFAULT_ENV_FILE,
  };
}

function readEnvFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    fail(`env file not readable: ${path} (copy infra/compose/.env.example first)`);
    return null;
  }
  const values = new Map();
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (!match) {
      fail(`${path}:${index + 1} is not a NAME=value assignment`);
      continue;
    }
    values.set(match[1], match[2]);
  }
  return values;
}

function requiredVariables() {
  const compose = readFileSync(COMPOSE_FILE, "utf8");
  return [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/gu)]
    .map((match) => match[1])
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort();
}

function checkTooling() {
  for (const [command, args, label] of [
    ["docker", ["info", "--format", "{{.ServerVersion}}"], "Docker Engine"],
    ["docker", ["compose", "version"], "Docker Compose v2"],
  ]) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status !== 0) fail(`${label} is not available (${command} ${args[0]})`);
    else notes.push(`${label}: ${result.stdout.trim().split("\n")[0]}`);
  }
}

function checkSecretFile(name, path, seenDigests) {
  if (!isAbsolute(path)) {
    fail(`${name} must be an absolute path`);
    return;
  }
  let stats;
  try {
    stats = statSync(path);
  } catch {
    fail(`${name} points at a missing file`);
    return;
  }
  if (!stats.isFile()) {
    fail(`${name} must point at a regular file`);
    return;
  }

  const contents = readFileSync(path, "utf8");
  if (PEM_VARIABLES.has(name)) {
    if (!/-----BEGIN [A-Z ]+-----/u.test(contents)) fail(`${name} is not PEM encoded`);
    return;
  }

  const lines = contents.split(/\r?\n/u).filter((line) => line !== "");
  if (lines.length !== 1) {
    fail(`${name} must hold exactly one non-empty line`);
    return;
  }
  const value = lines[0];
  if (value !== value.trim()) fail(`${name} has leading or trailing whitespace`);
  if (/^['"].*['"]$/u.test(value)) fail(`${name} must not be quoted`);

  if (name === "CURSOR_HMAC_KEY_FILE") {
    if (!CURSOR_KEY_PATTERN.test(value)) fail(`${name} must be 64 lowercase hex characters`);
  } else if (USERNAME_VARIABLES.has(name)) {
    if (value.length < MINIMUM_USERNAME_LENGTH) {
      fail(`${name} must be at least ${MINIMUM_USERNAME_LENGTH} characters`);
    }
  } else if (value.length < MINIMUM_PASSWORD_LENGTH) {
    fail(`${name} must be at least ${MINIMUM_PASSWORD_LENGTH} characters`);
  }

  const digest = spawnSync(process.execPath, [
    "-e",
    "const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(process.argv[1]).digest('hex'))",
    value,
  ], { encoding: "utf8" }).stdout;
  const previous = seenDigests.get(digest);
  if (previous) fail(`${name} reuses the same value as ${previous}`);
  else seenDigests.set(digest, name);
}

function checkComposeInterpolation(envFile) {
  const result = spawnSync(
    "docker",
    ["compose", "--env-file", envFile, "-f", COMPOSE_FILE, "config"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    fail(`docker compose config failed: ${result.stderr.trim().split("\n")[0]}`);
    return;
  }
  const rendered = YAML.parse(result.stdout);
  const images = Object.values(rendered.services)
    .map((service) => service.image)
    .filter(Boolean);
  const unpinned = images.filter((image) => !/@sha256:[a-f0-9]{64}$/u.test(image));
  if (unpinned.length > 0) fail(`images are not digest-pinned: ${unpinned.join(", ")}`);
  notes.push(`compose renders ${Object.keys(rendered.services).length} services`);
}

function main() {
  const { envFile } = parseArguments(process.argv.slice(2));
  checkTooling();

  const values = readEnvFile(envFile);
  if (values) {
    const required = requiredVariables();
    const seenDigests = new Map();
    for (const name of required) {
      const value = values.get(name);
      if (value === undefined || value === "") {
        fail(`${name} is required but unset in ${envFile}`);
        continue;
      }
      if (name.endsWith("_FILE")) checkSecretFile(name, value, seenDigests);
      else if (name === "OCC_JWT_ISSUER" && !value.startsWith("https://")) {
        fail("OCC_JWT_ISSUER must be an https URI");
      }
    }
    notes.push(`checked ${required.length} required variables`);
    if (problems.length === 0) checkComposeInterpolation(envFile);
  }

  for (const note of notes) console.log(`[preflight] ${note}`);
  if (problems.length > 0) {
    console.error(`\n[preflight] ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log("\n[preflight] host and secret preflight passed");
}

main();
