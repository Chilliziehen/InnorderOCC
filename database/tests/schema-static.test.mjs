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
  'V015__governed_ai_runtime.sql',
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
  const sql = readMigration('V015__governed_ai_runtime.sql');
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
    'expires_at', 'consumed_at', 'event_id', 'run_id',
  ]) assert.match(sql, new RegExp(`\\b${column}\\b`, 'iu'), column);
  assert.match(sql, /expires_at <= issued_at \+ interval '5 minutes'/iu);
  assert.match(sql, /authorized document limit of 500 exceeded/iu);
  assert.doesNotMatch(sql, /LIMIT\s+500[\s\S]*INSERT INTO authz\.ai_authorized_document/iu);
  assert.match(sql, /CREATE TRIGGER trg_ai_authorization_grant_lifecycle/iu);
  assert.match(sql, /CREATE TRIGGER trg_ai_authorized_document_immutable/iu);
  assert.match(sql, /retention_until[\s\S]*interval '1 year'/iu);
  assert.match(sql, /legal_hold/iu);
});

test('defines deterministic workers, durable event consumption, traces, and gates', () => {
  const sql = readMigration('V015__governed_ai_runtime.sql');
  for (const term of [
    'source_version', 'content_hash', 'checkpoint', 'stage', 'lease_owner',
    'lease_expires_at', 'next_attempt_at', 'sanitized_error', 'corpus_manifest_digest',
    'consumer_key', 'event_id', 'schema_version', 'aggregate_version', 'DEAD',
    'provider_request_id', 'capability_hash', 'request_hash', 'response_hash',
    'lexical_score', 'vector_score', 'fused_score', 'injection_detected',
    'eligible_count', 'embedded_count', 'leakage_count', 'citation_numerator',
    'citation_denominator', 'citation_precision', 'recall_sum', 'recall_count',
    'recall_mean', 'decision', 'evidence_hash',
  ]) assert.match(sql, new RegExp(`\\b${term}\\b`, 'iu'), term);
  for (const index of [
    'ix_ingestion_job_claim', 'ix_ingestion_job_stale_lease', 'ix_event_consumption_claim',
    'ix_event_consumption_stale_lease', 'ix_model_invocation_run',
    'ix_model_invocation_provider_request', 'ix_retrieval_trace_run',
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
  const sql = readMigration('V015__governed_ai_runtime.sql');
  for (const name of [
    'authz.consume_ai_authorization_grant',
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
  assert.doesNotMatch(readMigration('V015__governed_ai_runtime.sql'), /CREATE ROLE/iu);

  const compose = readFileSync(composeRolePath, 'utf8');
  assert.match(compose, /AI_DATABASE_PASSWORD_FILE/iu);
  assert.match(compose, /ALTER ROLE %I LOGIN PASSWORD %L/iu);
  assert.match(compose, /innorder_ai_runtime/iu);

  const testInit = readFileSync(coreTestInitPath, 'utf8');
  assert.match(testInit, /CREATE ROLE innorder_ai_runtime NOLOGIN/iu);

  const sql = readMigration('V015__governed_ai_runtime.sql');
  assert.match(sql, /GRANT USAGE ON SCHEMA ai, public TO innorder_ai_runtime/iu);
  assert.match(sql, /GRANT SELECT ON[\s\S]*ai\.knowledge_document_version[\s\S]*ai\.knowledge_chunk[\s\S]*ai\.chunk_embedding[\s\S]*TO innorder_ai_runtime/iu);
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
  const sql = readMigration('V015__governed_ai_runtime.sql');
  assert.match(sql, /octet_length\(bounded_context::text\) <= 32768/iu);
  const consume = sql.match(/CREATE FUNCTION authz\.consume_ai_authorization_grant\([\s\S]*?\$\$;/iu)?.[0] ?? '';
  for (const parameter of [
    'p_event_id uuid', 'p_operation text', 'p_authorization_revision bigint',
    'p_policy_release_digest text', 'p_authorized_set_digest text', 'p_context_digest text',
  ]) assert.match(consume, new RegExp(parameter, 'iu'), parameter);
  assert.match(consume, /grant token event mismatch/iu);
  assert.match(consume, /grant token operation mismatch/iu);
  assert.match(consume, /grant token authorized-set digest mismatch/iu);
  assert.match(consume, /grant token context digest mismatch/iu);
  assert.match(consume, /grant token run mismatch/iu);
  assert.match(consume, /authorization_revision <> p_authorization_revision/iu);
});

test('fails embedding gates closed with fixed manifest-bound evidence', () => {
  const sql = readMigration('V015__governed_ai_runtime.sql');
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
  const sql = readMigration('V015__governed_ai_runtime.sql');
  assert.match(sql, /CREATE TABLE ai\.retention_policy\b/iu);
  assert.match(sql, /retention_interval interval NOT NULL DEFAULT interval '1 year'/iu);
  for (const table of ['model_invocation', 'retrieval_trace', 'retrieval_hit', 'embedding_space_gate_result']) {
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
    'record_retrieval_trace', 'record_retrieval_hit',
  ]) assert.match(sql, new RegExp(`CREATE FUNCTION ai\\.${fn}\\(`, 'iu'), fn);
  assert.match(sql, /GRANT SELECT ON ai\.model_provider/iu);
  assert.doesNotMatch(sql, /GRANT SELECT, INSERT(?:, UPDATE)? ON ai\.(?:knowledge_document_version|knowledge_chunk|chunk_embedding|ingestion_job|ingestion_attempt|event_consumption|model_invocation|retrieval_trace|retrieval_hit)/iu);
});

test('requires live LOGIN, denial, concurrency, vector, event, and gate coverage', () => {
  const source = readFileSync(governedPostgresqlTestPath, 'utf8');
  for (const marker of [
    'innorder_ai_runtime LOGIN PASSWORD', 'aiConnectionEnvironment', 'PGPASSWORD',
    'knowledge_document', 'recommendation', 'iam.principal', 'occ.business_object',
    'audit.outbox_event', 'flowable', 'expired', 'stale authorization revision',
    'authorized-set digest mismatch', 'grant token event mismatch', 'grant token run mismatch',
    'claim_event_consumptions', 'stale event lease', 'hnsw', 'vector retrieval',
    'empty gate evidence', 'stale corpus manifest', 'positive path',
  ]) assert.match(source, new RegExp(marker, 'iu'), marker);
  assert.doesNotMatch(source, /'--dbname',\s*databaseUrl/iu);
});
