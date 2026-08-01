import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const strict = process.env.INNORDER_STRICT_DATABASE_TESTS === '1';
const localSkip = process.env.INNORDER_SKIP_POSTGRESQL_RESERVATION_RACE === '1';
let databaseUrl = process.env.DATABASE_URL;
let command = process.env.PSQL_PATH ?? (process.platform === 'win32' ? 'psql.exe' : 'psql');
let prefixArgs = [];
let provisionedContainer;
let provisioningError;

if (process.env.PSQL_PREFIX_ARGS_JSON) {
  const parsed = JSON.parse(process.env.PSQL_PREFIX_ARGS_JSON);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('PSQL_PREFIX_ARGS_JSON must be a JSON array of strings');
  }
  prefixArgs = parsed;
}

function spawnChecked(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${executable} exited with ${result.status}`);
  }
  return result.stdout.trim();
}

function provisionPostgreSql() {
  const docker = process.env.DOCKER_PATH ?? (process.platform === 'win32' ? 'docker.exe' : 'docker');
  spawnChecked(docker, ['version', '--format', '{{.Server.Version}}']);
  const container = `innorder-reservation-race-${randomUUID()}`;
  const image = 'pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9';
  spawnChecked(docker, [
    'run', '--detach', '--name', container,
    '--env', 'POSTGRES_USER=innorder_admin',
    '--env', 'POSTGRES_PASSWORD=admin-test-only',
    '--env', 'POSTGRES_DB=innorder_occ',
    image,
  ]);
  provisionedContainer = container;

  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = spawnSync(docker, [
      'exec', container, 'pg_isready', '-U', 'innorder_admin', '-d', 'innorder_occ',
    ], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) {
      ready = true;
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!ready) throw new Error('self-provisioned PostgreSQL did not become ready within 30 seconds');

  const initScript = fileURLToPath(new URL('../../services/core/src/test/resources/postgres-test-init.sql', import.meta.url));
  const databaseDirectory = fileURLToPath(new URL('../', import.meta.url));
  spawnChecked(docker, ['cp', initScript, `${container}:/tmp/postgres-test-init.sql`]);
  spawnChecked(docker, ['cp', databaseDirectory, `${container}:/tmp/database`]);
  spawnChecked(docker, [
    'exec', container, 'psql', '-U', 'innorder_admin', '-d', 'innorder_occ',
    '--set', 'ON_ERROR_STOP=1', '-f', '/tmp/postgres-test-init.sql',
  ]);
  spawnChecked(docker, [
    'exec', '--env', 'PGPASSWORD=admin-test-only', container,
    'psql', '-U', 'innorder_admin', '-d', 'innorder_occ',
    '--set', 'ON_ERROR_STOP=1', '-f', '/tmp/database/innorder_occ_full_schema.sql',
  ]);

  databaseUrl = 'postgresql://innorder_admin:admin-test-only@127.0.0.1/innorder_occ';
  command = docker;
  prefixArgs = [
    'exec', '-i',
    '--env', 'PGHOST=127.0.0.1',
    '--env', 'PGDATABASE=innorder_occ',
    '--env', 'PGUSER=innorder_admin',
    '--env', 'PGPASSWORD=admin-test-only',
    container, 'psql',
  ];
}

if (strict && !databaseUrl) {
  try {
    provisionPostgreSql();
  } catch (error) {
    provisioningError = error instanceof Error ? error.message : String(error);
  }
}

after(() => {
  if (!provisionedContainer) return;
  const docker = process.env.DOCKER_PATH ?? (process.platform === 'win32' ? 'docker.exe' : 'docker');
  spawnSync(docker, ['rm', '--force', provisionedContainer], { encoding: 'utf8', windowsHide: true });
});

function parseConnectionEnvironment() {
  if (!databaseUrl) return undefined;

  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol');
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!parsed.hostname || !database || !parsed.username) {
    throw new Error('DATABASE_URL must include host, database, and user');
  }

  return {
    ...process.env,
    DATABASE_URL: undefined,
    PGHOST: decodeURIComponent(parsed.hostname),
    PGPORT: parsed.port || '5432',
    PGDATABASE: database,
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGSSLMODE: parsed.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? 'prefer',
  };
}

let connectionEnvironment;
let connectionError;
try {
  connectionEnvironment = parseConnectionEnvironment();
} catch (error) {
  connectionError = error instanceof Error ? error.message : String(error);
}

const probe = spawnSync(command, [...prefixArgs, '--version'], {
  encoding: 'utf8',
  windowsHide: true,
});
const missingReason = provisioningError
  ?? connectionError
  ?? (!databaseUrl
    ? 'DATABASE_URL is not set'
    : probe.status !== 0
      ? `psql is unavailable through ${command}`
      : undefined);

function runPsql(sql, { onStdout } = {}) {
  const child = spawn(command, [
    ...prefixArgs,
    '--no-psqlrc',
    '--set', 'ON_ERROR_STOP=1',
    '--set', 'VERBOSITY=verbose',
    '--tuples-only',
    '--no-align',
  ], {
    env: connectionEnvironment,
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
    result: new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    }),
  };
}

async function execPsql(sql) {
  const result = await runPsql(sql).result;
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function createFixture(baselineCapacity = 0) {
  const ids = {
    package: randomUUID(),
    packageVersion: randomUUID(),
    entityType: randomUUID(),
    entityTypeVersion: randomUUID(),
    requester: randomUUID(),
    resource: randomUUID(),
    baseline: randomUUID(),
    contenderA: randomUUID(),
    contenderB: randomUUID(),
  };
  const fixtureKey = ids.resource;
  await execPsql(`
    INSERT INTO catalog.domain_package (id, package_key, name, status)
    VALUES ('${ids.package}', 'reservation-race.${fixtureKey}', 'Reservation race', 'ACTIVE');
    INSERT INTO catalog.package_version (id, package_id, semver, status)
    VALUES ('${ids.packageVersion}', '${ids.package}', '1.0.0', 'DRAFT');
    INSERT INTO catalog.entity_type (id, package_id, type_key, name, entity_kind)
    VALUES ('${ids.entityType}', '${ids.package}', 'reservation_race', 'Reservation race', 'RESOURCE');
    INSERT INTO catalog.entity_type_version
      (id, entity_type_id, package_version_id, schema_version, json_schema)
    VALUES ('${ids.entityTypeVersion}', '${ids.entityType}', '${ids.packageVersion}', 1, '{}'::jsonb);
    INSERT INTO authz.entity
      (id, entity_type_id, entity_type_version_id, entity_key, state)
    VALUES
      ('${ids.requester}', '${ids.entityType}', '${ids.entityTypeVersion}', 'requester:${fixtureKey}', 'ACTIVE'),
      ('${ids.resource}', '${ids.entityType}', '${ids.entityTypeVersion}', 'resource:${fixtureKey}', 'ACTIVE');
    INSERT INTO occ.managed_resource (id, resource_type, capacity, state)
    VALUES ('${ids.resource}', 'ROOM', 10, 'AVAILABLE');
    ${baselineCapacity > 0 ? `
    INSERT INTO occ.resource_reservation
      (id, resource_id, requester_entity_id, time_range, capacity, exclusive, state)
    VALUES ('${ids.baseline}', '${ids.resource}', '${ids.requester}',
            '[2035-01-01 10:00:00+00,2035-01-01 11:00:00+00)'::tstzrange,
            ${baselineCapacity}, false, 'PENDING');` : ''}
  `);
  return ids;
}

async function cleanupFixture(ids) {
  const ownsReservationTable = await execPsql(`
    SELECT pg_has_role(current_user, c.relowner, 'USAGE')
    FROM pg_class c
    WHERE c.oid = 'occ.resource_reservation'::regclass
  `);
  if (ownsReservationTable !== 't') {
    await execPsql(`
      UPDATE occ.resource_reservation
      SET state = 'CANCELLED', cancelled_at = now()
      WHERE resource_id = '${ids.resource}' AND state IN ('PENDING', 'CONFIRMED');
    `);
    return;
  }
  await execPsql(`
    ALTER TABLE occ.resource_reservation DISABLE TRIGGER trg_resource_reservation_no_delete;
    DELETE FROM occ.resource_reservation WHERE resource_id = '${ids.resource}';
    ALTER TABLE occ.resource_reservation ENABLE TRIGGER trg_resource_reservation_no_delete;
    DELETE FROM occ.managed_resource WHERE id = '${ids.resource}';
    DELETE FROM authz.entity WHERE id IN ('${ids.resource}', '${ids.requester}');
    DELETE FROM catalog.entity_type_version WHERE id = '${ids.entityTypeVersion}';
    DELETE FROM catalog.entity_type WHERE id = '${ids.entityType}';
    DELETE FROM catalog.package_version WHERE id = '${ids.packageVersion}';
    DELETE FROM catalog.domain_package WHERE id = '${ids.package}';
  `);
}

async function runConcurrentContenders(ids, contenderA, contenderB) {
  let markInserted;
  const inserted = new Promise((resolve) => {
    markInserted = resolve;
  });
  const contenderSql = (id, marker, contender, delay) => `
    BEGIN;
    INSERT INTO occ.resource_reservation
      (id, resource_id, requester_entity_id, time_range, capacity, exclusive, state)
    VALUES ('${id}', '${ids.resource}', '${ids.requester}',
            '[2035-01-01 10:00:00+00,2035-01-01 11:00:00+00)'::tstzrange,
            ${contender.capacity}, ${contender.exclusive}, 'PENDING');
    \\echo ${marker}
    ${delay ? 'SELECT pg_sleep(1);' : ''}
    COMMIT;
  `;
  const workerA = runPsql(contenderSql(ids.contenderA, 'A_INSERTED', contenderA, true), {
    onStdout: (stdout) => {
      if (stdout.includes('A_INSERTED')) markInserted();
    },
  });
  await Promise.race([
    inserted,
    workerA.result.then((result) => {
      assert.fail(`first contender exited before taking the resource lock: ${result.stderr || result.stdout}`);
    }),
  ]);
  const workerB = runPsql(contenderSql(ids.contenderB, 'B_INSERTED', contenderB, false));
  return Promise.all([workerA.result, workerB.result]);
}

function raceOptions() {
  return {
    skip: !strict && localSkip
      ? 'explicitly skipped by INNORDER_SKIP_POSTGRESQL_RESERVATION_RACE=1'
      : !strict && missingReason
        ? missingReason
        : false,
  };
}

function requirePrerequisites() {
  if (missingReason) {
    assert.fail(`strict PostgreSQL reservation race requires prerequisites: ${missingReason}`);
  }
}

function assertOneConflict(results, messagePattern) {
  assert.equal(results.filter(({ code }) => code === 0).length, 1, JSON.stringify(results));
  const failures = results.filter(({ code }) => code !== 0);
  assert.equal(failures.length, 1, JSON.stringify(results));
  assert.match(failures[0].stderr, /ERROR:\s+23P01:/i);
  assert.match(failures[0].stderr, messagePattern);
}

test('concurrent capacity contenders cannot overbook one resource', raceOptions(), async (t) => {
  requirePrerequisites();
  const ids = await createFixture(4);
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    await cleanupFixture(ids);
    cleaned = true;
  };
  t.after(cleanup);
  try {
    const results = await runConcurrentContenders(
      ids,
      { capacity: 6, exclusive: false },
      { capacity: 6, exclusive: false },
    );
    assertOneConflict(results, /peak resource capacity/i);
    assert.equal(
      await execPsql(`
        SELECT sum(capacity)
        FROM occ.resource_reservation
        WHERE resource_id = '${ids.resource}' AND state IN ('PENDING', 'CONFIRMED')
      `),
      '10',
    );
  } finally {
    await cleanup();
  }
});

test('concurrent exclusive and capacity contenders cannot overlap', raceOptions(), async (t) => {
  requirePrerequisites();
  const ids = await createFixture();
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    await cleanupFixture(ids);
    cleaned = true;
  };
  t.after(cleanup);
  try {
    const results = await runConcurrentContenders(
      ids,
      { capacity: 1, exclusive: true },
      { capacity: 1, exclusive: false },
    );
    assertOneConflict(results, /reservation conflicts with exclusivity/i);
    assert.equal(
      await execPsql(`
        SELECT count(*)
        FROM occ.resource_reservation
        WHERE id IN ('${ids.contenderA}', '${ids.contenderB}')
      `),
      '1',
    );
  } finally {
    await cleanup();
  }
});
