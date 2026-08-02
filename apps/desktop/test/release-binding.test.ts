// @vitest-environment node

import { createHash, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  certificateManifestContentSha256,
  parseCertificateState,
  withCertificateLifecycleLock,
  verifyDeploymentReleaseBundleForTest,
} from "../src/certificate-manifest";
import { DEPLOYMENT_CA_PEM } from "./certificate-fixtures";

const roots: string[] = [];
const deploymentId = "9d564974-1f4f-4cc8-987a-4f2f09790d13";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function releasePayload() {
  const root = await mkdtemp(path.join(tmpdir(), "occ-release-binding-"));
  roots.push(root);
  const certificate = new X509Certificate(DEPLOYMENT_CA_PEM);
  const certificatePath = path.join(root, "deployment-ca.pem");
  const helperPath = path.join(root, "enroll-deployment-ca.ps1");
  const removalHelperPath = path.join(root, "remove-deployment-ca.ps1");
  const installerPath = path.join(root, "InnorderOCC.exe");
  const certificateManifestPath = path.join(root, "certificate-manifest.json");
  const releaseManifestPath = path.join(root, "release-manifest.json");
  await writeFile(certificatePath, DEPLOYMENT_CA_PEM, "ascii");
  await writeFile(helperPath, "reviewed helper", "ascii");
  await writeFile(removalHelperPath, "reviewed removal helper", "ascii");
  await writeFile(installerPath, "signed installer fixture", "ascii");

  const certificatePayload = {
    version: 1,
    productId: "com.innorder.occ",
    deploymentId,
    certificate: {
      file: "deployment-ca.pem",
      sha256: sha256(DEPLOYMENT_CA_PEM),
      thumbprint: certificate.fingerprint256,
      subject: certificate.subject,
      dnsSans: ["occ.example"],
      ipSans: ["10.0.0.8"],
      validFrom: certificate.validFromDate.toISOString(),
      validTo: certificate.validToDate.toISOString(),
    },
  };
  const releaseManifest = {
    version: 1,
    productId: "com.innorder.occ",
    productVersion: "0.1.0",
    installer: { file: "InnorderOCC.exe", sha256: sha256("signed installer fixture"), productName: "Innorder OCC", internalName: "InnorderOCC" },
    helper: { file: "enroll-deployment-ca.ps1", sha256: sha256("reviewed helper") },
    removalHelper: { file: "remove-deployment-ca.ps1", sha256: sha256("reviewed removal helper") },
    certificateManifest: { file: "certificate-manifest.json", contentSha256: certificateManifestContentSha256(certificatePayload) },
    publisher: { subject: "CN=Innorder Release", thumbprint: "AB".repeat(20) },
  };
  const releaseBytes = Buffer.from(JSON.stringify(releaseManifest));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const releaseDigest = sha256(releaseBytes);
  const signature = sign("RSA-SHA256", Buffer.from(releaseDigest, "hex"), privateKey).toString("base64");
  const certificateManifest = {
    ...certificatePayload,
    releaseManifest: { file: "release-manifest.json", sha256: releaseDigest, signature: { algorithm: "RSA-SHA256", keyId: "test-release", value: signature } },
  };
  await writeFile(releaseManifestPath, releaseBytes);
  await writeFile(certificateManifestPath, JSON.stringify(certificateManifest));
  return { root, certificatePath, helperPath, removalHelperPath, installerPath, certificateManifestPath, releaseManifestPath, certificateManifestBytes: Buffer.from(JSON.stringify(certificateManifest)), certificateManifest, releaseManifest, publicKey };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("signed deployment release binding", () => {
  it("cryptographically verifies the release digest and binds every exact artifact", async () => {
    const fixture = await releasePayload();
    await expect(verifyDeploymentReleaseBundleForTest({
      payloadRoot: fixture.root,
      purpose: "enroll",
      certificateManifestPath: fixture.certificateManifestPath,
      releaseManifestPath: fixture.releaseManifestPath,
      enrollmentHelperPath: fixture.helperPath,
      removalHelperPath: fixture.removalHelperPath,
      installerPath: fixture.installerPath,
      expectedCertificateManifestSha256: sha256(fixture.certificateManifestBytes),
      expectedFingerprint: new X509Certificate(DEPLOYMENT_CA_PEM).fingerprint256,
      now: new Date("2030-01-01T00:00:00Z"),
    }, fixture.publicKey)).resolves.toMatchObject({ releaseManifest: { productId: "com.innorder.occ" } });
  });

  it.each(["release", "certificate manifest", "helper", "removal helper", "installer"])('rejects a changed %s', async (target) => {
    const fixture = await releasePayload();
    const targetPath = target === "release" ? fixture.releaseManifestPath
      : target === "certificate manifest" ? fixture.certificateManifestPath
      : target === "helper" ? fixture.helperPath
      : target === "removal helper" ? fixture.removalHelperPath : fixture.installerPath;
    await writeFile(targetPath, Buffer.concat([await readFile(targetPath), Buffer.from("changed")]));
    await expect(verifyDeploymentReleaseBundleForTest({
      payloadRoot: fixture.root,
      purpose: "enroll",
      certificateManifestPath: fixture.certificateManifestPath,
      releaseManifestPath: fixture.releaseManifestPath,
      enrollmentHelperPath: fixture.helperPath,
      removalHelperPath: fixture.removalHelperPath,
      installerPath: fixture.installerPath,
      expectedCertificateManifestSha256: sha256(fixture.certificateManifestBytes),
      expectedFingerprint: new X509Certificate(DEPLOYMENT_CA_PEM).fingerprint256,
      now: new Date("2030-01-01T00:00:00Z"),
    }, fixture.publicKey)).rejects.toThrow();
  });

  it("rejects another RSA key and refuses test key injection outside tests", async () => {
    const fixture = await releasePayload();
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    await expect(verifyDeploymentReleaseBundleForTest({
      payloadRoot: fixture.root,
      purpose: "enroll",
      certificateManifestPath: fixture.certificateManifestPath,
      releaseManifestPath: fixture.releaseManifestPath,
      enrollmentHelperPath: fixture.helperPath,
      removalHelperPath: fixture.removalHelperPath,
      installerPath: fixture.installerPath,
      expectedCertificateManifestSha256: sha256(fixture.certificateManifestBytes),
      expectedFingerprint: new X509Certificate(DEPLOYMENT_CA_PEM).fingerprint256,
      now: new Date("2030-01-01T00:00:00Z"),
    }, other)).rejects.toThrow(/signature/i);
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(verifyDeploymentReleaseBundleForTest({
        payloadRoot: fixture.root,
        purpose: "enroll",
        certificateManifestPath: fixture.certificateManifestPath,
        releaseManifestPath: fixture.releaseManifestPath,
        enrollmentHelperPath: fixture.helperPath,
        removalHelperPath: fixture.removalHelperPath,
        installerPath: fixture.installerPath,
        expectedCertificateManifestSha256: sha256(fixture.certificateManifestBytes),
        expectedFingerprint: new X509Certificate(DEPLOYMENT_CA_PEM).fingerprint256,
      }, fixture.publicKey)).rejects.toThrow(/unavailable in production/i);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("requires current CA validity for enrollment but permits expired identity verification for removal", async () => {
    const fixture = await releasePayload();
    const input = {
      payloadRoot: fixture.root,
      certificateManifestPath: fixture.certificateManifestPath,
      releaseManifestPath: fixture.releaseManifestPath,
      enrollmentHelperPath: fixture.helperPath,
      removalHelperPath: fixture.removalHelperPath,
      installerPath: fixture.installerPath,
      expectedCertificateManifestSha256: sha256(fixture.certificateManifestBytes),
      expectedFingerprint: new X509Certificate(DEPLOYMENT_CA_PEM).fingerprint256,
      now: new Date("2100-01-01T00:00:00Z"),
    } as const;
    await expect(verifyDeploymentReleaseBundleForTest({ ...input, purpose: "enroll" }, fixture.publicKey)).rejects.toThrow(/expired|valid/i);
    await expect(verifyDeploymentReleaseBundleForTest({ ...input, purpose: "remove" }, fixture.publicKey)).resolves.toMatchObject({ certificateManifest: { deploymentId } });
    const notYetValid = { ...input, now: new Date("1900-01-01T00:00:00Z") };
    await expect(verifyDeploymentReleaseBundleForTest({ ...notYetValid, purpose: "enroll" }, fixture.publicKey)).rejects.toThrow(/expired|valid/i);
    await expect(verifyDeploymentReleaseBundleForTest({ ...notYetValid, purpose: "remove" }, fixture.publicKey)).resolves.toMatchObject({ certificateManifest: { deploymentId } });
  });
});

describe("certificate identity policy", () => {
  it("accepts only v4 deployment and profile UUIDs and records preexisting certificates as non-owned", () => {
    const state = { version: 1, productId: "com.innorder.occ", deploymentId, importedByProduct: false, managed: true, ownedThumbprint: "AA".repeat(32), store: "CurrentUser\\Root", profileReferences: [], selectedProfileId: null };
    expect(parseCertificateState(state)).toEqual(state);
    expect(() => parseCertificateState({ ...state, deploymentId: "018f1f4f-7abc-7def-8abc-123456789abc" })).toThrow();
    expect(() => parseCertificateState({ ...state, profileReferences: ["018f1f4f-7abc-7def-8abc-123456789abc"] })).toThrow();
  });

  it("serializes main-process state work through the shared lifecycle lock file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "occ-lock-"));
    roots.push(root);
    const order: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const processStartUtc = "2026-01-01T00:00:00.000Z";
    const lockDependencies = { currentProcessStart: async () => processStartUtc, inspectProcess: async () => ({ processStartUtc }) };
    const first = withCertificateLifecycleLock(root, async () => { order.push("first-start"); started(); await gate; order.push("first-end"); }, lockDependencies);
    await firstStarted;
    const second = withCertificateLifecycleLock(root, async () => { order.push("second"); }, lockDependencies);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("recovers a strict dead stale lifecycle lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "occ-lock-dead-"));
    roots.push(root);
    const lockPath = path.join(root, ".deployment-ca.lifecycle.lock");
    await writeFile(lockPath, JSON.stringify({ version: 1, pid: 424242, processStartUtc: "2026-01-01T00:00:00.000Z", acquiredAtUtc: "2026-01-01T00:00:00.000Z", owner: "11111111-1111-4111-8111-111111111111" }));
    await utimes(lockPath, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    await expect(withCertificateLifecycleLock(root, async () => "recovered", {
      now: () => new Date("2026-01-01T00:01:00Z"),
      inspectProcess: async () => null,
      currentProcessStart: async () => "2026-01-01T00:00:30.000Z",
      sleep: async () => undefined,
      attempts: 2,
      staleMilliseconds: 1_000,
    })).resolves.toBe("recovered");
  });

  it("never publishes a final lock when durable staging fails before publication", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "occ-lock-publish-fault-"));
    roots.push(root);
    await expect(withCertificateLifecycleLock(root, async () => undefined, {
      currentProcessStart: async () => "2026-01-01T00:00:00.000Z",
      publishLock: async () => { throw new Error("simulated pre-publish crash"); },
    })).rejects.toThrow(/pre-publish crash/i);
    expect(await readdir(root)).toEqual([]);
  });

  it("publishes a complete owner record through the no-overwrite dependency", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "occ-lock-publish-complete-"));
    roots.push(root);
    let stagedRecord: unknown;
    await withCertificateLifecycleLock(root, async () => {
      expect(stagedRecord).toMatchObject({ version: 1, pid: process.pid, owner: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
    }, {
      currentProcessStart: async () => "2026-01-01T00:00:00.000Z",
      publishLock: async (temporaryPath, lockPath) => {
        stagedRecord = JSON.parse(await readFile(temporaryPath, "utf8"));
        const { link } = await import("node:fs/promises");
        await link(temporaryPath, lockPath);
      },
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("preserves a live stale lifecycle lock and a malformed fresh lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "occ-lock-live-"));
    roots.push(root);
    const lockPath = path.join(root, ".deployment-ca.lifecycle.lock");
    const live = { version: 1, pid: 42, processStartUtc: "2026-01-01T00:00:00.000Z", acquiredAtUtc: "2026-01-01T00:00:00.000Z", owner: "11111111-1111-4111-8111-111111111111" };
    await writeFile(lockPath, JSON.stringify(live));
    await expect(withCertificateLifecycleLock(root, async () => undefined, {
      now: () => new Date("2026-01-01T00:01:00Z"), inspectProcess: async () => ({ processStartUtc: live.processStartUtc }), currentProcessStart: async () => live.processStartUtc, sleep: async () => undefined, attempts: 2, staleMilliseconds: 1,
    })).rejects.toThrow(/timed out/i);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(live);
    await writeFile(lockPath, "{");
    const fresh = new Date();
    await utimes(lockPath, fresh, fresh);
    await expect(withCertificateLifecycleLock(root, async () => undefined, {
      now: () => fresh, inspectProcess: async () => null, sleep: async () => undefined, attempts: 2, staleMilliseconds: 60_000,
    })).rejects.toThrow(/timed out/i);
    expect((await stat(lockPath)).isFile()).toBe(true);
  }, 15_000);

  it("preserves a malformed stale lifecycle lock because its owner cannot be proven dead", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "occ-lock-malformed-stale-"));
    roots.push(root);
    const lockPath = path.join(root, ".deployment-ca.lifecycle.lock");
    await writeFile(lockPath, "{");
    await utimes(lockPath, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    await expect(withCertificateLifecycleLock(root, async () => undefined, {
      now: () => new Date("2026-01-01T00:01:00Z"),
      inspectProcess: async () => null,
      inspectLegacyHolder: async () => false,
      currentProcessStart: async () => "2026-01-01T00:00:30.000Z",
      sleep: async () => undefined,
      attempts: 2,
      staleMilliseconds: 1,
    })).rejects.toThrow(/timed out/i);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("{");
  });

  it("recovers an aged malformed legacy lock only after conclusive no-holder proof", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "occ-lock-malformed-proven-"));
    roots.push(root);
    const lockPath = path.join(root, ".deployment-ca.lifecycle.lock");
    await writeFile(lockPath, "{");
    await utimes(lockPath, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    const inspectLegacyHolder = async () => true;
    await expect(withCertificateLifecycleLock(root, async () => "recovered", {
      now: () => new Date("2026-01-01T00:01:00Z"),
      inspectLegacyHolder,
      currentProcessStart: async () => "2026-01-01T00:00:30.000Z",
      sleep: async () => undefined,
      attempts: 2,
      staleMilliseconds: 1,
    })).resolves.toBe("recovered");
  });

  it.runIf(process.platform === "win32")("fails closed when trusted PowerShell resolution is indeterminate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "occ-lock-malformed-indeterminate-"));
    roots.push(root);
    const lockPath = path.join(root, ".deployment-ca.lifecycle.lock");
    await writeFile(lockPath, "{");
    await utimes(lockPath, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    vi.stubEnv("SystemRoot", "relative-system-root");
    await expect(withCertificateLifecycleLock(root, async () => undefined, {
      now: () => new Date("2026-01-01T00:01:00Z"),
      currentProcessStart: async () => "2026-01-01T00:00:30.000Z",
      sleep: async () => undefined,
      attempts: 1,
      staleMilliseconds: 1,
    })).rejects.toThrow(/timed out/i);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("{");
  });

  it("preserves a stale lock whose owner token is not a UUID v4", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "occ-lock-owner-version-"));
    roots.push(root);
    const lockPath = path.join(root, ".deployment-ca.lifecycle.lock");
    const record = { version: 1, pid: 42, processStartUtc: "2026-01-01T00:00:00.000Z", acquiredAtUtc: "2026-01-01T00:00:00.000Z", owner: "11111111-1111-1111-8111-111111111111" };
    await writeFile(lockPath, JSON.stringify(record));
    await expect(withCertificateLifecycleLock(root, async () => undefined, {
      now: () => new Date("2026-01-01T00:01:00Z"),
      inspectProcess: async () => null,
      currentProcessStart: async () => "2026-01-01T00:00:30.000Z",
      sleep: async () => undefined,
      attempts: 2,
      staleMilliseconds: 1,
    })).rejects.toThrow(/timed out/i);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(record);
  });

  it("preserves a stale lock when process liveness cannot be inspected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "occ-lock-unknown-"));
    roots.push(root);
    const lockPath = path.join(root, ".deployment-ca.lifecycle.lock");
    const record = { version: 1, pid: 42, processStartUtc: "2026-01-01T00:00:00.000Z", acquiredAtUtc: "2026-01-01T00:00:00.000Z", owner: "11111111-1111-4111-8111-111111111111" };
    await writeFile(lockPath, JSON.stringify(record));
    await expect(withCertificateLifecycleLock(root, async () => undefined, {
      now: () => new Date("2026-01-01T00:01:00Z"), inspectProcess: async () => undefined, currentProcessStart: async () => record.processStartUtc, sleep: async () => undefined, attempts: 2, staleMilliseconds: 1,
    })).rejects.toThrow(/timed out/i);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(record);
  });

  it("does not delete a replacement lock owned by another process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "occ-lock-race-"));
    roots.push(root);
    const lockPath = path.join(root, ".deployment-ca.lifecycle.lock");
    const replacement = { version: 1, pid: 42, processStartUtc: "2026-01-01T00:00:00.000Z", acquiredAtUtc: "2026-01-01T00:00:01.000Z", owner: "22222222-2222-4222-8222-222222222222" };
    await withCertificateLifecycleLock(root, async () => {
      await rm(lockPath, { force: true });
      await writeFile(lockPath, JSON.stringify(replacement));
    }, { currentProcessStart: async () => "2026-01-01T00:00:30.000Z" });
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacement);
  });

  it("does not publish a lock when its current process identity is unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "occ-lock-identity-"));
    roots.push(root);
    const lockPath = path.join(root, ".deployment-ca.lifecycle.lock");
    await expect(withCertificateLifecycleLock(root, async () => undefined, {
      currentProcessStart: async () => { throw new Error("process identity unavailable"); },
    })).rejects.toThrow(/identity unavailable/i);
    await expect(stat(lockPath)).rejects.toThrow();
  });
});
