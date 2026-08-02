import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CreateBucketCommand, GetBucketPolicyCommand, GetObjectAclCommand, HeadObjectCommand,
  ListObjectsV2Command, S3Client,
} from "@aws-sdk/client-s3";

import { ClamdMalwareScanner } from "../dist/ingestion/malware-scanner.js";
import { MinioQuarantineObjectStore } from "../dist/object-store/minio-object-store.js";

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

test("pinned MinIO quarantine and official clamd fail closed end to end", { timeout: 300_000 }, async () => {
  const suffix = randomUUID(); const minio = `innorder-minio-${suffix}`; const clamav = `innorder-clamav-${suffix}`;
  const credentials = await mkdtemp(join(tmpdir(), "innorder-ingestion-container-"));
  const access = "innorderintegration"; const secret = "integration-secret-at-least-32-bytes";
  await writeFile(join(credentials, "access"), access); await writeFile(join(credentials, "secret"), secret);
  try {
    const minioRun = docker(["run", "--detach", "--name", minio, "--publish", "127.0.0.1::9000",
      "--env", `MINIO_ROOT_USER=${access}`, "--env", `MINIO_ROOT_PASSWORD=${secret}`,
      "--env", "MINIO_KMS_SECRET_KEY=integration-key:MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
      MINIO_IMAGE, "server", "/data"]);
    assert.equal(minioRun.status, 0, minioRun.stderr);
    const minioPort = mappedPort(minio, 9000); const endpoint = `http://127.0.0.1:${minioPort}`;
    await waitHttp(`${endpoint}/minio/health/ready`, minio);
    const client = new S3Client({ endpoint, forcePathStyle: true, region: "us-east-1", credentials: { accessKeyId: access, secretAccessKey: secret }, maxAttempts: 1 });
    const bucket = "knowledge-quarantine";
    await eventually(() => client.send(new CreateBucketCommand({ Bucket: bucket })));
    const store = await MinioQuarantineObjectStore.create({ endpoint, bucket, prefix: "quarantine/integration", accessKeyFile: join(credentials, "access"), secretKeyFile: join(credentials, "secret"), forcePathStyle: true, allowInsecureLocalhost: true });
    const body = Buffer.from("private governed upload");
    await store.upload("golden", body, sha256(body), new AbortController().signal);
    await assert.rejects(store.upload("golden", body, sha256(body), new AbortController().signal), /OCC-AI-OBJECT-STORE-CONFLICT/u);
    const key = "quarantine/integration/golden";
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }));
    assert.equal(head.ContentLength, body.length); assert.equal(head.ServerSideEncryption, "AES256");
    assert.equal(head.ChecksumSHA256, createHash("sha256").update(body).digest("base64"));
    const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "quarantine/" }));
    assert.deepEqual(listed.Contents?.map(({ Key }) => Key), [key]);
    const acl = await client.send(new GetObjectAclCommand({ Bucket: bucket, Key: key }));
    assert.equal(acl.Grants?.some(({ Permission }) => Permission === "READ" || Permission === "WRITE"), false);
    await assert.rejects(client.send(new GetBucketPolicyCommand({ Bucket: bucket })), /policy|NoSuch/iu);
    await assert.rejects(fetch(`${endpoint}/${bucket}/${key}`).then(async (response) => { assert.notEqual(response.status, 200); throw new Error("private"); }), /private/u);
    await store.delete("golden", new AbortController().signal);
    await assert.rejects(client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })));
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(store.upload("aborted", body, sha256(body), aborted.signal));
    await assert.rejects(client.send(new HeadObjectCommand({ Bucket: bucket, Key: "quarantine/integration/aborted" })));

    const clamRun = docker(["run", "--detach", "--name", clamav, "--publish", "127.0.0.1::3310", "--env", "CLAMAV_NO_FRESHCLAMD=true", CLAMAV_IMAGE]);
    assert.equal(clamRun.status, 0, clamRun.stderr);
    const clamPort = mappedPort(clamav, 3310); await waitTcp(clamPort, clamav);
    const scanner = new ClamdMalwareScanner({ host: "127.0.0.1", port: clamPort, maxSignatureAgeMs: 10 * 365 * 24 * 60 * 60 * 1000 });
    try { await eventually(() => scanner.scan(Buffer.from("clean integration payload"), new AbortController().signal), 120_000); }
    catch (error) { const logs = docker(["logs", clamav]); throw new Error(`${error instanceof Error ? error.message : error}\n${logs.stdout}${logs.stderr}`); }
    const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
    await assert.rejects(scanner.scan(eicar, new AbortController().signal), /OCC-AI-MALWARE-FOUND/u);
    let parserCalled = false;
    const stale = new ClamdMalwareScanner({ host: "127.0.0.1", port: clamPort, maxSignatureAgeMs: 1, now: () => new Date("2035-01-01T00:00:00Z") });
    await assert.rejects(stale.scan(body, new AbortController().signal), /OCC-AI-MALWARE-SIGNATURE-STALE/u);
    assert.equal(parserCalled, false);
    assert.equal(docker(["stop", "--time", "1", clamav]).status, 0);
    await assert.rejects(scanner.scan(body, new AbortController().signal), /OCC-AI-MALWARE-UNAVAILABLE/u);
    assert.equal(parserCalled, false);
    client.destroy();
  } finally {
    docker(["rm", "--force", minio]); docker(["rm", "--force", clamav]);
    await rm(credentials, { recursive: true, force: true });
  }
});
