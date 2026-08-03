#!/usr/bin/env node
/**
 * Build the release artifacts and write a checksum manifest.
 *
 * Produces the Core boot jar, the compiled AI service bundle, and the packaged
 * Windows x64 desktop client, then records SHA-256 digests for each file so a
 * deployment can prove it installed the bytes this build produced.
 *
 * Usage: node scripts/deploy/release.mjs [--out dist/release] [--skip-desktop]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

const CORE_JAR_DIRECTORY = "services/core/build/libs";
const AI_DIST = "services/ai/dist";
const DESKTOP_OUT = "apps/desktop/out";

function parseArguments(argv) {
  const index = argv.indexOf("--out");
  return {
    out: resolve(index >= 0 ? argv[index + 1] : "dist/release"),
    desktop: !argv.includes("--skip-desktop"),
  };
}

function run(label, command, args) {
  console.log(`\n[release] ${label}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    console.error(`[release] ${label} failed`);
    process.exit(1);
  }
}

function walk(directory, base = directory) {
  const entries = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) entries.push(...walk(path, base));
    else entries.push(path);
  }
  return entries;
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main() {
  const { out, desktop } = parseArguments(process.argv.slice(2));
  // The wrapper lives in the repository root and is not on PATH, so it is
  // always invoked through an explicit relative path.
  const gradle = process.platform === "win32" ? ".\\gradlew.bat" : "./gradlew";

  run("building the Core boot jar", gradle, [
    ":services:core:bootJar", "--dependency-verification", "strict",
  ]);
  run("building shared contracts", "npm", ["run", "build", "--workspace", "@innorder/contracts"]);
  run("building the AI service", "npm", ["run", "build", "--workspace", "@innorder/ai-service"]);
  if (desktop) {
    run("packaging the desktop client", "npm", ["run", "package", "--workspace", "@innorder/desktop"]);
  }

  mkdirSync(out, { recursive: true });
  const staged = [];

  const bootJar = readdirSync(CORE_JAR_DIRECTORY)
    .filter((name) => name.endsWith(".jar") && !name.endsWith("-plain.jar"))
    .sort()
    .at(-1);
  if (!bootJar) {
    console.error("[release] no Core boot jar was produced");
    process.exit(1);
  }
  cpSync(join(CORE_JAR_DIRECTORY, bootJar), join(out, bootJar));
  staged.push(join(out, bootJar));

  const aiArchiveRoot = join(out, "ai-service");
  cpSync(AI_DIST, join(aiArchiveRoot, "dist"), { recursive: true });
  cpSync("services/ai/package.json", join(aiArchiveRoot, "package.json"));
  staged.push(...walk(aiArchiveRoot));

  if (desktop && existsSync(DESKTOP_OUT)) {
    const desktopRoot = join(out, "desktop");
    cpSync(DESKTOP_OUT, desktopRoot, { recursive: true });
    staged.push(...walk(desktopRoot));
  }

  const revision = spawnSync("git", ["-c", "safe.directory=*", "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  const dirty = spawnSync("git", ["-c", "safe.directory=*", "status", "--porcelain"], {
    encoding: "utf8",
  }).stdout.trim() !== "";

  const files = staged
    .map((path) => ({
      path: relative(out, path).replaceAll("\\", "/"),
      bytes: statSync(path).size,
      sha256: digest(path),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const manifest = {
    product: "innorder-occ",
    builtAt: new Date().toISOString(),
    gitRevision: revision || null,
    workingTreeDirty: dirty,
    platform: `${process.platform}-${process.arch}`,
    files,
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(
    join(out, "SHA256SUMS"),
    `${files.map((file) => `${file.sha256}  ${file.path}`).join("\n")}\n`,
    "utf8",
  );

  console.log(`\n[release] ${files.length} artifact file(s) in ${out}`);
  if (dirty) console.log("[release] warning: built from a dirty working tree");
}

main();
