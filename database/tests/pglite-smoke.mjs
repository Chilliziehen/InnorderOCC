import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleRoot = process.env.PGLITE_MODULE_ROOT;
if (!moduleRoot) {
  throw new Error('PGLITE_MODULE_ROOT must point to @electric-sql/pglite');
}

const { PGlite } = await import(pathToFileURL(join(moduleRoot, 'dist/index.js')));
const { btree_gist } = await import(pathToFileURL(join(moduleRoot, 'dist/contrib/btree_gist.js')));

const db = new PGlite({ extensions: { btree_gist } });
await db.waitReady;

const runtimeRoleBootstrap = readFileSync(
  resolve('database/bootstrap/001-create-runtime-role.sql'),
  'utf8',
);
await db.exec(runtimeRoleBootstrap);
await db.exec(runtimeRoleBootstrap);
const runtimeRole = await db.query(
  "SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = 'innorder_runtime'",
);
if (runtimeRole.rows.length !== 1 || runtimeRole.rows[0].rolcanlogin !== false) {
  throw new Error('runtime role bootstrap must be idempotent and create a NOLOGIN role');
}
console.log('passed idempotent NOLOGIN runtime role bootstrap');
const aiRuntimeRole = await db.query(
  "SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = 'innorder_ai_runtime'",
);
if (aiRuntimeRole.rows.length !== 1 || aiRuntimeRole.rows[0].rolcanlogin !== false) {
  throw new Error('AI runtime role bootstrap must be idempotent and create a NOLOGIN role');
}

const migrationDir = resolve('database/migrations');
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

async function applyMigration(migration) {
  let sql = readFileSync(join(migrationDir, migration), 'utf8');
  if (migration === 'V001__bootstrap.sql') {
    sql = sql.replace(
      /CREATE EXTENSION IF NOT EXISTS vector;/i,
      'CREATE DOMAIN vector AS double precision[];',
    );
  }
  if (migration === 'V015__governed_ai_runtime.sql') {
    sql = sql
      .replace(/\(1 - \(embedding\.embedding OPERATOR\(public\.<=>\) p_query_embedding\)\)::double precision/g,
        '1::double precision')
      .replace(/embedding\.embedding OPERATOR\(public\.<=>\) p_query_embedding/g, 'chunk.id::text');
  }
  await db.exec(sql);
  console.log(`applied ${migration}`);
}

for (const migration of migrations.slice(0, migrations.indexOf('V010__platform_security_kernel.sql'))) {
  await applyMigration(migration);
}

await db.exec(`
  INSERT INTO catalog.domain_package
    (id, package_key, name, status, row_version, created_at, updated_at)
  VALUES
    ('90000000-0000-7000-8000-000000000001', 'legacy.security', 'Legacy security', 'ACTIVE', 0, now(), now());
  INSERT INTO catalog.package_version (id, package_id, semver, status, manifest, created_at)
  VALUES
    ('90000000-0000-7000-8000-000000000002', '90000000-0000-7000-8000-000000000001', '1.0.0', 'DRAFT', '{}'::jsonb, now());
  INSERT INTO catalog.entity_type (id, package_id, type_key, name, entity_kind, authorizable)
  VALUES
    ('90000000-0000-7000-8000-000000000003', '90000000-0000-7000-8000-000000000001', 'legacy_user', 'Legacy user', 'PRINCIPAL', true);
  INSERT INTO catalog.entity_type_version
    (id, entity_type_id, package_version_id, schema_version, json_schema, ui_schema, auth_schema, index_spec)
  VALUES
    ('90000000-0000-7000-8000-000000000004', '90000000-0000-7000-8000-000000000003',
     '90000000-0000-7000-8000-000000000002', 1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
  INSERT INTO authz.entity
    (id, entity_type_id, entity_type_version_id, entity_key, state, auth_attributes, row_version, created_at, updated_at)
  VALUES
    ('90000000-0000-7000-8000-000000000005', '90000000-0000-7000-8000-000000000003',
     '90000000-0000-7000-8000-000000000004', 'legacy:user', 'ACTIVE', '{}'::jsonb, 0, now(), now());
  INSERT INTO iam.principal
    (id, principal_kind, display_name, status, profile, row_version, created_at, updated_at)
  VALUES
    ('90000000-0000-7000-8000-000000000005', 'USER', 'Legacy User', 'ACTIVE', '{}'::jsonb, 0, now(), now());

  INSERT INTO audit.idempotency_record
    (id, principal_id, command_key, idempotency_key, request_hash, response_status,
     response_digest, resource_id, created_at, expires_at)
  VALUES
    ('90000000-0000-7000-8000-000000000010', '90000000-0000-7000-8000-000000000005',
     'legacy.complete', 'complete', repeat('a', 64), 200, repeat('b', 64),
     '90000000-0000-7000-8000-000000000005', now(), now() + interval '1 hour'),
    ('90000000-0000-7000-8000-000000000011', '90000000-0000-7000-8000-000000000005',
     'legacy.race', 'race', repeat('c', 64), NULL, NULL, NULL, now(), now() + interval '1 hour'),
    ('90000000-0000-7000-8000-000000000012', '90000000-0000-7000-8000-000000000005',
     'legacy.failed', 'failed', repeat('d', 64), 500, NULL, NULL, now(), now() + interval '1 hour'),
    ('90000000-0000-7000-8000-000000000013', '90000000-0000-7000-8000-000000000005',
     'legacy.resource-failed', 'resource-failed', repeat('f', 64), NULL, NULL,
     '90000000-0000-7000-8000-000000000005', now(), now() + interval '1 hour');

  INSERT INTO audit.outbox_event
    (id, aggregate_type, aggregate_id, aggregate_version, event_type, schema_version,
     payload, correlation_id, available_at, attempts, status, published_at, created_at)
  VALUES
    ('90000000-0000-7000-8000-000000000020', 'legacy', '90000000-0000-7000-8000-000000000005', 1,
     'legacy.pending', 1, '{}'::jsonb, '90000000-0000-7000-8000-000000000030',
     now() + interval '2 hours', 0, 'PENDING', now(), now()),
    ('90000000-0000-7000-8000-000000000021', 'legacy', '90000000-0000-7000-8000-000000000005', 2,
     'legacy.publishing', 1, '{}'::jsonb, '90000000-0000-7000-8000-000000000031', now(), 1, 'PUBLISHING', now(), now()),
    ('90000000-0000-7000-8000-000000000022', 'legacy', '90000000-0000-7000-8000-000000000005', 3,
     'legacy.published', 1, '{}'::jsonb, '90000000-0000-7000-8000-000000000032', now(), 1, 'PUBLISHED', now(), now()),
    ('90000000-0000-7000-8000-000000000023', 'legacy', '90000000-0000-7000-8000-000000000005', 4,
     'legacy.dead', 1, '{}'::jsonb, '90000000-0000-7000-8000-000000000033', now(), 3, 'DEAD', now(), now());
`);
console.log('inserted representative V009 legacy rows');

await applyMigration('V010__platform_security_kernel.sql');

await db.exec(`
  INSERT INTO audit.outbox_event
    (id, aggregate_type, aggregate_id, aggregate_version, event_type, schema_version,
     payload, correlation_id, customer_instance_id, available_at, status, created_at)
  VALUES
    ('90000000-0000-7000-8000-000000000024', 'legacy', '90000000-0000-7000-8000-000000000005', 5,
     'legacy.future', 1, '{}'::jsonb, '90000000-0000-7000-8000-000000000034',
     '00000000-0000-7000-8000-000000000001', now() + interval '3 hours', 'PENDING', now());
`);
const futureOutbox = await db.query(`
  SELECT next_attempt_at = available_at AS schedule_initialized
  FROM audit.outbox_event
  WHERE id = '90000000-0000-7000-8000-000000000024'
`);
if (futureOutbox.rows.length !== 1 || !futureOutbox.rows[0].schedule_initialized) {
  throw new Error('future outbox insert did not initialize next_attempt_at from available_at');
}

const legacyIdempotency = await db.query(`
  SELECT id::text, state, updated_at = created_at AS timestamps_preserved, resource_id::text
  FROM audit.idempotency_record
  WHERE id::text LIKE '90000000-0000-7000-8000-00000000001%'
  ORDER BY id
`);
const expectedStates = ['COMPLETED', 'IN_PROGRESS', 'FAILED', 'FAILED'];
if (legacyIdempotency.rows.length !== 4
    || legacyIdempotency.rows.some((row, index) => row.state !== expectedStates[index] || !row.timestamps_preserved)
    || legacyIdempotency.rows[3].resource_id !== '90000000-0000-7000-8000-000000000005') {
  throw new Error('V010 idempotency backfill is not deterministic');
}

const legacyOutbox = await db.query(`
  SELECT status, customer_instance_id::text, next_attempt_at = available_at AS schedule_preserved,
         published_at IS NOT NULL AS has_published_at, claimed_at IS NOT NULL AS has_claimed_at,
         last_error
  FROM audit.outbox_event
  WHERE id::text BETWEEN '90000000-0000-7000-8000-000000000020'
                     AND '90000000-0000-7000-8000-000000000023'
  ORDER BY id
`);
if (legacyOutbox.rows.length !== 4
    || legacyOutbox.rows.some((row) => row.customer_instance_id !== '00000000-0000-7000-8000-000000000001' || !row.schedule_preserved)
    || legacyOutbox.rows[0].has_published_at || legacyOutbox.rows[0].has_claimed_at
    || legacyOutbox.rows[1].has_published_at || !legacyOutbox.rows[1].has_claimed_at
    || !legacyOutbox.rows[2].has_published_at || !legacyOutbox.rows[2].has_claimed_at
    || legacyOutbox.rows[3].has_published_at || legacyOutbox.rows[3].last_error !== 'delivery failed') {
  throw new Error('V010 outbox backfill is not deterministic');
}
console.log('passed V010 legacy upgrade backfill');

await db.exec(`
  INSERT INTO iam.user_account
    (principal_id, username, password_hash, failed_attempts, locked_until)
  VALUES
    ('90000000-0000-7000-8000-000000000005', 'legacy.user', NULL, 0, now() + interval '15 minutes');
`);
await applyMigration('V011__account_failed_attempt_window.sql');
const legacyAccountWindow = await db.query(`
  SELECT failed_attempts, failed_window_started_at = locked_until - interval '15 minutes' AS window_preserved
  FROM iam.user_account
  WHERE principal_id = '90000000-0000-7000-8000-000000000005'
`);
if (legacyAccountWindow.rows.length !== 1
    || legacyAccountWindow.rows[0].failed_attempts !== 5
    || !legacyAccountWindow.rows[0].window_preserved) {
  throw new Error('V011 failed-attempt window backfill is not forward-compatible');
}
console.log('passed V011 legacy account failure-window backfill');

await applyMigration('V012__outbox_publisher_lifecycle.sql');
await applyMigration('V015__governed_ai_runtime.sql');

for (const relation of [
  'authz.ai_authorization_grant',
  'authz.ai_authorized_document',
  'ai.ingestion_job',
  'ai.ingestion_attempt',
  'ai.event_consumption',
  'ai.model_invocation',
  'ai.retrieval_trace',
  'ai.retrieval_hit',
  'ai.embedding_space_gate_result',
  'ai.embedding_space_gate_evaluation',
  'ai.embedding_space_gate_case_evidence',
  'ai.retention_policy',
]) {
  const result = await db.query('SELECT to_regclass($1) IS NOT NULL AS present', [relation]);
  if (!result.rows[0]?.present) throw new Error(`${relation} is missing after V015`);
}
for (const routine of [
  'authz.consume_ai_authorization_grant',
  'ai.claim_ingestion_jobs',
  'ai.claim_event_consumptions',
  'ai.authorized_hybrid_retrieval',
  'ai.persist_ingestion_document_version',
  'ai.persist_ingestion_chunk_embedding',
  'ai.checkpoint_ingestion_attempt',
  'ai.finalize_ingestion_job',
  'ai.register_event_consumption',
  'ai.finalize_event_consumption',
  'ai.transition_ai_run',
  'ai.start_model_invocation',
  'ai.finalize_model_invocation',
  'ai.persist_run_artifact',
  'ai.record_retrieval_trace',
  'ai.record_retrieval_hit',
  'ai.begin_embedding_space_gate',
  'ai.record_embedding_gate_case',
  'ai.finalize_embedding_space_gate',
]) {
  const result = await db.query(`
    SELECT count(*)::integer AS count
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname || '.' || p.proname = $1
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
  `, [routine]);
  if (result.rows[0]?.count !== 1) throw new Error(`${routine} is not a hardened SECURITY DEFINER function`);
}
console.log('passed V015 governed AI contracts');

const provenanceColumns = await db.query(`
  SELECT table_name, column_name
  FROM information_schema.columns
  WHERE table_schema = 'ai'
    AND ((table_name = 'ingestion_job' AND column_name IN
      ('source_object_hash', 'normalized_content_hash', 'parser_version', 'chunker_version'))
      OR (table_name = 'model_invocation' AND column_name = 'provider_request_id_hash'))
`);
if (provenanceColumns.rows.length !== 5) throw new Error('V015 provenance columns are incomplete');
const rawProviderColumn = await db.query(`
  SELECT count(*)::integer AS count FROM information_schema.columns
  WHERE table_schema = 'ai' AND table_name = 'model_invocation' AND column_name = 'provider_request_id'
`);
if (rawProviderColumn.rows[0]?.count !== 0) throw new Error('raw provider request ID column must not exist');

await db.exec(`UPDATE audit.idempotency_record
               SET state = 'COMPLETED', response_status = 200, response_digest = repeat('e', 64)
               WHERE id = '90000000-0000-7000-8000-000000000011'`);
try {
  await db.exec(`UPDATE audit.idempotency_record
                 SET state = 'FAILED', response_status = 500
                 WHERE id = '90000000-0000-7000-8000-000000000011'`);
  throw new Error('sequential terminal idempotency transition was accepted');
} catch (error) {
  if (error.code !== '55000') throw error;
}
console.log('passed sequential idempotency terminal transition coverage');

for (const testFile of ['000_assert.sql', '001_schema_contract.sql', '002_constraints.sql']) {
  const sql = readFileSync(resolve('database/tests', testFile), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n')
    .replace(
      /EXISTS \(SELECT 1 FROM pg_extension WHERE extname = 'vector'\)/i,
      "EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector')",
    );
  await db.exec(sql);
  console.log(`passed ${testFile}`);
}

await db.close();
console.log('PGlite PostgreSQL smoke test passed');
