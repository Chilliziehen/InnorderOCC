// @vitest-environment node

import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_CERTIFICATE_BYTES,
  MAX_CERTIFICATE_MANIFEST_BYTES,
  parseCertificateState,
  synchronizeCertificateReferences,
  verifyDeploymentCertificateManifest,
  verifyServerCertificate,
} from "../src/certificate-manifest";
import {
  DEPLOYMENT_CA_PEM,
  OTHER_CA_PEM,
  SERVER_CERTIFICATE_PEM,
  WRONG_HOST_CERTIFICATE_PEM,
} from "./certificate-fixtures";

const deploymentId = "9d564974-1f4f-4cc8-987a-4f2f09790d13";
const fixtureNow = new Date("2030-01-01T00:00:00.000Z");
const roots: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifestFor(certificateBytes: Buffer, overrides: Record<string, unknown> = {}) {
  const certificate = new X509Certificate(certificateBytes);
  return {
    version: 1,
    productId: "com.innorder.occ",
    deploymentId,
    certificate: {
      file: "deployment-ca.pem",
      sha256: sha256(certificateBytes).toUpperCase(),
      thumbprint: certificate.fingerprint256.toLowerCase(),
      subject: certificate.subject,
      dnsSans: ["occ.example"],
      ipSans: ["10.0.0.8"],
      validFrom: certificate.validFromDate.toISOString(),
      validTo: certificate.validToDate.toISOString(),
    },
    releaseManifest: {
      file: "release-manifest.json",
      sha256: "ab".repeat(32),
      signature: {
        algorithm: "RSA-SHA256",
        keyId: "innorder-release-2026",
        value: Buffer.alloc(64, 7).toString("base64"),
      },
    },
    ...overrides,
  };
}

async function payload(certificate = DEPLOYMENT_CA_PEM, manifestOverride?: Record<string, unknown>) {
  const root = await mkdtemp(path.join(tmpdir(), "occ-certificate-manifest-"));
  roots.push(root);
  const manifestPath = path.join(root, "certificate-manifest.json");
  const certificatePath = path.join(root, "deployment-ca.pem");
  const certificateBytes = Buffer.from(certificate, "ascii");
  const manifest = manifestFor(certificateBytes, manifestOverride);
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  await writeFile(certificatePath, certificateBytes);
  await writeFile(manifestPath, manifestBytes);
  return { root, manifestPath, certificatePath, certificateBytes, manifest, manifestBytes };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("deployment certificate manifest", () => {
  it("verifies bounded PEM certificate bytes and normalizes SHA-256 values", async () => {
    const fixture = await payload();
    const expectedFingerprint = new X509Certificate(fixture.certificateBytes).fingerprint256;

    const verified = await verifyDeploymentCertificateManifest({
      payloadRoot: fixture.root,
      manifestPath: fixture.manifestPath,
      expectedManifestSha256: sha256(fixture.manifestBytes).toUpperCase(),
      expectedFingerprint: expectedFingerprint.toLowerCase(),
      expectedHost: "occ.example",
      now: fixtureNow,
    });

    expect(verified.manifest.certificate.sha256).toBe(sha256(fixture.certificateBytes));
    expect(verified.manifest.certificate.thumbprint).toBe(expectedFingerprint.replaceAll(":", "").toUpperCase());
    expect(verified.certificate.raw).toEqual(new X509Certificate(fixture.certificateBytes).raw);
    expect(verified.certificatePath).toBe(fixture.certificatePath);
  });

  it("accepts exact DER bytes without allowing parser-ignored trailing data", async () => {
    const certificate = new X509Certificate(DEPLOYMENT_CA_PEM);
    const fixture = await payload();
    const derPath = path.join(fixture.root, "deployment-ca.der");
    const manifest = manifestFor(certificate.raw);
    manifest.certificate.file = "deployment-ca.der";
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(derPath, certificate.raw);
    await writeFile(fixture.manifestPath, manifestBytes);

    await expect(verifyDeploymentCertificateManifest({
      payloadRoot: fixture.root,
      manifestPath: fixture.manifestPath,
      expectedManifestSha256: sha256(manifestBytes),
      expectedFingerprint: certificate.fingerprint256,
      now: fixtureNow,
    })).resolves.toMatchObject({ certificatePath: derPath });

    await writeFile(derPath, Buffer.concat([certificate.raw, Buffer.from("polyglot")]));
    await expect(verifyDeploymentCertificateManifest({
      payloadRoot: fixture.root,
      manifestPath: fixture.manifestPath,
      expectedManifestSha256: sha256(manifestBytes),
      expectedFingerprint: certificate.fingerprint256,
      now: fixtureNow,
    })).rejects.toThrow(/trailing|exact|SHA-256/i);
  });

  it.each([
    "../deployment-ca.pem",
    "sub/deployment-ca.pem",
    "sub\\deployment-ca.pem",
    "C:\\deployment-ca.pem",
    "deployment-ca.pem:private",
    ".",
    "..",
  ])("rejects non-basename certificate path %s", async (file) => {
    const fixture = await payload(DEPLOYMENT_CA_PEM, {
      certificate: { ...manifestFor(Buffer.from(DEPLOYMENT_CA_PEM)).certificate, file },
    });
    await expect(verifyDeploymentCertificateManifest({
      payloadRoot: fixture.root,
      manifestPath: fixture.manifestPath,
      expectedManifestSha256: sha256(fixture.manifestBytes),
      expectedFingerprint: new X509Certificate(DEPLOYMENT_CA_PEM).fingerprint256,
      now: fixtureNow,
    })).rejects.toThrow(/certificate file|relative|basename/i);
  });

  it("rejects a manifest outside the absolute payload root and symbolic-link metadata", async () => {
    const fixture = await payload();
    const outside = await mkdtemp(path.join(tmpdir(), "occ-certificate-outside-"));
    roots.push(outside);
    const outsideManifest = path.join(outside, "manifest.json");
    await writeFile(outsideManifest, fixture.manifestBytes);

    await expect(verifyDeploymentCertificateManifest({
      payloadRoot: fixture.root,
      manifestPath: outsideManifest,
      expectedManifestSha256: sha256(fixture.manifestBytes),
      expectedFingerprint: new X509Certificate(DEPLOYMENT_CA_PEM).fingerprint256,
      now: fixtureNow,
    })).rejects.toThrow(/payload root/i);

    await expect(verifyDeploymentCertificateManifest({
      payloadRoot: fixture.root,
      manifestPath: fixture.manifestPath,
      expectedManifestSha256: sha256(fixture.manifestBytes),
      expectedFingerprint: new X509Certificate(DEPLOYMENT_CA_PEM).fingerprint256,
      now: fixtureNow,
    }, {
      lstat: async (target) => ({
        isFile: () => true,
        isSymbolicLink: () => target === fixture.certificatePath,
      }),
    })).rejects.toThrow(/symbolic link/i);
  });

  it("bounds manifest and certificate input before parsing", async () => {
    const fixture = await payload();
    await writeFile(fixture.manifestPath, Buffer.alloc(MAX_CERTIFICATE_MANIFEST_BYTES + 1, 32));
    await expect(verifyDeploymentCertificateManifest({
      payloadRoot: fixture.root,
      manifestPath: fixture.manifestPath,
      expectedManifestSha256: "00".repeat(32),
      expectedFingerprint: "00".repeat(32),
      now: fixtureNow,
    })).rejects.toThrow(/manifest.*size/i);

    const fresh = await payload();
    await writeFile(fresh.certificatePath, Buffer.alloc(MAX_CERTIFICATE_BYTES + 1, 1));
    await expect(verifyDeploymentCertificateManifest({
      payloadRoot: fresh.root,
      manifestPath: fresh.manifestPath,
      expectedManifestSha256: sha256(fresh.manifestBytes),
      expectedFingerprint: new X509Certificate(DEPLOYMENT_CA_PEM).fingerprint256,
      now: fixtureNow,
    })).rejects.toThrow(/certificate.*size/i);
  });

  it("rejects an oversized stat before allocating or reading file content", async () => {
    const fixture = await payload();
    await expect(verifyDeploymentCertificateManifest({
      payloadRoot: fixture.root,
      manifestPath: fixture.manifestPath,
      expectedManifestSha256: sha256(fixture.manifestBytes),
      expectedFingerprint: new X509Certificate(DEPLOYMENT_CA_PEM).fingerprint256,
      now: fixtureNow,
    }, {
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: MAX_CERTIFICATE_MANIFEST_BYTES + 1 }),
      readFile: async () => { throw new Error("oversized file was read"); },
    })).rejects.toThrow(/manifest.*size/i);
  });

  it.each([
    ["manifest digest", async (fixture: Awaited<ReturnType<typeof payload>>) => ({ expectedManifestSha256: "00".repeat(32) })],
    ["expected fingerprint", async () => ({ expectedFingerprint: "00".repeat(32) })],
    ["certificate hash", async (fixture: Awaited<ReturnType<typeof payload>>) => {
      fixture.manifest.certificate.sha256 = "00".repeat(32);
      fixture.manifestBytes = Buffer.from(JSON.stringify(fixture.manifest));
      await writeFile(fixture.manifestPath, fixture.manifestBytes);
      return {};
    }],
    ["subject", async (fixture: Awaited<ReturnType<typeof payload>>) => {
      fixture.manifest.certificate.subject = "CN=Replacement";
      fixture.manifestBytes = Buffer.from(JSON.stringify(fixture.manifest));
      await writeFile(fixture.manifestPath, fixture.manifestBytes);
      return {};
    }],
    ["SAN", async (fixture: Awaited<ReturnType<typeof payload>>) => {
      fixture.manifest.certificate.dnsSans = ["wrong.example"];
      fixture.manifestBytes = Buffer.from(JSON.stringify(fixture.manifest));
      await writeFile(fixture.manifestPath, fixture.manifestBytes);
      return {};
    }],
    ["validity", async (fixture: Awaited<ReturnType<typeof payload>>) => {
      fixture.manifest.certificate.validTo = "2037-01-01T00:00:00.000Z";
      fixture.manifestBytes = Buffer.from(JSON.stringify(fixture.manifest));
      await writeFile(fixture.manifestPath, fixture.manifestBytes);
      return {};
    }],
  ])("rejects a mismatched %s", async (_case, mutate) => {
    const fixture = await payload();
    const overrides = await mutate(fixture);
    await expect(verifyDeploymentCertificateManifest({
      payloadRoot: fixture.root,
      manifestPath: fixture.manifestPath,
      expectedManifestSha256: sha256(fixture.manifestBytes),
      expectedFingerprint: new X509Certificate(DEPLOYMENT_CA_PEM).fingerprint256,
      now: fixtureNow,
      ...overrides,
    })).rejects.toThrow();
  });

  it("rejects unknown/private-key metadata, non-CA certificates, expiry, and wrong host", async () => {
    const unknown = await payload(DEPLOYMENT_CA_PEM, { privateKey: "forbidden", unknown: true });
    await expect(verifyDeploymentCertificateManifest({
      payloadRoot: unknown.root,
      manifestPath: unknown.manifestPath,
      expectedManifestSha256: sha256(unknown.manifestBytes),
      expectedFingerprint: new X509Certificate(DEPLOYMENT_CA_PEM).fingerprint256,
      now: fixtureNow,
    })).rejects.toThrow();

    const leaf = await payload(SERVER_CERTIFICATE_PEM);
    await expect(verifyDeploymentCertificateManifest({
      payloadRoot: leaf.root,
      manifestPath: leaf.manifestPath,
      expectedManifestSha256: sha256(leaf.manifestBytes),
      expectedFingerprint: new X509Certificate(SERVER_CERTIFICATE_PEM).fingerprint256,
      now: fixtureNow,
    })).rejects.toThrow(/CA|keyCertSign/i);

    const fixture = await payload();
    const common = {
      payloadRoot: fixture.root,
      manifestPath: fixture.manifestPath,
      expectedManifestSha256: sha256(fixture.manifestBytes),
      expectedFingerprint: new X509Certificate(DEPLOYMENT_CA_PEM).fingerprint256,
    };
    await expect(verifyDeploymentCertificateManifest({ ...common, now: new Date("2040-01-01T00:00:00Z") })).rejects.toThrow(/expired|valid/i);
    await expect(verifyDeploymentCertificateManifest({ ...common, now: fixtureNow, expectedHost: "wrong.example" })).rejects.toThrow(/host|SAN/i);
  });

  it.each([
    DEPLOYMENT_CA_PEM + "trailing-data",
    DEPLOYMENT_CA_PEM + "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n",
    "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n" + DEPLOYMENT_CA_PEM,
  ])("rejects private-key and polyglot PEM input", async (certificate) => {
    const fixture = await payload(certificate);
    await expect(verifyDeploymentCertificateManifest({
      payloadRoot: fixture.root,
      manifestPath: fixture.manifestPath,
      expectedManifestSha256: sha256(fixture.manifestBytes),
      expectedFingerprint: new X509Certificate(DEPLOYMENT_CA_PEM).fingerprint256,
      now: fixtureNow,
    })).rejects.toThrow(/PEM|private|trailing|certificate/i);
  });
});

describe("server certificate fail-closed verification", () => {
  it("accepts only a currently valid exact-host certificate signed by the deployment CA", () => {
    expect(() => verifyServerCertificate({
      certificate: SERVER_CERTIFICATE_PEM,
      trustAnchor: DEPLOYMENT_CA_PEM,
      hostname: "occ.example",
      now: fixtureNow,
    })).not.toThrow();
  });

  it("rejects wrong-host, expired, replaced, and untrusted server certificates", () => {
    expect(() => verifyServerCertificate({ certificate: WRONG_HOST_CERTIFICATE_PEM, trustAnchor: DEPLOYMENT_CA_PEM, hostname: "occ.example", now: fixtureNow })).toThrow(/host/i);
    expect(() => verifyServerCertificate({ certificate: SERVER_CERTIFICATE_PEM, trustAnchor: DEPLOYMENT_CA_PEM, hostname: "occ.example", now: new Date("2040-01-01T00:00:00Z") })).toThrow(/expired|valid/i);
    expect(() => verifyServerCertificate({ certificate: SERVER_CERTIFICATE_PEM, trustAnchor: OTHER_CA_PEM, hostname: "occ.example", now: fixtureNow })).toThrow(/trust|issuer|signature/i);
    expect(() => verifyServerCertificate({ certificate: OTHER_CA_PEM, trustAnchor: DEPLOYMENT_CA_PEM, hostname: "occ.example", now: fixtureNow })).toThrow();
  });
});

describe("owned certificate reference state", () => {
  it("strictly parses ownership state and rejects extra or forged ownership fields", () => {
    const state = {
      version: 1,
      productId: "com.innorder.occ",
      deploymentId,
      importedByProduct: true,
      managed: true,
      ownedThumbprint: "AA".repeat(32),
      store: "CurrentUser\\Root",
      profileReferences: [],
      selectedProfileId: null,
    };
    expect(parseCertificateState(state)).toEqual(state);
    expect(() => parseCertificateState({ ...state, store: "LocalMachine\\Root" })).toThrow();
    expect(() => parseCertificateState({ ...state, arbitrary: true })).toThrow();
  });

  it("updates only product-owned state with profile references and selected profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "occ-certificate-state-"));
    roots.push(root);
    const stateDirectory = path.join(root, "state");
    await mkdir(stateDirectory);
    const statePath = path.join(stateDirectory, `${deploymentId}.json`);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      productId: "com.innorder.occ",
      deploymentId,
      importedByProduct: true,
      managed: true,
      ownedThumbprint: "AA".repeat(32),
      store: "CurrentUser\\Root",
      profileReferences: [],
      selectedProfileId: null,
    }));
    await writeFile(path.join(stateDirectory, "unrelated.json"), JSON.stringify({ keep: true }));

    await synchronizeCertificateReferences({
      stateDirectory,
      profiles: [
        { id: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2", caFingerprint: "AA".repeat(32) },
        { id: "67db5c28-973f-42a6-976d-91ece4fc975e", caFingerprint: "BB".repeat(32) },
      ],
      selectedId: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2",
    });

    expect(parseCertificateState(JSON.parse(await readFile(statePath, "utf8")))).toMatchObject({
      profileReferences: ["8e635134-d8a0-4bbf-8472-e8e44a0c66e2"],
      selectedProfileId: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2",
    });
    expect(JSON.parse(await readFile(path.join(stateDirectory, "unrelated.json"), "utf8"))).toEqual({ keep: true });
  });
});
