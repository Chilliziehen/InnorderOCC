import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../migrations/', import.meta.url));
const runtimeRoleBootstrapPath = fileURLToPath(
  new URL('../bootstrap/001-create-runtime-role.sql', import.meta.url),
);
const postgresqlRaceTestPath = fileURLToPath(
  new URL('./postgresql-idempotency-race.test.mjs', import.meta.url),
);
const migrations = [
  'V001__bootstrap.sql',
  'V002__catalog.sql',
  'V003__identity_and_entities.sql',
  'V004__policy_control_plane.sql',
  'V005__occ_runtime.sql',
  'V006__audit_and_outbox.sql',
  'V007__ai_rag.sql',
  'V008__cross_schema_constraints.sql',
  'V009__runtime_privileges.sql',
  'V010__platform_security_kernel.sql',
  'V011__account_failed_attempt_window.sql',
];

function readMigration(name) {
  return readFileSync(join(root, name), 'utf8');
}

test('provides every ordered Flyway migration without placeholders', () => {
  const sql = migrations.map(readMigration).join('\n');
  assert.doesNotMatch(sql, /\b(?:TODO|TBD)\b|待定|待补充/i);
});

test('creates all approved schemas and extensions', () => {
  const sql = readMigration(migrations[0]);
  for (const schema of ['platform', 'catalog', 'iam', 'authz', 'occ', 'audit', 'ai', 'flowable']) {
    assert.match(sql, new RegExp(`CREATE SCHEMA ${schema}\\b`, 'i'));
  }
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS vector/i);
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS btree_gist/i);
});

test('models versioned catalog, authorization, runtime, audit, and AI tables', () => {
  const sql = migrations.map(readMigration).join('\n');
  for (const table of [
    'catalog.package_version',
    'catalog.entity_type_version',
    'authz.entity',
    'authz.relationship',
    'authz.authorization_state',
    'authz.policy_release',
    'occ.business_object',
    'occ.process_instance',
    'occ.evidence_version',
    'audit.outbox_event',
    'ai.knowledge_chunk',
    'ai.chunk_embedding',
    'ai.ai_run',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table.replace('.', '\\.') }\\b`, 'i'), table);
  }
});

test('contains critical authorization and concurrency safeguards', () => {
  const sql = migrations.map(readMigration).join('\n');
  assert.match(sql, /reject_immutable_row/i);
  assert.match(sql, /validate_relationship/i);
  assert.match(sql, /bump_authorization_revision/i);
  assert.match(sql, /WHERE \(status = 'ACTIVE'\)/i);
  assert.match(sql, /EXCLUDE USING gist/i);
  assert.match(sql, /row_version bigint NOT NULL DEFAULT 0/i);
});

test('uses valid trigger return patterns', () => {
  const sql = readMigration('V008__cross_schema_constraints.sql');
  assert.match(
    sql,
    /CREATE FUNCTION authz\.bump_authorization_revision_trigger\(\)[\s\S]*?RETURN NULL;[\s\S]*?END;/i,
  );
  assert.doesNotMatch(sql, /RETURN platform\.reject_immutable_row\(\)/i);
});

test('provides a full-schema psql entrypoint in migration order', () => {
  const entrypoint = readFileSync(fileURLToPath(new URL('../innorder_occ_full_schema.sql', import.meta.url)), 'utf8');
  let previous = -1;
  for (const migration of migrations) {
    const position = entrypoint.indexOf(migration);
    assert.ok(position > previous, `${migration} is included in order`);
    previous = position;
  }
});

test('bootstraps an idempotent NOLOGIN runtime role before full-schema migrations', () => {
  const entrypoint = readFileSync(fileURLToPath(new URL('../innorder_occ_full_schema.sql', import.meta.url)), 'utf8');
  assert.ok(existsSync(runtimeRoleBootstrapPath), 'runtime role bootstrap exists');
  const bootstrap = readFileSync(runtimeRoleBootstrapPath, 'utf8');
  const bootstrapReference = 'bootstrap/001-create-runtime-role.sql';

  assert.ok(entrypoint.indexOf(bootstrapReference) >= 0, 'full-schema entrypoint includes runtime role bootstrap');
  assert.ok(
    entrypoint.indexOf(bootstrapReference) < entrypoint.indexOf(migrations[0]),
    'runtime role bootstrap runs before V001',
  );
  assert.match(bootstrap, /IF NOT EXISTS[\s\S]*pg_catalog\.pg_roles[\s\S]*rolname = 'innorder_runtime'/iu);
  assert.match(bootstrap, /CREATE ROLE\s+innorder_runtime\s+NOLOGIN/iu);
  assert.doesNotMatch(bootstrap, /\bPASSWORD\b|\bLOGIN\b/iu);
});

test('grants the Core runtime least-privilege schema access', () => {
  const sql = readMigration('V009__runtime_privileges.sql');
  for (const schema of ['platform', 'catalog', 'iam', 'authz', 'occ', 'audit', 'ai']) {
    assert.match(sql, new RegExp(`GRANT USAGE ON SCHEMA[\\s\\S]*\\b${schema}\\b[\\s\\S]*TO innorder_runtime`, 'i'));
  }
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON ALL TABLES IN SCHEMA/i);
  assert.match(sql, /GRANT USAGE, SELECT, UPDATE\s+ON ALL SEQUENCES IN SCHEMA/i);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES[\s\S]*GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO innorder_runtime/i);
  assert.match(sql, /GRANT USAGE, CREATE ON SCHEMA flowable TO innorder_runtime/i);
  assert.doesNotMatch(sql, /ALTER SCHEMA flowable OWNER TO innorder_runtime/i);
  assert.doesNotMatch(sql, /GRANT\s+(?:ALL|CREATE)\s+ON SCHEMA\s+(?:platform|catalog|iam|authz|occ|audit|ai)/i);
  assert.doesNotMatch(sql, /SUPERUSER|ALTER SCHEMA\s+(?:platform|catalog|iam|authz|occ|audit|ai)\s+OWNER TO innorder_runtime/i);
});

test('hardens embedding partition creation as a bounded runtime capability', () => {
  const constraints = readMigration('V008__cross_schema_constraints.sql');
  const privileges = readMigration('V009__runtime_privileges.sql');
  const functionSql = constraints.match(
    /CREATE FUNCTION ai\.create_embedding_partition\([\s\S]*?\$\$;/iu,
  )?.[0] ?? '';

  assert.match(functionSql, /SECURITY DEFINER/iu);
  assert.match(functionSql, /SET search_path = pg_catalog, pg_temp/iu);
  assert.match(functionSql, /FROM ai\.embedding_space/iu);
  assert.match(functionSql, /public\.vector_dims/iu);
  assert.match(functionSql, /public\.vector\(/iu);
  assert.match(functionSql, /public\.vector_(?:cosine|l2|ip)_ops/iu);
  assert.match(
    privileges,
    /REVOKE (?:ALL|EXECUTE) ON FUNCTION ai\.create_embedding_partition\(uuid, integer, text\) FROM PUBLIC/iu,
  );
  assert.match(
    privileges,
    /GRANT EXECUTE ON FUNCTION ai\.create_embedding_partition\(uuid, integer, text\) TO innorder_runtime/iu,
  );
  assert.doesNotMatch(privileges, /GRANT\s+(?:ALL|CREATE)\s+ON SCHEMA\s+ai\s+TO innorder_runtime/iu);
});

test('freezes authorization facts and enforces cross-table versions', () => {
  const sql = migrations.map(readMigration).join('\n');
  assert.match(sql, /CREATE TRIGGER trg_authorization_state_no_delete/i);
  assert.match(sql, /RETURNING current_revision INTO STRICT next_revision/i);
  assert.match(sql, /PERFORM 1[\s\S]*FROM catalog\.relation_definition[\s\S]*FOR UPDATE/i);
  assert.match(sql, /CREATE TRIGGER trg_relationship_history/i);
  assert.match(sql, /CREATE TRIGGER trg_entity_stable_identity/i);
  assert.match(sql, /fk_business_object_entity_version/i);
  assert.match(sql, /fk_data_migration_source_type/i);
  assert.match(sql, /fk_recommendation_citation_chunk_version/i);
});

test('freezes effective policy and versioned AI content', () => {
  const sql = migrations.map(readMigration).join('\n');
  assert.match(sql, /CREATE TRIGGER trg_policy_release_immutable/i);
  assert.match(sql, /CREATE TRIGGER trg_policy_release_item_mutable/i);
  assert.match(sql, /CREATE TRIGGER trg_prompt_template_version_immutable/i);
  assert.match(sql, /decision_log_created_at timestamptz NOT NULL/i);
  assert.match(sql, /dimensions integer NOT NULL CHECK \(dimensions BETWEEN 1 AND 2000\)/i);
});

test('protects stable policy, principal, relation, and package identities', () => {
  const sql = migrations.map(readMigration).join('\n');
  assert.match(sql, /CREATE TRIGGER trg_policy_release_insert_state/i);
  assert.match(sql, /CREATE TRIGGER trg_policy_bundle_identity/i);
  assert.match(sql, /CREATE TRIGGER trg_principal_entity_kind/i);
  assert.match(sql, /CREATE TRIGGER trg_entity_type_version_package/i);
  assert.match(sql, /CREATE TRIGGER trg_package_version_identity/i);
  assert.match(sql, /CREATE TRIGGER trg_entity_type_identity/i);
  assert.match(sql, /relationship definition must be published/i);
  assert.match(sql, /UNIQUE \(release_id, bundle_id\)/i);
  assert.match(sql, /FOREIGN KEY \(bundle_version_id, bundle_id\)/i);
});

test('adds protected customer and hashed authentication persistence', () => {
  const sql = readMigration('V010__platform_security_kernel.sql');
  assert.match(sql, /CREATE TABLE platform\.customer_instance\b/i);
  assert.match(sql, /00000000-0000-7000-8000-000000000001/i);
  assert.match(sql, /CREATE TRIGGER trg_customer_instance_identity/i);
  assert.match(sql, /CREATE TRIGGER trg_customer_instance_no_delete/i);
  assert.match(sql, /CREATE TRIGGER trg_customer_instance_no_truncate/i);
  assert.match(sql, /CREATE TABLE iam\.auth_session\b/i);
  assert.match(sql, /refresh_token_hash text NOT NULL UNIQUE/i);
  assert.match(sql, /refresh_token_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /replaced_by_session_id uuid REFERENCES iam\.auth_session\(id\)/i);
  assert.doesNotMatch(sql, /replacement_session_id/i);
  assert.match(sql, /CREATE TRIGGER trg_auth_session_rotation_integrity/i);
  assert.match(sql, /auth session security fields are immutable/i);
  assert.match(sql, /last_used_at cannot move backwards/i);
  assert.match(sql, /auth session revocation is one-way/i);
  assert.match(sql, /auth session replacement is one-way/i);
  assert.match(sql, /replacement session must belong to the same principal/i);
  assert.match(sql, /replacement session cannot predate rotated session/i);
  assert.match(sql, /CREATE INDEX ix_auth_session_active_principal_expiry/i);
  assert.doesNotMatch(sql, /\b(?:refresh_token|access_token|password)\b\s+(?:text|varchar)/i);
});

test('adds a constrained and forward-compatible account failure window', () => {
  const sql = readMigration('V011__account_failed_attempt_window.sql');
  assert.match(sql, /ADD COLUMN failed_window_started_at timestamptz/iu);
  assert.match(sql, /failed_attempts\s*=\s*greatest\(failed_attempts, 5\)/iu);
  assert.match(sql, /WHERE locked_until IS NOT NULL/iu);
  assert.match(sql, /failed_window_started_at[\s\S]*locked_until - interval '15 minutes'/iu);
  assert.match(sql, /failed_attempts = 0[\s\S]*failed_window_started_at IS NULL/iu);
  assert.match(sql, /locked_until >= failed_window_started_at/iu);
  assert.match(sql, /GRANT SELECT \(failed_window_started_at\), UPDATE \(failed_window_started_at\)/iu);
});

test('adds deterministic idempotency and outbox lifecycles', () => {
  const sql = readMigration('V010__platform_security_kernel.sql');
  assert.match(sql, /ADD COLUMN state text/i);
  assert.match(sql, /IN_PROGRESS[\s\S]*COMPLETED[\s\S]*FAILED/i);
  assert.match(sql, /octet_length\(response_body::text\) <= 65536/i);
  assert.match(sql, /CREATE TRIGGER trg_idempotency_record_lifecycle/i);
  assert.match(sql, /request_hash is immutable/i);
  assert.match(sql, /idempotency ownership fields are immutable/i);
  for (const column of [
    'customer_instance_id', 'actor_entity_id', 'causation_id', 'last_error',
    'next_attempt_at', 'claimed_at',
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN ${column}\\b`, 'i'), column);
  }
  assert.match(sql, /CREATE INDEX ix_outbox_pending_claim/i);
  assert.match(sql, /next_attempt_at, created_at/i);
  assert.match(sql, /published_at\s*=\s*CASE\s+WHEN status = 'PUBLISHED'/i);
  assert.match(sql, /CREATE TRIGGER trg_outbox_event_lifecycle/i);
  assert.match(sql, /CREATE TRIGGER trg_outbox_event_schedule/i);
  assert.match(sql, /NEW\.next_attempt_at := NEW\.available_at/i);
  assert.match(sql, /ALTER COLUMN next_attempt_at DROP DEFAULT/i);
  assert.match(sql, /outbox event identity and content are immutable/i);
  assert.match(sql, /terminal outbox event is immutable/i);
  assert.match(sql, /CREATE INDEX ix_outbox_stale_publishing/i);
  assert.match(sql, /ck_outbox_retry_schedule/i);
  assert.match(sql, /ck_outbox_claim_publish_time/i);
  assert.match(sql, /fk_outbox_customer_instance/i);
  assert.match(sql, /fk_outbox_actor_entity/i);
});

test('uses time-window relationship authorization and exact revision triggers', () => {
  const sql = readMigration('V010__platform_security_kernel.sql');
  assert.match(sql, /DROP INDEX authz\.uq_relationship_active/i);
  assert.match(sql, /CREATE INDEX ix_relationship_active_window/i);
  assert.match(sql, /ALTER COLUMN valid_from SET DEFAULT transaction_timestamp\(\)/i);
  assert.match(sql, /ADD COLUMN max_subjects integer/i);
  assert.match(sql, /ADD COLUMN max_objects integer/i);
  assert.match(sql, /tstzrange\(r\.valid_from, r\.valid_until, '\[\)'\)/i);
  assert.match(sql, /definition\.auth_relevant/i);
  assert.match(sql, /valid_from <= transaction_timestamp\(\)/i);
  assert.match(sql, /valid_until IS NULL OR [^)\n]*valid_until > transaction_timestamp\(\)/i);
  assert.doesNotMatch(sql, /valid_(?:from|until)[^\n]*statement_timestamp\(\)/i);
  assert.match(sql, /CREATE FUNCTION authz\.active_relationships_at\(\s*p_snapshot_at timestamptz DEFAULT transaction_timestamp\(\)/i);
  assert.match(sql, /RETURNS SETOF authz\.relationship/i);
  assert.match(sql, /r\.valid_from <= p_snapshot_at/i);
  assert.match(sql, /r\.valid_until IS NULL OR r\.valid_until > p_snapshot_at/i);
  assert.doesNotMatch(sql, /CREATE (?:UNIQUE )?INDEX[^;]*WHERE[^;]*(?:now|statement_timestamp|transaction_timestamp)\s*\(/i);
  assert.match(sql, /CREATE TRIGGER trg_principal_status_authorization_revision/i);
  assert.match(sql, /REFERENCING OLD TABLE AS old_principals NEW TABLE AS new_principals/i);
  assert.match(sql, /FOR EACH STATEMENT EXECUTE FUNCTION authz\.bump_principal_status_revision_statement/i);
  assert.doesNotMatch(sql, /FOR EACH ROW EXECUTE FUNCTION authz\.bump_principal_status_revision/i);
  assert.match(sql, /CREATE TRIGGER trg_relationship_authorization_revision_insert/i);
  assert.match(sql, /CREATE TRIGGER trg_relationship_authorization_revision_update/i);
  assert.match(sql, /CREATE TRIGGER trg_relationship_authorization_revision_delete/i);
  assert.match(sql, /REFERENCING NEW TABLE AS new_relationships/i);
  assert.match(sql, /REFERENCING OLD TABLE AS old_relationships/i);
  assert.match(sql, /FOR EACH STATEMENT EXECUTE FUNCTION authz\.bump_relationship_revision_statement/i);
  assert.doesNotMatch(sql, /FOR EACH ROW EXECUTE FUNCTION authz\.bump_active_relationship_revision/i);
  assert.match(sql, /DROP TRIGGER trg_relationship_authorization_revision/i);
  assert.match(sql, /revision tracks relationship fact mutations/i);
  assert.match(sql, /single transaction timestamp/i);
  assert.match(sql, /five-minute expiry/i);
  assert.match(sql, /CREATE FUNCTION authz\.lock_authorization_state_for_change\(\)/i);
  assert.match(sql, /CREATE FUNCTION authz\.lock_authorization_state_for_snapshot\(\)/i);
  assert.match(sql, /FOR UPDATE/i);
  assert.match(sql, /FOR SHARE/i);
  assert.match(sql, /CREATE TRIGGER trg_relationship_authorization_lock/i);
  assert.match(sql, /CREATE TRIGGER trg_principal_status_authorization_lock/i);
  assert.match(sql, /CREATE TRIGGER trg_entity_authorization_lock/i);
  assert.match(sql, /CREATE TRIGGER trg_policy_release_authorization_lock/i);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE ON authz\.relationship/i);
  assert.match(sql, /BEFORE UPDATE OF status ON iam\.principal/i);
  assert.match(sql, /BEFORE UPDATE OF auth_attributes, state, entity_type_version_id ON authz\.entity/i);
  assert.match(sql, /BEFORE INSERT OR UPDATE OF status OR DELETE ON authz\.policy_release/i);
  assert.match(sql, /call lock_authorization_state_for_change before fact writes/i);
});

test('isolates PostgreSQL race fixtures and keeps credentials out of process arguments', () => {
  const source = readFileSync(postgresqlRaceTestPath, 'utf8');
  assert.match(source, /randomUUID\(\)/i);
  assert.match(source, /new URL\(databaseUrl\)/i);
  assert.match(source, /PGHOST:\s*decodeURIComponent\(parsed\.hostname\)/i);
  for (const variable of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE']) {
    assert.match(source, new RegExp(`\\b${variable}\\b`), variable);
  }
  assert.doesNotMatch(source, /'--dbname',\s*databaseUrl/i);
  assert.doesNotMatch(source, /91000000-0000-7000-8000-/i);
  assert.match(source, /skip:\s*!strict\s*&&\s*localSkip/i);
  assert.match(source, /t\.after\(cleanup\)[\s\S]*await execPsql/i);
  assert.match(source, /finally\s*\{[\s\S]*await cleanup\(\)/i);
});
