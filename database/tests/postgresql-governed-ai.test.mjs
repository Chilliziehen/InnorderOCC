import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const docker = process.env.DOCKER_PATH ?? (process.platform === 'win32' ? 'docker.exe' : 'docker');
const image = process.env.PGVECTOR_TEST_IMAGE ?? 'pgvector/pgvector:pg16';
const container = `innorder-governed-ai-${randomUUID()}`;
const password = randomUUID();
const aiPassword = randomUUID();
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
    VALUES ('${id('000000000008')}', '${id('000000000006')}', 'test-model', 'EMBEDDING', '{}', '{}', 1000, '{}', '{}', 'ACTIVE');
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
      ('${id('000000000062')}', 'test.empty.${prefix}', 'Empty-case dataset');
    INSERT INTO ai.evaluation_dataset_version (id, dataset_id, version, content_hash, status) VALUES
      ('${id('000000000063')}', '${id('000000000060')}', 1, repeat('3', 64), 'DRAFT'),
      ('${id('000000000064')}', '${id('000000000061')}', 1, repeat('4', 64), 'DRAFT'),
      ('${id('000000000065')}', '${id('000000000062')}', 1, repeat('5', 64), 'DRAFT');
    INSERT INTO ai.evaluation_case (id, dataset_version_id, case_key, input, expected_properties) VALUES
      ${cases('000000000013', 100, 20)},
      ${cases('00000000003b', 120, 20)},
      ${cases('000000000063', 200, 1)},
      ${cases('000000000064', 300, 19)},
      ${cases('000000000065', 400, 20, 19)};

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
       issued_at, expires_at, event_id, intended_run_id)
    SELECT grant_input.id, grant_input.token_hash, 'RETRIEVE', grant_input.jti,
           '${id('000000000005')}', '${id('000000000015')}', 'answer',
           current_revision + grant_input.revision_offset, '${id('000000000019')}', repeat('d', 64),
           repeat('6', 64), repeat('7', 64), '{"scope":"test"}', 'PUBLIC',
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
      (id, source_id, document_id, source_version, content_hash, parser_version,
       corpus_manifest_digest, checkpoint, stage, status, created_at, updated_at)
    VALUES ('${id('000000000026')}', '${id('000000000014')}', '${id('000000000036')}', 'v1',
            repeat('8', 64), '1', repeat('9', 64), '{}', 'FETCH', 'PENDING',
            now() - interval '1 hour', now() - interval '1 hour');
    INSERT INTO ai.ingestion_job
      (id, source_id, document_id, source_version, content_hash, parser_version,
       corpus_manifest_digest, checkpoint, stage, status, attempts, max_attempts,
       lease_owner, lease_expires_at, created_at, updated_at)
    VALUES ('${id('000000000058')}', '${id('000000000014')}', '${id('000000000036')}', 'crashed',
            repeat('d', 64), '1', repeat('9', 64), '{}', 'FETCH', 'PROCESSING', 1, 1,
            'crashed-worker', now() - interval '1 minute', now() - interval '1 hour', now() - interval '1 hour');
    INSERT INTO ai.ingestion_attempt
      (id, job_id, attempt_number, worker_id, stage, checkpoint, status, lease_expires_at, started_at)
    VALUES ('${id('000000000059')}', '${id('000000000058')}', 1, 'crashed-worker', 'FETCH', '{}',
            'RUNNING', now() - interval '1 minute', now() - interval '1 hour');
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

  execSql(readFileSync(resolve('database/bootstrap/001-create-runtime-role.sql'), 'utf8'));
  for (const migration of migrations) execSql(readFileSync(join(migrationDir, migration), 'utf8'));
  execSql(`ALTER ROLE innorder_ai_runtime LOGIN PASSWORD '${aiPassword}';`);
  assert.equal(execAiSql('SELECT current_user;'), 'innorder_ai_runtime', 'positive path uses the AI LOGIN');

  const fixture = randomUUID().replaceAll('-', '').slice(0, 8);
  const id = (suffix) => `${fixture}-0000-7000-8000-${suffix}`;
  execSql(fixtureSql(fixture));

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
  const consume = ({ token, event, operation = 'RETRIEVE', tokenRevision = revision,
    releaseDigest = 'd'.repeat(64), authorizedDigest = '6'.repeat(64),
    contextDigest = '7'.repeat(64), run }) => `
      SELECT run_id FROM authz.consume_ai_authorization_grant(
        repeat('${token}', 64), '${event}', '${operation}', ${tokenRevision},
        '${releaseDigest}', '${authorizedDigest}', '${contextDigest}', '${run}',
        '${id('000000000012')}', '${id('000000000008')}',
        '${id('000000000010')}', '${id('000000000002')}');`;

  expectAiFailure(consume({ token: 'b', event: id('000000000099'), run: id('000000000031') }), /grant token event mismatch/iu);
  expectAiFailure(consume({ token: 'b', event: id('000000000035'), operation: 'WRITE', run: id('000000000031') }), /grant token operation mismatch/iu);
  expectAiFailure(consume({ token: 'b', event: id('000000000035'), authorizedDigest: '8'.repeat(64), run: id('000000000031') }), /authorized-set digest mismatch/iu);
  expectAiFailure(consume({ token: 'b', event: id('000000000035'), contextDigest: '8'.repeat(64), run: id('000000000031') }), /context digest mismatch/iu);
  expectAiFailure(consume({ token: 'b', event: id('000000000035'), run: id('000000000099') }), /grant token run mismatch/iu);
  expectAiFailure(consume({ token: 'c', event: id('000000000039'), run: id('000000000032') }), /expired/iu);
  expectAiFailure(consume({ token: 'e', event: id('00000000003d'), tokenRevision: revision + 1, run: id('000000000033') }), /stale authorization revision/iu);

  const consumeSql = consume({ token: 'a', event: id('000000000025'), run: id('000000000030') });
  const [consumeA, consumeB] = await Promise.all([runAiSql(consumeSql), runAiSql(consumeSql)]);
  assert.equal([consumeA, consumeB].filter((result) => result.code === 0).length, 1, 'grant must be consumed once');
  assert.match([consumeA, consumeB].find((result) => result.code !== 0)?.stderr ?? '', /consumed|replay/iu);

  assert.equal(execAiSql(`SELECT ai.transition_ai_run('${id('000000000030')}', 'RUNNING');`), 'RUNNING');
  expectAiFailure(`SELECT ai.start_model_invocation('${id('000000000049')}', '${id('000000000030')}',
    '${id('000000000008')}', 'WRITE', repeat('1',64), repeat('2',64));`, /invocation operation does not match grant/iu);
  assert.equal(execAiSql(`SELECT ai.start_model_invocation('${id('000000000043')}', '${id('000000000030')}',
    '${id('000000000008')}', 'RETRIEVE', repeat('1',64), repeat('2',64));`), id('000000000043'));
  execAiSql(`SELECT ai.finalize_model_invocation('${id('000000000043')}', 'COMPLETED', repeat('3',64),
    'provider-request', 10, 2, 0.01, 12, NULL);`);
  assert.equal(execAiSql(`SELECT ai.persist_run_artifact('${id('000000000044')}', '${id('000000000030')}',
    'TRACE', 'artifact-${fixture}', repeat('4',64), 'INTERNAL');`), id('000000000044'));

  const hits = execAiSql(`SELECT string_agg(chunk_id::text, ',') FROM ai.authorized_hybrid_retrieval(
    '${id('000000000030')}', '${id('000000000009')}', 'allowed', '[1,0,0]'::public.vector, 10, 10, 10);`);
  assert.match(hits, /000000000021/);
  assert.doesNotMatch(hits, /000000000022/);
  assert.match(execSql(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'ai'
    AND tablename = 'chunk_embedding_${id('000000000009').replaceAll('-', '_')}' AND indexdef ILIKE '%hnsw%';`), /hnsw/iu,
  'HNSW index existence and real vector retrieval');

  assert.equal(execAiSql(`SELECT ai.record_retrieval_trace('${id('000000000045')}', '${id('000000000030')}',
    '${id('000000000009')}', repeat('5',64), 1, 2, 1, '{}');`), id('000000000045'));
  execAiSql(`SELECT ai.record_retrieval_hit('${id('000000000045')}', '${id('000000000017')}',
    '${id('000000000021')}', 1, 1, 2, 1, repeat('6',64), false);`);
  expectAiFailure(`SELECT ai.record_retrieval_hit('${id('000000000045')}', '${id('000000000018')}',
    '${id('000000000022')}', 1, 1, 2, 2, repeat('7',64), false);`, /not authorized by grant/iu);

  const claimed = execAiSql(`SELECT count(*) FROM ai.claim_ingestion_jobs('worker-a', 10, interval '30 seconds');`);
  assert.equal(claimed, '1');
  assert.equal(execAiSql(`SELECT status || '|' || worker_id FROM ai.ingestion_attempt
    WHERE job_id = '${id('000000000026')}' AND attempt_number = 1;`), 'RUNNING|worker-a');
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
    '{}', '${id('000000000009')}', '[1,0,0]'::public.vector);`, /embedding space is not BUILDING/iu);
  execAiSql(`SELECT ai.persist_ingestion_chunk_embedding('${id('000000000026')}', 'worker-b',
    '${id('000000000037')}', '${id('000000000038')}', 0, 'candidate knowledge', repeat('9',64),
    2, '{}', '${id('000000000029')}', '[1,0,0]'::public.vector);`);
  execAiSql(`SELECT ai.finalize_ingestion_job('${id('000000000026')}', 'worker-b', '{"done":true}');`);
  assert.equal(execAiSql(`SELECT status || '|' || stage || '|' || (completed_at IS NOT NULL)
    FROM ai.ingestion_attempt WHERE job_id = '${id('000000000026')}' AND attempt_number = 2;`),
  'SUCCEEDED|COMPLETE|true');

  execSql(`INSERT INTO ai.ingestion_job
    (id, source_id, document_id, source_version, content_hash, parser_version,
     corpus_manifest_digest, checkpoint, stage, status, created_at, updated_at)
    VALUES ('${id('000000000070')}', '${id('000000000014')}', '${id('000000000036')}', 'failure',
      repeat('f',64), '1', repeat('9',64), '{}', 'FETCH', 'PENDING', now(), now());`);
  assert.equal(execAiSql(`SELECT count(*) FROM ai.claim_ingestion_jobs('failure-worker', 1, interval '30 seconds');`), '1');
  assert.equal(execAiSql(`SELECT ai.fail_ingestion_job('${id('000000000070')}', 'failure-worker',
    'sanitized failure', interval '1 minute');`), 'RETRY');
  assert.equal(execAiSql(`SELECT status || '|' || sanitized_error || '|' || (completed_at IS NOT NULL)
    FROM ai.ingestion_attempt WHERE job_id = '${id('000000000070')}';`),
  'FAILED|sanitized failure|true');
  expectAiFailure(`SELECT * FROM ai.authorized_hybrid_retrieval('${id('000000000030')}',
    '${id('000000000029')}', 'candidate', '[1,0,0]'::public.vector, 10, 10, 10);`,
  /retrieval embedding space is not active/iu);

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

  execAiSql(`SELECT ai.begin_embedding_space_gate('${id('000000000046')}', '${id('000000000013')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('a',64));`);
  expectAiFailure(`SELECT ai.finalize_embedding_space_gate('${id('000000000046')}');`, /at least 20/iu);

  execAiSql(`SELECT ai.begin_embedding_space_gate('${id('000000000066')}', '${id('000000000063')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('1',64));`);
  execAiSql(gateEvidence(id('000000000066'), 200, 1, 1, 1, 1));
  expectAiFailure(`SELECT ai.finalize_embedding_space_gate('${id('000000000066')}');`, /at least 20/iu);

  execAiSql(`SELECT ai.begin_embedding_space_gate('${id('000000000067')}', '${id('000000000064')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('2',64));`);
  execAiSql(gateEvidence(id('000000000067'), 300, 19, 1, 1, 1));
  expectAiFailure(`SELECT ai.finalize_embedding_space_gate('${id('000000000067')}');`, /at least 20/iu);

  execAiSql(`SELECT ai.begin_embedding_space_gate('${id('000000000068')}', '${id('000000000065')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('3',64));`);
  execAiSql(gateEvidence(id('000000000068'), 400, 19, 1, 1, 1));
  expectAiFailure(gateEvidence(id('000000000068'), 419, 1, 1, 1, 1), /evaluation case must contain non-empty input and expected properties/iu);
  execSql(`INSERT INTO ai.embedding_space_gate_case_evidence
    (evaluation_id, case_id, citation_numerator, citation_denominator, recall_at_10, evidence_hash)
    VALUES ('${id('000000000068')}', '${id('000000000419')}', 1, 1, 1, repeat('4',64));`);
  expectAiFailure(`SELECT ai.finalize_embedding_space_gate('${id('000000000068')}');`, /evaluation dataset contains empty cases/iu);

  execAiSql(gateEvidence(id('000000000046'), 100, 20, 19, 20, 0.85));
  assert.equal(execAiSql(`SELECT ai.finalize_embedding_space_gate('${id('000000000046')}');`), 'PASS');

  execAiSql(`SELECT ai.begin_embedding_space_gate('${id('000000000047')}', '${id('00000000003b')}',
    '${id('000000000029')}', repeat('9',64), '${id('000000000009')}', repeat('c',64));`);
  execAiSql(gateEvidence(id('000000000047'), 120, 20, 18, 20, 0.84));
  assert.equal(execAiSql(`SELECT ai.finalize_embedding_space_gate('${id('000000000047')}');`), 'FAIL');
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
