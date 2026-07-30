import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const strict = process.env.INNORDER_STRICT_DATABASE_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL;
const command = process.env.PSQL_PATH ?? (process.platform === 'win32' ? 'psql.exe' : 'psql');
let prefixArgs = [];

if (process.env.PSQL_PREFIX_ARGS_JSON) {
  const parsed = JSON.parse(process.env.PSQL_PREFIX_ARGS_JSON);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('PSQL_PREFIX_ARGS_JSON must be a JSON array of strings');
  }
  prefixArgs = parsed;
}

const probe = spawnSync(command, [...prefixArgs, '--version'], {
  encoding: 'utf8',
  windowsHide: true,
});
const missingReason = !databaseUrl
  ? 'DATABASE_URL is not set'
  : probe.status !== 0
    ? `psql is unavailable through ${command}`
    : undefined;

function runPsql(sql, { onStdout } = {}) {
  const child = spawn(command, [
    ...prefixArgs,
    '--no-psqlrc',
    '--dbname', databaseUrl,
    '--set', 'ON_ERROR_STOP=1',
    '--tuples-only',
    '--no-align',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    onStdout?.(stdout);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(sql);
  return {
    child,
    result: new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    }),
  };
}

async function execPsql(sql) {
  const execution = runPsql(sql);
  const result = await execution.result;
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('competing idempotency terminal transitions serialize at the database row', {
  skip: !strict && missingReason ? missingReason : false,
}, async (t) => {
  if (missingReason) assert.fail(`strict PostgreSQL race test requires prerequisites: ${missingReason}`);

  const ids = {
    package: '91000000-0000-7000-8000-000000000001',
    packageVersion: '91000000-0000-7000-8000-000000000002',
    entityType: '91000000-0000-7000-8000-000000000003',
    entityTypeVersion: '91000000-0000-7000-8000-000000000004',
    principal: '91000000-0000-7000-8000-000000000005',
    record: '91000000-0000-7000-8000-000000000006',
  };

  await execPsql(`
    INSERT INTO catalog.domain_package
      (id, package_key, name, status, row_version, created_at, updated_at)
    VALUES ('${ids.package}', 'race.security', 'Race security', 'ACTIVE', 0, now(), now());
    INSERT INTO catalog.package_version (id, package_id, semver, status, manifest, created_at)
    VALUES ('${ids.packageVersion}', '${ids.package}', '1.0.0', 'DRAFT', '{}'::jsonb, now());
    INSERT INTO catalog.entity_type (id, package_id, type_key, name, entity_kind, authorizable)
    VALUES ('${ids.entityType}', '${ids.package}', 'race_user', 'Race user', 'PRINCIPAL', true);
    INSERT INTO catalog.entity_type_version
      (id, entity_type_id, package_version_id, schema_version, json_schema, ui_schema, auth_schema, index_spec)
    VALUES ('${ids.entityTypeVersion}', '${ids.entityType}', '${ids.packageVersion}', 1,
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
    INSERT INTO authz.entity
      (id, entity_type_id, entity_type_version_id, entity_key, state,
       auth_attributes, row_version, created_at, updated_at)
    VALUES ('${ids.principal}', '${ids.entityType}', '${ids.entityTypeVersion}', 'race:user',
            'ACTIVE', '{}'::jsonb, 0, now(), now());
    INSERT INTO iam.principal
      (id, principal_kind, display_name, status, profile, row_version, created_at, updated_at)
    VALUES ('${ids.principal}', 'USER', 'Race User', 'ACTIVE', '{}'::jsonb, 0, now(), now());
    INSERT INTO audit.idempotency_record
      (id, principal_id, command_key, idempotency_key, request_hash, state, created_at, updated_at, expires_at)
    VALUES ('${ids.record}', '${ids.principal}', 'race.command', 'race', repeat('a', 64),
            'IN_PROGRESS', now(), now(), now() + interval '1 hour');
  `);

  t.after(async () => {
    await execPsql(`
      DELETE FROM audit.idempotency_record WHERE id = '${ids.record}';
      DELETE FROM iam.principal WHERE id = '${ids.principal}';
      DELETE FROM authz.entity WHERE id = '${ids.principal}';
      DELETE FROM catalog.entity_type_version WHERE id = '${ids.entityTypeVersion}';
      DELETE FROM catalog.entity_type WHERE id = '${ids.entityType}';
      DELETE FROM catalog.package_version WHERE id = '${ids.packageVersion}';
      DELETE FROM catalog.domain_package WHERE id = '${ids.package}';
    `);
  });

  let markLocked;
  const locked = new Promise((resolve) => {
    markLocked = resolve;
  });
  const transactionA = runPsql(`
    BEGIN;
    UPDATE audit.idempotency_record
    SET state = 'COMPLETED', response_status = 200, response_digest = repeat('b', 64)
    WHERE id = '${ids.record}';
    \\echo A_LOCKED
    SELECT pg_sleep(1);
    COMMIT;
  `, {
    onStdout: (stdout) => {
      if (stdout.includes('A_LOCKED')) markLocked();
    },
  });

  await Promise.race([
    locked,
    transactionA.result.then((result) => {
      assert.fail(`transaction A exited before acquiring the row lock: ${result.stderr || result.stdout}`);
    }),
  ]);
  const transactionB = runPsql(`
    BEGIN;
    UPDATE audit.idempotency_record
    SET state = 'FAILED', response_status = 500
    WHERE id = '${ids.record}';
    COMMIT;
  `);

  const [resultA, resultB] = await Promise.all([transactionA.result, transactionB.result]);
  assert.equal(resultA.code, 0, resultA.stderr || resultA.stdout);
  assert.notEqual(resultB.code, 0, 'competing FAILED transition unexpectedly succeeded');
  assert.match(resultB.stderr, /terminal idempotency state cannot transition/i);
  assert.equal(
    await execPsql(`SELECT state FROM audit.idempotency_record WHERE id = '${ids.record}'`),
    'COMPLETED',
  );
});
