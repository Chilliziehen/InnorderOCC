import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const strict = process.env.INNORDER_STRICT_DATABASE_TESTS === '1';
const localSkip = process.env.INNORDER_SKIP_POSTGRESQL_RESERVATION_RACE === '1';
const externalDisposable = process.env.INNORDER_POSTGRESQL_RACE_DISPOSABLE_DATABASE === '1';
const docker = process.env.DOCKER_PATH ?? (process.platform === 'win32' ? 'docker.exe' : 'docker');
const PROCESS_TIMEOUT_MS = 20_000;
const MARKER_TIMEOUT_MS = 10_000;
let databaseUrl = process.env.DATABASE_URL;
let command = process.env.PSQL_PATH ?? (process.platform === 'win32' ? 'psql.exe' : 'psql');
let prefixArgs = [];
let provisionedContainer;
let provisioningError;
let teardownStarted = false;
const activeChildren = new Set();

if (databaseUrl && !externalDisposable) {
  throw new Error(
    'DATABASE_URL is rejected unless INNORDER_POSTGRESQL_RACE_DISPOSABLE_DATABASE=1 confirms a disposable database',
  );
}

if (process.env.PSQL_PREFIX_ARGS_JSON) {
  const parsed = JSON.parse(process.env.PSQL_PREFIX_ARGS_JSON);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('PSQL_PREFIX_ARGS_JSON must be a JSON array of strings');
  }
  prefixArgs = parsed;
}

function spawnChecked(executable, args, { timeout = 120_000 } = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${executable} exited with ${result.status}`);
  }
  return result.stdout.trim();
}

function postgresDockerEnvironment() {
  return [
    '--env', 'PGCONNECT_TIMEOUT=5',
    '--env', 'PGOPTIONS=-c statement_timeout=15s -c lock_timeout=5s',
  ];
}

async function waitForFinalPostgreSql(container) {
  const deadline = Date.now() + 60_000;
  const finalEntryPointMarker = 'PostgreSQL init process complete; ready for start up.';
  while (Date.now() < deadline) {
    const logs = spawnSync(docker, ['logs', container], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    });
    const output = `${logs.stdout ?? ''}\n${logs.stderr ?? ''}`;
    if (output.includes(finalEntryPointMarker)) {
      const probe = await spawnTracked(docker, [
        'exec', ...postgresDockerEnvironment(), container,
        'psql', '-U', 'innorder_admin', '-d', 'innorder_occ',
        '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--command', 'SELECT 1',
      ], { timeoutMs: 5_000 }).result;
      if (probe.code === 0) return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error('self-provisioned PostgreSQL did not reach final entrypoint readiness within 60 seconds');
}

async function provisionPostgreSql() {
  spawnChecked(docker, ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 });
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
  await waitForFinalPostgreSql(container);

  const initScript = fileURLToPath(new URL('../../services/core/src/test/resources/postgres-test-init.sql', import.meta.url));
  const databaseDirectory = fileURLToPath(new URL('../', import.meta.url));
  spawnChecked(docker, ['cp', initScript, `${container}:/tmp/postgres-test-init.sql`]);
  spawnChecked(docker, ['cp', databaseDirectory, `${container}:/tmp/database`]);
  await spawnCheckedAsync(docker, [
    'exec', ...postgresDockerEnvironment(), container,
    'psql', '-U', 'innorder_admin', '-d', 'innorder_occ',
    '--set', 'ON_ERROR_STOP=1', '-f', '/tmp/postgres-test-init.sql',
  ]);
  await spawnCheckedAsync(docker, [
    'exec', ...postgresDockerEnvironment(), '--env', 'PGPASSWORD=admin-test-only', container,
    'psql', '-U', 'innorder_admin', '-d', 'innorder_occ',
    '--set', 'ON_ERROR_STOP=1', '-f', '/tmp/database/innorder_occ_full_schema.sql',
  ]);

  databaseUrl = 'postgresql://innorder_admin:admin-test-only@127.0.0.1/innorder_occ';
  command = docker;
  prefixArgs = [
    'exec', '-i',
    ...postgresDockerEnvironment(),
    '--env', 'PGHOST=127.0.0.1',
    '--env', 'PGDATABASE=innorder_occ',
    '--env', 'PGUSER=innorder_admin',
    '--env', 'PGPASSWORD=admin-test-only',
    container, 'psql',
  ];
}

function teardown() {
  if (teardownStarted) return;
  teardownStarted = true;
  killActiveChildren();
  activeChildren.clear();
  if (provisionedContainer) {
    spawnSync(docker, ['rm', '--force', provisionedContainer], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    provisionedContainer = undefined;
  }
}

function killActiveChildren() {
  for (const child of activeChildren) child.kill('SIGKILL');
}

after(teardown);
process.once('exit', teardown);
process.once('SIGINT', () => {
  teardown();
  process.exit(130);
});
process.once('SIGTERM', () => {
  teardown();
  process.exit(143);
});

if (!databaseUrl && (!localSkip || strict)) {
  try {
    await provisionPostgreSql();
  } catch (error) {
    provisioningError = error instanceof Error ? error.message : String(error);
  }
}

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

let probeError;
if (databaseUrl) {
  try {
    const probe = await spawnTracked(command, [...prefixArgs, '--version'], { timeoutMs: 10_000 }).result;
    if (probe.code !== 0) probeError = `psql is unavailable through ${command}`;
  } catch (error) {
    probeError = error instanceof Error ? error.message : String(error);
  }
}
const missingReason = provisioningError
  ?? connectionError
  ?? (!databaseUrl
    ? 'DATABASE_URL is not set'
    : probeError);

function spawnTracked(executable, args, {
  env = process.env,
  input,
  onStdout,
  timeoutMs = PROCESS_TIMEOUT_MS,
} = {}) {
  const child = spawn(executable, args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  activeChildren.add(child);
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    onStdout?.(stdout);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  timer.unref();
  return {
    result: new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        activeChildren.delete(child);
        if (timedOut) {
          reject(new Error(`${executable} exceeded ${timeoutMs}ms wall-clock timeout: ${stderr || stdout}`));
          return;
        }
        resolve({ code, stdout, stderr });
      });
    }),
  };
}

async function spawnCheckedAsync(executable, args, options) {
  const result = await spawnTracked(executable, args, options).result;
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `${executable} exited with ${result.code}`);
  }
  return result.stdout.trim();
}

function runPsql(sql, { onStdout, timeoutMs = PROCESS_TIMEOUT_MS } = {}) {
  return spawnTracked(command, [
    ...prefixArgs,
    '--no-psqlrc',
    '--set', 'ON_ERROR_STOP=1',
    '--set', 'VERBOSITY=verbose',
    '--tuples-only',
    '--no-align',
  ], {
    env: {
      ...connectionEnvironment,
      PGCONNECT_TIMEOUT: '5',
      PGOPTIONS: '-c statement_timeout=15s -c lock_timeout=5s',
    },
    input: sql,
    onStdout,
    timeoutMs,
  });
}

async function execPsql(sql) {
  const result = await runPsql(sql).result;
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function newFixtureIds() {
  return {
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
}

async function createFixture(ids, baselineCapacity = 0) {
  const fixtureKey = ids.resource;
  await execPsql(`
    BEGIN;
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
    COMMIT;
  `);
}

async function cleanupFixture(ids) {
  await execPsql(`
      BEGIN;
      UPDATE occ.resource_reservation
      SET state = 'CANCELLED', cancelled_at = now()
      WHERE resource_id = '${ids.resource}' AND state IN ('PENDING', 'CONFIRMED');
      COMMIT;
  `);
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  let workerB;
  try {
    await withTimeout(
      Promise.race([
        inserted,
        workerA.result.then((result) => {
          assert.fail(`first contender exited before taking the resource lock: ${result.stderr || result.stdout}`);
        }),
      ]),
      MARKER_TIMEOUT_MS,
      `first contender did not emit its lock marker within ${MARKER_TIMEOUT_MS}ms`,
    );
    workerB = runPsql(contenderSql(ids.contenderB, 'B_INSERTED', contenderB, false));
    return await Promise.all([workerA.result, workerB.result]);
  } catch (error) {
    killActiveChildren();
    await Promise.allSettled([workerA.result, workerB?.result].filter(Boolean));
    throw error;
  }
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
  const ids = newFixtureIds();
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    await cleanupFixture(ids);
    cleaned = true;
  };
  t.after(cleanup);
  try {
    await createFixture(ids, 4);
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
  const ids = newFixtureIds();
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    await cleanupFixture(ids);
    cleaned = true;
  };
  t.after(cleanup);
  try {
    await createFixture(ids);
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
