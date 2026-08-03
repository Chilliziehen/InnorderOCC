import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import type { TLSSocket } from "node:tls";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig, type ServiceConfig } from "../src/config.js";
import { verifyServiceIdentity } from "../src/security/service-identity.js";

const fixtureRoot = resolve("../../test-fixtures/service-tls");
const fixture = (name: string): Buffer => readFileSync(resolve(fixtureRoot, name));
const apps: FastifyInstance[] = [];

interface ClientIdentity { cert: Buffer; key: Buffer }

async function request(port: number, identity?: ClientIdentity, authorization?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, reject) => {
    const req = httpsRequest({
      host: "127.0.0.1",
      port,
      path: "/api/v1/system/status",
      method: "GET",
      ca: fixture("current-ca.cert.pem"),
      cert: identity?.cert,
      key: identity?.key,
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      headers: authorization === undefined ? undefined : { authorization },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolveRequest({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end();
  });
}

function identity(name: string): ClientIdentity {
  return { cert: fixture(`${name}.cert.pem`), key: fixture(`${name}.key.pem`) };
}

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("AI HTTPS service identity", () => {
  it("requires a verified Core certificate on every business route", async () => {
    const revoked = new Set(["BB55"]);
    const config = { ...loadConfig({}), businessEnabled: true } as ServiceConfig;
    const app = buildApp(config, {
      https: {
        key: fixture("ai-server.key.pem"),
        cert: fixture("ai-server.cert.pem"),
        ca: fixture("trust-bundle.cert.pem"),
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
      },
      authenticateCore: (incoming) => {
        const socket = incoming.raw.socket as TLSSocket;
        return verifyServiceIdentity(socket.getPeerCertificate(), socket.authorized, "spiffe://innorder/core", revoked);
      },
    });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("test listener unavailable");

    await expect(request(address.port, identity("core-client"))).resolves.toMatchObject({ status: 200 });
    await expect(request(address.port, identity("core-client-next"))).resolves.toMatchObject({ status: 200 });
    const missing = await request(address.port);
    const wrongSan = await request(address.port, identity("core-client-wrong-san"));
    const revokedResponse = await request(address.port, identity("core-client-revoked"));
    const wrongIssuer = await request(address.port, identity("core-client-wrong-issuer"));
    const bearer = await request(address.port, identity("core-client"), "Bearer end-user-secret");

    expect([missing.status, wrongSan.status, revokedResponse.status, wrongIssuer.status]).toEqual([401, 401, 401, 401]);
    expect(bearer.status).toBe(400);
    const captured = [missing.body, wrongSan.body, revokedResponse.body, wrongIssuer.body, bearer.body].join("\n");
    expect(captured).not.toMatch(/PRIVATE KEY|end-user-secret|service-tls/iu);
  }, 30_000);
});
