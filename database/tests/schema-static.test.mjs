import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
const pgliteSmokePath = fileURLToPath(new URL('./pglite-smoke.mjs', import.meta.url));
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
  'V012__outbox_publisher_lifecycle.sql',
  'V013__process_task_workflow.sql',
  'V014__relationship_revision_per_command.sql',
];
const frozenMigrationDigests = {
  'V001__bootstrap.sql': '5bfe3250f881a3321a8f900f98477dd733ed14d6ef54d1ddc566c68254102b27',
  'V002__catalog.sql': '376e530809075dc55d91b4f70c7b3faff7423938be748acda35014f02468af57',
  'V003__identity_and_entities.sql': '4a5bec615f06c701abed3a24015897abbb1baffdfb853b7d945deecc906fa0b9',
  'V004__policy_control_plane.sql': 'd14ef5eaf0251ca018f8567192e92ad38553b939089a9c41ef2567c4c5eccfc8',
  'V005__occ_runtime.sql': '7b33f24c1c8769afae488f95c32f273dfe4889aca5a60b320b5a68fe07c7a28d',
  'V006__audit_and_outbox.sql': '515d9a324fb5303389d1d319d12ad2b5fc9d3695d557d2b7566aba216df1569a',
  'V007__ai_rag.sql': 'dd6bcff27a8744ca1ea9385f9b859334cfe2ff0d7dad7b85599f9c2bca533757',
  'V008__cross_schema_constraints.sql': '7b601d25af06c4a7034bb213824a3f0084807888d522b9283391ec4997e10cac',
  'V009__runtime_privileges.sql': '6e7cbe9994601f8f820f10179e227002ce2309a3ad659607a8a0dc2d439504f5',
  'V010__platform_security_kernel.sql': '0d951300326889dbdcb76112aa92622e1639ce54e48f3fa40d3ce6f04fe4b7cb',
  'V011__account_failed_attempt_window.sql': '57aed42c4420670e923fce52eb719948a07581186781279b46d3f1fc035d7099',
  'V012__outbox_publisher_lifecycle.sql': 'c8ec9cdb9febbefd39a86bfa04b3d4e7922c6e59e4279a9cb367d2a4c092ea4b',
};

function readMigration(name) {
  return readFileSync(join(root, name), 'utf8');
}

test('provides every ordered Flyway migration without placeholders', () => {
  const sql = migrations.map(readMigration).join('\n');
  assert.doesNotMatch(sql, /\b(?:TODO|TBD)\b|待定|待补充/i);
});

test('keeps published V001 through V012 migration content immutable', () => {
  assert.deepEqual(Object.keys(frozenMigrationDigests), migrations.slice(0, 12));
  for (const [migration, expectedDigest] of Object.entries(frozenMigrationDigests)) {
    const normalizedSql = readMigration(migration).replace(/\r\n?/gu, '\n');
    const actualDigest = createHash('sha256').update(normalizedSql).digest('hex');
    assert.equal(actualDigest, expectedDigest, `${migration} SHA-256`);
  }
});

test('V013 reserves workflow schema and V014 fixes command-scoped relationship revisions', () => {
  const migrationNames = readdirSync(root)
    .filter((name) => /^V\d+__.*\.sql$/.test(name))
    .sort();
  assert.deepEqual(migrationNames.slice(-2), [
    'V013__process_task_workflow.sql',
    'V014__relationship_revision_per_command.sql',
  ]);

  const sql = readMigration('V013__process_task_workflow.sql');
  for (const table of [
    'occ.cohort',
    'occ.task_blocker',
    'occ.task_gate_requirement',
    'occ.task_gate_provider_state',
    'occ.task_timeline',
    'occ.task_review_projection_fact',
    'occ.notification',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table.replace('.', '\\.') }\\b`, 'i'), table);
  }
  assert.match(sql, /ALTER TABLE occ\.process_definition_binding\b/i);
  assert.match(sql, /ALTER TABLE occ\.process_instance\b/i);
  assert.match(sql, /ALTER TABLE occ\.task_projection\b/i);
  assert.match(sql, /ERRCODE = '55000'/i);
});

test('V014 deduplicates relationship revision bumps within one command transaction', () => {
  const sql = readMigration('V014__relationship_revision_per_command.sql');
  assert.match(sql, /CREATE OR REPLACE FUNCTION authz\.bump_relationship_revision_statement\(\)/iu);
  assert.match(sql, /definition\.relation_key <> 'cohort_owner'/iu);
  assert.doesNotMatch(sql, /current_setting|set_config/iu);
  assert.match(sql, /CREATE OR REPLACE FUNCTION occ\.project_cohort_owner\(\)/iu);
});

test('registers forward workflow migrations in every database schema entrypoint', () => {
  const migration = 'V013__process_task_workflow.sql';
  const revisionMigration = 'V014__relationship_revision_per_command.sql';
  const entrypoint = readFileSync(fileURLToPath(new URL('../innorder_occ_full_schema.sql', import.meta.url)), 'utf8');
  const pgliteSmoke = readFileSync(pgliteSmokePath, 'utf8');
  const explicitApplications = [...pgliteSmoke.matchAll(
    /await\s+applyMigration\(\s*(['"])(V\d+__[^'"]+\.sql)\1\s*\)/gu,
  )].map((match) => match[2]);
  assert.ok(entrypoint.indexOf(migration) > entrypoint.indexOf('V012__outbox_publisher_lifecycle.sql'));
  assert.ok(entrypoint.indexOf(revisionMigration) > entrypoint.indexOf(migration));
  assert.ok(pgliteSmoke.indexOf(migration) > pgliteSmoke.indexOf('V012__outbox_publisher_lifecycle.sql'));
  assert.ok(explicitApplications.includes(migration), 'PGlite explicitly applies V013');
  assert.ok(explicitApplications.includes(revisionMigration), 'PGlite explicitly applies V014');
  assert.match(pgliteSmoke, /appliedMigrations\.push\(migration\)/u);
  assert.match(pgliteSmoke, /assert\.deepEqual\(appliedMigrations, migrations/u);
  for (const table of ['occ.cohort', 'occ.task_gate_provider_state', 'occ.task_review_projection_fact', 'occ.notification']) {
    assert.match(pgliteSmoke, new RegExp(`to_regclass\\('${table.replace('.', '\\.')}'\\)`, 'u'), table);
  }
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
    const directive = new RegExp(`^\\\\ir[ \\t]+migrations/${migration.replaceAll('.', '\\.') }[ \\t]*$`, 'mu');
    const match = directive.exec(entrypoint);
    assert.ok(match, `${migration} has a complete \\ir directive`);
    const position = match.index;
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
  assert.match(sql, /locked_until > failed_window_started_at/iu);
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
