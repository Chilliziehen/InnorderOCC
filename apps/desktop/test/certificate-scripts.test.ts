// @vitest-environment node

import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import config from "../forge.config";
import { createProfileStore } from "../src/profile-store";
import { DEPLOYMENT_CA_PEM } from "./certificate-fixtures";

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const enrollScript = path.join(desktopRoot, "scripts", "enroll-deployment-ca.ps1");
const removeScript = path.join(desktopRoot, "scripts", "remove-deployment-ca.ps1");
const deploymentId = "9d564974-1f4f-4cc8-987a-4f2f09790d13";
const roots: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function payload() {
  const root = await mkdtemp(path.join(tmpdir(), "occ-ca-script-"));
  roots.push(root);
  const certificate = new X509Certificate(DEPLOYMENT_CA_PEM);
  const manifestPath = path.join(root, "certificate-manifest.json");
  const certificatePath = path.join(root, "deployment-ca.pem");
  const stateRoot = path.join(root, "userData", "state");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(certificatePath, DEPLOYMENT_CA_PEM, "ascii");
  const manifest = {
    version: 1,
    productId: "com.innorder.occ",
    deploymentId,
    certificate: {
      file: "deployment-ca.pem",
      sha256: sha256(DEPLOYMENT_CA_PEM),
      thumbprint: certificate.fingerprint256.replaceAll(":", "").toUpperCase(),
      subject: certificate.subject,
      dnsSans: ["occ.example"],
      ipSans: ["10.0.0.8"],
      validFrom: certificate.validFromDate.toISOString(),
      validTo: certificate.validToDate.toISOString(),
    },
    releaseManifest: {
      sha256: "ab".repeat(32),
      signature: { algorithm: "RSA-SHA256", keyId: "innorder-release-2026", value: Buffer.alloc(64, 7).toString("base64") },
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(manifestPath, manifestBytes);
  return { root, manifestPath, stateRoot, manifestBytes, fingerprint: manifest.certificate.thumbprint };
}

async function runPowerShell(script: string, arguments_: string[]) {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...arguments_,
  ], { windowsHide: true });
  return JSON.parse(stdout.trim());
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded PowerShell certificate helpers", () => {
  it("contains no machine-store or arbitrary execution surface", () => {
    const sources = [readFileSync(enrollScript, "utf8"), readFileSync(removeScript, "utf8")];
    for (const source of sources) {
      expect(source).toContain("CurrentUser");
      expect(source).toContain("Root");
      expect(source).not.toMatch(/LocalMachine|Invoke-Expression|\bIEX\b|Start-Process|ScriptBlock|\bCommand\b/i);
    }
    expect(sources[0]).toMatch(/ShouldContinue|InstallerConfirmed/);
    expect(sources[0]).toMatch(/Get-AuthenticodeSignature/);
    expect(sources[0]).toMatch(/ReparsePoint/);
  });

  it("validates existing ownership before import and atomically creates or replaces state", () => {
    const source = readFileSync(enrollScript, "utf8");
    expect(source.indexOf("Existing certificate state ownership mismatch")).toBeGreaterThan(0);
    expect(source.indexOf("Existing certificate state ownership mismatch")).toBeLessThan(source.indexOf("$store.Add"));
    expect(source).toMatch(/Test-Path[^\n]+\$statePath[\s\S]+\[IO\.File\]::Replace[\s\S]+else[\s\S]+\[IO\.File\]::Move/);
    expect(source).toMatch(/\$existingStateItem[\s\S]+ReparsePoint[\s\S]+Existing certificate state ownership mismatch/);
    expect(source).toMatch(/\$imported[\s\S]+\$store\.Add[\s\S]+catch[\s\S]+if \(\$imported\)[\s\S]+\$rollbackStore\.Remove/);
  });

  it("returns an exact development enrollment plan without touching the real store", async () => {
    const fixture = await payload();
    const plan = await runPowerShell(enrollScript, [
      "-PayloadRoot", fixture.root,
      "-ManifestPath", fixture.manifestPath,
      "-ExpectedManifestSha256", sha256(fixture.manifestBytes),
      "-ExpectedFingerprint", fixture.fingerprint,
      "-StateRoot", fixture.stateRoot,
      "-Mode", "Development",
      "-InstallerConfirmed",
      "-PlanOnly",
    ]);

    expect(plan).toMatchObject({
      status: "planned",
      action: "import-if-absent",
      store: "CurrentUser\\Root",
      productId: "com.innorder.occ",
      deploymentId,
      ownedThumbprint: fixture.fingerprint,
    });
    expect(plan).not.toHaveProperty("privateKey");
  }, 30_000);

  it("refuses unsigned production enrollment even in a deterministic plan", async () => {
    const fixture = await payload();
    const plan = await runPowerShell(enrollScript, [
      "-PayloadRoot", fixture.root,
      "-ManifestPath", fixture.manifestPath,
      "-ExpectedManifestSha256", sha256(fixture.manifestBytes),
      "-ExpectedFingerprint", fixture.fingerprint,
      "-StateRoot", fixture.stateRoot,
      "-Mode", "Production",
      "-InstallerConfirmed",
      "-PlanOnly",
    ]);
    expect(plan).toMatchObject({ status: "unavailable", reason: "AUTHENTICODE_REQUIRED", action: "none" });
  }, 30_000);

  it("plans removal only for owned unreferenced exact-thumbprint state", async () => {
    const fixture = await payload();
    const statePath = path.join(fixture.stateRoot, `${deploymentId}.json`);
    const state = {
      version: 1,
      productId: "com.innorder.occ",
      deploymentId,
      importedByProduct: true,
      ownedThumbprint: fixture.fingerprint,
      store: "CurrentUser\\Root",
      profileReferences: ["8e635134-d8a0-4bbf-8472-e8e44a0c66e2"],
      selectedProfileId: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2",
    };
    await writeFile(statePath, JSON.stringify(state));
    await expect(runPowerShell(removeScript, ["-StateRoot", fixture.stateRoot, "-DeploymentId", deploymentId, "-PlanOnly"]))
      .resolves.toMatchObject({ status: "retained", action: "none", reason: "PROFILE_REFERENCES", referenceCount: 1 });

    await writeFile(statePath, JSON.stringify({ ...state, profileReferences: [], selectedProfileId: null }));
    await expect(runPowerShell(removeScript, ["-StateRoot", fixture.stateRoot, "-DeploymentId", deploymentId, "-PlanOnly"]))
      .resolves.toMatchObject({ status: "planned", action: "remove-if-exact-match", store: "CurrentUser\\Root", ownedThumbprint: fixture.fingerprint });
  }, 30_000);

  it("is idempotent for missing removal state and rejects forged state", async () => {
    const fixture = await payload();
    await expect(runPowerShell(removeScript, ["-StateRoot", fixture.stateRoot, "-DeploymentId", deploymentId, "-PlanOnly"]))
      .resolves.toMatchObject({ status: "absent", action: "none" });
    await writeFile(path.join(fixture.stateRoot, `${deploymentId}.json`), JSON.stringify({ productId: "other.product", deploymentId }));
    await expect(runPowerShell(removeScript, ["-StateRoot", fixture.stateRoot, "-DeploymentId", deploymentId, "-PlanOnly"]))
      .rejects.toThrow();
  }, 30_000);
});

describe("main-process trust reference integration", () => {
  it("synchronizes CA references on load, save, select, update, and remove", async () => {
    let persisted: unknown;
    const synchronize = async (...arguments_: unknown[]) => {
      calls.push(structuredClone(arguments_));
    };
    const calls: unknown[][] = [];
    const store = await createProfileStore({
      read: async () => persisted,
      write: async (value) => { persisted = structuredClone(value); },
      packaged: true,
      synchronizeCertificateReferences: synchronize,
    });
    const saved = await store.save({ name: "Pilot", origin: "https://occ.example", caFingerprint: "AA".repeat(32) });
    await store.select(saved.id);
    await store.save({ ...saved, caFingerprint: "BB".repeat(32) });
    await store.remove(saved.id);

    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(calls).toContainEqual([[expect.objectContaining({ id: saved.id, caFingerprint: "AA".repeat(32) })], null]);
    expect(calls).toContainEqual([[expect.objectContaining({ id: saved.id, caFingerprint: "AA".repeat(32) })], saved.id]);
    expect(calls.at(-1)).toEqual([[], null]);
  });

  it("bundles helpers as installer resources without exposing renderer shell methods", () => {
    expect(config.packagerConfig?.extraResource).toEqual(expect.arrayContaining([
      expect.stringMatching(/enroll-deployment-ca\.ps1$/),
      expect.stringMatching(/remove-deployment-ca\.ps1$/),
    ]));
    const packageJson = JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
    const rootPackageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    expect(packageJson.scripts["cert:verify"]).toBeDefined();
    expect(rootPackageJson.scripts["cert:verify"]).toBeDefined();
    const preload = readFileSync(path.join(desktopRoot, "src", "preload.ts"), "utf8");
    expect(preload).not.toMatch(/certificate|powershell|shell|enroll/i);
  });
});
