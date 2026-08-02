import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";

import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

type Client = Pick<S3Client, "send">;
type Config = Readonly<{ endpoint: string; bucket: string; prefix: string; accessKeyFile: string; secretKeyFile: string; forcePathStyle: boolean; allowInsecureLocalhost?: boolean; maxObjectBytes?: number; client?: Client }>;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u;
const HASH = /^[a-f0-9]{64}$/u;

async function credential(path: string): Promise<string> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 4096) throw new Error();
    const value = (await readFile(path, "utf8")).trim();
    if (!value || /[\r\n\0]/u.test(value)) throw new Error();
    return value;
  } catch { throw new Error("OCC-AI-OBJECT-STORE-CREDENTIAL"); }
}

export class MinioQuarantineObjectStore {
  private constructor(private readonly config: Config, private readonly client: Client, private readonly maxObjectBytes: number) {}

  static async create(config: Config): Promise<MinioQuarantineObjectStore> {
    const endpoint = new URL(config.endpoint);
    const secure = endpoint.protocol === "https:";
    const localHttp = config.allowInsecureLocalhost === true && endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname);
    if ((!secure && !localHttp) || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || !/^[a-z0-9][a-z0-9.-]{0,62}$/u.test(config.bucket) || !config.prefix.startsWith("quarantine/") || !KEY.test(config.prefix)) throw new Error("OCC-AI-OBJECT-STORE-CONFIG");
    const max = config.maxObjectBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(max) || max < 1 || max > 100 * 1024 * 1024) throw new Error("OCC-AI-OBJECT-STORE-CONFIG");
    const [accessKeyId, secretAccessKey] = await Promise.all([credential(config.accessKeyFile), credential(config.secretKeyFile)]);
    const clientConfig: S3ClientConfig = { endpoint: endpoint.origin, forcePathStyle: config.forcePathStyle, region: "us-east-1", credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1 };
    return new MinioQuarantineObjectStore(config, config.client ?? new S3Client(clientConfig), max);
  }

  private key(objectId: string): string {
    if (!KEY.test(objectId) || objectId.includes("..") || objectId.startsWith("/")) throw new Error("OCC-AI-OBJECT-STORE-KEY");
    return `${this.config.prefix.replace(/\/+$/u, "")}/${objectId}`;
  }

  async upload(objectId: string, bytes: Uint8Array, expectedHash: string, signal: AbortSignal): Promise<void> {
    if (bytes.length < 1 || bytes.length > this.maxObjectBytes || !HASH.test(expectedHash) || createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error("OCC-AI-OBJECT-STORE-INTEGRITY");
    const checksum = createHash("sha256").update(bytes).digest("base64");
    const Key = this.key(objectId);
    let created = false;
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key, Body: bytes, ContentLength: bytes.length, ChecksumSHA256: checksum, ServerSideEncryption: "AES256", IfNoneMatch: "*" }), { abortSignal: signal });
      created = true;
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key, ChecksumMode: "ENABLED" }), { abortSignal: signal });
      if (head.ContentLength !== bytes.length || head.ChecksumSHA256 !== checksum || head.ServerSideEncryption !== "AES256") throw new Error("OCC-AI-OBJECT-STORE-INTEGRITY");
    } catch (error) {
      const status = typeof error === "object" && error !== null && "$metadata" in error ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode : undefined;
      if (status === 412 || (error instanceof Error && error.name === "PreconditionFailed")) throw new Error("OCC-AI-OBJECT-STORE-CONFLICT");
      if (created) await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key })).catch(() => undefined);
      throw error;
    }
  }

  async readObject(objectId: string, expectedHash: string, signal: AbortSignal): Promise<Uint8Array> {
    if (!HASH.test(expectedHash)) throw new Error("OCC-AI-OBJECT-STORE-INTEGRITY");
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(objectId), ChecksumMode: "ENABLED" }), { abortSignal: signal });
    if (response.ContentLength === undefined || response.ContentLength < 1 || response.ContentLength > this.maxObjectBytes || response.Body === undefined) throw new Error("OCC-AI-OBJECT-STORE-BOUNDS");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) { size += chunk.length; if (size > this.maxObjectBytes || size > response.ContentLength) throw new Error("OCC-AI-OBJECT-STORE-BOUNDS"); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    if (bytes.length !== response.ContentLength || createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error("OCC-AI-OBJECT-STORE-INTEGRITY");
    return bytes;
  }

  async delete(objectId: string, signal: AbortSignal): Promise<void> { await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.key(objectId) }), { abortSignal: signal }); }
}

export class MinioArtifactObjectStore {
  private constructor(private readonly config: Config, private readonly client: Client, private readonly maxObjectBytes: number) {}

  static async create(config: Config): Promise<MinioArtifactObjectStore> {
    const endpoint = new URL(config.endpoint);
    const secure = endpoint.protocol === "https:";
    const localHttp = config.allowInsecureLocalhost === true && endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname);
    if ((!secure && !localHttp) || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
      !/^[a-z0-9][a-z0-9.-]{0,62}$/u.test(config.bucket) || !config.prefix.startsWith("trace/") || config.prefix.startsWith("quarantine/") || !KEY.test(config.prefix)) {
      throw new Error("OCC-AI-OBJECT-STORE-CONFIG");
    }
    const max = config.maxObjectBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(max) || max < 1 || max > 16 * 1024 * 1024) throw new Error("OCC-AI-OBJECT-STORE-CONFIG");
    const [accessKeyId, secretAccessKey] = await Promise.all([credential(config.accessKeyFile), credential(config.secretKeyFile)]);
    const clientConfig: S3ClientConfig = { endpoint: endpoint.origin, forcePathStyle: config.forcePathStyle, region: "us-east-1",
      credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1 };
    return new MinioArtifactObjectStore(config, config.client ?? new S3Client(clientConfig), max);
  }

  private key(objectId: string): string {
    if (!KEY.test(objectId) || objectId.includes("..") || objectId.startsWith("/") || objectId.startsWith("quarantine/")) throw new Error("OCC-AI-OBJECT-STORE-KEY");
    return `${this.config.prefix.replace(/\/+$/u, "")}/${objectId}`;
  }

  async upload(objectId: string, bytes: Uint8Array, expectedHash: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("OCC-AI-CANCELLED");
    if (bytes.length < 1 || bytes.length > this.maxObjectBytes || !HASH.test(expectedHash) || createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error("OCC-AI-OBJECT-STORE-INTEGRITY");
    const checksum = createHash("sha256").update(bytes).digest("base64");
    const Key = this.key(objectId);
    let created = false;
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key, Body: bytes, ContentLength: bytes.length,
        ChecksumSHA256: checksum, ServerSideEncryption: "AES256", IfNoneMatch: "*", ContentType: "application/json" }), { abortSignal: signal });
      created = true;
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key, ChecksumMode: "ENABLED" }), { abortSignal: signal });
      if (head.ContentLength !== bytes.length || head.ChecksumSHA256 !== checksum || head.ServerSideEncryption !== "AES256") throw new Error("OCC-AI-OBJECT-STORE-INTEGRITY");
    } catch (error) {
      const status = typeof error === "object" && error !== null && "$metadata" in error ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode : undefined;
      if (status === 412 || (error instanceof Error && error.name === "PreconditionFailed")) throw new Error("OCC-AI-OBJECT-STORE-CONFLICT");
      if (created) await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key })).catch(() => undefined);
      throw error;
    }
  }
}
