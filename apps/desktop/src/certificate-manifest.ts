import { createHash, X509Certificate } from "node:crypto";
import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

import { z } from "zod";

export const MAX_CERTIFICATE_MANIFEST_BYTES = 64 * 1024;
export const MAX_CERTIFICATE_BYTES = 256 * 1024;
const MAX_CERTIFICATE_STATE_BYTES = 64 * 1024;
const MAX_CERTIFICATE_STATES = 128;
const PRODUCT_ID = "com.innorder.occ";
const STORE_NAME = "CurrentUser\\Root";

export const CERTIFICATE_ENROLLMENT_STATUS = Object.freeze({
  state: "unavailable",
  reason: "AUTHENTICODE_REQUIRED",
  message: "Production deployment CA enrollment requires a signed installer helper.",
} as const);

const sha256Schema = z
  .string()
  .regex(/^(?:[0-9A-Fa-f]{64}|(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})$/)
  .transform((value) => value.replaceAll(":", "").toLowerCase());

const thumbprintSchema = z
  .string()
  .regex(/^(?:[0-9A-Fa-f]{64}|(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})$/)
  .transform((value) => value.replaceAll(":", "").toUpperCase());

const certificateFileSchema = z.string().min(1).max(255).refine((value) =>
  value !== "." &&
  value !== ".." &&
  !value.includes(":") &&
  !value.includes("/") &&
  !value.includes("\\") &&
  path.basename(value) === value &&
  !path.isAbsolute(value),
"Certificate file must be a relative basename");

function normalizeIp(value: string): string {
  const version = isIP(value);
  if (version === 4) return value.split(".").map((part) => String(Number(part))).join(".");
  if (version === 6) return new URL(`http://[${value}]`).hostname.slice(1, -1).toLowerCase();
  throw new Error("Invalid IP SAN");
}

const dnsSanSchema = z.string().min(1).max(253).regex(
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/,
).transform((value) => value.toLowerCase());
const ipSanSchema = z.string().refine((value) => isIP(value) !== 0, "Invalid IP SAN").transform(normalizeIp);

const manifestSchema = z.object({
  version: z.literal(1),
  productId: z.literal(PRODUCT_ID),
  deploymentId: z.uuid(),
  certificate: z.object({
    file: certificateFileSchema,
    sha256: sha256Schema,
    thumbprint: thumbprintSchema,
    subject: z.string().min(1).max(4096),
    dnsSans: z.array(dnsSanSchema).max(64),
    ipSans: z.array(ipSanSchema).max(64),
    validFrom: z.iso.datetime({ offset: true }),
    validTo: z.iso.datetime({ offset: true }),
  }).strict().refine(({ dnsSans, ipSans }) => new Set([...dnsSans, ...ipSans]).size === dnsSans.length + ipSans.length, {
    message: "Certificate SAN entries must be unique",
  }).refine(({ validFrom, validTo }) => Date.parse(validFrom) < Date.parse(validTo), {
    message: "Certificate validity bounds are invalid",
  }),
  releaseManifest: z.object({
    sha256: sha256Schema,
    signature: z.object({
      algorithm: z.enum(["RSA-SHA256", "ECDSA-SHA256", "Ed25519"]),
      keyId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
      value: z.string().min(80).max(16_384).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine((value) => {
        const decoded = Buffer.from(value, "base64");
        return decoded.byteLength >= 64 && decoded.byteLength <= 8192 && decoded.toString("base64") === value;
      }, "Invalid release signature encoding"),
    }).strict(),
  }).strict(),
}).strict();

export type CertificateManifest = z.infer<typeof manifestSchema>;

const certificateStateSchema = z.object({
  version: z.literal(1),
  productId: z.literal(PRODUCT_ID),
  deploymentId: z.uuid(),
  importedByProduct: z.literal(true),
  ownedThumbprint: z.string().regex(/^[0-9A-F]{64}$/),
  store: z.literal(STORE_NAME),
  profileReferences: z.array(z.uuid()).max(10_000).refine((values) => new Set(values).size === values.length, "Profile references must be unique"),
  selectedProfileId: z.uuid().nullable(),
}).strict().refine(({ profileReferences, selectedProfileId }) =>
  selectedProfileId === null || profileReferences.includes(selectedProfileId),
"Selected profile must reference the certificate");

export type CertificateState = z.infer<typeof certificateStateSchema>;

export function parseCertificateState(value: unknown): CertificateState {
  return certificateStateSchema.parse(value);
}

type DerNode = { tag: number; contentStart: number; contentEnd: number; next: number };

function readDerNode(bytes: Buffer, offset: number, limit = bytes.length): DerNode {
  if (offset + 2 > limit) throw new Error("Truncated X.509 extension");
  const tag = bytes[offset]!;
  const firstLength = bytes[offset + 1]!;
  let length = firstLength;
  let contentStart = offset + 2;
  if ((firstLength & 0x80) !== 0) {
    const lengthBytes = firstLength & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || contentStart + lengthBytes > limit) {
      throw new Error("Invalid X.509 extension length");
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = length * 256 + bytes[contentStart + index]!;
    }
    if (length < 128) throw new Error("Non-canonical X.509 extension length");
    contentStart += lengthBytes;
  }
  const contentEnd = contentStart + length;
  if (contentEnd > limit) throw new Error("Truncated X.509 extension value");
  return { tag, contentStart, contentEnd, next: contentEnd };
}

function children(bytes: Buffer, node: DerNode): DerNode[] {
  const result: DerNode[] = [];
  let offset = node.contentStart;
  while (offset < node.contentEnd) {
    const child = readDerNode(bytes, offset, node.contentEnd);
    result.push(child);
    offset = child.next;
  }
  if (offset !== node.contentEnd) throw new Error("Invalid X.509 extension container");
  return result;
}

function decodeOid(bytes: Buffer, node: DerNode): string {
  if (node.tag !== 0x06 || node.contentStart === node.contentEnd) throw new Error("Invalid X.509 extension OID");
  const first = bytes[node.contentStart]!;
  const values = [Math.min(2, Math.floor(first / 40)), first < 80 ? first % 40 : first - 80];
  let value = 0;
  let continuing = false;
  for (let offset = node.contentStart + 1; offset < node.contentEnd; offset += 1) {
    const byte = bytes[offset]!;
    value = value * 128 + (byte & 0x7f);
    if (!Number.isSafeInteger(value)) throw new Error("Oversized X.509 extension OID");
    continuing = (byte & 0x80) !== 0;
    if (!continuing) {
      values.push(value);
      value = 0;
    }
  }
  if (continuing) throw new Error("Truncated X.509 extension OID");
  return values.join(".");
}

function certificateExtensions(certificate: X509Certificate): Map<string, Buffer> {
  const bytes = certificate.raw;
  const certificateNode = readDerNode(bytes, 0);
  if (certificateNode.tag !== 0x30 || certificateNode.next !== bytes.length) throw new Error("Invalid X.509 certificate DER");
  const tbs = children(bytes, certificateNode)[0];
  if (!tbs || tbs.tag !== 0x30) throw new Error("Invalid X.509 TBSCertificate");
  const extensionsWrapper = children(bytes, tbs).find(({ tag }) => tag === 0xa3);
  if (!extensionsWrapper) return new Map();
  const extensionSequence = children(bytes, extensionsWrapper)[0];
  if (!extensionSequence || extensionSequence.tag !== 0x30) throw new Error("Invalid X.509 extensions");
  const result = new Map<string, Buffer>();
  for (const extension of children(bytes, extensionSequence)) {
    if (extension.tag !== 0x30) throw new Error("Invalid X.509 extension");
    const parts = children(bytes, extension);
    const oid = decodeOid(bytes, parts[0]!);
    const valueNode = parts.at(-1);
    if (!valueNode || valueNode.tag !== 0x04 || result.has(oid)) throw new Error("Invalid or duplicate X.509 extension");
    result.set(oid, bytes.subarray(valueNode.contentStart, valueNode.contentEnd));
  }
  return result;
}

function requireCaKeyCertSign(certificate: X509Certificate): void {
  if (!certificate.ca) throw new Error("Certificate is not a CA certificate");
  const keyUsage = certificateExtensions(certificate).get("2.5.29.15");
  if (!keyUsage) throw new Error("CA certificate is missing keyCertSign");
  const bitString = readDerNode(keyUsage, 0);
  if (bitString.tag !== 0x03 || bitString.next !== keyUsage.length || bitString.contentEnd - bitString.contentStart < 2) {
    throw new Error("Invalid CA key usage extension");
  }
  const unusedBits = keyUsage[bitString.contentStart]!;
  const firstUsageByte = keyUsage[bitString.contentStart + 1]!;
  if (unusedBits > 7 || (firstUsageByte & 0x04) === 0) throw new Error("CA certificate does not permit keyCertSign");
}

function certificateSans(certificate: X509Certificate): { dnsSans: string[]; ipSans: string[] } {
  const san = certificateExtensions(certificate).get("2.5.29.17");
  if (!san) return { dnsSans: [], ipSans: [] };
  const sequence = readDerNode(san, 0);
  if (sequence.tag !== 0x30 || sequence.next !== san.length) throw new Error("Invalid certificate SAN extension");
  const dnsSans: string[] = [];
  const ipSans: string[] = [];
  for (const name of children(san, sequence)) {
    const value = san.subarray(name.contentStart, name.contentEnd);
    if (name.tag === 0x82) {
      if (value.some((byte) => byte < 0x21 || byte > 0x7e)) throw new Error("Invalid DNS SAN encoding");
      dnsSans.push(dnsSanSchema.parse(value.toString("ascii")));
    } else if (name.tag === 0x87) {
      if (value.length === 4) ipSans.push(Array.from(value).join("."));
      else if (value.length === 16) {
        const groups = Array.from({ length: 8 }, (_, index) => value.readUInt16BE(index * 2).toString(16));
        ipSans.push(normalizeIp(groups.join(":")));
      } else throw new Error("Invalid IP SAN encoding");
    }
  }
  return { dnsSans, ipSans };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactCertificate(bytes: Buffer): X509Certificate {
  const ascii = bytes.toString("ascii");
  if (/-----BEGIN (?:ENCRYPTED |RSA |EC )?PRIVATE KEY-----/.test(ascii)) {
    throw new Error("Private key PEM is forbidden");
  }
  let der = bytes;
  if (ascii.startsWith("-----BEGIN")) {
    const match = /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----\r?\n?$/.exec(ascii);
    if (!match) throw new Error("Certificate PEM must contain exactly one certificate and no trailing data");
    const base64 = match[1]!.replace(/\r?\n/g, "");
    der = Buffer.from(base64, "base64");
    if (der.toString("base64") !== base64) throw new Error("Certificate PEM encoding is not canonical");
  }
  const certificate = new X509Certificate(der);
  if (!certificate.raw.equals(der)) throw new Error("Certificate DER contains trailing data");
  return certificate;
}

function assertValidity(certificate: X509Certificate, now: Date): void {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp) || timestamp < certificate.validFromDate.getTime() || timestamp > certificate.validToDate.getTime()) {
    throw new Error("Certificate is not currently valid or has expired");
  }
}

type MinimalStat = { isFile(): boolean; isSymbolicLink(): boolean; size?: number };
type VerificationFileSystem = {
  readFile(target: string): Promise<Buffer>;
  lstat(target: string): Promise<MinimalStat>;
  realpath(target: string): Promise<string>;
};

const defaultVerificationFileSystem: VerificationFileSystem = {
  readFile: (target) => fs.readFile(target),
  lstat: (target) => fs.lstat(target),
  realpath: (target) => fs.realpath(target),
};

function isUnder(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function readBoundedRegularFile(
  target: string,
  maximumBytes: number,
  label: string,
  fileSystem: VerificationFileSystem,
): Promise<Buffer> {
  const stat = await fileSystem.lstat(target);
  if (stat.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (stat.size !== undefined && (stat.size === 0 || stat.size > maximumBytes)) {
    throw new Error(`${label} size exceeds the allowed bound`);
  }
  const bytes = await fileSystem.readFile(target);
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) throw new Error(`${label} size exceeds the allowed bound`);
  return bytes;
}

export async function verifyDeploymentCertificateManifest(
  input: {
    payloadRoot: string;
    manifestPath: string;
    expectedManifestSha256: string;
    expectedFingerprint: string;
    expectedHost?: string;
    now?: Date;
  },
  overrides: Partial<VerificationFileSystem> = {},
): Promise<{ manifest: CertificateManifest; certificate: X509Certificate; certificatePath: string }> {
  if (!path.isAbsolute(input.payloadRoot) || !path.isAbsolute(input.manifestPath)) throw new Error("Payload root and manifest path must be absolute");
  const fileSystem = { ...defaultVerificationFileSystem, ...overrides };
  const payloadRoot = path.resolve(input.payloadRoot);
  const manifestPath = path.resolve(input.manifestPath);
  if (!isUnder(payloadRoot, manifestPath)) throw new Error("Manifest path must be under the payload root");
  const realRoot = await fileSystem.realpath(payloadRoot);
  const realManifest = await fileSystem.realpath(manifestPath);
  if (!isUnder(realRoot, realManifest)) throw new Error("Manifest path escapes the payload root");
  const manifestBytes = await readBoundedRegularFile(manifestPath, MAX_CERTIFICATE_MANIFEST_BYTES, "Certificate manifest", fileSystem);
  const expectedManifestSha256 = sha256Schema.parse(input.expectedManifestSha256);
  if (sha256(manifestBytes) !== expectedManifestSha256) throw new Error("Certificate manifest SHA-256 mismatch");

  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("Certificate manifest is not valid JSON");
  }
  const manifest = manifestSchema.parse(manifestValue);
  const certificatePath = path.join(payloadRoot, manifest.certificate.file);
  if (!isUnder(payloadRoot, certificatePath)) throw new Error("Certificate file escapes the payload root");
  const realCertificate = await fileSystem.realpath(certificatePath);
  if (!isUnder(realRoot, realCertificate)) throw new Error("Certificate file escapes the payload root through a symbolic link");
  const certificateBytes = await readBoundedRegularFile(certificatePath, MAX_CERTIFICATE_BYTES, "Certificate", fileSystem);
  if (sha256(certificateBytes) !== manifest.certificate.sha256) throw new Error("Certificate file SHA-256 mismatch");
  const certificate = exactCertificate(certificateBytes);
  requireCaKeyCertSign(certificate);

  const thumbprint = certificate.fingerprint256.replaceAll(":", "").toUpperCase();
  if (thumbprint !== manifest.certificate.thumbprint) throw new Error("Certificate thumbprint does not match the manifest");
  if (thumbprint !== thumbprintSchema.parse(input.expectedFingerprint)) throw new Error("Certificate thumbprint does not match the expected fingerprint");
  if (certificate.subject !== manifest.certificate.subject) throw new Error("Certificate subject does not match the manifest");
  if (certificate.validFromDate.toISOString() !== manifest.certificate.validFrom || certificate.validToDate.toISOString() !== manifest.certificate.validTo) {
    throw new Error("Certificate validity does not match the manifest");
  }
  const sans = certificateSans(certificate);
  if (JSON.stringify(sans.dnsSans) !== JSON.stringify(manifest.certificate.dnsSans) || JSON.stringify(sans.ipSans) !== JSON.stringify(manifest.certificate.ipSans)) {
    throw new Error("Certificate SAN values do not match the manifest");
  }
  assertValidity(certificate, input.now ?? new Date());
  if (input.expectedHost) {
    const hostMatches = isIP(input.expectedHost)
      ? certificate.checkIP(input.expectedHost) !== undefined
      : certificate.checkHost(input.expectedHost, { subject: "never" }) !== undefined;
    if (!hostMatches) throw new Error("Certificate SAN does not match the expected host");
  }
  return { manifest, certificate, certificatePath };
}

export function verifyServerCertificate(input: {
  certificate: string | Buffer;
  trustAnchor: string | Buffer;
  hostname: string;
  now?: Date;
}): void {
  const certificate = exactCertificate(Buffer.isBuffer(input.certificate) ? input.certificate : Buffer.from(input.certificate, "ascii"));
  const trustAnchor = exactCertificate(Buffer.isBuffer(input.trustAnchor) ? input.trustAnchor : Buffer.from(input.trustAnchor, "ascii"));
  requireCaKeyCertSign(trustAnchor);
  assertValidity(certificate, input.now ?? new Date());
  const hostMatches = isIP(input.hostname)
    ? certificate.checkIP(input.hostname) !== undefined
    : certificate.checkHost(input.hostname, { subject: "never" }) !== undefined;
  if (!hostMatches) throw new Error("Server certificate host mismatch");
  if (!certificate.checkIssued(trustAnchor) || !certificate.verify(trustAnchor.publicKey)) {
    throw new Error("Server certificate is not trusted by the deployment CA");
  }
}

type CertificateProfileReference = { id: string; caFingerprint?: string | undefined };

export async function synchronizeCertificateReferences(input: {
  stateDirectory: string;
  profiles: CertificateProfileReference[];
  selectedId: string | null;
}): Promise<void> {
  if (!path.isAbsolute(input.stateDirectory) || path.basename(input.stateDirectory) !== "state") {
    throw new Error("Certificate state directory must be an absolute product state path");
  }
  const profiles = z.array(z.object({
    id: z.uuid(),
    caFingerprint: z.string().regex(/^[0-9A-F]{64}$/).optional(),
  }).strip()).max(10_000).parse(input.profiles);
  const selectedId = z.uuid().nullable().parse(input.selectedId);
  if (selectedId !== null && !profiles.some(({ id }) => id === selectedId)) throw new Error("Selected certificate profile does not exist");

  await fs.mkdir(input.stateDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.lstat(input.stateDirectory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("Certificate state path must be a regular directory");
  const entries = await fs.readdir(input.stateDirectory, { withFileTypes: true });
  const stateEntries = entries.filter(({ name }) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(name));
  if (stateEntries.length > MAX_CERTIFICATE_STATES) throw new Error("Too many deployment certificate states");
  for (const entry of stateEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Certificate state must be a regular file");
    const statePath = path.join(input.stateDirectory, entry.name);
    const bytes = await fs.readFile(statePath);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CERTIFICATE_STATE_BYTES) throw new Error("Certificate state size exceeds the allowed bound");
    let stateValue: unknown;
    try {
      stateValue = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Certificate state is not valid JSON");
    }
    const state = parseCertificateState(stateValue);
    if (`${state.deploymentId}.json`.toLowerCase() !== entry.name.toLowerCase()) throw new Error("Certificate state deployment filename mismatch");
    const profileReferences = profiles
      .filter(({ caFingerprint }) => caFingerprint === state.ownedThumbprint)
      .map(({ id }) => id)
      .sort();
    const selectedProfileId = selectedId !== null && profileReferences.includes(selectedId) ? selectedId : null;
    const updated = parseCertificateState({ ...state, profileReferences, selectedProfileId });
    const temporaryPath = path.join(input.stateDirectory, `.${state.deploymentId}.${process.pid}.tmp`);
    await fs.writeFile(temporaryPath, JSON.stringify(updated), { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await fs.rename(temporaryPath, statePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
  }
}
