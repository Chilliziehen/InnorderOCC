// @vitest-environment node

import { createHash, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("signed deployment release binding", () => {
  it("cryptographically verifies the release digest and binds every exact artifact", async () => {
    const fixture = await releasePayload();
    await expect(verifyDeploymentReleaseBundleForTest({
      payloadRoot: fixture.root,
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
    const first = withCertificateLifecycleLock(root, async () => { order.push("first-start"); started(); await gate; order.push("first-end"); });
    await firstStarted;
    const second = withCertificateLifecycleLock(root, async () => { order.push("second"); });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});
