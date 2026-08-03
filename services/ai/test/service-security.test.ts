import { generateKeyPairSync, randomUUID } from "node:crypto";

import { exportSPKI, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { verifyAiGrant } from "../src/security/grant-verifier.js";
import { createPostgresPool, PostgresAiRepository } from "../src/persistence/postgres.js";
import { verifyServiceIdentity } from "../src/security/service-identity.js";
import { loadConfig } from "../src/config.js";
import { readBoundedFile, validateInternalOrigin } from "../src/core/core-client.js";
import { createCompositionRoot } from "../src/composition-root.js";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const now = 1_785_672_000;
const ids = Array.from({ length: 10 }, () => randomUUID());
const digest = (digit: string): string => digit.repeat(64);
const claims = {
  iss: "innorder-core",
  aud: "innorder-ai",
  typ: "ai_authorization_grant",
  jti: ids[0]!,
  eventId: ids[1]!,
  operationId: ids[2]!,
  principalId: ids[3]!,
  targetId: ids[4]!,
  purpose: "PARTICIPANT_GUIDANCE",
  authorizationRevision: 7,
  policyReleaseDigest: digest("1"),
  authorizedSetDigest: digest("2"),
  contextDigest: digest("3"),
  classificationCeiling: "CONFIDENTIAL",
  agentVersionId: ids[5]!,
  modelProfileId: ids[6]!,
  promptVersionId: ids[7]!,
  packageVersionId: ids[8]!,
  embeddingSpaceId: ids[9]!,
  iat: now,
  nbf: now,
  exp: now + 300,
} as const;

async function signingFixture() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const publicKey = await exportSPKI(pair.publicKey);
  const sign = (payload: Record<string, unknown> = claims, kid = "current") =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid })
      .sign(pair.privateKey);
  return { publicKey, sign };
}

describe("AI grant verification", () => {
  it("verifies exact claims and returns the hash used by V015", async () => {
    const fixture = await signingFixture();
    const token = await fixture.sign();

    const verified = await verifyAiGrant(token, {
      keys: [{ kid: "current", publicKey: fixture.publicKey }],
      now: () => now,
      clockSkewSeconds: 20,
    });

    expect(verified.claims).toEqual(claims);
    expect(verified.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
  }, 15_000);

  it.each([
    ["unknown claim", { ...claims, harmless: true }],
    ["wrong audience", { ...claims, aud: "occ-core" }],
    ["excessive lifetime", { ...claims, exp: now + 301 }],
    ["noncanonical digest", { ...claims, contextDigest: digest("A") }],
  ])("rejects %s", async (_name, payload) => {
    const fixture = await signingFixture();
    await expect(
      verifyAiGrant(await fixture.sign(payload), {
        keys: [{ kid: "current", publicKey: fixture.publicKey }],
        now: () => now,
        clockSkewSeconds: 20,
      }),
    ).rejects.toThrow("OCC-AI-GRANT-INVALID");
  });

  it("rejects unknown kid and weak RSA keys", async () => {
    const fixture = await signingFixture();
    await expect(
      verifyAiGrant(await fixture.sign(claims, "unknown"), {
        keys: [{ kid: "current", publicKey: fixture.publicKey }],
        now: () => now,
        clockSkewSeconds: 20,
      }),
    ).rejects.toThrow("OCC-AI-GRANT-INVALID");

    const weak = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(
      verifyAiGrant(await fixture.sign(), {
        keys: [{ kid: "current", publicKey: await exportSPKI(weak.publicKey) }],
        now: () => now,
        clockSkewSeconds: 20,
      }),
    ).rejects.toThrow("OCC-AI-GRANT-INVALID");
  });
});

describe("service route direction", () => {
  it("does not expose an HTTP grant start trigger", async () => {
    const app = buildApp(undefined, { authenticateCore: () => true });
    const response = await app.inject({ method: "POST", url: "/internal/v1/ai/operations/start", payload: { grantToken: "a.b.c" } });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("keeps only health public when business routes are enabled", async () => {
    const config = loadConfig({
      AI_BUSINESS_ENABLED: "true",
      AI_DATABASE_URL: "postgresql://innorder_ai_runtime@ai.internal/innorder",
      AI_DATABASE_PASSWORD_FILE: "/run/secrets/db",
      AI_TLS_KEY_FILE: "/run/secrets/key",
      AI_TLS_CERT_FILES: "/run/secrets/cert",
      AI_TLS_CA_FILES: "/run/secrets/ca",
      AI_REVOKED_SERIALS_FILE: "/run/secrets/revoked",
      AI_GRANT_PUBLIC_KEYS: "current:/run/secrets/grant",
      CORE_INTERNAL_ORIGIN: "https://core.internal",
    });
    const app = buildApp(config, { authenticateCore: () => false });

    const health = await app.inject({ method: "GET", url: "/health" });
    const status = await app.inject({ method: "GET", url: "/api/v1/system/status" });
    const capabilities = await app.inject({ method: "GET", url: "/api/v1/providers/capabilities" });

    expect(health.statusCode).toBe(200);
    expect(status.statusCode).toBe(401);
    expect(capabilities.statusCode).toBe(401);
    await app.close();
  });

  it("allows only Core to query status and cancel through bounded dependencies", async () => {
    const status = vi.fn().mockResolvedValue({ operationId: ids[2], status: "RUNNING" });
    const cancel = vi.fn().mockResolvedValue({ operationId: ids[2], status: "CANCELLED" });
    const app = buildApp(undefined, {
      authenticateCore: (request) => request.headers["x-test-service"] === "core",
      operationStatus: status,
      cancelOperation: cancel,
    });

    const statusResponse = await app.inject({ method: "GET", url: `/internal/v1/ai/operations/${ids[2]}/status`, headers: { "x-test-service": "core" } });
    const cancelResponse = await app.inject({ method: "POST", url: `/internal/v1/ai/operations/${ids[2]}/cancel`, headers: { "x-test-service": "core" } });

    expect(statusResponse.statusCode).toBe(200);
    expect(cancelResponse.statusCode).toBe(200);
    expect(status).toHaveBeenCalledWith(ids[2]);
    expect(cancel).toHaveBeenCalledWith(ids[2]);
    await app.close();
  });
});

describe("PostgreSQL grant consumption", () => {
  it("calls only the V015 function with every signed binding", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ run_id: claims.operationId, authorized_document_version_ids: [], bounded_context: {}, replayed: true }],
    });
    const release = vi.fn();
    const repository = new PostgresAiRepository({ connect: vi.fn().mockResolvedValue({ query, release }), query } as never);

    await expect(repository.consumeGrant({ claims, tokenHash: digest("a") })).resolves.toMatchObject({ replayed: true });

    expect(query).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith();
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toMatch(/^SELECT run_id/u);
    expect(sql).toContain("authz.consume_ai_authorization_grant");
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/iu);
    expect(values).toEqual([
      digest("a"), claims.eventId, claims.operationId, claims.authorizationRevision,
      claims.policyReleaseDigest, claims.authorizedSetDigest, claims.contextDigest,
      claims.operationId, claims.agentVersionId, claims.modelProfileId,
      claims.promptVersionId, claims.packageVersionId, claims.embeddingSpaceId,
    ]);
  });

  it("destroys an in-flight consume session on abort and returns only the stable cancellation", async () => {
    let rejectQuery: ((error: Error) => void) | undefined;
    const query = vi.fn(() => new Promise((_resolve, reject) => { rejectQuery = reject; }));
    const release = vi.fn((destroy?: boolean) => {
      if (destroy) rejectQuery?.(new Error("raw connection termination detail"));
    });
    const database = {
      connect: vi.fn().mockResolvedValue({ query, release }),
      query: vi.fn(() => new Promise(() => undefined)),
    };
    const repository = new PostgresAiRepository(database as never);
    const controller = new AbortController();

    const consume = repository.consumeGrant({ claims, tokenHash: digest("a") }, controller.signal);
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    controller.abort();

    await expect(Promise.race([
      consume,
      new Promise((resolve) => setTimeout(() => resolve("did-not-settle"), 250)),
    ])).rejects.toThrow("OCC-AI-CANCELLED");
    expect(release).toHaveBeenCalledWith(true);
  });

  it("sets bounded server and client timeouts with an identifiable pool application", async () => {
    const pool = createPostgresPool({ max: 2 });
    try {
      expect(pool.options).toMatchObject({
        max: 2,
        statement_timeout: 2_000,
        lock_timeout: 1_000,
        query_timeout: 2_500,
        idle_in_transaction_session_timeout: 2_000,
        application_name: "innorder-ai",
      });
    } finally {
      await pool.end();
    }
  });

  it("reads status and cancels only through the bounded transition function", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ operation_id: ids[2], status: "RUNNING" }] })
      .mockResolvedValueOnce({ rows: [{ status: "CANCELLED" }] });
    const repository = new PostgresAiRepository({ query } as never);

    await expect(repository.operationStatus(ids[2]!)).resolves.toEqual({ operationId: ids[2], status: "RUNNING" });
    await expect(repository.cancelOperation(ids[2]!)).resolves.toEqual({ operationId: ids[2], status: "CANCELLED" });
    expect(query.mock.calls[0]![0]).toContain("ai.get_ai_operation_status");
    expect(query.mock.calls[0]![0]).not.toContain("ai.ai_run");
    expect(query.mock.calls[1]![0]).toContain("ai.transition_ai_run");
    expect(query.mock.calls[1]![0]).not.toMatch(/UPDATE|DELETE|INSERT/iu);
  });
});

describe("mTLS service identity", () => {
  const validPeer = {
    subjectaltname: "URI:spiffe://innorder/core",
    ext_key_usage: ["1.3.6.1.5.5.7.3.2"],
    serialNumber: "01AB",
    valid_from: "Aug  2 11:00:00 2026 GMT",
    valid_to: "Aug  2 13:00:00 2026 GMT",
  };

  it("accepts only the exact Core URI identity with client EKU", () => {
    expect(verifyServiceIdentity(validPeer, true, "spiffe://innorder/core", new Set(), now * 1000)).toBe(true);
    expect(verifyServiceIdentity({ ...validPeer, subjectaltname: "URI:spiffe://innorder/ai" }, true, "spiffe://innorder/core", new Set(), now * 1000)).toBe(false);
    expect(verifyServiceIdentity({ ...validPeer, subjectaltname: undefined, subject: { CN: "spiffe://innorder/core" } }, true, "spiffe://innorder/core", new Set(), now * 1000)).toBe(false);
    expect(verifyServiceIdentity({ ...validPeer, ext_key_usage: ["1.3.6.1.5.5.7.3.1"] }, true, "spiffe://innorder/core", new Set(), now * 1000)).toBe(false);
  });

  it("rejects unauthorized TLS, revocation, expiry, and extra URI SANs", () => {
    expect(verifyServiceIdentity(validPeer, false, "spiffe://innorder/core", new Set(), now * 1000)).toBe(false);
    expect(verifyServiceIdentity(validPeer, true, "spiffe://innorder/core", new Set(["01AB"]), now * 1000)).toBe(false);
    expect(verifyServiceIdentity({ ...validPeer, valid_to: "Aug  2 12:00:00 2026 GMT" }, true, "spiffe://innorder/core", new Set(), now * 1000)).toBe(false);
    expect(verifyServiceIdentity({ ...validPeer, subjectaltname: "URI:spiffe://innorder/core, URI:spiffe://innorder/admin" }, true, "spiffe://innorder/core", new Set(), now * 1000)).toBe(false);
  });
});

describe("strict business configuration", () => {
  it("allows disabled construction but rejects partially configured business security", () => {
    expect(loadConfig({}).businessEnabled).toBe(false);
    expect(() => loadConfig({ AI_BUSINESS_ENABLED: "true" })).toThrow();
    expect(() => loadConfig({ AI_BUSINESS_ENABLED: "yes" })).toThrow();
    expect(() => loadConfig({
      AI_BUSINESS_ENABLED: "true",
      AI_DATABASE_URL: "postgresql://postgres@ai.internal/innorder",
      AI_DATABASE_PASSWORD_FILE: "/run/secrets/db",
      AI_TLS_KEY_FILE: "/run/secrets/key",
      AI_TLS_CERT_FILES: "/run/secrets/cert",
      AI_TLS_CA_FILES: "/run/secrets/ca",
      AI_REVOKED_SERIALS_FILE: "/run/secrets/revoked",
      AI_GRANT_PUBLIC_KEYS: "current:/run/secrets/grant",
      CORE_INTERNAL_ORIGIN: "https://core.internal",
    })).toThrow();
  });
});

describe("bounded internal clients and composition", () => {
  it("accepts only an exact HTTPS origin", () => {
    expect(validateInternalOrigin("https://core.internal:8443").origin).toBe("https://core.internal:8443");
    for (const value of ["http://core.internal", "https://user@core.internal", "https://core.internal/path", "https://core.internal?x=1"]) {
      expect(() => validateInternalOrigin(value)).toThrow("Invalid internal origin");
    }
  });

  it("rejects oversized file-backed secrets without exposing the path", async () => {
    const path = join(tmpdir(), `innorder-secret-${randomUUID()}`);
    await writeFile(path, "x".repeat(65 * 1024));
    try {
      await expect(readBoundedFile(path, 64 * 1024)).rejects.toThrow("Secret material is unavailable or invalid");
    } finally {
      await rm(path, { force: true });
    }
  });

  it("constructs and closes disabled mode without PostgreSQL provider or Kafka", async () => {
    const root = await createCompositionRoot(loadConfig({}));
    expect(root.app).toBeDefined();
    await root.close();
  });

  it("owns a ready parser sidecar when ingestion is enabled and cancels it on close", async () => {
    const rootPath = join(tmpdir(), `innorder-parser-root-${randomUUID()}`);
    const input = join(rootPath, "input"); const requests = join(rootPath, "requests"); const output = join(rootPath, "output");
    await Promise.all([mkdir(input, { recursive: true }), mkdir(requests, { recursive: true }), mkdir(output, { recursive: true })]);
    await writeFile(join(output, ".parser-heartbeat.json"), JSON.stringify({ version: 1, at: Date.now() }));
    try {
      const root = await createCompositionRoot(loadConfig({ AI_INGESTION_ENABLED: "true", AI_PARSER_INPUT_ROOT: input, AI_PARSER_REQUEST_ROOT: requests, AI_PARSER_OUTPUT_ROOT: output }));
      expect(root.parserSidecar).toBeDefined();
      await root.close();
      await expect(root.parserSidecar!.parse({ bytes: Buffer.from("after close"), fileName: "closed.txt", mimeType: "text/plain" }, new AbortController().signal)).rejects.toThrow("OCC-AI-PARSER-CANCELLED");
    } finally { await rm(rootPath, { recursive: true, force: true }); }
  });
});
