import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../migrations/', import.meta.url));
const runtimeRoleBootstrapPath = fileURLToPath(
  new URL('../bootstrap/001-create-runtime-role.sql', import.meta.url),
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
