import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const guardUrl = new URL("./electron-provenance.mjs", import.meta.url);
const approvedTempRoot = resolve(process.env.OPENCODE_TEMP_DIR ?? join(tmpdir(), "opencode"));
const token = (...parts) => parts.join("_");
const electron = "ELECTRON";
const mirror = "MIRROR";
const property = (...parts) => parts.join("");
const webUrl = (protocol, host, path = "") => `${protocol}://${host}${path}`;

const forbiddenEnvironmentNames = [
  token(electron, mirror),
  token(electron, "NIGHTLY", mirror),
  token(electron.toLowerCase(), mirror.toLowerCase()),
  token("npm", "config", electron.toLowerCase(), mirror.toLowerCase()),
  token("npm", "config", electron.toLowerCase(), "nightlymirror"),
  token("npm", "config", electron.toLowerCase(), "customfilename"),
  token("npm", "package", "config", electron.toLowerCase(), "customDir"),
  token("NpM", "CoNfIg", electron.toLowerCase(), "nightly", mirror.toLowerCase()),
  token(electron, "CUSTOM", "DIR"),
  token("npm", "config", electron.toLowerCase(), "custom", "filename"),
  token(electron, "CUSTOM", "VERSION"),
  token(electron, "CHECKSUM"),
  token(electron.toLowerCase(), "download", "base", "url"),
  token(electron, "BASE", "URL"),
  token(electron, "OVERRIDE", "DIST", "PATH"),
  token("npm", "config", electron.toLowerCase(), "override", "dist", "path"),
  token("NpM", "PaCkAgE", "CoNfIg", electron.toLowerCase(), "override", "dist", "path"),
  token(electron.toLowerCase(), "config", "cache"),
  token("npm", "config", electron.toLowerCase(), "config", "cache"),
  token(electron.toLowerCase(), "use", "remote", "checksums"),
  token("npm", "config", electron.toLowerCase(), "use", "remote", "checksums"),
];

function cleanEnvironment(overrides = {}) {
  const environment = { ...process.env };
  const suspicious = new RegExp(
    `${electron}.*(?:${mirror}|CUSTOM.*(?:DIR|FILENAME)|CHECKSUM|BASE.*URL|DOWNLOAD.*URL)`,
    "iu",
  );
  for (const name of Object.keys(environment)) {
    if (suspicious.test(name.replace(/^npm_config_/iu, ""))) delete environment[name];
  }
  return { ...environment, ...overrides };
}

async function temporaryDirectory(t, prefix) {
  await mkdir(approvedTempRoot, { recursive: true });
  const directory = await mkdtemp(join(approvedTempRoot, prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function loadGuard() {
  return import(guardUrl.href);
}

test("pins Electron exactly and exposes verified installation as the clean install boundary", async () => {
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const desktopPackage = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const launcher = await readFile(join(root, "apps/desktop/scripts/run-forge.mjs"), "utf8");

  assert.equal(desktopPackage.devDependencies.electron, "43.2.0");
  assert.equal(lockfile.packages["node_modules/electron"].version, "43.2.0");
  assert.equal(rootPackage.scripts["install:verified"], "node scripts/install-verified.mjs");
  assert.match(rootPackage.scripts["test:electron-provenance"], /electron-provenance[.]test[.]mjs/u);
  assert.equal(desktopPackage.scripts.dev, "node scripts/run-forge.mjs start");
  assert.equal(desktopPackage.scripts.build, "node scripts/run-forge.mjs package");
  assert.equal(desktopPackage.scripts.package, "node scripts/run-forge.mjs package");
  for (const command of Object.values(desktopPackage.scripts)) {
    assert.doesNotMatch(command, /\belectron-forge\b/u);
  }
  const versionCheckIndex = launcher.indexOf("assertInstalledElectronVersion");
  const forgeImportIndex = launcher.indexOf('import("@electron-forge/core")');
  assert.ok(versionCheckIndex >= 0 && versionCheckIndex < forgeImportIndex);
  assert.match(launcher, /platform:\s*"win32"/u);
  assert.match(launcher, /arch:\s*"x64"/u);
});

test("the actual Forge launcher rejects inherited overrides before start or package loads Forge", async (t) => {
  const invalidForgeRoot = await temporaryDirectory(t, "forge-guard-");
  const launcher = join(root, "apps/desktop/scripts/run-forge.mjs");

  for (const operation of ["start", "package"]) {
    for (const name of forbiddenEnvironmentNames) {
      const result = spawnSync(process.execPath, [launcher, operation], {
        cwd: invalidForgeRoot,
        encoding: "utf8",
        env: cleanEnvironment({ [name]: "https://invalid.example/source" }),
      });

      assert.notEqual(result.status, 0, `${operation} with ${name} must fail`);
      assert.match(result.stderr, /Electron provenance violation/u, `${name} must report provenance failure`);
      assert.match(result.stderr, new RegExp(name, "iu"));
      assert.doesNotMatch(result.stderr, /package[.]json|electron-forge|Cannot find module/iu, `${name} reached Forge`);
    }
  }
});

test("environment guard permits Electron flags that do not select artifact provenance", async () => {
  const { assertElectronProvenanceEnvironment } = await loadGuard();
  const environment = {
    [token(electron, "GET", "NO", "PROGRESS")]: "1",
    [token(electron, "GET", "USE", "PROXY")]: "1",
    [token("force", "no", "cache")]: "true",
    [token(electron, "INSTALL", "PLATFORM")]: "win32",
    [token(electron, "INSTALL", "ARCH")]: "x64",
  };

  assert.doesNotThrow(() => assertElectronProvenanceEnvironment(environment));
});

test("recursive guard catches forbidden settings in future executable and configuration files", async (t) => {
  const { assertRepositoryElectronProvenance } = await loadGuard();
  const forbidden = token(electron, mirror);
  const badHost = ["https://downloads.invalid", "electron", "releases"].join("/");
  const fixtures = [
    [".npmrc", `${token("electron", "mirror")}=${badHost}\n`],
    ["workspace/.npmrc", `${token("npm", "config", "electron", "mirror")}=${badHost}\n`],
    ["workspace/package.json", JSON.stringify({ scripts: { package: `${forbidden}=${badHost} node build.js` } })],
    [".github/workflows/release.yml", `env:\n  ${forbidden}: ${badHost}\n`],
    ["ci/pipeline.yaml", `variables:\n  ${token(electron, "CUSTOM", "DIR")}: custom\n`],
    ["tools/package.ps1", `$env:${token(electron, "CHECKSUM")} = 'skip'\n`],
    ["tools/package.cmd", `set ${token(electron, "BASE", "URL")}=${badHost}\n`],
    ["tools/package.sh", `export ${token(electron, "CUSTOM", "FILENAME")}=archive.zip\n`],
    ["tools/package.mjs", `const source = ${JSON.stringify(badHost)};\n`],
    ["config/release.config.ts", `export default { binaryUrl: ${JSON.stringify(badHost)} };\n`],
    ["vendor/release.config.js", `export default { binaryUrl: ${JSON.stringify(badHost)} };\n`],
    ["containers/Desktop.Dockerfile", `ENV ${forbidden}=${badHost}\n`],
  ];

  for (const [relativePath, content] of fixtures) {
    const fixtureRoot = await temporaryDirectory(t, "repo-guard-");
    const path = join(fixtureRoot, relativePath);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");

    await assert.rejects(
      assertRepositoryElectronProvenance(fixtureRoot),
      (error) => error instanceof Error && error.message.includes(relativePath.replaceAll("\\", "/")),
      `${relativePath} must be scanned recursively`,
    );
  }
});

test("recursive guard rejects Forge and Packager download controls without Electron-prefixed names", async (t) => {
  const { assertRepositoryElectronProvenance } = await loadGuard();
  const packagerKey = property("packager", "Config");
  const downloadKey = property("down", "load");
  const mirrorOptionKey = property("mirror", "Options");
  const disableChecksumKey = property("unsafely", "Disable", "Checksums");
  const electronZipKey = property("electron", "Zip", "Dir");
  const resolveAssetKey = property("resolve", "Asset", "URL");
  const downloaderKey = property("down", "loader");
  const checksumKey = property("check", "sums");
  const cacheRootKey = property("cache", "Root");
  const artifactFunction = property("download", "Artifact");
  const bypass = `export default { ${packagerKey}: { ${downloadKey}: { ${mirrorOptionKey}: { mirror: 'https://review.invalid/' }, ${disableChecksumKey}: true } } };\n`;
  const fixtures = [
    ["forge.config.ts", bypass],
    ["workspace/package.json", JSON.stringify({ config: { forge: { [packagerKey]: { [downloadKey]: {} } } } })],
    ["config/packager.config.mjs", `const ${mirrorOptionKey} = {}; export default { ${mirrorOptionKey} };\n`],
    ["tools/package.cjs", `const ${disableChecksumKey} = true; module.exports = { ${disableChecksumKey} };\n`],
    ["config/dotted.config.js", `config.${packagerKey}.${downloadKey} = {};\n`],
    ["config/bracket.config.js", `config[${JSON.stringify(packagerKey)}][${JSON.stringify(downloadKey)}] = {};\n`],
    ["config/shorthand.config.js", `const ${downloadKey} = {}; export default { ${packagerKey}: { ${downloadKey} } };\n`],
    ["config/local-zip.config.js", `export default { ${packagerKey}: { ${electronZipKey}: './local-electron' } };\n`],
    ["config/local-zip-bracket.cjs", `config[${JSON.stringify(packagerKey)}][${JSON.stringify(electronZipKey)}] = './local-electron';\n`],
    ["config/get-resolver.mjs", `${artifactFunction}({ ${resolveAssetKey}: async () => 'local' });\n`],
    [`config/get-${downloaderKey}.mjs`, `${artifactFunction}({ ${downloaderKey}: custom });\n`],
    [`config/get-${checksumKey}.mjs`, `${artifactFunction}({ ${checksumKey}: custom });\n`],
    [`config/get-${cacheRootKey}.mjs`, `${artifactFunction}({ ${cacheRootKey}: './local-cache' });\n`],
  ];

  for (const [relativePath, content] of fixtures) {
    const fixtureRoot = await temporaryDirectory(t, "packager-bypass-");
    const path = join(fixtureRoot, relativePath);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
    await assert.rejects(assertRepositoryElectronProvenance(fixtureRoot), /Electron provenance violation/u);
  }
});

test("recursive guard rejects direct and statically concatenated Electron downloader access", async (t) => {
  const { assertRepositoryElectronProvenance } = await loadGuard();
  const getModule = property("@electron/", "get");
  const artifactFunction = property("download", "Artifact");
  const downloadFunction = property("down", "load");
  const overrideKey = token(electron, "OVERRIDE", "DIST", "PATH");
  const electronZipKey = property("electron", "Zip", "Dir");
  const resolverKey = property("resolve", "Asset", "URL");
  const fixtures = [
    ["config/literal-get.mjs", `import ${JSON.stringify(getModule)};\n`],
    ["config/computed-get.mjs", `import(${JSON.stringify("@electron/")} + ${JSON.stringify("get")});\n`],
    ["config/artifact-call.mjs", `${artifactFunction}({});\n`],
    ["config/version-bypass.mjs", `${downloadFunction}("43.2.1");\n`],
    ["config/computed-version-bypass.mjs", `api[${JSON.stringify("down")} + ${JSON.stringify("load")}](${JSON.stringify("43.2.1")});\n`],
    ["config/computed-env.mjs", `process.env[${JSON.stringify("ELECTRON_")} + ${JSON.stringify("OVERRIDE_DIST_PATH")}] = "local";\n`],
    ["config/computed-zip.mjs", `export default { [${JSON.stringify("electron")} + ${JSON.stringify("ZipDir")}]: "local" };\n`],
    ["config/computed-resolver.mjs", `export default { [${JSON.stringify("resolve")} + ${JSON.stringify("AssetURL")}]: custom };\n`],
  ];

  assert.equal(property("ELECTRON_", "OVERRIDE_DIST_PATH"), overrideKey);
  assert.equal(property("electron", "ZipDir"), electronZipKey);
  assert.equal(property("resolve", "AssetURL"), resolverKey);
  for (const [relativePath, content] of fixtures) {
    const fixtureRoot = await temporaryDirectory(t, "direct-download-bypass-");
    const path = join(fixtureRoot, relativePath);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
    await assert.rejects(assertRepositoryElectronProvenance(fixtureRoot), /Electron provenance violation/u);
  }
});

test("recursive guard allows generic option names without Electron downloader access", async (t) => {
  const { assertRepositoryElectronProvenance } = await loadGuard();
  const fixtureRoot = await temporaryDirectory(t, "generic-options-");
  const content = `export default { ${property("check", "sums")}: {}, ${property("cache", "Root")}: "local", ${property("down", "loader")}: custom };\n`;
  await writeFile(join(fixtureRoot, "application.config.mjs"), content, "utf8");

  await assert.doesNotReject(assertRepositoryElectronProvenance(fixtureRoot));
});

test("recursive guard excludes only documentation generated output dependency trees and git metadata", async (t) => {
  const { assertRepositoryElectronProvenance } = await loadGuard();
  const fixtureRoot = await temporaryDirectory(t, "repo-exclusions-");
  const forbidden = `${token(electron, mirror)}=https://invalid.example/source\n`;
  for (const directory of ["Docs", "documentation", "node_modules", "dist", "build", "out", ".git", ".gradle", ".vite", "coverage"]) {
    const path = join(fixtureRoot, directory, "nested", "package.json");
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, forbidden, "utf8");
  }

  await assert.doesNotReject(assertRepositoryElectronProvenance(fixtureRoot));
});

test("recursive guard inspects nested URLs instead of consuming them as one outer URL", async (t) => {
  const { assertRepositoryElectronProvenance } = await loadGuard();
  const fixtureRoot = await temporaryDirectory(t, "repo-nested-url-");
  const nested = webUrl("https", "downloads.invalid", "/electron/releases/file.zip");
  const outer = webUrl("https", "redirect.invalid", `/?next=${nested}`);
  await writeFile(join(fixtureRoot, "release.config.js"), `export default ${JSON.stringify(outer)};\n`, "utf8");

  await assert.rejects(assertRepositoryElectronProvenance(fixtureRoot), /Electron provenance violation/u);
});

test("recursive guard permits only exact official Electron release download URLs", async (t) => {
  const { assertRepositoryElectronProvenance } = await loadGuard();
  const fixtureRoot = await temporaryDirectory(t, "repo-official-source-");
  const path = join(fixtureRoot, "release.config.js");
  const officialBase = webUrl("https", "github.com", "/electron/electron/releases/download/");
  await writeFile(
    path,
    `export default [${JSON.stringify(`${officialBase}v43.2.0/electron-v43.2.0-win32-x64.zip`)}, ${JSON.stringify(`${officialBase}v43.2.0/SHASUMS256.txt`)}];\n`,
    "utf8",
  );

  await assert.doesNotReject(assertRepositoryElectronProvenance(fixtureRoot));
});

test("recursive guard rejects lookalike or mutable official Electron URLs", async (t) => {
  const { assertRepositoryElectronProvenance } = await loadGuard();
  const candidates = [
    webUrl("http", "github.com", "/electron/electron/releases/download/v43.2.0/file.zip"),
    webUrl("https", "user@github.com", "/electron/electron/releases/download/v43.2.0/file.zip"),
    `${webUrl("https", "github.com", "/electron/electron/releases/download/v43.2.0/file.zip")}?source=other`,
    `${webUrl("https", "github.com", "/electron/electron/releases/download/v43.2.0/file.zip")}#other`,
    webUrl("https", "github.com:444", "/electron/electron/releases/download/v43.2.0/file.zip"),
    webUrl("https", "github.com", "/electron/electron/releases/tag/v43.2.0"),
    webUrl("https", "github.com", "/electron/electron/releases/latest/download/electron-v43.2.0-win32-x64.zip"),
    webUrl("https", "github.com", "/electron/electron/releases/download/v43.2.1/electron-v43.2.1-win32-x64.zip"),
    webUrl("https", "github.com", "/electron/electron/releases/download/v43.2.0/electron-v43.2.1-win32-x64.zip"),
    webUrl("https", "github.com", "/electron/electron/releases/download/v43.2.0/arbitrary.zip"),
    webUrl("https", "github.com", "/electron/electron/releases/download/v43.2.0/electron-v43.2.0-freebsd-x64.zip"),
    webUrl("https", "github.com", "/electron/electron/releases/download/v43.2.0/electron-v43.2.0-darwin-armv7l.zip"),
    webUrl("https", "github.com", "/electron/electron/releases/download/v43.2.0/electron-v43.2.0-darwin-x64.zip"),
    webUrl("https", "github.com", "/electron/electron/releases/download/v43.2.0/electron-v43.2.0-linux-x64.zip"),
    webUrl("https", "github.com", "/electron/electron/releases/download/v43.2.0/electron-v43.2.0-win32-arm64.zip"),
    webUrl("https", "github.com", "/electron/electron/releases/download/v43.2.0%2Felectron-v43.2.0-win32-x64.zip"),
    webUrl("https", "github.com", "/electron/electron/releases/download/v43.2.0/%65lectron-v43.2.0-win32-x64.zip"),
  ];

  for (const candidate of candidates) {
    const fixtureRoot = await temporaryDirectory(t, "repo-official-lookalike-");
    await writeFile(join(fixtureRoot, "release.config.js"), `export default ${JSON.stringify(candidate)};\n`, "utf8");
    await assert.rejects(assertRepositoryElectronProvenance(fixtureRoot), /Electron provenance violation/u);
  }
});

test("installed Electron version assertion rejects anything except 43.2.0", async (t) => {
  const { assertInstalledElectronVersion } = await loadGuard();
  const fixtureRoot = await temporaryDirectory(t, "installed-electron-");
  const packagePath = join(fixtureRoot, "package.json");

  await writeFile(packagePath, JSON.stringify({ version: "43.2.1" }), "utf8");
  await assert.rejects(assertInstalledElectronVersion(packagePath), /43[.]2[.]1/u);
  await writeFile(packagePath, JSON.stringify({ version: "43.2.0" }), "utf8");
  await assert.doesNotReject(assertInstalledElectronVersion(packagePath));
});

test("guard accepts the current repository executable and configuration surface", async () => {
  const { assertElectronProvenance } = await loadGuard();
  await assert.doesNotReject(assertElectronProvenance({ root, environment: cleanEnvironment() }));
});

async function createFakeNpm(t, directory) {
  const path = join(directory, process.platform === "win32" ? "npm.cmd" : "npm");
  const content = process.platform === "win32"
    ? "@echo off\r\n> \"%FAKE_NPM_RECORD%\" echo %*\r\nexit /b %FAKE_NPM_EXIT%\r\n"
    : "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$FAKE_NPM_RECORD\"\nexit \"$FAKE_NPM_EXIT\"\n";
  await writeFile(path, content, "utf8");
  if (process.platform !== "win32") await chmod(path, 0o755);
  t.after(() => rm(path, { force: true }));
}

test("verified install rejects inherited overrides before invoking npm", async (t) => {
  const toolDirectory = await temporaryDirectory(t, "verified-install-tool-");
  const record = join(toolDirectory, "npm-args.txt");
  await createFakeNpm(t, toolDirectory);
  const name = token("npm", "config", electron.toLowerCase(), mirror.toLowerCase());

  const result = spawnSync(process.execPath, [join(root, "scripts/install-verified.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnvironment({
      PATH: `${toolDirectory}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_NPM_RECORD: record,
      FAKE_NPM_EXIT: "0",
      [name]: "https://invalid.example/source",
    }),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Electron provenance violation/u);
  await assert.rejects(readFile(record, "utf8"), { code: "ENOENT" });
});

test("verified install invokes official npm ci with writable cache and propagates status", async (t) => {
  const toolDirectory = await temporaryDirectory(t, "verified-install-tool-");
  const record = join(toolDirectory, "npm-args.txt");
  await createFakeNpm(t, toolDirectory);

  const result = spawnSync(process.execPath, [join(root, "scripts/install-verified.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnvironment({
      PATH: `${toolDirectory}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_NPM_RECORD: record,
      FAKE_NPM_EXIT: "23",
    }),
  });
  const args = await readFile(record, "utf8");

  assert.equal(result.status, 23, result.stderr);
  assert.match(args, /^ci\b/u);
  assert.match(args, /--registry https:\/\/registry[.]npmjs[.]org/u);
  assert.match(args, /--cache \S+/u);
  assert.doesNotMatch(args, /mirror/iu);
});
