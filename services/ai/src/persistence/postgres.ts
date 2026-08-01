import type { Pool, PoolConfig, QueryResult } from "pg";
import pg from "pg";

import type { VerifiedAiGrant } from "../security/grant-verifier.js";

export interface ConsumedGrant {
  runId: string;
  authorizedDocumentVersionIds: string[];
  boundedContext: Record<string, unknown>;
  replayed: boolean;
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

interface ReleasableQueryable extends Queryable {
  release(destroy?: boolean): void;
}

interface AiDatabase extends Queryable {
  connect(): Promise<ReleasableQueryable>;
}

export class PostgresAiRepository {
  constructor(private readonly database: AiDatabase) {}

  async consumeGrant(grant: VerifiedAiGrant, signal?: AbortSignal): Promise<ConsumedGrant> {
    let client: ReleasableQueryable | undefined;
    let destroyed = false;
    const abort = (): void => {
      if (client === undefined || destroyed) return;
      destroyed = true;
      client.release(true);
    };
    try {
      if (signal?.aborted) throw new Error("cancelled");
      client = await this.database.connect();
      if (signal?.aborted) {
        abort();
        throw new Error("cancelled");
      }
      signal?.addEventListener("abort", abort, { once: true });
      const c = grant.claims;
      const result = await client.query(
        "SELECT run_id, authorized_document_version_ids, bounded_context, replayed FROM authz.consume_ai_authorization_grant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [grant.tokenHash, c.eventId, c.operationId, c.authorizationRevision, c.policyReleaseDigest,
          c.authorizedSetDigest, c.contextDigest, c.operationId, c.agentVersionId, c.modelProfileId,
          c.promptVersionId, c.packageVersionId, c.embeddingSpaceId],
      );
      if (result.rows.length !== 1) throw new Error("invalid result");
      const row = result.rows[0] as Record<string, unknown>;
      return {
        runId: String(row.run_id),
        authorizedDocumentVersionIds: row.authorized_document_version_ids as string[],
        boundedContext: row.bounded_context as Record<string, unknown>,
        replayed: row.replayed === true,
      };
    } catch (error) {
      if (signal?.aborted) throw new Error("OCC-AI-CANCELLED");
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code === "55000") throw new Error("OCC-AI-GRANT-REPLAY");
      if (code === "28000") throw new Error("OCC-AI-GRANT-STALE-OR-EXPIRED");
      throw new Error("OCC-AI-DATABASE-UNAVAILABLE");
    } finally {
      signal?.removeEventListener("abort", abort);
      if (client !== undefined && !destroyed) client.release();
    }
  }

  async operationStatus(operationId: string): Promise<{ operationId: string; status: string }> {
    try {
      const result = await this.database.query("SELECT operation_id, status FROM ai.get_ai_operation_status($1)", [operationId]);
      if (result.rows.length !== 1) throw new Error();
      return { operationId: String(result.rows[0]!.operation_id), status: String(result.rows[0]!.status) };
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
  return new pg.Pool({
    ...config,
    max: config.max ?? 10,
    connectionTimeoutMillis: 1_500,
    idleTimeoutMillis: 30_000,
    statement_timeout: 2_000,
    lock_timeout: 1_000,
    query_timeout: 2_500,
    idle_in_transaction_session_timeout: 2_000,
    application_name: "innorder-ai",
  });
}
