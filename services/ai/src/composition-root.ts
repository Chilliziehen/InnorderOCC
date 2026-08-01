import type { TLSSocket } from "node:tls";

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { buildApp } from "./app.js";
import type { ServiceConfig } from "./config.js";
import { CoreClient, readBoundedFile } from "./core/core-client.js";
import { GrantConsumer } from "./core/grant-consumer.js";
import { createPostgresPool, PostgresAiRepository } from "./persistence/postgres.js";
import { parseRevokedSerials, verifyServiceIdentity } from "./security/service-identity.js";

export interface CompositionRoot {
  app: FastifyInstance;
  grantConsumer?: GrantConsumer;
  close(): Promise<void>;
}

export async function createCompositionRoot(config: ServiceConfig): Promise<CompositionRoot> {
  if (!config.businessEnabled) {
    const app = buildApp(config);
    return { app, close: async () => app.close() };
  }

  const [key, certificates, cas, passwordBytes, revokedBytes, grantKeys] = await Promise.all([
    readBoundedFile(config.tlsKeyFile!),
    Promise.all(config.tlsCertificateFiles!.map((path) => readBoundedFile(path))),
    Promise.all(config.tlsCaFiles!.map((path) => readBoundedFile(path))),
    readBoundedFile(config.databasePasswordFile!, 4096),
    readBoundedFile(config.revokedSerialsFile!),
    Promise.all(config.grantKeys!.map(async ({ kid, file }) => ({ kid, publicKey: (await readBoundedFile(file)).toString("ascii") }))),
  ]);
  const password = passwordBytes.toString("utf8").trim();
  if (password.length === 0 || password.includes("\n") || password.includes("\r")) throw new Error("Secret material is unavailable or invalid");
  const revoked = parseRevokedSerials(revokedBytes.toString("ascii"));
  const pool: Pool = createPostgresPool({
    connectionString: config.databaseUrl, password, max: config.databasePoolSize,
    ssl: { key, cert: Buffer.concat(certificates), ca: cas, rejectUnauthorized: true },
  });
  const repository = new PostgresAiRepository(pool);
  const grantConsumer = new GrantConsumer({ keys: grantKeys }, repository);
  const core = new CoreClient({ origin: config.coreOrigin!, key, cert: certificates, ca: cas, revokedSerials: revoked });
  const app = buildApp(config, {
    https: { key, cert: certificates, ca: cas, requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3" },
    authenticateCore: (request) => {
      const socket = request.raw.socket as TLSSocket;
      return verifyServiceIdentity(socket.getPeerCertificate(), socket.authorized, "spiffe://innorder/core", revoked);
    },
    operationStatus: (operationId) => repository.operationStatus(operationId),
    cancelOperation: (operationId) => repository.cancelOperation(operationId),
  });
  let resourcesClosed = false;
  app.addHook("onClose", async () => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    core.close();
    await pool.end();
  });
  return { app, grantConsumer, close: async () => app.close() };
}
