import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import pg from "pg";
import { describe, expect, it } from "vitest";

import { createPostgresPool, PostgresAiRepository } from "../src/persistence/postgres.js";

const docker = process.env.DOCKER_PATH ?? (process.platform === "win32" ? "docker.exe" : "docker");
const image = process.env.PGVECTOR_TEST_IMAGE ?? "pgvector/pgvector:pg16";
const migrations = [
  "V001__bootstrap.sql", "V002__catalog.sql", "V003__identity_and_entities.sql",
  "V004__policy_control_plane.sql", "V005__occ_runtime.sql", "V006__audit_and_outbox.sql",
  "V007__ai_rag.sql", "V008__cross_schema_constraints.sql", "V009__runtime_privileges.sql",
  "V010__platform_security_kernel.sql", "V011__account_failed_attempt_window.sql",
  "V012__outbox_publisher_lifecycle.sql", "V016__governed_ai_runtime.sql",
];

function dockerSync(args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(docker, args, { encoding: "utf8", windowsHide: true, ...options });
}

function fixtureSql(prefix: string): { sql: string; ids: Record<string, string>; revisionQuery: string } {
  const id = (suffix: string): string => `${prefix}-0000-7000-8000-${suffix}`;
  const ids = {
    package: id("000000000002"), principal: id("000000000005"), provider: id("000000000006"),
    model: id("000000000008"), space: id("000000000009"), prompt: id("000000000010"),
    agent: id("000000000012"), target: id("000000000015"), release: id("000000000019"),
    grant: id("000000000020"), event: id("000000000025"), run: id("000000000030"),
  };
  return { ids, revisionQuery: "SELECT current_revision FROM authz.authorization_state WHERE singleton", sql: `
    INSERT INTO catalog.domain_package (id, package_key, name, status)
    VALUES ('${id("000000000001")}', 'abort.${prefix}', 'Abort test', 'ACTIVE');
    INSERT INTO catalog.package_version (id, package_id, semver, status, manifest)
    VALUES ('${ids.package}', '${id("000000000001")}', '1.0.0', 'DRAFT', '{}');
    INSERT INTO catalog.entity_type (id, package_id, type_key, name, entity_kind, authorizable) VALUES
      ('${id("000000000003")}', '${id("000000000001")}', 'principal_${prefix}', 'Principal', 'PRINCIPAL', true),
      ('${id("000000000023")}', '${id("000000000001")}', 'resource_${prefix}', 'Resource', 'RESOURCE', true);
    INSERT INTO catalog.entity_type_version
      (id, entity_type_id, package_version_id, schema_version, json_schema, ui_schema, auth_schema, index_spec) VALUES
      ('${id("000000000004")}', '${id("000000000003")}', '${ids.package}', 1, '{}', '{}', '{}', '{}'),
      ('${id("000000000024")}', '${id("000000000023")}', '${ids.package}', 1, '{}', '{}', '{}', '{}');
    INSERT INTO authz.entity (id, entity_type_id, entity_type_version_id, entity_key, state, auth_attributes) VALUES
      ('${ids.principal}', '${id("000000000003")}', '${id("000000000004")}', 'principal:${prefix}', 'ACTIVE', '{}'),
      ('${ids.provider}', '${id("000000000023")}', '${id("000000000024")}', 'provider:${prefix}', 'ACTIVE', '{}'),
      ('${ids.target}', '${id("000000000023")}', '${id("000000000024")}', 'target:${prefix}', 'ACTIVE', '{}');
    INSERT INTO iam.principal (id, principal_kind, display_name, status, profile)
    VALUES ('${ids.principal}', 'SERVICE', 'Abort test', 'ACTIVE', '{}');
    INSERT INTO authz.policy_release (id, release_number, status, content_hash)
    VALUES ('${ids.release}', 1, 'STAGED', repeat('d', 64));
    INSERT INTO ai.model_provider (id, provider_type, base_url, secret_ref, capabilities, data_policy, state)
    VALUES ('${ids.provider}', 'TEST', 'https://invalid.test', 'test-secret', '{}', '{}', 'ACTIVE');
    INSERT INTO ai.model_profile
      (id, provider_id, model_key, purpose, parameters, capability_snapshot, timeout_ms, rate_limit, cost_rule, state)
    VALUES ('${ids.model}', '${ids.provider}', 'test-model', 'EMBEDDING', '{}', '{}', 1000, '{}', '{}', 'ACTIVE');
    INSERT INTO ai.embedding_space
      (id, model_profile_id, dimensions, distance_metric, corpus_version, status, coverage, activated_at)
    VALUES ('${ids.space}', '${ids.model}', 3, 'COSINE', repeat('0', 64), 'ACTIVE', 1, now());
    INSERT INTO ai.prompt_template (id, prompt_key, name)
    VALUES ('${id("00000000000a")}', 'abort.${prefix}', 'Abort prompt');
    INSERT INTO ai.prompt_template_version
      (id, prompt_template_id, version, template, variable_schema, content_hash, status, created_by)
    VALUES ('${ids.prompt}', '${id("00000000000a")}', 1, 'test', '{}', repeat('e', 64), 'DRAFT', '${ids.principal}');
    INSERT INTO ai.agent_definition (id, agent_key, name)
    VALUES ('${id("00000000000b")}', 'abort.${prefix}', 'Abort agent');
    INSERT INTO ai.agent_definition_version
      (id, agent_definition_id, package_version_id, input_schema, output_schema, prompt_version_id, content_hash)
    VALUES ('${ids.agent}', '${id("00000000000b")}', '${ids.package}', '{}', '{}', '${ids.prompt}', repeat('f', 64));
    INSERT INTO authz.ai_authorization_grant
      (id, token_hash, signer_kid, operation, jti, principal_id, target_entity_id, purpose,
       authorization_revision, policy_release_id, policy_release_digest, authorized_set_digest,
       context_digest, bounded_context, classification_ceiling, agent_version_id, model_profile_id,
       prompt_version_id, package_version_id, embedding_space_id, issued_at, expires_at, event_id, intended_run_id)
    SELECT '${ids.grant}', repeat('a',64), 'test-current', 'RETRIEVE', 'jti-abort-${prefix}',
      '${ids.principal}', '${ids.target}', 'answer', current_revision, '${ids.release}', repeat('d',64),
      repeat('6',64), repeat('7',64), '{"scope":"abort"}', 'PUBLIC', '${ids.agent}', '${ids.model}',
      '${ids.prompt}', '${ids.package}', '${ids.space}', now(), now() + interval '5 minutes', '${ids.event}', '${ids.run}'
    FROM authz.authorization_state WHERE singleton;
  ` };
}

async function deadline<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("real PostgreSQL grant cancellation", () => {
  it("aborts a lock-blocked consume, rolls back, and closes the pool promptly", async () => {
    const container = `innorder-ai-abort-${randomUUID()}`;
    const adminPassword = `admin-${randomUUID()}`;
    const aiPassword = `ai-${randomUUID()}`;
    let pool: pg.Pool | undefined;
    let admin: pg.Client | undefined;
    let locker: pg.Client | undefined;
    try {
      expect(dockerSync(["info", "--format", "{{.ServerVersion}}"]), "Docker is required").toMatchObject({ status: 0 });
      const started = dockerSync([
        "run", "--detach", "--name", container, "--publish", "127.0.0.1::5432",
        "-e", `POSTGRES_PASSWORD=${adminPassword}`, "-e", "POSTGRES_DB=innorder_test", image,
      ]);
      expect(started.status, started.stderr).toBe(0);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const probe = dockerSync(["exec", "-e", `PGPASSWORD=${adminPassword}`, container,
          "psql", "--username", "postgres", "--dbname", "innorder_test", "--command", "SELECT 1"]);
        if (probe.status === 0) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
        if (attempt === 59) throw new Error("PostgreSQL container did not become ready");
      }
      const roleSql = `CREATE ROLE innorder_runtime NOLOGIN; CREATE ROLE innorder_ai_runtime LOGIN PASSWORD '${aiPassword}';`;
      const roleResult = dockerSync(["exec", "-i", "-e", `PGPASSWORD=${adminPassword}`, container,
        "psql", "--username", "postgres", "--dbname", "innorder_test", "--set", "ON_ERROR_STOP=1"], { input: roleSql });
      expect(roleResult.status, roleResult.stderr).toBe(0);
      for (const migration of migrations) {
        const migrated = dockerSync(["exec", "-i", "-e", `PGPASSWORD=${adminPassword}`, container,
          "psql", "--username", "postgres", "--dbname", "innorder_test", "--set", "ON_ERROR_STOP=1"], {
          input: readFileSync(join(resolve("../../database/migrations"), migration), "utf8"),
        });
        expect(migrated.status, migrated.stderr).toBe(0);
      }
      const portOutput = dockerSync(["port", container, "5432/tcp"]);
      expect(portOutput.status, portOutput.stderr).toBe(0);
      const port = Number(portOutput.stdout.trim().split(":").at(-1));
      const fixture = fixtureSql(randomUUID().replaceAll("-", "").slice(0, 8));
      admin = new pg.Client({ host: "127.0.0.1", port, database: "innorder_test", user: "postgres", password: adminPassword });
      await admin.connect();
      await admin.query(fixture.sql);
      const revision = Number((await admin.query(fixture.revisionQuery)).rows[0]?.current_revision);
      pool = createPostgresPool({
        host: "127.0.0.1", port, database: "innorder_test", user: "innorder_ai_runtime", password: aiPassword, max: 2,
      });
      const settings = (await pool.query(`SELECT current_setting('statement_timeout') AS statement_timeout,
        current_setting('lock_timeout') AS lock_timeout,
        current_setting('idle_in_transaction_session_timeout') AS idle_transaction_timeout,
        current_setting('application_name') AS application_name`)).rows[0];
      expect(settings).toEqual({
        statement_timeout: "2s", lock_timeout: "1s", idle_transaction_timeout: "2s", application_name: "innorder-ai",
      });

      locker = new pg.Client({ host: "127.0.0.1", port, database: "innorder_test", user: "postgres", password: adminPassword });
      await locker.connect();
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM authz.ai_authorization_grant WHERE id = $1 FOR UPDATE", [fixture.ids.grant]);
      const controller = new AbortController();
      const consume = new PostgresAiRepository(pool).consumeGrant({
        tokenHash: "a".repeat(64),
        claims: {
          iss: "innorder-core", aud: "innorder-ai", typ: "ai_authorization_grant", jti: randomUUID(),
          eventId: fixture.ids.event, operationId: fixture.ids.run, principalId: fixture.ids.principal,
          targetId: fixture.ids.target, purpose: "PARTICIPANT_GUIDANCE", authorizationRevision: revision,
          policyReleaseDigest: "d".repeat(64), authorizedSetDigest: "6".repeat(64), contextDigest: "7".repeat(64),
          classificationCeiling: "PUBLIC", agentVersionId: fixture.ids.agent, modelProfileId: fixture.ids.model,
          promptVersionId: fixture.ids.prompt, packageVersionId: fixture.ids.package, embeddingSpaceId: fixture.ids.space,
          iat: Math.floor(Date.now() / 1000), nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
        },
      }, controller.signal);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const blocked = await admin.query(`SELECT count(*)::integer AS count FROM pg_stat_activity
          WHERE application_name = 'innorder-ai' AND wait_event_type = 'Lock'`);
        if (blocked.rows[0]?.count === 1) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        if (attempt === 49) throw new Error("consume query did not block on the grant row");
      }
      controller.abort();
      await expect(deadline(consume, 1_000, "consume cancellation did not settle")).rejects.toThrow("OCC-AI-CANCELLED");
      const persisted = await admin.query(`SELECT consumed_at, run_id,
        (SELECT count(*)::integer FROM ai.ai_run WHERE id = $2) AS run_count
        FROM authz.ai_authorization_grant WHERE id = $1`, [fixture.ids.grant, fixture.ids.run]);
      expect(persisted.rows[0]).toMatchObject({ consumed_at: null, run_id: null, run_count: 0 });
      await deadline(pool.end(), 1_500, "AI pool shutdown hung after cancellation");
      pool = undefined;
    } finally {
      await locker?.query("ROLLBACK").catch(() => undefined);
      await locker?.end().catch(() => undefined);
      await admin?.end().catch(() => undefined);
      await pool?.end().catch(() => undefined);
      dockerSync(["rm", "-f", container]);
    }
  }, 180_000);
});
