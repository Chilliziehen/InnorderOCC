#!/usr/bin/env node
/**
 * Take a consistent backup of the deployment's durable state.
 *
 * Captures the PostgreSQL cluster, the MinIO object store, and the deployment's
 * non-secret configuration, then writes a manifest with SHA-256 digests so a
 * restore can prove it read the same bytes. Secret files are never copied.
 *
 * Usage: node scripts/deploy/backup.mjs --out DIR [--compose-env PATH]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const COMPOSE_FILE = "infra/compose/compose.yml";
const DEFAULT_ENV_FILE = "infra/compose/.env";

function parseArguments(argv) {
  const value = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const out = value("--out", null);
  if (!out) {
    console.error("usage: backup.mjs --out DIR [--compose-env PATH]");
    process.exit(2);
  }
  return { out: resolve(out), envFile: value("--compose-env", DEFAULT_ENV_FILE) };
}

function compose(envFile, args, options = {}) {
  const result = spawnSync(
    "docker",
    ["compose", "--env-file", envFile, "-f", COMPOSE_FILE, ...args],
    { encoding: options.encoding ?? "utf8", maxBuffer: 1024 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    console.error(`[backup] docker compose ${args[0]} failed: ${result.stderr}`);
    process.exit(1);
  }
  return result.stdout;
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main() {
  const { out, envFile } = parseArguments(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replaceAll(/[:.]/gu, "-");
  const directory = join(out, `innorder-occ-${stamp}`);
  mkdirSync(directory, { recursive: true });
  console.log(`[backup] writing to ${directory}`);

  // pg_dumpall captures roles alongside data so a restore rebuilds logins too.
  console.log("[backup] dumping PostgreSQL cluster");
  const dump = compose(envFile, [
    "exec", "-T", "postgres",
    "sh", "-c", "pg_dumpall --username=innorder_admin --clean --if-exists",
  ], { encoding: "buffer" });
  const dumpPath = join(directory, "postgres-cluster.sql");
  writeFileSync(dumpPath, dump);

  console.log("[backup] mirroring the MinIO bucket");
  const objectsPath = join(directory, "minio-objects.tar");
  const objects = compose(envFile, [
    "exec", "-T", "minio", "sh", "-c", "tar -cf - -C /data .",
  ], { encoding: "buffer" });
  writeFileSync(objectsPath, objects);

  console.log("[backup] recording non-secret configuration");
  const rendered = compose(envFile, ["config"]);
  const configPath = join(directory, "compose-rendered.yml");
  writeFileSync(configPath, rendered, "utf8");

  const revision = spawnSync("git", ["-c", "safe.directory=*", "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();

  const files = readdirSync(directory).sort().map((name) => ({
    name,
    bytes: statSync(join(directory, name)).size,
    sha256: digest(join(directory, name)),
  }));

  const manifest = {
    product: "innorder-occ",
    startedAt,
    completedAt: new Date().toISOString(),
    gitRevision: revision || null,
    files,
    // Secrets stay with the operator's key custodian; a restore needs the same
    // thirteen files, which this archive deliberately does not contain.
    excludes: ["secret files", "infra/compose/.env"],
  };
  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  for (const file of files) console.log(`[backup] ${file.name} ${file.bytes} bytes`);
  console.log(`[backup] complete: ${directory}`);
}

main();
