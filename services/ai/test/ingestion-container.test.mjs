import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CreateBucketCommand, DeleteObjectCommand, GetObjectRetentionCommand, HeadObjectCommand, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";

import { IngestionWorker } from "../dist/ingestion/ingestion-worker.js";
import { ClamdMalwareScanner } from "../dist/ingestion/malware-scanner.js";
import { MinioArtifactObjectStore, MinioQuarantineObjectStore } from "../dist/object-store/minio-object-store.js";

const MINIO_IMAGE = "minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e";
const CLAMAV_IMAGE = "clamav/clamav@sha256:efc48bad8b67f30867b4e6f198324d2097a6b6d5f22aedaf70f4e634fe0504da";
const docker = (args, options = {}) => spawnSync("docker", args, { encoding: "utf8", timeout: 180_000, ...options });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function mappedPort(container, port) {
  const result = docker(["port", container, `${port}/tcp`]);
  assert.equal(result.status, 0, result.stderr);
  const match = /:(\d+)\s*$/u.exec(result.stdout.trim().split(/\r?\n/u)[0]);
  assert.ok(match, result.stdout);
  return Number(match[1]);
}

async function waitHttp(url, container) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return; } catch { /* continue */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`MinIO did not become ready: ${docker(["logs", container]).stderr}`);
}

async function waitTcp(port, container) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolvePromise) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
      socket.once("error", () => resolvePromise(false));
    });
    if (ready) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  const logs = docker(["logs", container]);
  throw new Error(`clamd did not become ready: ${logs.stdout}${logs.stderr}`);
}

async function eventually(action, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await action(); } catch (error) { lastError = error; await new Promise((resolvePromise) => setTimeout(resolvePromise, 250)); }
  }
  throw lastError;
}

async function stage(name, action) {
  try { return await action(); } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : "failed"}`, { cause: error }); }
}

test("pinned MinIO quarantine and official clamd fail closed end to end", { timeout: 300_000 }, async () => {
  const suffix = randomUUID(); const minio = `innorder-minio-${suffix}`; const clamav = `innorder-clamav-${suffix}`;
  const credentials = await mkdtemp(join(tmpdir(), "innorder-ingestion-container-"));
  const rootAccess = "innorderroot"; const rootSecret = "root-secret-at-least-32-bytes";
  const appAccess = "ingestion-app"; const appSecret = "app-secret-at-least-32-bytes";
  const bucket = "knowledge-quarantine"; const prefix = "quarantine/integration";
  await writeFile(join(credentials, "access"), appAccess); await writeFile(join(credentials, "secret"), appSecret);
    await writeFile(join(credentials, "app-policy.json"), JSON.stringify({ Version: "2012-10-17", Statement: [
      { Effect: "Allow", Action: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], Resource: [`arn:aws:s3:::${bucket}/${prefix}/*`] },
      { Effect: "Allow", Action: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:GetObjectRetention"], Resource: [`arn:aws:s3:::${bucket}/trace/integration/*`] },
    ] }));
  await writeFile(join(credentials, "local.ndb"), await readFile(new URL("./fixtures/ingestion/sources/local.ndb", import.meta.url)));
  try {
    const minioRun = docker(["run", "--detach", "--name", minio, "--publish", "127.0.0.1::9000",
      "--env", `MINIO_ROOT_USER=${rootAccess}`, "--env", `MINIO_ROOT_PASSWORD=${rootSecret}`,
      "--env", "MINIO_KMS_SECRET_KEY=integration-key:MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
      "--mount", `type=bind,src=${credentials},dst=/config,readonly`,
      MINIO_IMAGE, "server", "/data"]);
    assert.equal(minioRun.status, 0, minioRun.stderr);
    const minioPort = mappedPort(minio, 9000); const endpoint = `http://127.0.0.1:${minioPort}`;
    await waitHttp(`${endpoint}/minio/health/ready`, minio);
    const rootClient = new S3Client({ endpoint, forcePathStyle: true, region: "us-east-1", credentials: { accessKeyId: rootAccess, secretAccessKey: rootSecret }, maxAttempts: 1 });
    await eventually(() => rootClient.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true })));
    await eventually(() => rootClient.send(new CreateBucketCommand({ Bucket: "other-quarantine" })));
    const mc = (args) => docker(["exec", minio, "mc", ...args]);
    assert.equal(mc(["alias", "set", "local", "http://127.0.0.1:9000", rootAccess, rootSecret]).status, 0);
    assert.equal(mc(["admin", "user", "add", "local", appAccess, appSecret]).status, 0);
    assert.equal(mc(["admin", "policy", "create", "local", "ingestion-quarantine", "/config/app-policy.json"]).status, 0);
    assert.equal(mc(["admin", "policy", "attach", "local", "ingestion-quarantine", "--user", appAccess]).status, 0);
    const appClient = new S3Client({ endpoint, forcePathStyle: true, region: "us-east-1", credentials: { accessKeyId: appAccess, secretAccessKey: appSecret }, maxAttempts: 1 });
    const store = await MinioQuarantineObjectStore.create({ endpoint, bucket, prefix, accessKeyFile: join(credentials, "access"), secretKeyFile: join(credentials, "secret"), forcePathStyle: true, allowInsecureLocalhost: true });
    const body = Buffer.from("private governed upload");
    await stage("golden upload", () => store.upload("golden", body, sha256(body), new AbortController().signal));
    assert.deepEqual(await stage("golden read", () => store.readObject("golden", sha256(body), new AbortController().signal)), body);
    await assert.rejects(store.upload("golden", body, sha256(body), new AbortController().signal), /OCC-AI-OBJECT-STORE-CONFLICT/u);
    const key = "quarantine/integration/golden";
    const head = await stage("golden head", () => appClient.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" })));
    assert.equal(head.ContentLength, body.length); assert.equal(head.ServerSideEncryption, "AES256");
    assert.equal(head.ChecksumSHA256, createHash("sha256").update(body).digest("base64"));
    await assert.rejects(appClient.send(new PutObjectCommand({ Bucket: bucket, Key: "quarantine/other/denied", Body: body })));
    await assert.rejects(appClient.send(new PutObjectCommand({ Bucket: "other-quarantine", Key: `${prefix}/denied`, Body: body })));
    await assert.rejects(appClient.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix })));
    await assert.rejects(appClient.send(new ListBucketsCommand({})));
    await assert.rejects(fetch(`${endpoint}/${bucket}/${key}`).then(async (response) => { assert.notEqual(response.status, 200); throw new Error("private"); }), /private/u);
    await store.delete("golden", new AbortController().signal);
    await assert.rejects(appClient.send(new HeadObjectCommand({ Bucket: bucket, Key: key })));
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(store.upload("aborted", body, sha256(body), aborted.signal));
    await assert.rejects(appClient.send(new HeadObjectCommand({ Bucket: bucket, Key: "quarantine/integration/aborted" })));

    const artifactStore = await MinioArtifactObjectStore.create({ endpoint, bucket, prefix: "trace/integration",
      accessKeyFile: join(credentials, "access"), secretKeyFile: join(credentials, "secret"), forcePathStyle: true, allowInsecureLocalhost: true });
    const artifactBody = Buffer.from('{"generatedContent":true}');
    await stage("artifact upload", () => artifactStore.upload("run/artifact.json", artifactBody, sha256(artifactBody), new AbortController().signal));
    const artifactKey = "trace/integration/run/artifact.json";
    const artifactHead = await stage("artifact head", () => appClient.send(new HeadObjectCommand({ Bucket: bucket, Key: artifactKey, ChecksumMode: "ENABLED" })));
    assert.equal(artifactHead.ObjectLockMode, "GOVERNANCE");
    assert.equal(typeof artifactHead.VersionId, "string");
    assert.ok(artifactHead.ObjectLockRetainUntilDate instanceof Date);
    assert.ok(artifactHead.ObjectLockRetainUntilDate.getTime() > Date.now() + 364 * 24 * 60 * 60 * 1000);
    const retention = await stage("artifact retention", () => appClient.send(new GetObjectRetentionCommand({ Bucket: bucket, Key: artifactKey })));
    assert.equal(retention.Retention?.Mode, "GOVERNANCE");
    assert.ok(retention.Retention?.RetainUntilDate instanceof Date);
    await assert.rejects(appClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: artifactKey, VersionId: artifactHead.VersionId })));
    assert.equal((await stage("artifact retained head", () => appClient.send(new HeadObjectCommand({ Bucket: bucket, Key: artifactKey })))).VersionId, artifactHead.VersionId);

    const clamRun = docker(["run", "--detach", "--name", clamav, "--publish", "127.0.0.1::3310",
      "--mount", `type=bind,src=${join(credentials, "local.ndb")},dst=/var/lib/clamav/local.ndb,readonly`,
      "--entrypoint", "clamd", CLAMAV_IMAGE, "--foreground"]);
    assert.equal(clamRun.status, 0, clamRun.stderr);
    const clamPort = mappedPort(clamav, 3310); await waitTcp(clamPort, clamav);
    const localSignatureEvidence = { version: "local-eicar-1", updatedAt: new Date("2026-08-02T02:00:00Z") };
    const scanner = new ClamdMalwareScanner({ host: "127.0.0.1", port: clamPort, maxSignatureAgeMs: 10 * 365 * 24 * 60 * 60 * 1000, localSignatureEvidence });
    try { await eventually(() => scanner.scan(Buffer.from("clean integration payload"), new AbortController().signal), 120_000); }
    catch (error) { const logs = docker(["logs", clamav]); throw new Error(`${error instanceof Error ? error.message : error}\n${logs.stdout}${logs.stderr}`); }
    const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
    async function ingest(candidateScanner, fileName, mimeType, source) {
      let parserCalls = 0;
      const failures = [];
      const repository = {
        claim: async () => [{ id: randomUUID(), stage: "FETCH", checkpoint: {}, sourceObjectHash: sha256(source), normalizedContentHash: sha256("normalized"), candidateEmbeddingSpaceId: randomUUID(), corpusManifestDigest: sha256("manifest"), fileName, mimeType }],
        heartbeat: async () => undefined, checkpoint: async () => undefined, persistDocument: async () => undefined,
        persistChunkEmbedding: async () => undefined, persistEmbeddingBatch: async () => undefined, finalize: async () => undefined,
        fail: async (_id, _worker, code) => { failures.push(code); },
      };
      const worker = new IngestionWorker({ workerId: "integration-worker", repository,
        objectStore: { readObject: async () => source, upload: async () => undefined }, scanner: candidateScanner,
        parser: { parse: async () => { parserCalls += 1; return { text: "normalized", regions: [{ start: 0, end: 10, source: "fixture", injectionMarked: false }], parserVersion: "governed-parser-v1" }; } },
        chunker: { version: "governed-chunker-v2", chunk: () => [{ ordinal: 0, content: "normalized", contentHash: sha256("normalized"), tokenCount: 3, metadata: {} }] },
        embedder: { dimensions: 2, maxBatchSize: 1, embed: async () => [[0.1, 0.2]] },
      });
      await worker.runOnce(new AbortController().signal);
      return { parserCalls, failures };
    }
    for (const [format, fileName, mimeType] of [
      ["text", "eicar.txt", "text/plain"], ["markdown", "eicar.md", "text/markdown"], ["pdf", "eicar.pdf", "application/pdf"],
      ["docx", "eicar.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["xlsx", "eicar.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ]) {
      const result = await ingest(scanner, fileName, mimeType, eicar);
      assert.equal(result.parserCalls, 0, `${format}-malware-before-parse`);
      assert.deepEqual(result.failures, ["OCC-AI-INGESTION-MALWARE"], `${format}-malware-before-parse`);
    }
    assert.equal((await ingest(scanner, "clean.txt", "text/plain", Buffer.from("clean integration payload"))).parserCalls, 1, "clean-parser-after-scan");
    const stale = new ClamdMalwareScanner({ host: "127.0.0.1", port: clamPort, maxSignatureAgeMs: 1, now: () => new Date("2035-01-01T00:00:00Z"), localSignatureEvidence });
    assert.equal((await ingest(stale, "stale.txt", "text/plain", body)).parserCalls, 0, "stale-signatures-before-parse");
    assert.equal(docker(["stop", "--time", "1", clamav]).status, 0);
    assert.equal((await ingest(scanner, "unavailable.txt", "text/plain", body)).parserCalls, 0, "unavailable-clamd-before-parse");
    appClient.destroy(); rootClient.destroy();
  } finally {
    docker(["rm", "--force", minio]); docker(["rm", "--force", clamav]);
    await rm(credentials, { recursive: true, force: true });
  }
});
