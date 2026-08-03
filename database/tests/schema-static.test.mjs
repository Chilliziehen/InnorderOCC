import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import './evidence-risk-resource-static.test.mjs';

const root = fileURLToPath(new URL('../migrations/', import.meta.url));
const runtimeRoleBootstrapPath = fileURLToPath(
  new URL('../bootstrap/001-create-runtime-role.sql', import.meta.url),
);
const postgresqlRaceTestPath = fileURLToPath(
  new URL('./postgresql-idempotency-race.test.mjs', import.meta.url),
);
const pgliteSmokePath = fileURLToPath(new URL('./pglite-smoke.mjs', import.meta.url));
const governedPostgresqlTestPath = fileURLToPath(
  new URL('./postgresql-governed-ai.test.mjs', import.meta.url),
);
const composeRolePath = fileURLToPath(
  new URL('../../infra/compose/postgres/010-create-roles.sh', import.meta.url),
);
const coreTestInitPath = fileURLToPath(
  new URL('../../services/core/src/test/resources/postgres-test-init.sql', import.meta.url),
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
  'V012__outbox_publisher_lifecycle.sql',
  'V013__process_task_workflow.sql',
  'V014__evidence_risk_resource.sql',
  'V015__cohort_api_lifecycle.sql',
  'V016__governed_ai_runtime.sql',
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

test('V013 is the only migration after V012 and owns workflow authorization revisions', () => {
  const migrationNames = readdirSync(root)
    .filter((name) => /^V\d+__.*\.sql$/.test(name))
    .sort();
  assert.deepEqual(migrationNames.slice(-2), [
    'V012__outbox_publisher_lifecycle.sql',
    'V013__process_task_workflow.sql',
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

test('V013 deduplicates cohort owner revision bumps within one command transaction', () => {
  const sql = readMigration('V013__process_task_workflow.sql');
  assert.match(sql, /CREATE OR REPLACE FUNCTION authz\.bump_relationship_revision_statement\(\)/iu);
  assert.match(sql, /definition\.relation_key <> 'cohort_owner'/iu);
  assert.doesNotMatch(sql, /current_setting|set_config/iu);
  assert.match(sql, /CREATE OR REPLACE FUNCTION occ\.project_cohort_owner\(\)/iu);
});

test('registers only V013 in every database schema entrypoint', () => {
  const migration = 'V013__process_task_workflow.sql';
  const entrypoint = readFileSync(fileURLToPath(new URL('../innorder_occ_full_schema.sql', import.meta.url)), 'utf8');
  const pgliteSmoke = readFileSync(pgliteSmokePath, 'utf8');
  const explicitApplications = [...pgliteSmoke.matchAll(
    /await\s+applyMigration\(\s*(['"])(V\d+__[^'"]+\.sql)\1\s*\)/gu,
  )].map((match) => match[2]);
  assert.ok(entrypoint.indexOf(migration) > entrypoint.indexOf('V012__outbox_publisher_lifecycle.sql'));
  assert.doesNotMatch(entrypoint, /V014__/u);
  assert.ok(pgliteSmoke.indexOf(migration) > pgliteSmoke.indexOf('V012__outbox_publisher_lifecycle.sql'));
  assert.ok(explicitApplications.includes(migration), 'PGlite explicitly applies V013');
  assert.ok(explicitApplications.every((name) => !name.startsWith('V014__')), 'PGlite does not claim V014');
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

test('defines the governed AI persistence and retention contracts', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  for (const table of [
    'authz.ai_authorization_grant',
    'authz.ai_authorized_document',
    'ai.ingestion_job',
    'ai.ingestion_attempt',
    'ai.event_consumption',
    'ai.model_invocation',
    'ai.retrieval_trace',
    'ai.retrieval_hit',
    'ai.embedding_space_gate_result',
    'ai.legal_hold',
    'ai.legal_hold_object',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table.replace('.', '\\.') }\\b`, 'iu'), table);
  }
  assert.match(sql, /token_hash text NOT NULL UNIQUE[\s\S]*?\^\[0-9a-f\]\{64\}\$/iu);
  for (const column of [
    'operation', 'jti', 'principal_id', 'target_entity_id', 'purpose',
    'authorization_revision', 'policy_release_digest', 'authorized_set_digest',
    'context_digest', 'bounded_context', 'classification_ceiling', 'issued_at',
    'signer_kid', 'expires_at', 'consumed_at', 'event_id', 'run_id',
  ]) assert.match(sql, new RegExp(`\\b${column}\\b`, 'iu'), column);
  assert.match(sql, /expires_at <= issued_at \+ interval '5 minutes'/iu);
  assert.match(sql, /authorized document limit of 500 exceeded/iu);
  assert.doesNotMatch(sql, /LIMIT\s+500[\s\S]*INSERT INTO authz\.ai_authorized_document/iu);
  assert.match(sql, /CREATE TRIGGER trg_ai_authorization_grant_lifecycle/iu);
  assert.match(sql, /claim_idempotency_key_hash text[\s\S]*\^\[0-9a-f\]\{64\}\$/iu);
  assert.match(sql, /signer_kid text NOT NULL[\s\S]*\^\[A-Za-z0-9\]/u);
  assert.match(sql, /CREATE FUNCTION authz\.bind_ai_grant_claim_idempotency\(p_operation_id uuid, p_key_hash text\)[\s\S]*SECURITY DEFINER/iu);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION authz\.bind_ai_grant_claim_idempotency\(uuid, text\) TO innorder_runtime/iu);
  assert.match(sql, /REVOKE UPDATE, DELETE ON authz\.ai_authorization_grant FROM innorder_runtime/iu);
  assert.match(sql, /CREATE TRIGGER trg_ai_authorized_document_immutable/iu);
  assert.match(sql, /retention_until[\s\S]*interval '1 year'/iu);
  assert.match(sql, /legal_hold/iu);
});

test('defines deterministic workers, durable event consumption, traces, and gates', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  for (const term of [
    'source_version', 'content_hash', 'checkpoint', 'stage', 'lease_owner',
    'lease_expires_at', 'next_attempt_at', 'sanitized_error', 'corpus_manifest_digest',
    'consumer_key', 'event_id', 'schema_version', 'aggregate_version', 'DEAD',
    'provider_request_id_hash', 'capability_hash', 'request_hash', 'response_hash',
    'lexical_score', 'vector_score', 'fused_score', 'injection_detected',
    'eligible_count', 'embedded_count', 'leakage_count', 'citation_numerator',
    'citation_denominator', 'citation_precision', 'recall_sum', 'recall_count',
    'recall_mean', 'decision', 'evidence_hash',
  ]) assert.match(sql, new RegExp(`\\b${term}\\b`, 'iu'), term);
  for (const index of [
    'ix_ingestion_job_claim', 'ix_ingestion_job_stale_lease', 'ix_event_consumption_claim',
    'ix_event_consumption_stale_lease', 'ix_model_invocation_run',
    'ix_model_invocation_provider_request_hash', 'ix_retrieval_trace_run',
    'ix_retrieval_hit_document', 'ix_ai_authorized_document_version',
  ]) assert.match(sql, new RegExp(`CREATE (?:UNIQUE )?INDEX ${index}\\b`, 'iu'), index);
  assert.match(sql, /CREATE TRIGGER trg_ingestion_job_lifecycle/iu);
  assert.match(sql, /ingestion job deterministic identity is immutable/iu);
  assert.match(sql, /CREATE TRIGGER trg_event_consumption_lifecycle/iu);
  assert.match(sql, /terminal event consumption is immutable/iu);
  assert.match(sql, /CREATE TRIGGER trg_model_invocation_lifecycle/iu);
  assert.match(sql, /model invocation request identity is immutable/iu);
});

test('exposes only hardened bounded AI capabilities', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  for (const name of [
    'authz.consume_ai_authorization_grant',
    'ai.get_ai_operation_status',
    'ai.claim_ingestion_jobs',
    'ai.claim_event_consumptions',
    'ai.authorized_hybrid_retrieval',
  ]) {
    const escaped = name.replace('.', '\\.');
    const definition = sql.match(new RegExp(`CREATE FUNCTION ${escaped}\\([\\s\\S]*?\\$\\$;`, 'iu'))?.[0] ?? '';
    assert.match(definition, /SECURITY DEFINER/iu, `${name} is SECURITY DEFINER`);
    assert.match(definition, /SET search_path = pg_catalog, pg_temp/iu, `${name} fixes search_path`);
    assert.match(sql, new RegExp(`REVOKE (?:ALL|EXECUTE) ON FUNCTION ${escaped}\\([\\s\\S]*?FROM PUBLIC`, 'iu'));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION ${escaped}\\([\\s\\S]*?TO innorder_ai_runtime`, 'iu'));
  }
  const retrieval = sql.match(/CREATE FUNCTION ai\.authorized_hybrid_retrieval\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(retrieval, /JOIN authz\.ai_authorized_document/iu);
  assert.ok((retrieval.match(/JOIN authz\.ai_authorized_document/giu) ?? []).length >= 2,
    'lexical and vector candidate branches each authorization-filter before ranking');
  assert.match(retrieval, /ROW_NUMBER\(\)[\s\S]*fused/iu);
  assert.match(sql, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA authz, ai FROM PUBLIC/iu);
  assert.match(sql, /GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA authz, ai TO innorder_runtime/iu);
});

test('provisions a separate AI identity before Flyway without granting broad access', () => {
  const bootstrap = readFileSync(runtimeRoleBootstrapPath, 'utf8');
  assert.match(bootstrap, /CREATE ROLE\s+innorder_ai_runtime\s+NOLOGIN/iu);
  assert.doesNotMatch(readMigration('V016__governed_ai_runtime.sql'), /CREATE ROLE/iu);

  const compose = readFileSync(composeRolePath, 'utf8');
  assert.match(compose, /AI_DATABASE_PASSWORD_FILE/iu);
  assert.match(compose, /ALTER ROLE %I LOGIN PASSWORD %L/iu);
  assert.match(compose, /innorder_ai_runtime/iu);

  const testInit = readFileSync(coreTestInitPath, 'utf8');
  assert.match(testInit, /CREATE ROLE innorder_ai_runtime NOLOGIN/iu);

  const sql = readMigration('V016__governed_ai_runtime.sql');
  assert.match(sql, /GRANT USAGE ON SCHEMA ai, public TO innorder_ai_runtime/iu);
  for (const table of ['knowledge_document_version', 'knowledge_chunk', 'chunk_embedding']) {
    assert.match(sql, new RegExp(`REVOKE (?:ALL|SELECT) ON ai\\.${table} FROM innorder_ai_runtime`, 'iu'));
    assert.doesNotMatch(sql, new RegExp(`GRANT SELECT ON[^;]*ai\\.${table}[^;]*TO innorder_ai_runtime`, 'iu'));
  }
  assert.doesNotMatch(sql, /GRANT\s+(?:ALL|CREATE)\s+ON SCHEMA/iu);
  assert.doesNotMatch(sql, /GRANT[^;]*(?:INSERT|UPDATE|DELETE)[^;]*ON[^;]*(?:iam\.|authz\.(?:entity|relationship|authorization_state|policy_release)\b|occ\.|flowable\.|audit\.|ai\.(?:model_provider|knowledge_source|knowledge_document|recommendation|conversation)\b)/iu);
  for (const schema of ['iam', 'occ', 'flowable', 'audit']) {
    assert.match(sql, new RegExp(`REVOKE ALL ON SCHEMA ${schema} FROM innorder_ai_runtime`, 'iu'));
  }
  assert.ok(existsSync(governedPostgresqlTestPath), 'real governed AI PostgreSQL suite exists');
  const liveSuite = readFileSync(governedPostgresqlTestPath, 'utf8');
  assert.match(liveSuite, /docker/iu);
  assert.doesNotMatch(liveSuite, /\bskip\s*:/iu);
});

test('keeps current Compose compatible while supporting a file-backed AI LOGIN', () => {
  const compose = readFileSync(composeRolePath, 'utf8');
  assert.match(compose, /ai_password_file="\$\{AI_DATABASE_PASSWORD_FILE:-\/run\/secrets\/postgres_ai_runtime_password\}"/u);
  assert.match(compose, /if \[\[ -r "\$ai_password_file" \]\]/u);
  assert.match(compose, /ai_runtime_login=(?:true|false)/u);
  assert.match(compose, /CREATE ROLE %I NOLOGIN/iu);
  assert.match(compose, /ALTER ROLE %I LOGIN PASSWORD %L/iu);
  assert.match(compose, /ALTER ROLE %I NOLOGIN/iu);
  assert.doesNotMatch(compose, /ai_runtime_password="\$\(read_secret "\$\{AI_DATABASE_PASSWORD_FILE/iu);
});

test('binds grant consumption to every signed token claim and 32 KiB canonical context', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  assert.match(sql, /octet_length\(bounded_context::text\) <= 32768/iu);
  const consume = sql.match(/CREATE FUNCTION authz\.consume_ai_authorization_grant\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  for (const parameter of [
    'p_event_id uuid', 'p_operation text', 'p_authorization_revision bigint',
    'p_policy_release_digest text', 'p_authorized_set_digest text', 'p_context_digest text',
    'p_embedding_space_id uuid',
  ]) assert.match(consume, new RegExp(parameter, 'iu'), parameter);
  assert.match(consume, /replayed boolean/iu);
  assert.match(consume, /RETURN QUERY SELECT p_run_id, authorized_ids, grant_row\.bounded_context, true/iu);
  assert.match(consume, /grant token event mismatch/iu);
  assert.match(consume, /grant token operation mismatch/iu);
  assert.match(consume, /grant token authorized-set digest mismatch/iu);
  assert.match(consume, /grant token context digest mismatch/iu);
  assert.match(consume, /grant token run mismatch/iu);
  for (const comparison of [
    'event_id', 'operation', 'authorization_revision', 'policy_release_digest',
    'authorized_set_digest', 'context_digest',
  ]) assert.match(consume, new RegExp(`${comparison} IS DISTINCT FROM p_${comparison}`, 'iu'));
  assert.match(consume, /signed AI grant claims cannot be NULL/iu);
  assert.match(sql, /CREATE FUNCTION ai\.get_ai_operation_status\(p_operation_id uuid\)[\s\S]*SECURITY DEFINER/iu);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION ai\.get_ai_operation_status\(uuid\) TO innorder_ai_runtime/iu);
  assert.doesNotMatch(sql, /GRANT SELECT ON[^;]*ai\.ai_run(?:\s|,|;)/iu);
  assert.doesNotMatch(sql, /claim_idempotency_key(?!_hash)/iu);
});

test('fails embedding gates closed with fixed manifest-bound evidence', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  assert.match(sql, /CREATE TABLE ai\.embedding_space_gate_case_evidence\b/iu);
  assert.match(sql, /candidate_embedding_space_id uuid NOT NULL/iu);
  assert.match(sql, /eligible_count bigint NOT NULL CHECK \(eligible_count > 0\)/iu);
  assert.match(sql, /citation_denominator bigint NOT NULL CHECK \(citation_denominator > 0/iu);
  assert.match(sql, /recall_count bigint NOT NULL CHECK \(recall_count > 0\)/iu);
  assert.match(sql, /minimum_coverage numeric NOT NULL DEFAULT 1\.0 CHECK \(minimum_coverage = 1\.0\)/iu);
  assert.match(sql, /maximum_leakage bigint NOT NULL DEFAULT 0 CHECK \(maximum_leakage = 0\)/iu);
  assert.match(sql, /minimum_citation_precision numeric NOT NULL DEFAULT 0\.95 CHECK \(minimum_citation_precision = 0\.95\)/iu);
  assert.match(sql, /minimum_recall_at_10 numeric NOT NULL DEFAULT 0\.85 CHECK \(minimum_recall_at_10 = 0\.85\)/iu);
  assert.doesNotMatch(sql, /CASE WHEN (?:citation_denominator|recall_count|eligible_count) = 0 THEN 1/iu);
  for (const fn of ['begin_embedding_space_gate', 'record_embedding_gate_case', 'finalize_embedding_space_gate']) {
    const definition = sql.match(new RegExp(`CREATE FUNCTION ai\\.${fn}\\([\\s\\S]*?\\$\\$;`, 'iu'))?.[0] ?? '';
    assert.match(definition, /SECURITY DEFINER/iu, fn);
    assert.match(definition, /SET search_path = pg_catalog, pg_temp/iu, fn);
  }
  assert.match(sql, /stale corpus manifest/iu);
  assert.match(sql, /empty gate evidence/iu);
});

test('routes AI mutations through bounded functions and retains governed evidence', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  assert.match(sql, /CREATE TABLE ai\.retention_policy\b/iu);
  const submission = sql.match(/CREATE TABLE ai\.recommendation_submission\s*\([\s\S]*?\n\);/iu)?.[0] ?? '';
  assert.match(submission, /status text NOT NULL[^\n]*PREPARED[^\n]*ACKNOWLEDGED[^\n]*FAILED/iu);
  assert.match(submission, /payload jsonb NOT NULL/iu);
  assert.match(submission, /payload_hash text NOT NULL/iu);
  assert.match(submission, /idempotency_key text NOT NULL/iu);
  assert.match(submission, /core_recommendation_id uuid/iu);
  assert.match(submission, /core_receipt_hash text/iu);
  assert.match(submission, /attempts integer NOT NULL DEFAULT 0/iu);
  assert.match(submission, /artifact_id uuid NOT NULL/iu);
  assert.match(submission, /artifact_object_key text NOT NULL/iu);
  assert.match(submission, /artifact_hash text NOT NULL[\s\S]*\^\[0-9a-f\]\{64\}\$/iu);
  assert.match(submission, /data_classification text NOT NULL/iu);
  assert.match(submission, /retention_until timestamptz NOT NULL DEFAULT \(statement_timestamp\(\) \+ interval '1 year'\)/iu);
  assert.match(submission, /legal_hold_id uuid/iu);
  assert.match(sql, /retention_interval interval NOT NULL DEFAULT interval '1 year'/iu);
  for (const table of ['model_invocation', 'recommendation_submission', 'retrieval_trace', 'retrieval_hit', 'embedding_space_gate_result']) {
    const definition = sql.match(new RegExp(`CREATE TABLE ai\\.${table}\\s*\\([\\s\\S]*?\\n\\);`, 'iu'))?.[0] ?? '';
    assert.match(definition, /retention_until timestamptz NOT NULL DEFAULT \(statement_timestamp\(\) \+ interval '1 year'\)/iu, table);
    assert.match(definition, /legal_hold_id uuid/iu, table);
  }
  assert.match(sql, /ALTER TABLE ai\.ai_run_artifact[\s\S]*retention_until[\s\S]*interval '1 year'/iu);
  assert.match(sql, /fk_retrieval_trace_grant_run/iu);
  assert.match(sql, /fk_retrieval_trace_run_grant/iu);
  assert.match(sql, /CREATE TRIGGER trg_retrieval_hit_authorized/iu);
  assert.match(sql, /retrieval hit document is not authorized by grant/iu);
  for (const fn of [
    'persist_ingestion_document_version', 'persist_ingestion_chunk_embedding',
    'finalize_ingestion_job', 'fail_ingestion_job', 'register_event_consumption',
    'finalize_event_consumption', 'fail_event_consumption', 'transition_ai_run',
    'start_model_invocation', 'finalize_model_invocation', 'persist_run_artifact',
    'persist_retrieval_bundle', 'prepare_guidance_recommendation_submission',
    'mark_guidance_recommendation_dispatched', 'acknowledge_guidance_recommendation',
    'fail_guidance_recommendation_submission',
  ]) assert.match(sql, new RegExp(`CREATE FUNCTION ai\\.${fn}\\(`, 'iu'), fn);
  assert.match(sql, /CREATE TRIGGER trg_recommendation_submission_lifecycle/iu);
  assert.match(sql, /UPDATE ai\.recommendation_submission[\s\S]*UPDATE ai\.ai_run[\s\S]*status = 'COMPLETED'/iu);
  const persistArtifact = sql.match(/CREATE FUNCTION ai\.persist_run_artifact\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(persistArtifact, /ON CONFLICT[\s\S]*DO NOTHING/iu);
  assert.match(persistArtifact, /artifact replay conflicts with retained identity/iu);
  assert.match(sql, /GRANT SELECT ON ai\.model_provider/iu);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION ai\.(?:record_retrieval_trace|record_retrieval_hit)\([^;]*TO innorder_ai_runtime/iu);
  assert.doesNotMatch(sql, /GRANT SELECT, INSERT(?:, UPDATE)? ON ai\.(?:knowledge_document_version|knowledge_chunk|chunk_embedding|ingestion_job|ingestion_attempt|event_consumption|model_invocation|retrieval_trace|retrieval_hit)/iu);
});

test('requires live LOGIN, denial, concurrency, vector, event, and gate coverage', () => {
  const source = readFileSync(governedPostgresqlTestPath, 'utf8');
  for (const marker of [
    'innorder_ai_runtime', 'aiConnectionEnvironment', 'PGPASSWORD',
    'knowledge_document', 'recommendation', 'iam.principal', 'occ.business_object',
    'audit.outbox_event', 'flowable', 'expired', 'stale authorization revision',
    'authorized-set digest mismatch', 'grant token event mismatch', 'grant token run mismatch',
    'claim_event_consumptions', 'stale event lease', 'hnsw', 'vector retrieval',
    'at least 20', 'stale corpus manifest', 'positive path',
  ]) assert.match(source, new RegExp(marker, 'iu'), marker);
  assert.doesNotMatch(source, /'--dbname',\s*databaseUrl/iu);
});

test('requires twenty meaningful versioned cases before gate finalization', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  const record = sql.match(/CREATE FUNCTION ai\.record_embedding_gate_case\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  const finalize = sql.match(/CREATE FUNCTION ai\.finalize_embedding_space_gate\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(record, /case_input <> '\{\}'::jsonb/iu);
  assert.match(record, /case_expected_properties <> '\{\}'::jsonb/iu);
  assert.match(finalize, /cases < 20/iu);
  assert.match(finalize, /evaluation dataset contains empty cases/iu);
  assert.match(finalize, /JOIN ai\.evaluation_case/iu);
});

test('binds chunk persistence to the produced version and BUILDING space', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  const fn = sql.match(/CREATE FUNCTION ai\.persist_ingestion_chunk_embedding\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(fn, /p_document_version_id <> job\.produced_document_version_id/iu);
  assert.match(fn, /space_status <> 'BUILDING'/iu);
  assert.match(fn, /embedding space is not BUILDING/iu);
});

test('persists bounded ingestion attempt history and terminalizes exhausted leases', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  const claim = sql.match(/CREATE FUNCTION ai\.claim_ingestion_jobs\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(sql, /lease_expires_at timestamptz/iu);
  assert.match(claim, /INSERT INTO ai\.ingestion_attempt/iu);
  assert.match(claim, /LEASE_EXPIRED_MAX_ATTEMPTS/iu);
  assert.match(claim, /status = 'FAILED'/iu);
  assert.match(claim, /completed_at = statement_timestamp\(\)/iu);
  for (const fn of ['checkpoint_ingestion_attempt', 'finalize_ingestion_job', 'fail_ingestion_job']) {
    const definition = sql.match(new RegExp(`CREATE FUNCTION ai\\.${fn}\\([\\s\\S]*?\\$\\$;`, 'iu'))?.[0] ?? '';
    assert.match(definition, /ai\.ingestion_attempt/iu, fn);
  }
  const eventClaim = sql.match(/CREATE FUNCTION ai\.claim_event_consumptions\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(eventClaim, /LEASE_EXPIRED_MAX_ATTEMPTS/iu);
  assert.match(eventClaim, /status = 'DEAD'/iu);
  assert.match(eventClaim, /dead_at = statement_timestamp\(\)/iu);
  const heartbeat = sql.match(/CREATE FUNCTION ai\.heartbeat_ingestion_job\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(heartbeat, /p_lease[^\n]*interval/iu);
  assert.match(heartbeat, /lease_expires_at = transaction_timestamp\(\) \+ p_lease/iu);
  assert.match(heartbeat, /ingestion lease is not owned or has expired/iu);
  const batch = sql.match(/CREATE FUNCTION ai\.persist_ingestion_embedding_batch\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(batch, /jsonb_array_length\(p_chunks\).*BETWEEN 1 AND 100/isu);
  assert.match(batch, /PERFORM ai\.persist_ingestion_chunk_embedding/iu);
  assert.match(sql.match(/CREATE FUNCTION ai\.persist_ingestion_chunk_embedding\([\s\S]*?\$\$;/iu)?.[0] ?? '', /conflicting ingestion (?:chunk|embedding) replay/iu);
  assert.match(batch, /checkpoint = p_checkpoint/iu);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION ai\.heartbeat_ingestion_job/iu);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION ai\.persist_ingestion_embedding_batch/iu);
});

test('keeps first-release tool metadata inaccessible to AI', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  assert.doesNotMatch(sql, /GRANT SELECT ON[^;]*(?:ai\.tool_definition|ai\.agent_tool_grant)/iu);
  const live = readFileSync(governedPostgresqlTestPath, 'utf8');
  assert.match(live, /SELECT \* FROM ai\.tool_definition/iu);
  assert.match(live, /SELECT \* FROM ai\.agent_tool_grant/iu);
});

test('binds gate metrics to every case in an immutable published dataset version', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  assert.match(sql, /CREATE TABLE ai\.embedding_space_gate_evaluation[\s\S]*dataset_content_hash text NOT NULL/iu);
  assert.match(sql, /CREATE TABLE ai\.embedding_space_gate_result[\s\S]*dataset_content_hash text NOT NULL/iu);
  const begin = sql.match(/CREATE FUNCTION ai\.begin_embedding_space_gate\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(begin, /SELECT content_hash, status[\s\S]*FOR SHARE/iu);
  assert.match(begin, /dataset_status <> 'PUBLISHED'/iu);
  assert.match(begin, /dataset_content_hash/iu);
  const finalize = sql.match(/CREATE FUNCTION ai\.finalize_embedding_space_gate\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(finalize, /SELECT content_hash, status[\s\S]*FOR SHARE/iu);
  assert.match(finalize, /dataset_content_hash <> evaluation\.dataset_content_hash/iu);
  assert.match(finalize, /evidence_cases <> dataset_cases/iu);
  assert.match(finalize, /foreign_cases <> 0/iu);
  assert.match(finalize, /dataset_content_hash, corpus_manifest_digest/iu);
  for (const column of ['recall_numerator', 'recall_denominator', 'leakage_count', 'expected_outcome_hash', 'actual_outcome_hash', 'outcome_status']) {
    assert.match(sql, new RegExp(`CREATE TABLE ai\\.embedding_space_gate_case_evidence[\\s\\S]*\\b${column}\\b`, 'iu'), column);
  }
  assert.match(finalize, /outcome_status = 'MISMATCH'/iu);
  assert.match(sql, /outcome_mismatch_count bigint NOT NULL DEFAULT 0/iu);
  assert.match(finalize, /sum\(evidence\.leakage_count\)/iu);

  assert.match(sql, /CREATE FUNCTION ai\.enforce_evaluation_dataset_version_lifecycle\(\)/iu);
  assert.match(sql, /OLD\.status = 'PUBLISHED'[\s\S]*NEW\.status = 'RETIRED'/iu);
  assert.match(sql, /CREATE FUNCTION ai\.enforce_evaluation_case_lifecycle\(\)/iu);
  assert.match(sql, /evaluation cases for published or retired datasets are immutable/iu);

  const live = readFileSync(governedPostgresqlTestPath, 'utf8');
  assert.match(live, /cases\('000000000013', 100, 30\)/iu);
  assert.match(live, /partial evidence cannot finalize a complete evaluation dataset/iu);
  assert.match(live, /dataset version is not PUBLISHED/iu);
  assert.match(live, /dataset version content hash changed/iu);
});

test('preserves deterministic ingestion and provider invocation provenance', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  const ingestion = sql.match(/CREATE TABLE ai\.ingestion_job[\s\S]*?\n\);/iu)?.[0] ?? '';
  for (const column of ['source_object_hash', 'normalized_content_hash', 'parser_version', 'chunker_version']) {
    assert.match(ingestion, new RegExp(`\\b${column}\\b`, 'iu'));
  }
  assert.match(ingestion,
    /UNIQUE \(source_id, source_version, source_object_hash, normalized_content_hash,[\s\S]*parser_version, chunker_version, candidate_embedding_space_id\)/iu);
  assert.doesNotMatch(ingestion, /\n\s*content_hash text/iu);
  const persist = sql.match(/CREATE FUNCTION ai\.persist_ingestion_document_version\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(persist, /p_normalized_content_hash/iu);
  assert.match(persist, /job\.normalized_content_hash/iu);
  assert.match(sql, /NEW\.chunker_version IS DISTINCT FROM OLD\.chunker_version/iu);

  const invocation = sql.match(/CREATE TABLE ai\.model_invocation[\s\S]*?\n\);/iu)?.[0] ?? '';
  assert.match(invocation, /provider_request_id_hash text[\s\S]*\^\[0-9a-f\]\{64\}\$/iu);
  assert.doesNotMatch(invocation, /\n\s*provider_request_id text/iu);
  const finalize = sql.match(/CREATE FUNCTION ai\.finalize_model_invocation\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(finalize, /p_provider_request_id_hash text/iu);
  assert.doesNotMatch(finalize, /p_provider_request_id text[,)]/iu);
  assert.match(finalize, /provider request id hash must be lowercase SHA-256/iu);

  const live = readFileSync(governedPostgresqlTestPath, 'utf8');
  assert.match(live, /chunker-v2/iu);
  assert.match(live, /raw-provider-request-id/iu);
  assert.match(live, /provider_request_id_hash/iu);
});

test('revalidates gate corpus snapshots under locks before deciding', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  const evaluation = sql.match(/CREATE TABLE ai\.embedding_space_gate_evaluation[\s\S]*?\n\);/iu)?.[0] ?? '';
  assert.match(evaluation, /document_manifest text NOT NULL/iu);
  const begin = sql.match(/CREATE FUNCTION ai\.begin_embedding_space_gate\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(begin, /candidate_status <> 'BUILDING'/iu);
  assert.match(begin, /document_manifest/iu);
  const finalize = sql.match(/CREATE FUNCTION ai\.finalize_embedding_space_gate\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(finalize, /FROM ai\.embedding_space[\s\S]*FOR UPDATE/iu);
  assert.match(finalize, /candidate_status <> 'BUILDING'/iu);
  assert.match(finalize, /current_eligible <> evaluation\.eligible_count/iu);
  assert.match(finalize, /current_embedded <> evaluation\.embedded_count/iu);
  assert.match(finalize, /current_leakage <> evaluation\.leakage_count/iu);
  assert.match(finalize, /current_document_manifest IS DISTINCT FROM evaluation\.document_manifest/iu);
  assert.match(finalize, /gate corpus snapshot changed/iu);
});

test('protects retained artifacts and exposes only bounded AI cleanup', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  assert.match(sql, /CREATE FUNCTION ai\.enforce_run_artifact_lifecycle\(\)/iu);
  assert.match(sql, /artifact deletion requires bounded retention cleanup/iu);
  assert.match(sql, /active legal hold/iu);
  const cleanup = sql.match(/CREATE FUNCTION ai\.cleanup_expired_run_artifacts\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(cleanup, /p_limit IS NULL/iu);
  assert.match(cleanup, /p_limit NOT BETWEEN 1 AND 100/iu);
  assert.match(cleanup, /retention_until <= p_before/iu);
  assert.match(cleanup, /released_at IS NULL/iu);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION ai\.cleanup_expired_run_artifacts\(timestamptz, integer\) TO innorder_ai_runtime/iu);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION ai\.cleanup_expired_run_artifacts\([^;]*TO innorder_runtime/iu);
});

test('binds governed runs and invocations to immutable grant configuration', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  const grant = sql.match(/CREATE TABLE authz\.ai_authorization_grant[\s\S]*?\n\);/iu)?.[0] ?? '';
  for (const column of ['agent_version_id', 'model_profile_id', 'prompt_version_id', 'package_version_id', 'embedding_space_id']) {
    assert.match(grant, new RegExp(`\\b${column} uuid NOT NULL`, 'iu'));
  }
  const consume = sql.match(/CREATE FUNCTION authz\.consume_ai_authorization_grant\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(consume, /grant_row\.agent_version_id/iu);
  assert.match(consume, /grant_row\.model_profile_id/iu);
  const start = sql.match(/CREATE FUNCTION ai\.start_model_invocation\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(start, /run_model_profile_id IS DISTINCT FROM p_model_profile_id/iu);
  assert.match(start, /model profile does not match governed run/iu);
});

test('rejects null and out-of-range limits before every bounded LIMIT', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  for (const name of ['claim_ingestion_jobs', 'claim_event_consumptions']) {
    const fn = sql.match(new RegExp(`CREATE FUNCTION ai\\.${name}\\([\\s\\S]*?\\$\\$;`, 'iu'))?.[0] ?? '';
    assert.match(fn, /p_limit IS NULL/iu, name);
    assert.ok(fn.indexOf('p_limit IS NULL') < fn.indexOf('LIMIT p_limit'), name);
  }
  const retrieval = sql.match(/CREATE FUNCTION ai\.authorized_hybrid_retrieval\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  for (const limit of ['p_lexical_limit', 'p_vector_limit', 'p_result_limit']) {
    assert.match(retrieval, new RegExp(`${limit} IS NULL`, 'iu'));
  }
  assert.ok(retrieval.indexOf('p_lexical_limit IS NULL') < retrieval.indexOf('LIMIT p_lexical_limit'));
});

test('keeps every PostgreSQL role password out of psql argv', () => {
  const compose = readFileSync(composeRolePath, 'utf8');
  assert.doesNotMatch(compose, /--set=(?:flyway|runtime|ai_runtime)_password=/u);
  for (const binding of [
    '\\getenv flyway_password FLYWAY_PASSWORD',
    '\\getenv runtime_password RUNTIME_PASSWORD',
    '\\getenv ai_runtime_password AI_RUNTIME_PASSWORD',
  ]) assert.ok(compose.includes(binding), binding);
  assert.match(compose, /unset .*PASSWORD/iu);
  const live = readFileSync(governedPostgresqlTestPath, 'utf8');
  assert.match(live, /psql-argv/iu);
  assert.match(live, /sentinel/iu);
});

test('serializes ingestion and gates candidate-first with ordered job locks', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  const ingestion = sql.match(/CREATE TABLE ai\.ingestion_job[\s\S]*?\n\);/iu)?.[0] ?? '';
  assert.match(ingestion, /candidate_embedding_space_id uuid NOT NULL REFERENCES ai\.embedding_space\(id\)/iu);
  assert.match(sql, /NEW\.candidate_embedding_space_id IS DISTINCT FROM OLD\.candidate_embedding_space_id/iu);
  for (const name of [
    'claim_ingestion_jobs', 'persist_ingestion_document_version', 'persist_ingestion_chunk_embedding',
    'checkpoint_ingestion_attempt', 'finalize_ingestion_job', 'fail_ingestion_job',
    'begin_embedding_space_gate', 'finalize_embedding_space_gate',
  ]) {
    const fn = sql.match(new RegExp(`CREATE FUNCTION (?:ai\\.)${name}\\([\\s\\S]*?\\$\\$;`, 'iu'))?.[0] ?? '';
    const spaceLock = fn.search(/FROM ai\.embedding_space[\s\S]{0,200}FOR UPDATE/iu);
    const jobReadAfterSpace = fn.indexOf('FROM ai.ingestion_job', spaceLock);
    const jobLock = fn.indexOf('FOR UPDATE', jobReadAfterSpace);
    assert.ok(spaceLock >= 0 && jobReadAfterSpace > spaceLock && jobLock > jobReadAfterSpace,
      `${name} must lock candidate before ingestion job`);
  }
  const claim = sql.match(/CREATE FUNCTION ai\.claim_ingestion_jobs\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(claim, /ORDER BY job\.id[\s\S]*FOR UPDATE/iu);
  assert.match(sql, /ingestion completion is blocked by finalized gate/iu);
});

test('scopes every gate corpus job query to the evaluated candidate', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  const begin = sql.match(/CREATE FUNCTION ai\.begin_embedding_space_gate\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  const finalize = sql.match(/CREATE FUNCTION ai\.finalize_embedding_space_gate\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.ok((begin.match(/job\.candidate_embedding_space_id = p_candidate_embedding_space_id/giu) ?? []).length >= 2,
    'begin gate job locks and eligible corpus must be candidate-scoped');
  assert.ok((finalize.match(/job\.candidate_embedding_space_id = evaluation\.candidate_embedding_space_id/giu) ?? []).length >= 4,
    'finalize gate locks and recomputed corpus must be candidate-scoped');
});

test('serializes legal hold placement and cleanup run-first without dangling targets', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  const hold = sql.match(/CREATE FUNCTION ai\.validate_legal_hold_object_target\(\)[\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(hold, /FROM ai\.ai_run[\s\S]*FOR UPDATE/iu);
  assert.match(hold, /FROM ai\.ai_run_artifact[\s\S]*FOR UPDATE/iu);
  assert.ok(hold.indexOf('FROM ai.ai_run') < hold.indexOf('FROM ai.ai_run_artifact'));
  assert.match(hold, /legal hold target does not exist/iu);
  const cleanup = sql.match(/CREATE FUNCTION ai\.cleanup_expired_run_artifacts\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(cleanup, /FROM ai\.ai_run run[\s\S]*FOR UPDATE/iu);
  assert.match(cleanup, /FROM ai\.ai_run_artifact artifact[\s\S]*FOR UPDATE/iu);
  assert.ok(cleanup.indexOf('FROM ai.ai_run run') < cleanup.indexOf('FROM ai.ai_run_artifact artifact'));
  assert.match(cleanup, /held\.object_kind = 'RUN'/iu);
  const live = readFileSync(governedPostgresqlTestPath, 'utf8');
  assert.match(live, /deadlock regression/iu);
  assert.match(live, /dangling legal hold/iu);
  assert.match(live, /SET LOCAL lock_timeout/iu);
});

test('releases append-only legal holds through ordered bounded locking', () => {
  const sql = readMigration('V016__governed_ai_runtime.sql');
  const lifecycle = sql.match(/CREATE FUNCTION ai\.enforce_legal_hold_lifecycle\(\)[\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(lifecycle, /legal hold is append-only/iu);
  assert.match(lifecycle, /legal hold release requires bounded function/iu);
  assert.match(sql, /CREATE TRIGGER trg_legal_hold_lifecycle[\s\S]*BEFORE INSERT OR UPDATE OR DELETE ON ai\.legal_hold/iu);
  const release = sql.match(/CREATE FUNCTION ai\.release_legal_hold\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(release, /SECURITY DEFINER/iu);
  assert.match(release, /FROM ai\.ai_run run[\s\S]*FOR UPDATE/iu);
  assert.match(release, /FROM ai\.ai_run_artifact artifact[\s\S]*FOR UPDATE/iu);
  assert.match(release, /FROM ai\.legal_hold hold_row[\s\S]*FOR UPDATE/iu);
  assert.ok((release.match(/artifact\.legal_hold_id = p_hold_id/giu) ?? []).length >= 2,
    'release must discover direct artifact holds for both run and artifact locks');
  const runLock = release.indexOf('PERFORM 1 FROM ai.ai_run run');
  const releaseArtifactLock = release.indexOf('PERFORM 1 FROM ai.ai_run_artifact artifact', runLock);
  const releaseHoldLock = release.indexOf('FROM ai.legal_hold hold_row', releaseArtifactLock);
  assert.ok(runLock >= 0 && releaseArtifactLock > runLock && releaseHoldLock > releaseArtifactLock);
  const cleanup = sql.match(/CREATE FUNCTION ai\.cleanup_expired_run_artifacts\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  assert.match(cleanup, /FROM ai\.legal_hold hold_row[\s\S]*FOR UPDATE/iu);
  const artifactLock = cleanup.indexOf('SELECT * INTO artifact_row FROM ai.ai_run_artifact artifact');
  const holdLock = cleanup.indexOf('PERFORM 1 FROM ai.legal_hold hold_row', artifactLock);
  assert.ok(artifactLock >= 0 && holdLock > artifactLock);
  assert.match(sql, /REVOKE ALL ON FUNCTION ai\.release_legal_hold\(uuid, uuid\) FROM PUBLIC, innorder_ai_runtime/iu);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION ai\.release_legal_hold\(uuid, uuid\) TO innorder_runtime/iu);
  const live = readFileSync(governedPostgresqlTestPath, 'utf8');
  assert.match(live, /released hold was concurrently reactivated/iu);
  assert.match(live, /release-cleanup/iu);
});

test('retrofits optimistic versioning onto AI model profiles in V015', () => {
  const v007 = readMigration('V007__ai_rag.sql');
  const v015 = readMigration('V016__governed_ai_runtime.sql');
  const originalProfile = v007.match(/CREATE TABLE ai\.model_profile\s*\([\s\S]*?\n\);/iu)?.[0] ?? '';
  assert.doesNotMatch(originalProfile, /\brow_version\b|\bupdated_at\b/iu);
  assert.match(v015, /ALTER TABLE ai\.model_profile[\s\S]*ADD COLUMN row_version bigint NOT NULL DEFAULT 0 CHECK \(row_version >= 0\)[\s\S]*ADD COLUMN updated_at timestamptz NOT NULL DEFAULT statement_timestamp\(\)/iu);
  assert.match(v015, /CREATE TRIGGER trg_model_profile_touch[\s\S]*BEFORE UPDATE ON ai\.model_profile[\s\S]*EXECUTE FUNCTION platform\.touch_updated_at\(\)/iu);
  assert.equal((v015.match(/CREATE TRIGGER trg_model_profile_touch/giu) ?? []).length, 1,
    'model profiles must have exactly one row-version increment trigger');
});
