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
  'V014__evidence_risk_resource.sql',
];

async function applyMigration(migration) {
  let sql = readFileSync(join(migrationDir, migration), 'utf8');
  if (migration === 'V001__bootstrap.sql') {
    sql = sql.replace(
      /CREATE EXTENSION IF NOT EXISTS vector;/i,
      'CREATE DOMAIN vector AS double precision[];',
    );
  }
  await db.exec(sql);
  console.log(`applied ${migration}`);
}

const stagedUpgradeMigrations = new Set([
  'V010__platform_security_kernel.sql',
  'V011__account_failed_attempt_window.sql',
  'V012__outbox_publisher_lifecycle.sql',
  'V014__evidence_risk_resource.sql',
]);
for (const migration of migrations.filter((name) => !stagedUpgradeMigrations.has(name))) {
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
await applyMigration('V014__evidence_risk_resource.sql');

const v14FunctionSecurity = await db.query(`
  SELECT p.proname, p.prosecdef, p.proconfig,
         pg_get_userbyid(p.proowner) AS owner_name, current_user AS migration_owner,
         has_function_privilege('innorder_runtime', p.oid, 'EXECUTE') AS runtime_execute,
         p.prorettype = 'pg_catalog.trigger'::regtype AS trigger_only
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'occ'
    AND p.proname IN (
      'validate_upload_session_lifecycle', 'validate_evidence_version_provenance',
      'validate_evidence_review_insert', 'validate_evidence_head_lifecycle',
      'validate_evidence_object_disposition', 'validate_risk_lifecycle',
      'validate_risk_occurrence_insert', 'validate_risk_action_insert',
      'validate_risk_adjudication_insert', 'enforce_risk_occurrence_completeness',
      'validate_resource_availability',
      'validate_resource_reservation', 'reject_resource_reservation_delete',
      'validate_managed_resource_change', 'snapshot_resource_reservation',
      'validate_resource_reservation_history_change'
    )
`);
const reservationSnapshotFunction = v14FunctionSecurity.rows.find((row) => row.proname === 'snapshot_resource_reservation');
if (v14FunctionSecurity.rows.length !== 16
    || !reservationSnapshotFunction?.prosecdef
    || reservationSnapshotFunction.owner_name !== reservationSnapshotFunction.migration_owner
    || reservationSnapshotFunction.runtime_execute
    || !reservationSnapshotFunction.trigger_only
    || reservationSnapshotFunction.proconfig?.[0] !== 'search_path=pg_catalog, occ'
    || v14FunctionSecurity.rows.some((row) => row.proname !== 'snapshot_resource_reservation'
      && (row.prosecdef || row.runtime_execute || !row.trigger_only
        || row.proconfig?.[0] !== 'search_path=pg_catalog, occ, pg_temp'))) {
  throw new Error('V014 trigger functions expose an elevated or directly callable runtime API');
}
const reservationHistoryPrivileges = await db.query(`
  SELECT has_table_privilege('innorder_runtime', 'occ.resource_reservation_history', 'SELECT') AS can_select,
         has_table_privilege('innorder_runtime', 'occ.resource_reservation_history', 'INSERT') AS can_insert,
         has_table_privilege('innorder_runtime', 'occ.resource_reservation_history', 'UPDATE') AS can_update,
         has_table_privilege('innorder_runtime', 'occ.resource_reservation_history', 'DELETE') AS can_delete
`);
if (!reservationHistoryPrivileges.rows[0]?.can_select
    || reservationHistoryPrivileges.rows[0]?.can_insert
    || reservationHistoryPrivileges.rows[0]?.can_update
    || reservationHistoryPrivileges.rows[0]?.can_delete) {
  throw new Error('runtime reservation history privileges are not append-trigger-only');
}
console.log('passed V014 trigger-only function security boundary');

async function expectSqlState(sql, expectedCode, label) {
  let caught;
  await db.exec('BEGIN');
  try {
    await db.exec(sql);
  } catch (error) {
    caught = error;
  }
  await db.exec('ROLLBACK');
  if (!caught) throw new Error(`${label} was accepted`);
  if (caught.code !== expectedCode) throw caught;
}

async function expectCommitSqlState(sql, expectedCode, label) {
  let caught;
  await db.exec('BEGIN');
  await db.exec(sql);
  try {
    await db.exec('COMMIT');
  } catch (error) {
    caught = error;
    await db.exec('ROLLBACK');
  }
  if (!caught) throw new Error(`${label} committed`);
  if (caught.code !== expectedCode) throw caught;
}

await db.exec(`
  INSERT INTO catalog.evidence_requirement
    (id, package_version_id, requirement_key, allowed_types, min_count, validation_schema)
  VALUES
    ('92000000-0000-7000-8000-000000000010', '90000000-0000-7000-8000-000000000002',
     'portable.evidence', '["text/plain"]'::jsonb, 1, '{}'::jsonb),
    ('92000000-0000-7000-8000-000000000011', '90000000-0000-7000-8000-000000000002',
     'portable.other', '["text/plain"]'::jsonb, 1, '{}'::jsonb);
  INSERT INTO catalog.risk_rule_definition
    (id, package_version_id, rule_key, dmn_key, severity, deadline_policy, content_hash)
  VALUES
    ('92000000-0000-7000-8000-000000000012', '90000000-0000-7000-8000-000000000002',
     'portable.risk', 'portable-risk', 'YELLOW', '{}'::jsonb, repeat('f', 64));

  INSERT INTO authz.entity
    (id, entity_type_id, entity_type_version_id, entity_key, state, auth_attributes)
  SELECT id, '90000000-0000-7000-8000-000000000003',
         '90000000-0000-7000-8000-000000000004', entity_key, 'ACTIVE', '{}'::jsonb
  FROM (VALUES
    ('92000000-0000-7000-8000-000000000001'::uuid, 'portable:target'),
    ('92000000-0000-7000-8000-000000000002'::uuid, 'portable:evidence'),
    ('92000000-0000-7000-8000-000000000003'::uuid, 'portable:archived-evidence'),
    ('92000000-0000-7000-8000-000000000004'::uuid, 'portable:duplicate-evidence'),
    ('92000000-0000-7000-8000-000000000005'::uuid, 'portable:reviewer'),
    ('92000000-0000-7000-8000-000000000006'::uuid, 'portable:risk'),
    ('92000000-0000-7000-8000-000000000007'::uuid, 'portable:resource'),
    ('92000000-0000-7000-8000-000000000008'::uuid, 'portable:duplicate-risk')
  ) fixture(id, entity_key);
  INSERT INTO iam.principal (id, principal_kind, display_name, status)
  VALUES ('92000000-0000-7000-8000-000000000005', 'USER', 'Portable Reviewer', 'ACTIVE');
  INSERT INTO occ.business_object (id, entity_type_version_id, lifecycle_state, data)
  VALUES ('92000000-0000-7000-8000-000000000001',
          '90000000-0000-7000-8000-000000000004', 'ACTIVE', '{}'::jsonb);

  INSERT INTO occ.evidence
    (id, business_object_id, requirement_id, state, created_by, target_entity_id, slot_key)
  VALUES
    ('92000000-0000-7000-8000-000000000002', '92000000-0000-7000-8000-000000000001',
     '92000000-0000-7000-8000-000000000010', 'PENDING',
     '90000000-0000-7000-8000-000000000005', '92000000-0000-7000-8000-000000000001', 'main'),
    ('92000000-0000-7000-8000-000000000003', '92000000-0000-7000-8000-000000000001',
     '92000000-0000-7000-8000-000000000010', 'PENDING',
     '90000000-0000-7000-8000-000000000005', '92000000-0000-7000-8000-000000000001', 'archived-slot');
  UPDATE occ.evidence SET state = 'ARCHIVED' WHERE id = '92000000-0000-7000-8000-000000000003';
`);

await expectSqlState(`
  INSERT INTO occ.evidence
    (id, business_object_id, requirement_id, state, created_by, target_entity_id, slot_key)
  VALUES ('92000000-0000-7000-8000-000000000004', '92000000-0000-7000-8000-000000000001',
          '92000000-0000-7000-8000-000000000010', 'PENDING',
          '90000000-0000-7000-8000-000000000005', '92000000-0000-7000-8000-000000000001',
          'archived-slot')
`, '23505', 'archived evidence slot reuse');

await expectSqlState(`
  INSERT INTO occ.upload_session
    (id, uploader_id, target_entity_id, object_key, expected_sha256, expected_size_bytes,
     status, expires_at, requirement_id, evidence_id, slot_key, normalized_extension,
     quarantine_object_key, immutable_object_key, absolute_deadline_at)
  VALUES ('92000000-0000-7000-8000-000000000020', '90000000-0000-7000-8000-000000000005',
          '92000000-0000-7000-8000-000000000001', 'lease-too-long', repeat('a', 64), 10,
          'CREATED', transaction_timestamp() + interval '31 minutes',
          '92000000-0000-7000-8000-000000000010', '92000000-0000-7000-8000-000000000002',
          'main', 'txt', 'quarantine/lease-too-long', 'evidence/lease-too-long',
          transaction_timestamp() + interval '2 hours 1 second')
`, '23514', 'unbounded upload lease');

await expectSqlState(`
  INSERT INTO occ.upload_session
    (id, uploader_id, target_entity_id, object_key, expected_sha256, expected_size_bytes,
     status, expires_at, requirement_id, evidence_id, slot_key, normalized_extension,
     quarantine_object_key, immutable_object_key, absolute_deadline_at)
  VALUES ('92000000-0000-7000-8000-000000000021', '90000000-0000-7000-8000-000000000005',
          '92000000-0000-7000-8000-000000000001', 'wrong-requirement', repeat('a', 64), 10,
          'CREATED', transaction_timestamp() + interval '30 minutes',
          '92000000-0000-7000-8000-000000000011', '92000000-0000-7000-8000-000000000002',
          'main', 'txt', 'quarantine/wrong-requirement', 'evidence/wrong-requirement',
          transaction_timestamp() + interval '2 hours')
`, '23514', 'mismatched upload provenance');

await db.exec(`
  INSERT INTO occ.upload_session
    (id, uploader_id, target_entity_id, object_key, expected_sha256, expected_size_bytes,
     status, expires_at, requirement_id, evidence_id, slot_key, normalized_extension,
     quarantine_object_key, immutable_object_key, absolute_deadline_at)
  VALUES
    ('92000000-0000-7000-8000-000000000022', '90000000-0000-7000-8000-000000000005',
          '92000000-0000-7000-8000-000000000001', 'quarantine/main', repeat('a', 64), 10,
     'CREATED', transaction_timestamp() + interval '30 minutes',
     '92000000-0000-7000-8000-000000000010', '92000000-0000-7000-8000-000000000002',
     'main', 'txt', 'quarantine/main', 'evidence/main', transaction_timestamp() + interval '2 hours'),
    ('92000000-0000-7000-8000-000000000023', '90000000-0000-7000-8000-000000000005',
     '92000000-0000-7000-8000-000000000001', 'quarantine/spare', repeat('b', 64), 11,
     'CREATED', transaction_timestamp() + interval '30 minutes',
     '92000000-0000-7000-8000-000000000010', '92000000-0000-7000-8000-000000000002',
     'main', 'txt', 'quarantine/spare', 'evidence/spare', transaction_timestamp() + interval '2 hours');
  UPDATE occ.upload_session
  SET status = 'STREAMING', lease_owner = '90000000-0000-7000-8000-000000000005',
      lease_acquired_at = transaction_timestamp(), lease_heartbeat_at = transaction_timestamp(),
      lease_expires_at = transaction_timestamp() + interval '5 minutes',
      actual_sha256 = repeat('a', 64), actual_size_bytes = 10, detected_media_type = 'text/plain',
      scanner_engine = 'portable', scanner_version = '1', scanner_result_ref = 'clean:1'
  WHERE id = '92000000-0000-7000-8000-000000000022';
  UPDATE occ.upload_session SET status = 'INSPECTING' WHERE id = '92000000-0000-7000-8000-000000000022';
  UPDATE occ.upload_session SET status = 'SCANNING' WHERE id = '92000000-0000-7000-8000-000000000022';
  UPDATE occ.upload_session SET status = 'PROMOTING' WHERE id = '92000000-0000-7000-8000-000000000022';
`);

await expectSqlState(`
  UPDATE occ.upload_session
  SET status = 'STREAMING', lease_owner = '90000000-0000-7000-8000-000000000005',
      lease_acquired_at = transaction_timestamp(), lease_heartbeat_at = transaction_timestamp(),
      lease_expires_at = transaction_timestamp()
  WHERE id = '92000000-0000-7000-8000-000000000023'
`, '23514', 'non-increasing upload lease chronology');

await expectSqlState(`
  INSERT INTO occ.evidence_version
    (id, evidence_id, version, object_key, sha256, mime_type, size_bytes, submitted_by,
     upload_session_id, detected_media_type, normalized_extension, scanner_engine,
     scanner_version, scanner_result, scanner_result_ref)
  VALUES ('92000000-0000-7000-8000-000000000031', '92000000-0000-7000-8000-000000000002',
          1, 'evidence/main', repeat('a', 64), 'text/plain', 10,
          '90000000-0000-7000-8000-000000000005', '92000000-0000-7000-8000-000000000022',
          'text/plain', 'txt', 'portable', '1', 'CLEAN', 'wrong-reference')
`, '23514', 'mismatched scanner provenance');

await expectSqlState(`
  UPDATE occ.upload_session SET status = 'CONFIRMED'
  WHERE id = '92000000-0000-7000-8000-000000000022'
`, '23514', 'confirmation without a matching version');

await db.exec(`
  INSERT INTO occ.evidence_version
    (id, evidence_id, version, object_key, sha256, mime_type, size_bytes, submitted_by,
     upload_session_id, detected_media_type, normalized_extension, scanner_engine,
     scanner_version, scanner_result, scanner_result_ref)
  VALUES ('92000000-0000-7000-8000-000000000030', '92000000-0000-7000-8000-000000000002',
          1, 'evidence/main', repeat('a', 64), 'text/plain', 10,
          '90000000-0000-7000-8000-000000000005', '92000000-0000-7000-8000-000000000022',
          'text/plain', 'txt', 'portable', '1', 'CLEAN', 'clean:1');
  UPDATE occ.evidence SET current_version = 1 WHERE id = '92000000-0000-7000-8000-000000000002';
  UPDATE occ.upload_session SET status = 'CONFIRMED' WHERE id = '92000000-0000-7000-8000-000000000022';
  UPDATE occ.evidence SET state = 'SUBMITTED' WHERE id = '92000000-0000-7000-8000-000000000002';
  INSERT INTO occ.evidence_review
    (id, evidence_version_id, reviewer_id, decision, gate_satisfied)
  VALUES ('92000000-0000-7000-8000-000000000040', '92000000-0000-7000-8000-000000000030',
          '92000000-0000-7000-8000-000000000005', 'ACCEPTED', true);
`);

await expectSqlState(`
  UPDATE occ.evidence_version SET mime_type = 'application/octet-stream'
  WHERE id = '92000000-0000-7000-8000-000000000030'
`, '55000', 'evidence version mutation');
await expectSqlState(`
  INSERT INTO occ.evidence_review (id, evidence_version_id, reviewer_id, decision, gate_satisfied)
  VALUES ('92000000-0000-7000-8000-000000000041', '92000000-0000-7000-8000-000000000030',
          '92000000-0000-7000-8000-000000000005', 'ACCEPTED', true)
`, '23505', 'second evidence review');

await db.exec(`
  UPDATE occ.upload_session
  SET status = 'STREAMING', lease_owner = '90000000-0000-7000-8000-000000000005',
      lease_acquired_at = transaction_timestamp(), lease_heartbeat_at = transaction_timestamp(),
      lease_expires_at = transaction_timestamp() + interval '5 minutes',
      actual_sha256 = repeat('b', 64), actual_size_bytes = 11, detected_media_type = 'text/plain',
      scanner_engine = 'portable', scanner_version = '1', scanner_result_ref = 'clean:spare'
  WHERE id = '92000000-0000-7000-8000-000000000023';
  UPDATE occ.upload_session SET status = 'INSPECTING' WHERE id = '92000000-0000-7000-8000-000000000023';
  UPDATE occ.upload_session SET status = 'SCANNING' WHERE id = '92000000-0000-7000-8000-000000000023';
  UPDATE occ.upload_session SET status = 'PROMOTING' WHERE id = '92000000-0000-7000-8000-000000000023';
  INSERT INTO occ.evidence_object_disposition
    (id, upload_session_id, object_key, disposition_state)
  VALUES
    ('92000000-0000-7000-8000-000000000054', '92000000-0000-7000-8000-000000000023',
     'quarantine/spare', 'CLEANUP_PENDING'),
    ('92000000-0000-7000-8000-000000000055', '92000000-0000-7000-8000-000000000023',
     'evidence/spare', 'CLEANUP_PENDING');
`);
await expectSqlState(`
  INSERT INTO occ.evidence_object_disposition (id, upload_session_id, object_key, disposition_state)
  VALUES ('92000000-0000-7000-8000-000000000056', '92000000-0000-7000-8000-000000000023',
          'evidence/spare', 'CLEANUP_PENDING')
`, '23505', 'duplicate promoted orphan disposition');

await db.exec(`
  UPDATE occ.evidence_object_disposition
  SET disposition_state = 'DELETING'
  WHERE id = '92000000-0000-7000-8000-000000000055';
  UPDATE occ.evidence
  SET legal_hold_at = transaction_timestamp(), legal_hold_by = '92000000-0000-7000-8000-000000000005',
      legal_hold_reason = 'portable hold'
  WHERE id = '92000000-0000-7000-8000-000000000002';
  INSERT INTO occ.evidence_object_disposition
    (id, evidence_version_id, object_key, disposition_state)
  VALUES ('92000000-0000-7000-8000-000000000050', '92000000-0000-7000-8000-000000000030',
          'evidence/main', 'RETAINED');
`);
await expectSqlState(`
  UPDATE occ.evidence_object_disposition
  SET disposition_state = 'DELETED', deleted_at = transaction_timestamp()
  WHERE id = '92000000-0000-7000-8000-000000000055'
`, '55000', 'deleted disposition under a newly placed legal hold');
await expectSqlState(`
  UPDATE occ.evidence_object_disposition SET disposition_state = 'CLEANUP_PENDING'
  WHERE id = '92000000-0000-7000-8000-000000000050'
`, '55000', 'version disposition cleanup under legal hold');
await expectSqlState(`
  INSERT INTO occ.evidence_object_disposition
    (id, evidence_version_id, upload_session_id, object_key, disposition_state)
  VALUES ('92000000-0000-7000-8000-000000000053', '92000000-0000-7000-8000-000000000030',
          '92000000-0000-7000-8000-000000000023', 'evidence/main', 'RETAINED')
`, '23514', 'mismatched dual disposition provenance');

await expectSqlState(`
  INSERT INTO occ.risk
    (id, rule_definition_id, target_entity_id, severity, state, reason)
  VALUES ('92000000-0000-7000-8000-000000000006', '92000000-0000-7000-8000-000000000012',
          '92000000-0000-7000-8000-000000000001', 'YELLOW', 'OPEN', 'portable risk')
`, '23514', 'risk without occurrence facts');
await expectSqlState(`
  INSERT INTO occ.risk
    (id, rule_definition_id, target_entity_id, severity, state, reason, occurrence_key,
     detected_at, evaluated_at, calendar_version)
  VALUES ('92000000-0000-7000-8000-000000000006', '92000000-0000-7000-8000-000000000012',
          '92000000-0000-7000-8000-000000000001', 'YELLOW', 'OPEN', 'portable risk',
          'portable-occurrence', transaction_timestamp(), transaction_timestamp(), 'calendar-1');
  INSERT INTO occ.risk_occurrence
    (id, risk_id, rule_definition_id, target_entity_id, occurrence_key, triggering_fact_ids,
     threshold_kind, calendar_version, evaluated_at, detected_at)
  VALUES ('92000000-0000-7000-8000-000000000060', '92000000-0000-7000-8000-000000000006',
          '92000000-0000-7000-8000-000000000012', '92000000-0000-7000-8000-000000000001',
          'wrong-occurrence', '[]'::jsonb, 'ELAPSED', 'calendar-1',
          transaction_timestamp(), transaction_timestamp())
`, '23514', 'risk occurrence mismatch');
await db.exec(`
  INSERT INTO occ.risk
    (id, rule_definition_id, target_entity_id, severity, state, reason, occurrence_key,
     detected_at, evaluated_at, calendar_version)
  VALUES ('92000000-0000-7000-8000-000000000006', '92000000-0000-7000-8000-000000000012',
          '92000000-0000-7000-8000-000000000001', 'YELLOW', 'OPEN', 'portable risk',
          'portable-occurrence', transaction_timestamp(), transaction_timestamp(), 'calendar-1');
  INSERT INTO occ.risk_occurrence
    (id, risk_id, rule_definition_id, target_entity_id, occurrence_key, triggering_fact_ids,
     threshold_kind, calendar_version, evaluated_at, detected_at)
  SELECT '92000000-0000-7000-8000-000000000061', id, rule_definition_id, target_entity_id,
         occurrence_key, '[]'::jsonb, 'ELAPSED', calendar_version, evaluated_at, detected_at
  FROM occ.risk WHERE id = '92000000-0000-7000-8000-000000000006';
  UPDATE occ.risk SET state = 'RESOLVED', resolved_at = transaction_timestamp()
  WHERE id = '92000000-0000-7000-8000-000000000006';
`);
await expectSqlState(`
  INSERT INTO occ.risk
    (id, rule_definition_id, target_entity_id, severity, state, reason, occurrence_key,
     detected_at, evaluated_at, calendar_version)
  VALUES ('92000000-0000-7000-8000-000000000008', '92000000-0000-7000-8000-000000000012',
          '92000000-0000-7000-8000-000000000001', 'YELLOW', 'OPEN', 'duplicate risk',
          'portable-occurrence', transaction_timestamp(), transaction_timestamp(), 'calendar-1')
`, '23505', 'duplicate risk head occurrence identity');
await expectCommitSqlState(`
  INSERT INTO occ.risk
    (id, rule_definition_id, target_entity_id, severity, state, reason, occurrence_key,
     detected_at, evaluated_at, calendar_version)
  VALUES ('92000000-0000-7000-8000-000000000008', '92000000-0000-7000-8000-000000000012',
          '92000000-0000-7000-8000-000000000001', 'YELLOW', 'OPEN', 'missing occurrence',
          'portable-missing-child', transaction_timestamp(), transaction_timestamp(), 'calendar-1')
`, '23514', 'risk head without child occurrence');
await expectSqlState(`
  INSERT INTO occ.risk_action (id, risk_id, actor_id, action_type, reason)
  VALUES ('92000000-0000-7000-8000-000000000062', '92000000-0000-7000-8000-000000000006',
          '92000000-0000-7000-8000-000000000005', 'MITIGATED', 'too late')
`, '55000', 'action on terminal risk');

await db.exec(`
  INSERT INTO occ.managed_resource (id, resource_type, capacity, state)
  VALUES ('92000000-0000-7000-8000-000000000007', 'portable', 10, 'AVAILABLE');
  SET ROLE innorder_runtime;
  INSERT INTO occ.resource_availability
    (id, resource_id, time_range, mode, created_by)
  VALUES ('92000000-0000-7000-8000-000000000069', '92000000-0000-7000-8000-000000000007',
          tstzrange('2025-01-01 00:00Z', '2027-01-01 00:00Z', '[)'), 'AVAILABLE',
          '90000000-0000-7000-8000-000000000005');
  RESET ROLE;
  SET ROLE innorder_runtime;
  INSERT INTO occ.resource_reservation
    (id, resource_id, requester_entity_id, time_range, capacity, exclusive, state)
  VALUES ('92000000-0000-7000-8000-000000000070', '92000000-0000-7000-8000-000000000007',
           '90000000-0000-7000-8000-000000000005',
           tstzrange('2026-01-01 10:00Z', '2026-01-01 12:00Z', '[)'), 6, false, 'PENDING');
  RESET ROLE;
`);
await expectSqlState(`
  INSERT INTO occ.resource_reservation
    (id, resource_id, requester_entity_id, time_range, capacity, exclusive, state)
  VALUES ('92000000-0000-7000-8000-000000000071', '92000000-0000-7000-8000-000000000007',
          '90000000-0000-7000-8000-000000000005',
          tstzrange('2026-01-01 12:00Z', '2026-01-01 13:00Z', '(]'), 1, false, 'PENDING')
`, '22000', 'noncanonical reservation');
await expectSqlState(`
  INSERT INTO occ.resource_reservation
    (id, resource_id, requester_entity_id, time_range, capacity, exclusive, state)
  VALUES ('92000000-0000-7000-8000-000000000072', '92000000-0000-7000-8000-000000000007',
          '90000000-0000-7000-8000-000000000005',
          tstzrange('2026-01-01 11:00Z', '2026-01-01 11:30Z', '[)'), 1, true, 'PENDING')
`, '23P01', 'exclusive reservation overlap');
await expectSqlState(`
  INSERT INTO occ.resource_reservation
    (id, resource_id, requester_entity_id, time_range, capacity, exclusive, state)
  VALUES ('92000000-0000-7000-8000-000000000073', '92000000-0000-7000-8000-000000000007',
          '90000000-0000-7000-8000-000000000005',
          tstzrange('2026-01-01 11:00Z', '2026-01-01 11:30Z', '[)'), 5, false, 'PENDING')
`, '23P01', 'peak reservation capacity');
await expectSqlState(`
  UPDATE occ.resource_reservation
  SET state = 'COMPLETED', confirmed_at = transaction_timestamp(), completed_at = transaction_timestamp()
  WHERE id = '92000000-0000-7000-8000-000000000070'
`, '23514', 'invalid reservation transition');
await expectSqlState(`
  DELETE FROM occ.resource_reservation WHERE id = '92000000-0000-7000-8000-000000000070'
`, '55000', 'reservation deletion');
const reservationHistory = await db.query(`
  SELECT count(*)::integer AS versions,
         count(*) FILTER (WHERE valid_until IS NULL)::integer AS current_versions,
         count(*) FILTER (WHERE valid_until IS NOT NULL)::integer AS closed_versions,
         bool_and(valid_until IS NULL OR valid_until > valid_from) AS valid_intervals
  FROM occ.resource_reservation_history
  WHERE reservation_id = '92000000-0000-7000-8000-000000000070'
`);
if (reservationHistory.rows[0]?.versions !== 1
    || reservationHistory.rows[0]?.current_versions !== 1
    || reservationHistory.rows[0]?.closed_versions !== 0
    || !reservationHistory.rows[0]?.valid_intervals) {
  throw new Error('reservation insert temporal history snapshot is invalid');
}
await db.exec(`
  SET ROLE innorder_runtime;
  UPDATE occ.resource_reservation SET row_version = row_version + 1
  WHERE id = '92000000-0000-7000-8000-000000000070';
  RESET ROLE;
`);
const updatedReservationHistory = await db.query(`
  SELECT count(*)::integer AS versions,
         count(*) FILTER (WHERE valid_until IS NULL)::integer AS current_versions,
         count(*) FILTER (WHERE valid_until IS NOT NULL)::integer AS closed_versions,
         bool_and(valid_until IS NULL OR valid_until > valid_from) AS valid_intervals
  FROM occ.resource_reservation_history
  WHERE reservation_id = '92000000-0000-7000-8000-000000000070'
`);
if (updatedReservationHistory.rows[0]?.versions !== 2
    || updatedReservationHistory.rows[0]?.current_versions !== 1
    || updatedReservationHistory.rows[0]?.closed_versions !== 1
    || !updatedReservationHistory.rows[0]?.valid_intervals) {
  throw new Error('reservation update did not close and replace temporal history');
}
await expectSqlState(`
  INSERT INTO occ.resource_reservation_history
    (reservation_id, resource_id, requester_entity_id, process_instance_id, task_id,
     time_range, capacity, exclusive, state, row_version, created_at, updated_at,
     confirmed_at, cancelled_at, completed_at, valid_from, valid_until)
  SELECT reservation_id, resource_id, requester_entity_id, process_instance_id, task_id,
         time_range, capacity, exclusive, state, row_version, created_at, updated_at,
         confirmed_at, cancelled_at, completed_at, valid_from, valid_until
  FROM occ.resource_reservation_history
  WHERE reservation_id = '92000000-0000-7000-8000-000000000070' AND valid_until IS NULL
`, '23P01', 'overlapping reservation temporal history');
await expectSqlState(`
  SET ROLE innorder_runtime;
  INSERT INTO occ.resource_reservation_history
  SELECT gen_random_uuid(), reservation_id, resource_id, requester_entity_id,
         process_instance_id, task_id, time_range, capacity, exclusive, state,
         row_version, created_at, updated_at, confirmed_at, cancelled_at, completed_at,
         valid_from, valid_until
  FROM occ.resource_reservation_history
  WHERE reservation_id = '92000000-0000-7000-8000-000000000070'
`, '42501', 'runtime reservation history forgery');
await expectSqlState(`
  UPDATE occ.resource_reservation_history SET capacity = 9
  WHERE reservation_id = '92000000-0000-7000-8000-000000000070'
`, '55000', 'reservation history mutation');
console.log('passed portable V014 provenance, history, risk, reservation, and legal-hold behavior');

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
