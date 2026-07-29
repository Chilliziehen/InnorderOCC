import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const excludedDirectories = new Set([
  ".cache",
  ".git",
  ".gradle",
  ".vite",
  "build",
  "coverage",
  "dist",
  "docs",
  "documentation",
  "node_modules",
  "out",
  "playwright-report",
  "test-results",
]);
const scannedExtensions = new Set([
  ".bat",
  ".bash",
  ".cjs",
  ".cmd",
  ".cts",
  ".js",
  ".mjs",
  ".mts",
  ".ps1",
  ".psm1",
  ".sh",
  ".ts",
  ".yaml",
  ".yml",
  ".zsh",
]);

const sourceControlSuffix = [
  "(?:nightly)?mirror",
  "custom(?:dir|filename|version|checksum)",
  "(?:custom)?checksum",
  "(?:download)?baseurl",
  "downloadurl",
  "overridedistpath",
  "configcache",
  "useremotechecksums",
].join("|");

function normalizedEnvironmentName(name) {
  return name.toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replace(/^npm_(?:package_)?config_/u, "")
    .replaceAll("_", "");
}

function isSourceControlEnvironmentName(name) {
  return new RegExp(`^electron(?:${sourceControlSuffix})$`, "u").test(normalizedEnvironmentName(name));
}

export function assertElectronProvenanceEnvironment(environment = process.env) {
  const forbiddenNames = Object.keys(environment).filter(isSourceControlEnvironmentName);
  if (forbiddenNames.length > 0) {
    throw new Error(`Electron provenance violation: inherited source override ${forbiddenNames.join(", ")}`);
  }
}

function shouldScan(path) {
  const name = basename(path).toLowerCase();
  return name === ".npmrc"
    || name === "package.json"
    || name.endsWith("dockerfile")
    || scannedExtensions.has(extname(name));
}

function forbiddenSettingPattern() {
  const separator = "[-_.]";
  const optionalSeparator = "[-_.]?";
  const prefix = `(?:npm${separator}(?:package${separator})?config${separator})?electron${separator}`;
  const suffix = [
    `(?:nightly${optionalSeparator})?mirror`,
    `custom${optionalSeparator}(?:dir|filename|version|checksum)`,
    `(?:custom${optionalSeparator})?checksum`,
    `(?:download${optionalSeparator})?base${optionalSeparator}url`,
    `download${optionalSeparator}url`,
    `override${optionalSeparator}dist${optionalSeparator}path`,
    `config${optionalSeparator}cache`,
    `use${optionalSeparator}remote${optionalSeparator}checksums`,
  ].join("|");
  return new RegExp(`${prefix}(?:${suffix})`, "iu");
}

function forbiddenPackagerControlPattern() {
  const packagerKey = ["packager", "Config"].join("");
  const downloadKey = ["down", "load"].join("");
  const mirrorOptionKey = ["mirror", "Options"].join("");
  const disableChecksumKey = ["unsafely", "Disable", "Checksums"].join("");
  const localZipKey = ["electron", "Zip", "Dir"].join("");
  return new RegExp([
    `\\b${mirrorOptionKey}\\b`,
    `\\b${disableChecksumKey}\\b`,
    `\\b${localZipKey}\\b`,
    `\\b${packagerKey}\\b[\\s\\S]{0,512}?\\b${downloadKey}\\b`,
  ].join("|"), "u");
}

function normalizeStaticStringConcatenations(content) {
  const adjacentStrings = /(["'`])([^"'`\\]*(?:\\.[^"'`\\]*)*)\1\s*[+]\s*(["'`])([^"'`\\]*(?:\\.[^"'`\\]*)*)\3/gu;
  let normalized = content;
  while (true) {
    const next = normalized.replace(adjacentStrings, (_, _leftQuote, left, _rightQuote, right) => (
      JSON.stringify(`${left}${right}`)
    ));
    if (next === normalized) return normalized;
    normalized = next;
  }
}

function forbiddenDownloaderReferencePattern() {
  const getModule = ["@electron/", "get"].join("");
  const artifactFunction = ["download", "Artifact"].join("");
  const resolverKey = ["resolve", "Asset", "URL"].join("");
  const downloadFunction = ["down", "load"].join("");
  return new RegExp([
    getModule.replace("/", "\\/"),
    `\\b${artifactFunction}\\b`,
    `\\b${resolverKey}\\b`,
    `\\b${downloadFunction}\\s*\\(`,
    `["']${downloadFunction}["']\\s*\\]\\s*\\(`,
  ].join("|"), "u");
}

function isOfficialElectronReleaseUrl(rawUrl) {
  const releaseBase = ["https://github.com", "electron", "electron", "releases", "download", "v43.2.0"].join("/");
  return rawUrl === `${releaseBase}/electron-v43.2.0-win32-x64.zip`
    || rawUrl === `${releaseBase}/SHASUMS256.txt`;
}

function thirdPartyElectronUrl(content) {
  const urlStart = /https?:\/\//giu;
  for (const match of content.matchAll(urlStart)) {
    const rawUrl = content.slice(match.index).match(/^https?:\/\/[^\s'"`<>)]+/iu)?.[0];
    if (!rawUrl) continue;
    let url;
    try {
      url = new URL(rawUrl.replace(/[.,;:]$/u, ""));
    } catch {
      continue;
    }
    const identifiesElectron = `${url.hostname}${url.pathname}`.toLowerCase().includes("electron");
    if (identifiesElectron && !isOfficialElectronReleaseUrl(rawUrl)) return rawUrl;
  }
  return undefined;
}

export async function assertRepositoryElectronProvenance(root = repositoryRoot) {
  const violations = [];

  async function scan(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name.toLowerCase())) await scan(path);
        continue;
      }
      if (!entry.isFile() || !shouldScan(path)) continue;

      const content = normalizeStaticStringConcatenations(await readFile(path, "utf8"));
      const setting = content.match(forbiddenSettingPattern())?.[0];
      const packagerControl = content.match(forbiddenPackagerControlPattern())?.[0];
      const downloaderReference = content.match(forbiddenDownloaderReferencePattern())?.[0];
      const host = thirdPartyElectronUrl(content);
      if (setting || packagerControl || downloaderReference || host) {
        const displayPath = relative(root, path).replaceAll("\\", "/");
        violations.push(`${displayPath}: ${setting ?? packagerControl ?? downloaderReference ?? host}`);
      }
    }
  }

  await scan(resolve(root));
  if (violations.length > 0) {
    throw new Error(`Electron provenance violation in repository configuration:\n${violations.join("\n")}`);
  }
}

export async function assertElectronProvenance({ root = repositoryRoot, environment = process.env } = {}) {
  assertElectronProvenanceEnvironment(environment);
  await assertRepositoryElectronProvenance(root);
}

export async function assertInstalledElectronVersion(packagePath) {
  let packageManifest;
  try {
    packageManifest = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`Electron provenance violation: cannot read installed Electron package at ${packagePath}`, { cause: error });
  }
  if (packageManifest.version !== "43.2.0") {
    throw new Error(`Electron provenance violation: installed Electron version is ${String(packageManifest.version)}, expected 43.2.0`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await assertElectronProvenance();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
