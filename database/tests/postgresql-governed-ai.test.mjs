import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const docker = process.env.DOCKER_PATH ?? (process.platform === 'win32' ? 'docker.exe' : 'docker');
const image = process.env.PGVECTOR_TEST_IMAGE ?? 'pgvector/pgvector:pg16';
const container = `innorder-governed-ai-${randomUUID()}`;
const password = `admin-sentinel-'${randomUUID()}`;
const flywayPassword = `flyway-sentinel-'${randomUUID()}`;
const runtimePassword = `runtime-sentinel-'${randomUUID()}`;
const aiPassword = `ai-sentinel-'${randomUUID()}`;
const adminConnectionEnvironment = { ...process.env, PGPASSWORD: password };
const aiConnectionEnvironment = { ...process.env, PGPASSWORD: aiPassword };
const migrationDir = resolve('database/migrations');
const migrations = [
  'V001__bootstrap.sql', 'V002__catalog.sql', 'V003__identity_and_entities.sql',
  'V004__policy_control_plane.sql', 'V005__occ_runtime.sql', 'V006__audit_and_outbox.sql',
  'V007__ai_rag.sql', 'V008__cross_schema_constraints.sql', 'V009__runtime_privileges.sql',
  'V010__platform_security_kernel.sql', 'V011__account_failed_attempt_window.sql',
  'V012__outbox_publisher_lifecycle.sql', 'V015__governed_ai_runtime.sql',
];

function dockerSync(args, options = {}) {
  return spawnSync(docker, args, { encoding: 'utf8', windowsHide: true, ...options });
}

function execSql(sql, { role } = {}) {
  const prefix = role ? `SET ROLE ${role};\n` : '';
  const result = dockerSync([
    'exec', '-i', '-e', 'PGPASSWORD', container,
    'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align',
    '--username', 'postgres', '--dbname', 'innorder_test',
  ], { input: prefix + sql, env: adminConnectionEnvironment });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.split(/\r?\n/u).filter((line) => line.trim() !== 'SET').join('\n').trim();
}

function runSql(sql) {
  const child = spawn(docker, [
    'exec', '-i', '-e', 'PGPASSWORD', container,
    'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align',
    '--username', 'postgres', '--dbname', 'innorder_test',
  ], { env: adminConnectionEnvironment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(sql);
  return new Promise((resolveResult) => child.on('close', (code) => resolveResult({ code, stdout, stderr })));
}

function expectDenied(sql, pattern = /permission denied/iu) {
  const result = dockerSync([
    'exec', '-i', '-e', 'PGPASSWORD', container,
    'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--username', 'postgres', '--dbname', 'innorder_test',
  ], { input: `SET ROLE innorder_ai_runtime;\n${sql}`, env: adminConnectionEnvironment });
  assert.notEqual(result.status, 0, `${sql} unexpectedly succeeded`);
  assert.match(result.stderr, pattern);
}

function runAiSql(sql) {
  const child = spawn(docker, [
    'exec', '-i', '-e', 'PGPASSWORD', container,
    'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align',
    '--host', '127.0.0.1', '--username', 'innorder_ai_runtime', '--dbname', 'innorder_test',
  ], { env: aiConnectionEnvironment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(sql);
  return new Promise((resolveResult) => child.on('close', (code) => resolveResult({ code, stdout, stderr })));
}

function execAiSql(sql) {
  const result = dockerSync([
    'exec', '-i', '-e', 'PGPASSWORD', container,
    'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align',
    '--host', '127.0.0.1', '--username', 'innorder_ai_runtime', '--dbname', 'innorder_test',
  ], { input: sql, env: aiConnectionEnvironment });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function expectAiFailure(sql, pattern) {
  const result = dockerSync([
    'exec', '-i', '-e', 'PGPASSWORD', container,
    'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1',
    '--host', '127.0.0.1', '--username', 'innorder_ai_runtime', '--dbname', 'innorder_test',
  ], { input: sql, env: aiConnectionEnvironment });
  assert.notEqual(result.status, 0, `${sql} unexpectedly succeeded`);
  assert.match(result.stderr, pattern);
}

function expectSqlFailure(sql, pattern) {
  const result = dockerSync([
    'exec', '-i', '-e', 'PGPASSWORD', container,
    'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1',
    '--username', 'postgres', '--dbname', 'innorder_test',
  ], { input: sql, env: adminConnectionEnvironment });
  assert.notEqual(result.status, 0, `${sql} unexpectedly succeeded`);
  assert.match(result.stderr, pattern);
}

function expectCoreFailure(sql, pattern) {
  const result = dockerSync([
    'exec', '-i', '-e', 'PGPASSWORD', container,
    'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1',
    '--username', 'postgres', '--dbname', 'innorder_test',
  ], { input: `SET ROLE innorder_runtime;\n${sql}`, env: adminConnectionEnvironment });
  assert.notEqual(result.status, 0, `${sql} unexpectedly succeeded as Core runtime`);
  assert.match(result.stderr, pattern);
}

function fixtureSql(prefix) {
  const id = (suffix) => `${prefix}-0000-7000-8000-${suffix}`;
  const cases = (datasetVersion, start, count, emptyIndex = -1) => Array.from({ length: count }, (_, index) => {
    const caseId = String(start + index).padStart(12, '0');
    const input = index === emptyIndex ? '{}' : `{"question":${index + 1}}`;
    const expected = index === emptyIndex ? '{}' : `{"answer":${index + 1}}`;
    return `('${id(caseId)}', '${id(datasetVersion)}', 'case-${start + index}', '${input}', '${expected}')`;
  }).join(',\n      ');
  return `
    INSERT INTO catalog.domain_package (id, package_key, name, status)
    VALUES ('${id('000000000001')}', 'governed.${prefix}', 'Governed AI', 'ACTIVE');
    INSERT INTO catalog.package_version (id, package_id, semver, status, manifest)
    VALUES ('${id('000000000002')}', '${id('000000000001')}', '1.0.0', 'DRAFT', '{}');

    INSERT INTO catalog.entity_type (id, package_id, type_key, name, entity_kind, authorizable)
    VALUES
      ('${id('000000000003')}', '${id('000000000001')}', 'principal_${prefix}', 'Principal', 'PRINCIPAL', true),
      ('${id('000000000023')}', '${id('000000000001')}', 'resource_${prefix}', 'Resource', 'RESOURCE', true);
    INSERT INTO catalog.entity_type_version
      (id, entity_type_id, package_version_id, schema_version, json_schema, ui_schema, auth_schema, index_spec)
    VALUES
      ('${id('000000000004')}', '${id('000000000003')}', '${id('000000000002')}', 1, '{}', '{}', '{}', '{}'),
      ('${id('000000000024')}', '${id('000000000023')}', '${id('000000000002')}', 1, '{}', '{}', '{}', '{}');

    INSERT INTO authz.entity
      (id, entity_type_id, entity_type_version_id, entity_key, state, auth_attributes)
    VALUES
      ('${id('000000000005')}', '${id('000000000003')}', '${id('000000000004')}', 'principal:${prefix}', 'ACTIVE', '{}'),
      ('${id('000000000006')}', '${id('000000000023')}', '${id('000000000024')}', 'provider:${prefix}', 'ACTIVE', '{}'),
      ('${id('000000000014')}', '${id('000000000023')}', '${id('000000000024')}', 'source:${prefix}', 'ACTIVE', '{}'),
      ('${id('000000000015')}', '${id('000000000023')}', '${id('000000000024')}', 'document:allowed:${prefix}', 'ACTIVE', '{}'),
      ('${id('000000000016')}', '${id('000000000023')}', '${id('000000000024')}', 'document:denied:${prefix}', 'ACTIVE', '{}'),
      ('${id('000000000036')}', '${id('000000000023')}', '${id('000000000024')}', 'document:ingestion:${prefix}', 'ACTIVE', '{}');
    INSERT INTO iam.principal (id, principal_kind, display_name, status, profile)
    VALUES ('${id('000000000005')}', 'SERVICE', 'Governed AI test', 'ACTIVE', '{}');

    INSERT INTO authz.policy_release (id, release_number, status, content_hash)
    VALUES ('${id('000000000019')}', 1, 'STAGED', repeat('d', 64));
    INSERT INTO ai.model_provider
      (id, provider_type, base_url, secret_ref, capabilities, data_policy, state)
    VALUES ('${id('000000000006')}', 'TEST', 'https://invalid.test', 'test-secret', '{}', '{}', 'ACTIVE');
    INSERT INTO ai.model_profile
      (id, provider_id, model_key, purpose, parameters, capability_snapshot, timeout_ms, rate_limit, cost_rule, state)
    VALUES
      ('${id('000000000008')}', '${id('000000000006')}', 'test-model', 'EMBEDDING', '{}', '{}', 1000, '{}', '{}', 'ACTIVE'),
      ('${id('000000000080')}', '${id('000000000006')}', 'substitute-model', 'CHAT', '{}', '{}', 1000, '{}', '{}', 'ACTIVE');
    INSERT INTO ai.embedding_space
      (id, model_profile_id, dimensions, distance_metric, corpus_version, status, coverage, activated_at)
    VALUES
      ('${id('000000000009')}', '${id('000000000008')}', 3, 'COSINE', repeat('0', 64), 'ACTIVE', 1, now()),
      ('${id('000000000029')}', '${id('000000000008')}', 3, 'COSINE', repeat('9', 64), 'BUILDING', 0, NULL);
    SELECT ai.create_embedding_partition('${id('000000000009')}', 3, 'COSINE');
    SELECT ai.create_embedding_partition('${id('000000000029')}', 3, 'COSINE');

    INSERT INTO ai.prompt_template (id, prompt_key, name)
    VALUES ('${id('00000000000a')}', 'test.${prefix}', 'Test prompt');
    INSERT INTO ai.prompt_template_version
      (id, prompt_template_id, version, template, variable_schema, content_hash, status, created_by)
    VALUES ('${id('000000000010')}', '${id('00000000000a')}', 1, 'test', '{}', repeat('e', 64), 'DRAFT', '${id('000000000005')}');
    INSERT INTO ai.agent_definition (id, agent_key, name)
    VALUES ('${id('00000000000b')}', 'test.${prefix}', 'Test agent');
    INSERT INTO ai.agent_definition_version
      (id, agent_definition_id, package_version_id, input_schema, output_schema, prompt_version_id, content_hash)
    VALUES ('${id('000000000012')}', '${id('00000000000b')}', '${id('000000000002')}', '{}', '{}',
            '${id('000000000010')}', repeat('f', 64));

    INSERT INTO ai.evaluation_dataset (id, dataset_key, name)
    VALUES ('${id('00000000000c')}', 'test.${prefix}', 'Test dataset');
    INSERT INTO ai.evaluation_dataset_version (id, dataset_id, version, content_hash, status)
    VALUES ('${id('000000000013')}', '${id('00000000000c')}', 1, repeat('1', 64), 'DRAFT');
    INSERT INTO ai.evaluation_dataset (id, dataset_key, name)
    VALUES ('${id('00000000003a')}', 'test.fail.${prefix}', 'Fail dataset');
    INSERT INTO ai.evaluation_dataset_version (id, dataset_id, version, content_hash, status)
    VALUES ('${id('00000000003b')}', '${id('00000000003a')}', 1, repeat('a', 64), 'DRAFT');
    INSERT INTO ai.evaluation_dataset (id, dataset_key, name) VALUES
      ('${id('000000000060')}', 'test.one.${prefix}', 'One-case dataset'),
      ('${id('000000000061')}', 'test.nineteen.${prefix}', 'Nineteen-case dataset'),
      ('${id('000000000062')}', 'test.empty.${prefix}', 'Empty-case dataset'),
      ('${id('000000000074')}', 'test.draft.${prefix}', 'Draft dataset'),
      ('${id('000000000075')}', 'test.retired.${prefix}', 'Retired dataset'),
      ('${id('000000000500')}', 'test.embedding-drift.${prefix}', 'Embedding drift dataset'),
      ('${id('000000000502')}', 'test.corpus-drift.${prefix}', 'Corpus drift dataset'),
      ('${id('000000000504')}', 'test.status-drift.${prefix}', 'Status drift dataset'),
      ('${id('000000000520')}', 'test.completion-race.${prefix}', 'Completion race dataset'),
      ('${id('000000000522')}', 'test.deadlock.${prefix}', 'Deadlock dataset'),
      ('${id('000000000524')}', 'test.final-pass.${prefix}', 'Final pass dataset');
    INSERT INTO ai.evaluation_dataset_version (id, dataset_id, version, content_hash, status) VALUES
      ('${id('000000000063')}', '${id('000000000060')}', 1, repeat('3', 64), 'DRAFT'),
      ('${id('000000000064')}', '${id('000000000061')}', 1, repeat('4', 64), 'DRAFT'),
      ('${id('000000000065')}', '${id('000000000062')}', 1, repeat('5', 64), 'DRAFT'),
      ('${id('000000000076')}', '${id('000000000074')}', 1, repeat('6', 64), 'DRAFT'),
      ('${id('000000000077')}', '${id('000000000075')}', 1, repeat('7', 64), 'DRAFT'),
      ('${id('000000000501')}', '${id('000000000500')}', 1, repeat('8', 64), 'DRAFT'),
      ('${id('000000000503')}', '${id('000000000502')}', 1, repeat('9', 64), 'DRAFT'),
      ('${id('000000000505')}', '${id('000000000504')}', 1, repeat('a', 64), 'DRAFT'),
      ('${id('000000000521')}', '${id('000000000520')}', 1, repeat('b', 64), 'DRAFT'),
      ('${id('000000000523')}', '${id('000000000522')}', 1, repeat('c', 64), 'DRAFT'),
      ('${id('000000000525')}', '${id('000000000524')}', 1, repeat('d', 64), 'DRAFT');
    INSERT INTO ai.evaluation_case (id, dataset_version_id, case_key, input, expected_properties) VALUES
      ${cases('000000000013', 100, 30)},
      ${cases('00000000003b', 130, 20)},
      ${cases('000000000063', 200, 1)},
      ${cases('000000000064', 300, 19)},
      ${cases('000000000065', 400, 20, 19)},
      ${cases('000000000525', 700, 20)};
    UPDATE ai.evaluation_dataset_version SET status = 'PUBLISHED'
    WHERE id IN ('${id('000000000013')}', '${id('00000000003b')}', '${id('000000000063')}',
                 '${id('000000000064')}', '${id('000000000065')}', '${id('000000000077')}',
                 '${id('000000000501')}', '${id('000000000503')}', '${id('000000000505')}');
    UPDATE ai.evaluation_dataset_version SET status = 'PUBLISHED'
    WHERE id IN ('${id('000000000521')}', '${id('000000000523')}', '${id('000000000525')}');
    UPDATE ai.evaluation_dataset_version SET status = 'RETIRED' WHERE id = '${id('000000000077')}';

    INSERT INTO ai.knowledge_source
      (id, source_type, sync_config, state, sync_cursor)
    VALUES ('${id('000000000014')}', 'UPLOAD', '{}', 'ACTIVE', '{}');
    INSERT INTO ai.knowledge_document (id, source_id, document_key, state)
    VALUES
      ('${id('000000000015')}', '${id('000000000014')}', 'allowed', 'PENDING'),
      ('${id('000000000016')}', '${id('000000000014')}', 'denied', 'PENDING'),
      ('${id('000000000036')}', '${id('000000000014')}', 'ingestion', 'PENDING');
    INSERT INTO ai.knowledge_document_version
      (id, document_id, version, object_key, content_hash, mime_type, parser_version, data_classification)
    VALUES
      ('${id('000000000017')}', '${id('000000000015')}', 1, 'allowed-${prefix}', repeat('2', 64), 'text/plain', '1', 'PUBLIC'),
      ('${id('000000000018')}', '${id('000000000016')}', 1, 'denied-${prefix}', repeat('3', 64), 'text/plain', '1', 'PUBLIC'),
      ('${id('00000000004b')}', '${id('000000000036')}', 1, 'old-${prefix}', repeat('b', 64), 'text/plain', 'old', 'PUBLIC');
    INSERT INTO ai.knowledge_chunk
      (id, document_version_id, ordinal, content, content_hash, token_count, metadata)
    VALUES
      ('${id('000000000021')}', '${id('000000000017')}', 0, 'allowed knowledge', repeat('4', 64), 2, '{}'),
      ('${id('000000000022')}', '${id('000000000018')}', 0, 'allowed but unauthorized', repeat('5', 64), 3, '{}'),
      ('${id('00000000004c')}', '${id('00000000004b')}', 0, 'old corpus version', repeat('c', 64), 3, '{}');
    INSERT INTO ai.chunk_embedding (embedding_space_id, chunk_id, embedding)
    VALUES
      ('${id('000000000009')}', '${id('000000000021')}', '[1,0,0]'),
      ('${id('000000000009')}', '${id('000000000022')}', '[1,0,0]');

    INSERT INTO authz.ai_authorization_grant
      (id, token_hash, operation, jti, principal_id, target_entity_id, purpose,
       authorization_revision, policy_release_id, policy_release_digest,
       authorized_set_digest, context_digest, bounded_context, classification_ceiling,
       agent_version_id, model_profile_id, prompt_version_id, package_version_id, embedding_space_id,
       issued_at, expires_at, event_id, intended_run_id)
    SELECT grant_input.id, grant_input.token_hash, 'RETRIEVE', grant_input.jti,
           '${id('000000000005')}', '${id('000000000015')}', 'answer',
           current_revision + grant_input.revision_offset, '${id('000000000019')}', repeat('d', 64),
           repeat('6', 64), repeat('7', 64), '{"scope":"test"}', 'PUBLIC',
           '${id('000000000012')}', '${id('000000000008')}', '${id('000000000010')}',
           '${id('000000000002')}', '${id('000000000009')}',
           now() + grant_input.issued_offset, now() + grant_input.expires_offset, grant_input.event_id, grant_input.run_id
    FROM authz.authorization_state
    CROSS JOIN (VALUES
      ('${id('000000000020')}'::uuid, repeat('a',64), 'jti-main-${prefix}', 0, interval '0', interval '5 minutes', '${id('000000000025')}'::uuid, '${id('000000000030')}'::uuid),
      ('${id('000000000040')}'::uuid, repeat('b',64), 'jti-mismatch-${prefix}', 0, interval '0', interval '5 minutes', '${id('000000000035')}'::uuid, '${id('000000000031')}'::uuid),
      ('${id('000000000041')}'::uuid, repeat('c',64), 'jti-expired-${prefix}', 0, interval '-10 minutes', interval '-6 minutes', '${id('000000000039')}'::uuid, '${id('000000000032')}'::uuid),
      ('${id('000000000042')}'::uuid, repeat('e',64), 'jti-stale-${prefix}', 1, interval '0', interval '5 minutes', '${id('00000000003d')}'::uuid, '${id('000000000033')}'::uuid)
    ) AS grant_input(id, token_hash, jti, revision_offset, issued_offset, expires_offset, event_id, run_id)
    WHERE singleton;
    INSERT INTO authz.ai_authorized_document (grant_id, document_version_id)
    VALUES
      ('${id('000000000020')}', '${id('000000000017')}'),
      ('${id('000000000040')}', '${id('000000000017')}'),
      ('${id('000000000041')}', '${id('000000000017')}'),
      ('${id('000000000042')}', '${id('000000000017')}');
    INSERT INTO ai.ingestion_job
      (id, source_id, document_id, source_version, source_object_hash, normalized_content_hash,
       parser_version, chunker_version, candidate_embedding_space_id,
       corpus_manifest_digest, checkpoint, stage, status, created_at, updated_at)
    VALUES ('${id('000000000026')}', '${id('000000000014')}', '${id('000000000036')}', 'v1',
            repeat('7', 64), repeat('8', 64), 'parser-v1', 'chunker-v1', '${id('000000000029')}', repeat('9', 64), '{}', 'FETCH', 'PENDING',
            now() - interval '1 hour', now() - interval '1 hour');
    INSERT INTO ai.ingestion_job
      (id, source_id, document_id, source_version, source_object_hash, normalized_content_hash,
       parser_version, chunker_version, candidate_embedding_space_id,
       corpus_manifest_digest, checkpoint, stage, status, attempts, max_attempts,
       lease_owner, lease_expires_at, created_at, updated_at)
    VALUES ('${id('000000000058')}', '${id('000000000014')}', '${id('000000000036')}', 'crashed',
            repeat('c', 64), repeat('d', 64), 'parser-v1', 'chunker-v1', '${id('000000000029')}', repeat('9', 64), '{}', 'FETCH', 'PROCESSING', 1, 1,
            'crashed-worker', now() - interval '1 minute', now() - interval '1 hour', now() - interval '1 hour');
    INSERT INTO ai.ingestion_attempt
      (id, job_id, attempt_number, worker_id, stage, checkpoint, status, lease_expires_at, started_at)
    VALUES ('${id('000000000059')}', '${id('000000000058')}', 1, 'crashed-worker', 'FETCH', '{}',
            'RUNNING', now() - interval '1 minute', now() - interval '1 hour');
    INSERT INTO ai.ingestion_job
      (id, source_id, document_id, source_version, source_object_hash, normalized_content_hash,
       parser_version, chunker_version, candidate_embedding_space_id, corpus_manifest_digest,
       checkpoint, stage, status, attempts, max_attempts, created_at, updated_at)
    VALUES ('${id('000000000024')}', '${id('000000000014')}', '${id('000000000036')}', 'exhausted-pending',
            repeat('a', 64), repeat('b', 64), 'parser-v1', 'chunker-v1', '${id('000000000029')}',
            repeat('9', 64), '{}', 'FETCH', 'PENDING', 1, 1,
            now() - interval '2 hours', now() - interval '2 hours');
    CREATE TABLE flowable.governed_secret (id integer PRIMARY KEY);
    INSERT INTO flowable.governed_secret VALUES (1);
  `;
}

test('governed AI boundary enforces role, replay, retrieval, leases, and gates on PostgreSQL', async (t) => {
  assert.equal(dockerSync(['info', '--format', '{{.ServerVersion}}']).status, 0,
    'Docker is required for the explicit governed AI PostgreSQL suite');
  t.after(() => dockerSync(['rm', '-f', container]));
  if (dockerSync(['image', 'inspect', image]).status !== 0) {
    let pulled;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      pulled = dockerSync(['pull', image]);
      if (pulled.status === 0) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000 * (attempt + 1)));
    }
    assert.equal(pulled?.status, 0, pulled?.stderr || pulled?.stdout);
  }
  const started = dockerSync([
    'run', '--detach', '--name', container,
    '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=innorder_test', image,
  ]);
  assert.equal(started.status, 0, started.stderr);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const logs = dockerSync(['logs', container]);
    const initialized = /PostgreSQL init process complete; ready for start up/iu.test(`${logs.stdout}${logs.stderr}`);
    const probe = dockerSync([
      'exec', '-e', 'PGPASSWORD', container,
      'psql', '--username', 'postgres', '--dbname', 'innorder_test', '--command', 'SELECT 1',
    ], { env: adminConnectionEnvironment });
    if (initialized && probe.status === 0) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    if (attempt === 59) assert.fail('PostgreSQL container did not become ready');
  }

  assert.equal(dockerSync(['cp', resolve('infra/compose/postgres/010-create-roles.sh'), `${container}:/tmp/010-create-roles.sh`]).status, 0);
  assert.equal(dockerSync(['exec', container, 'sh', '-c',
    "tr -d '\\r' < /tmp/010-create-roles.sh > /tmp/010-create-roles.lf && mv /tmp/010-create-roles.lf /tmp/010-create-roles.sh"]).status, 0);
  for (const [name, value] of [
    ['postgres_admin_password', password], ['postgres_flyway_password', flywayPassword],
    ['postgres_runtime_password', runtimePassword], ['postgres_ai_runtime_password', aiPassword],
  ]) {
    const secret = dockerSync(['exec', '-i', container, 'sh', '-c', `mkdir -p /run/secrets && cat > /run/secrets/${name}`], { input: value });
    assert.equal(secret.status, 0, secret.stderr);
  }
  const fakePsql = dockerSync(['exec', '-i', container, 'sh', '-c',
    'mkdir -p /tmp/fake-bin && cat > /tmp/fake-bin/psql && chmod +x /tmp/fake-bin/psql'], {
    input: '#!/bin/sh\nprintf "%s\\n" "$@" > /tmp/psql-argv\nexec /usr/bin/psql "$@"\n',
  });
  assert.equal(fakePsql.status, 0, fakePsql.stderr);
  const provisioned = dockerSync(['exec',
    '-e', 'PATH=/tmp/fake-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_DB=innorder_test',
    '-e', 'AI_DATABASE_PASSWORD_FILE=/run/secrets/postgres_ai_runtime_password',
    container, 'bash', '/tmp/010-create-roles.sh']);
  assert.equal(provisioned.status, 0, provisioned.stderr || provisioned.stdout);
  const psqlArgv = dockerSync(['exec', container, 'cat', '/tmp/psql-argv']).stdout;
  for (const sentinel of [password, flywayPassword, runtimePassword, aiPassword]) {
    assert.doesNotMatch(psqlArgv, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')), 'sentinel password leaked into psql argv');
  }
  for (const [role, rolePassword] of [
    ['innorder_flyway', flywayPassword], ['innorder_runtime', runtimePassword], ['innorder_ai_runtime', aiPassword],
  ]) {
    const login = dockerSync(['exec', '-e', `PGPASSWORD=${rolePassword}`, container,
      'psql', '--no-psqlrc', '--host', '127.0.0.1', '--username', role, '--dbname', 'innorder_test',
      '--tuples-only', '--no-align', '--command', 'SELECT current_user;']);
    assert.equal(login.status, 0, login.stderr);
    assert.equal(login.stdout.trim(), role);
  }
  for (const migration of migrations) execSql(readFileSync(join(migrationDir, migration), 'utf8'));
  assert.equal(execAiSql('SELECT current_user;'), 'innorder_ai_runtime', 'positive path uses the AI LOGIN');

  const fixture = randomUUID().replaceAll('-', '').slice(0, 8);
  const id = (suffix) => `${fixture}-0000-7000-8000-${suffix}`;
  execSql(fixtureSql(fixture));

  expectSqlFailure(`UPDATE ai.evaluation_dataset_version SET content_hash = repeat('f',64)
    WHERE id = '${id('000000000013')}';`, /published evaluation dataset version is immutable/iu);
  expectSqlFailure(`INSERT INTO ai.evaluation_case (id, dataset_version_id, case_key, input, expected_properties)
    VALUES ('${id('000000000078')}', '${id('000000000013')}', 'late', '{"x":1}', '{"y":1}');`,
  /evaluation cases for published or retired datasets are immutable/iu);
  expectSqlFailure(`UPDATE ai.evaluation_case SET input = '{"changed":true}'
    WHERE id = '${id('000000000100')}';`, /evaluation cases for published or retired datasets are immutable/iu);
  expectSqlFailure(`DELETE FROM ai.evaluation_case WHERE id = '${id('000000000100')}';`,
  /evaluation cases for published or retired datasets are immutable/iu);

  for (const sql of [
    'SELECT * FROM iam.principal;', 'SELECT * FROM authz.relationship;',
    'SELECT * FROM occ.business_object;', 'SELECT * FROM audit.outbox_event;',
    'SELECT * FROM flowable.governed_secret;', 'SELECT * FROM ai.knowledge_source;',
    'SELECT * FROM ai.knowledge_document;', 'SELECT * FROM ai.recommendation;',
    'SELECT * FROM ai.tool_definition;', 'SELECT * FROM ai.agent_tool_grant;',
  ]) expectAiFailure(sql, /permission denied/iu);
  for (const sql of [
    "INSERT INTO flowable.governed_secret VALUES (2);",
    "UPDATE iam.principal SET display_name = 'forbidden' WHERE false;",
    'DELETE FROM occ.business_object WHERE false;',
    'DELETE FROM audit.outbox_event WHERE false;',
    "UPDATE ai.model_provider SET state = 'DISABLED' WHERE false;",
    "UPDATE ai.model_profile SET state = 'DISABLED' WHERE false;",
    "UPDATE ai.knowledge_source SET state = 'PAUSED' WHERE false;",
    "UPDATE ai.knowledge_document SET state = 'ARCHIVED' WHERE false;",
    "INSERT INTO ai.knowledge_document_version (id, document_id, version, object_key, content_hash, mime_type, parser_version, data_classification) VALUES (gen_random_uuid(), gen_random_uuid(), 1, 'x', repeat('a',64), 'text/plain', '1', 'PUBLIC');",
    "INSERT INTO ai.event_consumption (id, consumer_key, event_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version) VALUES (gen_random_uuid(), 'x', gen_random_uuid(), 'x', 1, 'x', gen_random_uuid(), 1);",
    "INSERT INTO ai.recommendation (id, run_id, target_entity_id, recommendation_type, payload, status) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x', '{}', 'PROPOSED');",
    'CREATE TABLE ai.forbidden (id integer);',
  ]) expectAiFailure(sql, /permission denied/iu);
  assert.match(execAiSql(`SELECT provider_type FROM ai.model_provider WHERE id = '${id('000000000006')}';`), /TEST/iu);

  const revision = Number(execSql('SELECT current_revision FROM authz.authorization_state WHERE singleton;'));
  const sqlText = (value) => value === null ? 'NULL' : `'${value}'`;
  const consume = ({ token, event, operation = 'RETRIEVE', tokenRevision = revision,
    releaseDigest = 'd'.repeat(64), authorizedDigest = '6'.repeat(64),
    contextDigest = '7'.repeat(64), run, agent = id('000000000012'),
    model = id('000000000008'), prompt = id('000000000010'), packageVersion = id('000000000002') }) => `
      SELECT run_id FROM authz.consume_ai_authorization_grant(
        ${token === null ? 'NULL' : `repeat('${token}', 64)`}, ${sqlText(event)}, ${sqlText(operation)}, ${tokenRevision ?? 'NULL'},
        ${sqlText(releaseDigest)}, ${sqlText(authorizedDigest)}, ${sqlText(contextDigest)}, ${sqlText(run)},
        ${sqlText(agent)}, ${sqlText(model)}, ${sqlText(prompt)}, ${sqlText(packageVersion)});`;

  for (const nullClaim of [
    { token: null }, { event: null }, { operation: null }, { tokenRevision: null },
    { releaseDigest: null }, { authorizedDigest: null }, { contextDigest: null }, { run: null },
    { agent: null }, { model: null }, { prompt: null }, { packageVersion: null },
  ]) {
    expectAiFailure(consume({ token: 'b', event: id('000000000035'), run: id('000000000031'), ...nullClaim }),
      /signed AI grant claims cannot be NULL/iu);
  }

  expectAiFailure(consume({ token: 'b', event: id('000000000099'), run: id('000000000031') }), /grant token event mismatch/iu);
  expectAiFailure(consume({ token: 'b', event: id('000000000035'), operation: 'WRITE', run: id('000000000031') }), /grant token operation mismatch/iu);
  expectAiFailure(consume({ token: 'b', event: id('000000000035'), authorizedDigest: '8'.repeat(64), run: id('000000000031') }), /authorized-set digest mismatch/iu);
  expectAiFailure(consume({ token: 'b', event: id('000000000035'), contextDigest: '8'.repeat(64), run: id('000000000031') }), /context digest mismatch/iu);
  expectAiFailure(consume({ token: 'b', event: id('000000000035'), run: id('000000000099') }), /grant token run mismatch/iu);
  expectAiFailure(consume({ token: 'b', event: id('000000000035'), run: id('000000000031'), agent: id('000000000099') }), /agent version mismatch/iu);
  expectAiFailure(consume({ token: 'b', event: id('000000000035'), run: id('000000000031'), model: id('000000000080') }), /model profile mismatch/iu);
  expectAiFailure(consume({ token: 'b', event: id('000000000035'), run: id('000000000031'), prompt: id('000000000099') }), /prompt version mismatch/iu);
  expectAiFailure(consume({ token: 'b', event: id('000000000035'), run: id('000000000031'), packageVersion: id('000000000099') }), /package version mismatch/iu);
  expectAiFailure(consume({ token: 'c', event: id('000000000039'), run: id('000000000032') }), /expired/iu);
  expectAiFailure(consume({ token: 'e', event: id('00000000003d'), tokenRevision: revision + 1, run: id('000000000033') }), /stale authorization revision/iu);

  const consumeSql = consume({ token: 'a', event: id('000000000025'), run: id('000000000030') });
  const [consumeA, consumeB] = await Promise.all([runAiSql(consumeSql), runAiSql(consumeSql)]);
  assert.equal([consumeA, consumeB].filter((result) => result.code === 0).length, 1, 'grant must be consumed once');
  assert.match([consumeA, consumeB].find((result) => result.code !== 0)?.stderr ?? '', /consumed|replay/iu);
  assert.equal(execSql(`SELECT agent_version_id || '|' || model_profile_id || '|' || prompt_version_id || '|' ||
    package_version_id || '|' || embedding_space_id FROM ai.ai_run WHERE id = '${id('000000000030')}';`),
  [id('000000000012'), id('000000000008'), id('000000000010'), id('000000000002'), id('000000000009')].join('|'));

  assert.equal(execAiSql(`SELECT ai.transition_ai_run('${id('000000000030')}', 'RUNNING');`), 'RUNNING');
  expectAiFailure(`SELECT ai.start_model_invocation('${id('00000000004f')}', '${id('000000000030')}',
    '${id('000000000080')}', 'RETRIEVE', repeat('1',64), repeat('2',64));`, /model profile does not match governed run/iu);
  expectAiFailure(`SELECT ai.start_model_invocation('${id('000000000049')}', '${id('000000000030')}',
    '${id('000000000008')}', 'WRITE', repeat('1',64), repeat('2',64));`, /invocation operation does not match grant/iu);
  assert.equal(execAiSql(`SELECT ai.start_model_invocation('${id('000000000043')}', '${id('000000000030')}',
    '${id('000000000008')}', 'RETRIEVE', repeat('1',64), repeat('2',64));`), id('000000000043'));
  expectAiFailure(`SELECT ai.finalize_model_invocation('${id('000000000043')}', 'COMPLETED', repeat('3',64),
    'raw-provider-request-id', 10, 2, 0.01, 12, NULL);`, /provider request id hash must be lowercase SHA-256/iu);
  execAiSql(`SELECT ai.finalize_model_invocation('${id('000000000043')}', 'COMPLETED', repeat('3',64),
    repeat('a',64), 10, 2, 0.01, 12, NULL);`);
  assert.equal(execAiSql(`SELECT provider_request_id_hash FROM ai.model_invocation
    WHERE id = '${id('000000000043')}';`), 'a'.repeat(64));
  assert.equal(execSql(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'ai'
    AND table_name = 'model_invocation' AND column_name = 'provider_request_id';`), '0');
  assert.doesNotMatch(execAiSql(`SELECT to_jsonb(invocation)::text FROM ai.model_invocation invocation
    WHERE id = '${id('000000000043')}';`), /raw-provider-request-id/iu);
  assert.equal(execAiSql(`SELECT ai.persist_run_artifact('${id('000000000044')}', '${id('000000000030')}',
    'TRACE', 'artifact-${fixture}', repeat('4',64), 'INTERNAL');`), id('000000000044'));
  expectCoreFailure(`UPDATE ai.ai_run_artifact SET object_key = 'changed' WHERE id = '${id('000000000044')}';`,
    /AI run artifact is immutable/iu);
  expectCoreFailure(`DELETE FROM ai.ai_run_artifact WHERE id = '${id('000000000044')}';`,
    /artifact deletion requires bounded retention cleanup/iu);
  expectCoreFailure(`DELETE FROM ai.ai_run WHERE id = '${id('000000000030')}';`,
    /artifact deletion requires bounded retention cleanup/iu);

  execSql(`INSERT INTO ai.ai_run
    (id, agent_version_id, model_profile_id, prompt_version_id, package_version_id, policy_release_id,
     triggered_by, target_entity_id, status, embedding_space_id)
    VALUES ('${id('000000000510')}', '${id('000000000012')}', '${id('000000000008')}',
      '${id('000000000010')}', '${id('000000000002')}', '${id('000000000019')}',
      '${id('000000000005')}', '${id('000000000015')}', 'QUEUED', '${id('000000000009')}');
    INSERT INTO ai.legal_hold (id, hold_key, reason, placed_by)
    VALUES ('${id('000000000514')}', 'artifact-hold-${fixture}', 'retention test', '${id('000000000005')}');
    INSERT INTO ai.ai_run_artifact
      (id, run_id, artifact_kind, object_key, sha256, data_classification, retention_until, created_at)
    VALUES
      ('${id('000000000511')}', '${id('000000000510')}', 'TRACE', 'expired-${fixture}', repeat('5',64),
       'INTERNAL', now() - interval '1 year', now() - interval '2 years'),
      ('${id('000000000512')}', '${id('000000000510')}', 'TRACE', 'held-${fixture}', repeat('6',64),
       'INTERNAL', now() - interval '1 year', now() - interval '2 years');
    INSERT INTO ai.legal_hold_object (hold_id, object_kind, object_id)
    VALUES ('${id('000000000514')}', 'ARTIFACT', '${id('000000000512')}');`);
  expectCoreFailure(`SELECT * FROM ai.cleanup_expired_run_artifacts(now(), 10);`, /permission denied/iu);
  for (const args of ['now(), NULL', 'now(), 0', 'now(), 101', "now() + interval '1 day', 10"]) {
    expectAiFailure(`SELECT * FROM ai.cleanup_expired_run_artifacts(${args});`, /invalid artifact cleanup bounds/iu);
  }
  assert.equal(execAiSql(`SELECT count(*) FROM ai.cleanup_expired_run_artifacts(now(), 10);`), '1');
  assert.equal(execAiSql(`SELECT count(*) FROM ai.ai_run_artifact
    WHERE id IN ('${id('000000000511')}', '${id('000000000512')}');`), '1');
  execSql(`UPDATE ai.legal_hold SET released_by = '${id('000000000005')}', released_at = now()
    WHERE id = '${id('000000000514')}';`);
  assert.equal(execAiSql(`SELECT count(*) FROM ai.cleanup_expired_run_artifacts(now(), 10);`), '1');

  execSql(`INSERT INTO ai.legal_hold (id, hold_key, reason, placed_by) VALUES
      ('${id('000000000517')}', 'artifact-race-${fixture}', 'artifact race', '${id('000000000005')}'),
      ('${id('000000000518')}', 'run-race-${fixture}', 'run race', '${id('000000000005')}');
    INSERT INTO ai.ai_run_artifact
      (id, run_id, artifact_kind, object_key, sha256, data_classification, retention_until, created_at)
    VALUES
      ('${id('000000000515')}', '${id('000000000510')}', 'TRACE', 'artifact-race-${fixture}', repeat('7',64),
       'INTERNAL', now() - interval '1 year', now() - interval '2 years'),
      ('${id('000000000516')}', '${id('000000000510')}', 'TRACE', 'run-race-${fixture}', repeat('8',64),
       'INTERNAL', now() - interval '1 year', now() - interval '2 years');`);
  const cleanupWins = runAiSql(`BEGIN; SET LOCAL lock_timeout = '3s';
    SELECT count(*) FROM ai.cleanup_expired_run_artifacts(now(), 1);
    SELECT pg_sleep(1); COMMIT;`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  const lateArtifactHold = await runSql(`BEGIN; SET LOCAL lock_timeout = '3s';
    INSERT INTO ai.legal_hold_object (hold_id, object_kind, object_id)
    VALUES ('${id('000000000517')}', 'ARTIFACT', '${id('000000000515')}'); COMMIT;`);
  const cleanupWinsResult = await cleanupWins;
  assert.equal(cleanupWinsResult.code, 0, cleanupWinsResult.stderr);
  assert.notEqual(lateArtifactHold.code, 0, 'dangling legal hold was accepted after artifact cleanup');
  assert.match(lateArtifactHold.stderr, /legal hold target does not exist/iu);
  assert.equal(execSql(`SELECT count(*) FROM ai.legal_hold_object
    WHERE hold_id = '${id('000000000517')}';`), '0');

  const runHoldWins = runSql(`BEGIN; SET LOCAL lock_timeout = '3s';
    INSERT INTO ai.legal_hold_object (hold_id, object_kind, object_id)
    VALUES ('${id('000000000518')}', 'RUN', '${id('000000000510')}');
    SELECT pg_sleep(1); COMMIT;`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  const blockedCleanup = await runAiSql(`BEGIN; SET LOCAL lock_timeout = '3s';
    SELECT count(*) FROM ai.cleanup_expired_run_artifacts(now(), 10); COMMIT;`);
  const runHoldResult = await runHoldWins;
  assert.equal(runHoldResult.code, 0, runHoldResult.stderr);
  assert.equal(blockedCleanup.code, 0, blockedCleanup.stderr);
  assert.match(blockedCleanup.stdout, /0/iu);
  assert.equal(execSql(`SELECT count(*) FROM ai.ai_run_artifact WHERE id = '${id('000000000516')}';`), '1');

  const hits = execAiSql(`SELECT string_agg(chunk_id::text, ',') FROM ai.authorized_hybrid_retrieval(
    '${id('000000000030')}', '${id('000000000009')}', 'allowed', '[1,0,0]'::public.vector, 10, 10, 10);`);
  assert.match(hits, /000000000021/);
  assert.doesNotMatch(hits, /000000000022/);
  expectAiFailure(`SELECT * FROM ai.authorized_hybrid_retrieval('${id('000000000030')}',
    '${id('000000000029')}', 'allowed', '[1,0,0]'::public.vector, 10, 10, 10);`,
  /embedding space does not match governed run/iu);
  for (const limits of ['NULL, 10, 10', '10, NULL, 10', '10, 10, NULL', '0, 10, 10', '201, 10, 10', '10, 10, 101']) {
    expectAiFailure(`SELECT * FROM ai.authorized_hybrid_retrieval('${id('000000000030')}',
      '${id('000000000009')}', 'allowed', '[1,0,0]'::public.vector, ${limits});`, /invalid retrieval bounds/iu);
  }
  assert.match(execSql(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'ai'
    AND tablename = 'chunk_embedding_${id('000000000009').replaceAll('-', '_')}' AND indexdef ILIKE '%hnsw%';`), /hnsw/iu,
  'HNSW index existence and real vector retrieval');

  assert.equal(execAiSql(`SELECT ai.record_retrieval_trace('${id('000000000045')}', '${id('000000000030')}',
    '${id('000000000009')}', repeat('5',64), 1, 2, 1, '{}');`), id('000000000045'));
  execAiSql(`SELECT ai.record_retrieval_hit('${id('000000000045')}', '${id('000000000017')}',
    '${id('000000000021')}', 1, 1, 2, 1, repeat('6',64), false);`);
  expectAiFailure(`SELECT ai.record_retrieval_hit('${id('000000000045')}', '${id('000000000018')}',
    '${id('000000000022')}', 1, 1, 2, 2, repeat('7',64), false);`, /not authorized by grant/iu);

  for (const limit of ['NULL', '0', '101']) {
    expectAiFailure(`SELECT * FROM ai.claim_ingestion_jobs('worker-a', ${limit}, interval '30 seconds');`, /invalid ingestion claim bounds/iu);
    expectAiFailure(`SELECT * FROM ai.claim_event_consumptions('event-worker', ${limit}, interval '30 seconds');`, /invalid event claim bounds/iu);
  }
  expectAiFailure(`SELECT * FROM ai.claim_ingestion_jobs('worker-a', 1, NULL);`, /invalid ingestion claim bounds/iu);
  expectAiFailure(`SELECT * FROM ai.claim_event_consumptions('event-worker', 1, NULL);`, /invalid event claim bounds/iu);
  const claimed = execAiSql(`SELECT count(*) FROM ai.claim_ingestion_jobs('worker-a', 1, interval '30 seconds');`);
  assert.equal(claimed, '1');
  assert.equal(execAiSql(`SELECT status || '|' || worker_id FROM ai.ingestion_attempt
    WHERE job_id = '${id('000000000026')}' AND attempt_number = 1;`), 'RUNNING|worker-a');
  assert.equal(execAiSql(`SELECT count(*) FROM ai.claim_ingestion_jobs('lease-cleaner', 10, interval '30 seconds');`), '0');
  assert.equal(execAiSql(`SELECT status || '|' || sanitized_error || '|' || (completed_at IS NOT NULL)
    FROM ai.ingestion_job WHERE id = '${id('000000000058')}';`),
  'FAILED|LEASE_EXPIRED_MAX_ATTEMPTS|true');
  assert.equal(execAiSql(`SELECT status || '|' || sanitized_error || '|' || (completed_at IS NOT NULL)
    FROM ai.ingestion_attempt WHERE job_id = '${id('000000000058')}';`),
  'FAILED|LEASE_EXPIRED_MAX_ATTEMPTS|true');
  execSql(`UPDATE ai.ingestion_job SET lease_expires_at = now() - interval '1 second'
           WHERE lease_owner = 'worker-a';`);
  const reclaimed = execAiSql(`SELECT count(*) FROM ai.claim_ingestion_jobs('worker-b', 10, interval '30 seconds');`);
  assert.equal(reclaimed, '1');
  assert.equal(execAiSql(`SELECT string_agg(attempt_number || ':' || status || ':' || worker_id, ',' ORDER BY attempt_number)
    FROM ai.ingestion_attempt WHERE job_id = '${id('000000000026')}';`),
  '1:FAILED:worker-a,2:RUNNING:worker-b');
  execAiSql(`SELECT ai.checkpoint_ingestion_attempt('${id('000000000026')}', 'worker-b', 'PARSE', '{"page":1}');`);
  expectAiFailure(`SELECT ai.persist_ingestion_document_version('${id('000000000026')}', 'worker-b',
    '${id('00000000004a')}', 2, 'wrong-${fixture}', repeat('f',64), 'text/plain', 'PUBLIC');`,
  /content hash does not match claimed job/iu);
  execAiSql(`SELECT ai.persist_ingestion_document_version('${id('000000000026')}', 'worker-b',
    '${id('000000000037')}', 2, 'ingested-${fixture}', repeat('8',64), 'text/plain', 'PUBLIC');`);
  expectAiFailure(`SELECT ai.persist_ingestion_chunk_embedding('${id('000000000026')}', 'worker-b',
    '${id('00000000004b')}', '${id('00000000004d')}', 0, 'old', repeat('d',64), 1,
    '{}', '${id('000000000029')}', '[1,0,0]'::public.vector);`, /produced document version/iu);
  expectAiFailure(`SELECT ai.persist_ingestion_chunk_embedding('${id('000000000026')}', 'worker-b',
    '${id('000000000037')}', '${id('00000000004e')}', 0, 'active', repeat('e',64), 1,
    '{}', '${id('000000000009')}', '[1,0,0]'::public.vector);`, /embedding space does not match claimed ingestion job/iu);
  execAiSql(`SELECT ai.persist_ingestion_chunk_embedding('${id('000000000026')}', 'worker-b',
    '${id('000000000037')}', '${id('000000000038')}', 0, 'candidate knowledge', repeat('9',64),
    2, '{}', '${id('000000000029')}', '[1,0,0]'::public.vector);`);
  execAiSql(`SELECT ai.finalize_ingestion_job('${id('000000000026')}', 'worker-b', '{"done":true}');`);
  assert.equal(execAiSql(`SELECT status || '|' || stage || '|' || (completed_at IS NOT NULL)
    FROM ai.ingestion_attempt WHERE job_id = '${id('000000000026')}' AND attempt_number = 2;`),
  'SUCCEEDED|COMPLETE|true');

  execSql(`INSERT INTO ai.knowledge_document_version
      (id, document_id, version, object_key, content_hash, mime_type, parser_version, data_classification)
    VALUES ('${id('000000000601')}', '${id('000000000036')}', 3, 'completion-race-${fixture}',
      repeat('1',64), 'text/plain', 'parser-v1', 'PUBLIC');
    INSERT INTO ai.knowledge_chunk
      (id, document_version_id, ordinal, content, content_hash, token_count, metadata)
    VALUES ('${id('000000000602')}', '${id('000000000601')}', 0, 'completion race chunk', repeat('2',64), 3, '{}');
    INSERT INTO ai.chunk_embedding (embedding_space_id, chunk_id, embedding)
    VALUES ('${id('000000000029')}', '${id('000000000602')}', '[1,0,0]');
    INSERT INTO ai.ingestion_job
      (id, source_id, document_id, produced_document_version_id, source_version,
       source_object_hash, normalized_content_hash, parser_version, chunker_version,
       candidate_embedding_space_id, corpus_manifest_digest, checkpoint, stage, status,
       attempts, lease_owner, lease_expires_at, created_at, updated_at)
    VALUES ('${id('000000000600')}', '${id('000000000014')}', '${id('000000000036')}',
      '${id('000000000601')}', 'completion-race', repeat('3',64), repeat('1',64),
      'parser-v1', 'chunker-v1', '${id('000000000029')}', repeat('9',64), '{}', 'EMBED',
      'PROCESSING', 1, 'completion-worker', now() + interval '5 minutes', now(), now());
    INSERT INTO ai.ingestion_attempt
      (id, job_id, attempt_number, worker_id, stage, checkpoint, status, lease_expires_at)
    VALUES ('${id('000000000603')}', '${id('000000000600')}', 1, 'completion-worker', 'EMBED', '{}',
      'RUNNING', now() + interval '5 minutes');
    INSERT INTO ai.ingestion_job
      (id, source_id, document_id, source_version, source_object_hash, normalized_content_hash,
       parser_version, chunker_version, candidate_embedding_space_id, corpus_manifest_digest,
       checkpoint, stage, status, attempts, lease_owner, lease_expires_at, created_at, updated_at)
    VALUES ('${id('000000000604')}', '${id('000000000014')}', '${id('000000000036')}', 'deadlock-race',
      repeat('4',64), repeat('5',64), 'parser-v1', 'chunker-v1', '${id('000000000029')}',
      repeat('9',64), '{}', 'FETCH', 'PROCESSING', 1, 'deadlock-worker', now() + interval '5 minutes', now(), now());
    INSERT INTO ai.ingestion_attempt
      (id, job_id, attempt_number, worker_id, stage, checkpoint, status, lease_expires_at)
    VALUES ('${id('000000000605')}', '${id('000000000604')}', 1, 'deadlock-worker', 'FETCH', '{}',
      'RUNNING', now() + interval '5 minutes');`);

  const gateHoldsCandidate = runAiSql(`BEGIN; SET LOCAL lock_timeout = '3s';
    SELECT ai.begin_embedding_space_gate('${id('000000000610')}', '${id('000000000521')}',
      '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('4',64));
    SELECT pg_sleep(1); COMMIT;`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  const completionWaits = runAiSql(`BEGIN; SET LOCAL lock_timeout = '3s';
    SELECT ai.finalize_ingestion_job('${id('000000000600')}', 'completion-worker', '{"done":true}'); COMMIT;`);
  const [gateLockResult, completionResult] = await Promise.all([gateHoldsCandidate, completionWaits]);
  assert.equal(gateLockResult.code, 0, gateLockResult.stderr);
  assert.equal(completionResult.code, 0, completionResult.stderr);
  expectAiFailure(`SELECT ai.finalize_embedding_space_gate('${id('000000000610')}');`, /gate corpus snapshot changed/iu);

  const deadlockGate = runAiSql(`BEGIN; SET LOCAL lock_timeout = '3s';
    SELECT ai.begin_embedding_space_gate('${id('000000000611')}', '${id('000000000523')}',
      '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('5',64));
    SELECT pg_sleep(1); COMMIT;`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  const deadlockWorker = runAiSql(`BEGIN; SET LOCAL lock_timeout = '3s';
    SELECT ai.checkpoint_ingestion_attempt('${id('000000000604')}', 'deadlock-worker', 'PARSE', '{"race":true}'); COMMIT;`);
  const [deadlockGateResult, deadlockWorkerResult] = await Promise.all([deadlockGate, deadlockWorker]);
  assert.equal(deadlockGateResult.code, 0, `deadlock regression gate failed: ${deadlockGateResult.stderr}`);
  assert.equal(deadlockWorkerResult.code, 0, `deadlock regression worker failed: ${deadlockWorkerResult.stderr}`);

  execSql(`INSERT INTO ai.ingestion_job
    (id, source_id, document_id, source_version, source_object_hash, normalized_content_hash,
     parser_version, chunker_version, candidate_embedding_space_id,
     corpus_manifest_digest, checkpoint, stage, status, created_at, updated_at)
    VALUES ('${id('000000000070')}', '${id('000000000014')}', '${id('000000000036')}', 'failure',
      repeat('e',64), repeat('f',64), 'parser-v1', 'chunker-v1', '${id('000000000029')}', repeat('9',64), '{}', 'FETCH', 'PENDING', now(), now());`);
  assert.equal(execAiSql(`SELECT count(*) FROM ai.claim_ingestion_jobs('failure-worker', 1, interval '30 seconds');`), '1');
  assert.equal(execAiSql(`SELECT ai.fail_ingestion_job('${id('000000000070')}', 'failure-worker',
    'sanitized failure', interval '1 minute');`), 'RETRY');
  assert.equal(execAiSql(`SELECT status || '|' || sanitized_error || '|' || (completed_at IS NOT NULL)
    FROM ai.ingestion_attempt WHERE job_id = '${id('000000000070')}';`),
  'FAILED|sanitized failure|true');
  execSql(`INSERT INTO ai.ingestion_job
    (id, source_id, document_id, source_version, source_object_hash, normalized_content_hash,
     parser_version, chunker_version, candidate_embedding_space_id, corpus_manifest_digest, checkpoint, stage, status, created_at, updated_at)
    VALUES ('${id('000000000079')}', '${id('000000000014')}', '${id('000000000036')}', 'v1',
      repeat('7',64), repeat('8',64), 'parser-v1', 'chunker-v2', '${id('000000000029')}', repeat('9',64), '{}', 'FETCH', 'PENDING', now(), now());`);
  assert.equal(execSql(`SELECT string_agg(chunker_version, ',' ORDER BY chunker_version)
    FROM ai.ingestion_job WHERE source_id = '${id('000000000014')}' AND source_version = 'v1';`),
  'chunker-v1,chunker-v2');
  expectSqlFailure(`INSERT INTO ai.ingestion_job
    (id, source_id, document_id, source_version, source_object_hash, normalized_content_hash,
     parser_version, chunker_version, candidate_embedding_space_id, corpus_manifest_digest, checkpoint, stage, status)
    VALUES ('${id('00000000007a')}', '${id('000000000014')}', '${id('000000000036')}', 'v1',
      repeat('7',64), repeat('8',64), 'parser-v1', 'chunker-v1', '${id('000000000029')}', repeat('9',64), '{}', 'FETCH', 'PENDING');`,
  /duplicate key value violates unique constraint/iu);
  expectAiFailure(`SELECT * FROM ai.authorized_hybrid_retrieval('${id('000000000030')}',
    '${id('000000000029')}', 'candidate', '[1,0,0]'::public.vector, 10, 10, 10);`,
  /embedding space does not match governed run/iu);

  const eventId = execAiSql(`SELECT ai.register_event_consumption('${id('000000000027')}', 'consumer',
    '${id('000000000028')}', 'test.event', 1, 'document', '${id('000000000036')}', 1);`);
  assert.equal(eventId, id('000000000027'));
  assert.equal(execAiSql(`SELECT ai.register_event_consumption('${id('00000000002f')}', 'consumer',
    '${id('000000000028')}', 'test.event', 1, 'document', '${id('000000000036')}', 1);`), eventId,
  'event dedup positive path');
  execSql(`INSERT INTO ai.event_consumption
    (id, consumer_key, event_id, event_type, schema_version, aggregate_type, aggregate_id,
     aggregate_version, status, attempts, max_attempts, lease_owner, lease_expires_at, created_at)
    VALUES ('${id('000000000072')}', 'crashed-consumer', '${id('000000000073')}', 'crashed.event', 1,
      'document', '${id('000000000036')}', 1, 'PROCESSING', 1, 1, 'crashed-event-worker',
      now() - interval '1 minute', now() - interval '1 hour');`);
  assert.equal(execAiSql(`SELECT count(*) FROM ai.claim_event_consumptions('event-worker-a', 10, interval '30 seconds');`), '1');
  assert.equal(execAiSql(`SELECT status || '|' || sanitized_terminal_error || '|' || (dead_at IS NOT NULL)
    FROM ai.event_consumption WHERE id = '${id('000000000072')}';`),
  'DEAD|LEASE_EXPIRED_MAX_ATTEMPTS|true');
  execSql(`UPDATE ai.event_consumption SET lease_expires_at = now() - interval '1 second'
           WHERE lease_owner = 'event-worker-a';`);
  assert.equal(execAiSql(`SELECT count(*) FROM ai.claim_event_consumptions('event-worker-b', 10, interval '30 seconds');`), '1',
    'stale event lease is reclaimed');
  execAiSql(`SELECT ai.finalize_event_consumption('${id('000000000027')}', 'event-worker-b');`);
  assert.equal(execAiSql(`SELECT ai.register_event_consumption('${id('00000000002e')}', 'consumer',
    '${id('000000000028')}', 'test.event', 1, 'document', '${id('000000000036')}', 1);`), eventId,
  'terminal event dedup returns the durable record');

  const gateEvidence = (evaluationId, start, count, numerator, denominator, recall) =>
    Array.from({ length: count }, (_, index) => `SELECT ai.record_embedding_gate_case('${evaluationId}',
      '${id(String(start + index).padStart(12, '0'))}', ${numerator}, ${denominator}, ${recall}, repeat('b',64));`).join('\n');

  execSql(`INSERT INTO ai.knowledge_chunk
    (id, document_version_id, ordinal, content, content_hash, token_count, metadata)
    VALUES ('${id('000000000081')}', '${id('000000000037')}', 1, 'late embedding', repeat('1',64), 2, '{}');`);
  execAiSql(`SELECT ai.begin_embedding_space_gate('${id('000000000506')}', '${id('000000000501')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('1',64));`);
  const embeddingMutation = runSql(`BEGIN;
    INSERT INTO ai.chunk_embedding (embedding_space_id, chunk_id, embedding)
    VALUES ('${id('000000000029')}', '${id('000000000081')}', '[1,0,0]');
    SELECT pg_sleep(1);
    COMMIT;`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  const concurrentFinalize = await runAiSql(`SELECT ai.finalize_embedding_space_gate('${id('000000000506')}');`);
  const mutationResult = await embeddingMutation;
  assert.equal(mutationResult.code, 0, mutationResult.stderr);
  assert.notEqual(concurrentFinalize.code, 0, 'concurrent embedding change unexpectedly finalized');
  assert.match(concurrentFinalize.stderr, /gate corpus snapshot changed/iu);

  execAiSql(`SELECT ai.begin_embedding_space_gate('${id('000000000507')}', '${id('000000000503')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('2',64));`);
  execSql(`INSERT INTO ai.knowledge_chunk
    (id, document_version_id, ordinal, content, content_hash, token_count, metadata)
    VALUES ('${id('000000000082')}', '${id('000000000037')}', 2, 'new eligible chunk', repeat('2',64), 3, '{}');`);
  expectAiFailure(`SELECT ai.finalize_embedding_space_gate('${id('000000000507')}');`, /gate corpus snapshot changed/iu);
  execSql(`INSERT INTO ai.chunk_embedding (embedding_space_id, chunk_id, embedding)
    VALUES ('${id('000000000029')}', '${id('000000000082')}', '[1,0,0]');`);

  execAiSql(`SELECT ai.begin_embedding_space_gate('${id('000000000508')}', '${id('000000000505')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('3',64));`);
  execSql(`UPDATE ai.embedding_space SET status = 'FAILED' WHERE id = '${id('000000000029')}';`);
  expectAiFailure(`SELECT ai.finalize_embedding_space_gate('${id('000000000508')}');`, /candidate embedding space is not BUILDING/iu);
  execSql(`UPDATE ai.embedding_space SET status = 'BUILDING' WHERE id = '${id('000000000029')}';`);

  expectAiFailure(`SELECT ai.begin_embedding_space_gate('${id('000000000069')}', '${id('000000000076')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('5',64));`,
  /dataset version is not PUBLISHED/iu);
  expectAiFailure(`SELECT ai.begin_embedding_space_gate('${id('00000000006a')}', '${id('000000000077')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('6',64));`,
  /dataset version is not PUBLISHED/iu);

  execAiSql(`SELECT ai.begin_embedding_space_gate('${id('000000000046')}', '${id('000000000013')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('a',64));`);
  expectAiFailure(`SELECT ai.finalize_embedding_space_gate('${id('000000000046')}');`,
  /partial evidence cannot finalize a complete evaluation dataset/iu);

  execAiSql(`SELECT ai.begin_embedding_space_gate('${id('000000000066')}', '${id('000000000063')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('1',64));`);
  execAiSql(gateEvidence(id('000000000066'), 200, 1, 1, 1, 1));
  expectAiFailure(`SELECT ai.finalize_embedding_space_gate('${id('000000000066')}');`, /at least 20/iu);
  execSql(`UPDATE ai.evaluation_dataset_version SET status = 'RETIRED' WHERE id = '${id('000000000063')}';`);
  expectAiFailure(`SELECT ai.finalize_embedding_space_gate('${id('000000000066')}');`, /dataset version is not PUBLISHED/iu);
  expectSqlFailure(`UPDATE ai.evaluation_dataset_version SET status = 'PUBLISHED'
    WHERE id = '${id('000000000063')}';`, /retired evaluation dataset version is immutable/iu);

  execAiSql(`SELECT ai.begin_embedding_space_gate('${id('000000000067')}', '${id('000000000064')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('2',64));`);
  execAiSql(gateEvidence(id('000000000067'), 300, 19, 1, 1, 1));
  expectAiFailure(`SELECT ai.finalize_embedding_space_gate('${id('000000000067')}');`, /at least 20/iu);
  execSql(`ALTER TABLE ai.evaluation_dataset_version DISABLE TRIGGER trg_evaluation_dataset_version_lifecycle;
    UPDATE ai.evaluation_dataset_version SET content_hash = repeat('8',64) WHERE id = '${id('000000000064')}';
    ALTER TABLE ai.evaluation_dataset_version ENABLE TRIGGER trg_evaluation_dataset_version_lifecycle;`);
  expectAiFailure(`SELECT ai.finalize_embedding_space_gate('${id('000000000067')}');`, /dataset version content hash changed/iu);

  execAiSql(`SELECT ai.begin_embedding_space_gate('${id('000000000068')}', '${id('000000000065')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('3',64));`);
  execAiSql(gateEvidence(id('000000000068'), 400, 19, 1, 1, 1));
  expectAiFailure(gateEvidence(id('000000000068'), 419, 1, 1, 1, 1), /evaluation case must contain non-empty input and expected properties/iu);
  execSql(`INSERT INTO ai.embedding_space_gate_case_evidence
    (evaluation_id, case_id, citation_numerator, citation_denominator, recall_at_10, evidence_hash)
    VALUES ('${id('000000000068')}', '${id('000000000419')}', 1, 1, 1, repeat('4',64));`);
  expectAiFailure(`SELECT ai.finalize_embedding_space_gate('${id('000000000068')}');`, /evaluation dataset contains empty cases/iu);

  execAiSql(gateEvidence(id('000000000046'), 100, 20, 1, 1, 1));
  expectAiFailure(`SELECT ai.finalize_embedding_space_gate('${id('000000000046')}');`,
  /partial evidence cannot finalize a complete evaluation dataset/iu);
  execAiSql(gateEvidence(id('000000000046'), 120, 10, 0, 1, 0));
  assert.equal(execAiSql(`SELECT ai.finalize_embedding_space_gate('${id('000000000046')}');`), 'FAIL');
  assert.equal(execAiSql(`SELECT dataset_content_hash || '|' || citation_numerator || '|' || citation_denominator ||
    '|' || recall_sum || '|' || recall_count FROM ai.embedding_space_gate_result
    WHERE id = '${id('000000000046')}';`), `${'1'.repeat(64)}|20|30|20|30`);

  execAiSql(`SELECT ai.begin_embedding_space_gate('${id('000000000047')}', '${id('00000000003b')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('c',64));`);
  execAiSql(gateEvidence(id('000000000047'), 130, 20, 18, 20, 0.84));
  assert.equal(execAiSql(`SELECT ai.finalize_embedding_space_gate('${id('000000000047')}');`), 'FAIL');

  execSql(`INSERT INTO ai.knowledge_document_version
      (id, document_id, version, object_key, content_hash, mime_type, parser_version, data_classification)
    VALUES ('${id('000000000528')}', '${id('000000000036')}', 4, 'post-pass-${fixture}',
      repeat('6',64), 'text/plain', 'parser-v1', 'PUBLIC');
    INSERT INTO ai.knowledge_chunk
      (id, document_version_id, ordinal, content, content_hash, token_count, metadata)
    VALUES ('${id('000000000529')}', '${id('000000000528')}', 0, 'post pass chunk', repeat('7',64), 3, '{}');
    INSERT INTO ai.ingestion_job
      (id, source_id, document_id, produced_document_version_id, source_version,
       source_object_hash, normalized_content_hash, parser_version, chunker_version,
       candidate_embedding_space_id, corpus_manifest_digest, checkpoint, stage, status,
       attempts, lease_owner, lease_expires_at, created_at, updated_at)
    VALUES ('${id('000000000527')}', '${id('000000000014')}', '${id('000000000036')}',
      '${id('000000000528')}', 'post-pass', repeat('8',64), repeat('6',64), 'parser-v1', 'chunker-v1',
      '${id('000000000029')}', repeat('9',64), '{}', 'CHUNK', 'PROCESSING', 1, 'post-pass-worker',
      now() + interval '5 minutes', now(), now());
    INSERT INTO ai.ingestion_attempt
      (id, job_id, attempt_number, worker_id, stage, checkpoint, status, lease_expires_at)
    VALUES ('${id('000000000530')}', '${id('000000000527')}', 1, 'post-pass-worker', 'CHUNK', '{}',
      'RUNNING', now() + interval '5 minutes');`);
  execAiSql(`SELECT ai.begin_embedding_space_gate('${id('000000000526')}', '${id('000000000525')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('6',64));`);
  execAiSql(gateEvidence(id('000000000526'), 700, 20, 1, 1, 1));
  assert.equal(execAiSql(`SELECT ai.finalize_embedding_space_gate('${id('000000000526')}');`), 'PASS');
  expectAiFailure(`SELECT ai.finalize_ingestion_job('${id('000000000527')}', 'post-pass-worker', '{}');`,
    /ingestion completion is blocked by finalized gate/iu);
  expectAiFailure(`SELECT ai.begin_embedding_space_gate('${id('000000000048')}', '${id('000000000013')}',
    '${id('000000000029')}', repeat('8',64), '${id('000000000009')}', repeat('e',64));`, /stale corpus manifest/iu);
  assert.equal(execAiSql(`SELECT minimum_coverage || '|' || maximum_leakage || '|' ||
    minimum_citation_precision || '|' || minimum_recall_at_10
    FROM ai.embedding_space_gate_result WHERE id = '${id('000000000046')}';`), '1.0|0|0.95|0.85');
  expectAiFailure(`INSERT INTO ai.embedding_space_gate_result (id) VALUES (gen_random_uuid());`, /permission denied/iu);

  assert.equal(execAiSql(`SELECT bool_and(retained) FROM (
    SELECT retention_until >= started_at + interval '1 year' AS retained FROM ai.model_invocation
    UNION ALL SELECT retention_until >= created_at + interval '1 year' FROM ai.retrieval_trace
    UNION ALL SELECT retention_until >= created_at + interval '1 year' FROM ai.retrieval_hit
    UNION ALL SELECT retention_until >= created_at + interval '1 year' FROM ai.ai_run_artifact
    UNION ALL SELECT retention_until >= evaluated_at + interval '1 year' FROM ai.embedding_space_gate_result
  ) retention_checks;`), 't');
});
