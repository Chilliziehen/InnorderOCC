import type { Pool, PoolConfig, QueryResult } from "pg";
import pg from "pg";

import type { VerifiedAiGrant } from "../security/grant-verifier.js";

export interface ConsumedGrant {
  runId: string;
  authorizedDocumentVersionIds: string[];
  boundedContext: Record<string, unknown>;
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

export class PostgresAiRepository {
  constructor(private readonly database: Queryable) {}

  async consumeGrant(grant: VerifiedAiGrant, signal?: AbortSignal): Promise<ConsumedGrant> {
    try {
      if (signal?.aborted) throw new Error("cancelled");
      const c = grant.claims;
      const result = await this.database.query(
        "SELECT run_id, authorized_document_version_ids, bounded_context FROM authz.consume_ai_authorization_grant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [grant.tokenHash, c.eventId, c.operationId, c.authorizationRevision, c.policyReleaseDigest,
          c.authorizedSetDigest, c.contextDigest, c.operationId, c.agentVersionId, c.modelProfileId,
          c.promptVersionId, c.packageVersionId],
      );
      if (result.rows.length !== 1) throw new Error("invalid result");
      const row = result.rows[0] as Record<string, unknown>;
      return {
        runId: String(row.run_id),
        authorizedDocumentVersionIds: row.authorized_document_version_ids as string[],
        boundedContext: row.bounded_context as Record<string, unknown>,
      };
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code === "55000") throw new Error("OCC-AI-GRANT-REPLAY");
      if (code === "28000") throw new Error("OCC-AI-GRANT-STALE-OR-EXPIRED");
      throw new Error(signal?.aborted ? "OCC-AI-CANCELLED" : "OCC-AI-DATABASE-UNAVAILABLE");
    }
  }

  async operationStatus(operationId: string): Promise<{ operationId: string; status: string }> {
    try {
      const result = await this.database.query("SELECT id, status FROM ai.ai_run WHERE id = $1", [operationId]);
      if (result.rows.length !== 1) throw new Error();
      return { operationId: String(result.rows[0]!.id), status: String(result.rows[0]!.status) };
    } catch { throw new Error("OCC-AI-OPERATION-NOT-AVAILABLE"); }
  }

  async cancelOperation(operationId: string): Promise<{ operationId: string; status: string }> {
    try {
      const result = await this.database.query("SELECT ai.transition_ai_run($1, 'CANCELLED') AS status", [operationId]);
      if (result.rows.length !== 1 || result.rows[0]!.status !== "CANCELLED") throw new Error();
      return { operationId, status: "CANCELLED" };
    } catch { throw new Error("OCC-AI-OPERATION-NOT-CANCELLABLE"); }
  }
}

export function createPostgresPool(config: PoolConfig): Pool {
  if ((config.max ?? 10) < 1 || (config.max ?? 10) > 32) throw new Error("Invalid database pool size");
  return new pg.Pool({ max: 10, connectionTimeoutMillis: 1500, idleTimeoutMillis: 30_000, ...config });
}
