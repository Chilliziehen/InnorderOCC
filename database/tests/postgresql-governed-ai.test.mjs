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
    'exec', '-i', '-e', `PGPASSWORD=${password}`, container,
    'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align',
    '--username', 'postgres', '--dbname', 'innorder_test',
  ], { input: prefix + sql });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.split(/\r?\n/u).filter((line) => line.trim() !== 'SET').join('\n').trim();
}

function runSql(sql) {
  const child = spawn(docker, [
    'exec', '-i', '-e', `PGPASSWORD=${password}`, container,
    'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align',
    '--username', 'postgres', '--dbname', 'innorder_test',
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    'exec', '-i', '-e', `PGPASSWORD=${password}`, container,
    'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--username', 'postgres', '--dbname', 'innorder_test',
  ], { input: `SET ROLE innorder_ai_runtime;\n${sql}` });
  assert.notEqual(result.status, 0, `${sql} unexpectedly succeeded`);
  assert.match(result.stderr, pattern);
}

function fixtureSql(prefix) {
  const id = (suffix) => `${prefix}-0000-7000-8000-${suffix}`;
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
      ('${id('000000000016')}', '${id('000000000023')}', '${id('000000000024')}', 'document:denied:${prefix}', 'ACTIVE', '{}');
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
      (id, model_profile_id, dimensions, distance_metric, corpus_version, status, coverage)
    VALUES ('${id('000000000009')}', '${id('000000000008')}', 3, 'COSINE', 'manifest-v1', 'BUILDING', 0);
    SELECT ai.create_embedding_partition('${id('000000000009')}', 3, 'COSINE');

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

    INSERT INTO ai.knowledge_source
      (id, source_type, sync_config, state, sync_cursor)
    VALUES ('${id('000000000014')}', 'UPLOAD', '{}', 'ACTIVE', '{}');
    INSERT INTO ai.knowledge_document (id, source_id, document_key, state)
    VALUES
      ('${id('000000000015')}', '${id('000000000014')}', 'allowed', 'PENDING'),
      ('${id('000000000016')}', '${id('000000000014')}', 'denied', 'PENDING');
    INSERT INTO ai.knowledge_document_version
      (id, document_id, version, object_key, content_hash, mime_type, parser_version, data_classification)
    VALUES
      ('${id('000000000017')}', '${id('000000000015')}', 1, 'allowed-${prefix}', repeat('2', 64), 'text/plain', '1', 'PUBLIC'),
      ('${id('000000000018')}', '${id('000000000016')}', 1, 'denied-${prefix}', repeat('3', 64), 'text/plain', '1', 'PUBLIC');
    INSERT INTO ai.knowledge_chunk
      (id, document_version_id, ordinal, content, content_hash, token_count, metadata)
    VALUES
      ('${id('000000000021')}', '${id('000000000017')}', 0, 'allowed knowledge', repeat('4', 64), 2, '{}'),
      ('${id('000000000022')}', '${id('000000000018')}', 0, 'allowed but unauthorized', repeat('5', 64), 3, '{}');
    INSERT INTO ai.chunk_embedding (embedding_space_id, chunk_id, embedding)
    VALUES
      ('${id('000000000009')}', '${id('000000000021')}', '[1,0,0]'),
      ('${id('000000000009')}', '${id('000000000022')}', '[1,0,0]');

    INSERT INTO authz.ai_authorization_grant
      (id, token_hash, operation, jti, principal_id, target_entity_id, purpose,
       authorization_revision, policy_release_id, policy_release_digest,
       authorized_set_digest, context_digest, bounded_context, classification_ceiling,
       issued_at, expires_at, event_id)
    SELECT '${id('000000000020')}', repeat('a', 64), 'RETRIEVE', 'jti-${prefix}',
           '${id('000000000005')}', '${id('000000000015')}', 'answer', current_revision,
           '${id('000000000019')}', repeat('d', 64), repeat('6', 64), repeat('7', 64),
           '{"scope":"test"}', 'PUBLIC', now(), now() + interval '5 minutes', '${id('000000000025')}'
    FROM authz.authorization_state WHERE singleton;
    INSERT INTO authz.ai_authorized_document (grant_id, document_version_id)
    VALUES ('${id('000000000020')}', '${id('000000000017')}');
    INSERT INTO ai.ingestion_job
      (id, source_id, document_id, source_version, content_hash, parser_version,
       corpus_manifest_digest, checkpoint, stage, status, created_at, updated_at)
    VALUES ('${id('000000000026')}', '${id('000000000014')}', '${id('000000000015')}', 'v1',
            repeat('8', 64), '1', repeat('9', 64), '{}', 'FETCH', 'PENDING',
            now() - interval '1 hour', now() - interval '1 hour');
    INSERT INTO ai.event_consumption
      (id, consumer_key, event_id, event_type, schema_version, aggregate_type,
       aggregate_id, aggregate_version, status, sanitized_terminal_error)
    VALUES ('${id('000000000027')}', 'governed-test', '${id('000000000028')}', 'test.event', 1,
            'test', '${id('000000000015')}', 1, 'DEAD', 'sanitized failure');
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
      'exec', '-e', `PGPASSWORD=${password}`, container,
      'psql', '--username', 'postgres', '--dbname', 'innorder_test', '--command', 'SELECT 1',
    ]);
    if (initialized && probe.status === 0) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    if (attempt === 59) assert.fail('PostgreSQL container did not become ready');
  }

  execSql(readFileSync(resolve('database/bootstrap/001-create-runtime-role.sql'), 'utf8'));
  for (const migration of migrations) execSql(readFileSync(join(migrationDir, migration), 'utf8'));

  expectDenied('SELECT * FROM iam.principal;');
  expectDenied('SELECT * FROM authz.relationship;');
  expectDenied('SELECT * FROM audit.outbox_event;');
  expectDenied("INSERT INTO ai.recommendation (id, run_id, target_entity_id, recommendation_type, payload, status) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x', '{}', 'PROPOSED');");
  expectDenied("CREATE TABLE ai.forbidden (id integer);");

  const fixture = randomUUID().replaceAll('-', '').slice(0, 8);
  execSql(fixtureSql(fixture));

  const consumeSql = `SET ROLE innorder_ai_runtime;
    SELECT run_id FROM authz.consume_ai_authorization_grant(repeat('a', 64),
      '${fixture.slice(0, 8)}-0000-7000-8000-000000000030'::uuid,
      '${fixture.slice(0, 8)}-0000-7000-8000-000000000012'::uuid,
      '${fixture.slice(0, 8)}-0000-7000-8000-000000000008'::uuid,
      '${fixture.slice(0, 8)}-0000-7000-8000-000000000010'::uuid,
      '${fixture.slice(0, 8)}-0000-7000-8000-000000000002'::uuid);
  `;
  const [consumeA, consumeB] = await Promise.all([runSql(consumeSql), runSql(consumeSql)]);
  assert.equal([consumeA, consumeB].filter((result) => result.code === 0).length, 1, 'grant must be consumed once');
  assert.match([consumeA, consumeB].find((result) => result.code !== 0)?.stderr ?? '', /consumed|replay/iu);

  const hits = execSql(`SELECT string_agg(chunk_id::text, ',') FROM ai.authorized_hybrid_retrieval(
    '${fixture.slice(0, 8)}-0000-7000-8000-000000000030',
    '${fixture.slice(0, 8)}-0000-7000-8000-000000000009', 'allowed', '[1,0,0]'::vector, 10, 10, 10);`,
  { role: 'innorder_ai_runtime' });
  assert.match(hits, /000000000021/);
  assert.doesNotMatch(hits, /000000000022/);
  expectDenied(`UPDATE ai.event_consumption SET status = 'RETRY', sanitized_terminal_error = NULL
                WHERE id = '${fixture.slice(0, 8)}-0000-7000-8000-000000000027';`,
  /terminal event consumption is immutable/iu);

  const claimed = execSql(`SELECT count(*) FROM ai.claim_ingestion_jobs('worker-a', 10, interval '30 seconds');`,
    { role: 'innorder_ai_runtime' });
  assert.equal(claimed, '1');
  execSql(`UPDATE ai.ingestion_job SET lease_expires_at = now() - interval '1 second'
           WHERE lease_owner = 'worker-a';`);
  const reclaimed = execSql(`SELECT count(*) FROM ai.claim_ingestion_jobs('worker-b', 10, interval '30 seconds');`,
    { role: 'innorder_ai_runtime' });
  assert.equal(reclaimed, '1');

  assert.throws(() => execSql(`INSERT INTO ai.embedding_space_gate_result
    (id, dataset_version_id, corpus_manifest_digest, expected_active_space_id,
     eligible_count, embedded_count, leakage_count, citation_numerator, citation_denominator,
     recall_sum, recall_count, minimum_coverage, maximum_leakage, minimum_citation_precision,
     minimum_recall, decision, evidence_hash, evaluated_at, retention_until)
    VALUES (gen_random_uuid(), '${fixture.slice(0, 8)}-0000-7000-8000-000000000013', repeat('b',64),
      '${fixture.slice(0, 8)}-0000-7000-8000-000000000009', 1, 2, 0, 1, 1, 1, 1,
      1, 0, 1, 1, 'PASS', repeat('c',64), now(), now() + interval '1 year');`), /check constraint/iu);
});
