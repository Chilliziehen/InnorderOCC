import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait } from 'testcontainers';

const IMAGE = 'pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9';
const migrationRoot = fileURLToPath(new URL('../migrations/', import.meta.url));
const testRoot = fileURLToPath(new URL('./', import.meta.url));

function combine(root, names) {
  return names.map((name) => `\n\\echo applying ${name}\n${readFileSync(`${root}/${name}`, 'utf8')}`).join('\n');
}

test('fresh PostgreSQL applies every migration and passes the workflow SQL contract', { timeout: 180_000 }, async () => {
  const migrations = readdirSync(migrationRoot).filter((name) => /^V\d+__.*\.sql$/u.test(name)).sort();
  // The chain must stay gap-free and start at V001, whatever its current length.
  assert.deepEqual(
    migrations.map((name) => name.slice(0, 4)),
    Array.from({ length: migrations.length }, (_, index) => `V${String(index + 1).padStart(3, '0')}`),
  );
  const schema = `${readFileSync(fileURLToPath(new URL('../bootstrap/001-create-runtime-role.sql', import.meta.url)), 'utf8')}\n${combine(migrationRoot, migrations)}`;
  const contractFiles = ['run_all.sql', '000_assert.sql', '001_schema_contract.sql', '002_constraints.sql', '003_process_task_workflow.sql'];
  let container;
  try {
    container = await new GenericContainer(IMAGE)
      .withEnvironment({ POSTGRES_DB: 'innorder_occ', POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'postgres-test-only' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/u, 2))
      .withStartupTimeout(120_000)
      .start();
    await container.copyContentToContainer([
      { content: schema, target: '/tmp/schema.sql' },
      ...contractFiles.map((name) => ({ content: readFileSync(`${testRoot}/${name}`, 'utf8'), target: `/tmp/tests/${name}` })),
    ]);
    const applied = await container.exec(['psql', '--username=postgres', '--dbname=innorder_occ', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--file=/tmp/schema.sql']);
    assert.equal(applied.exitCode, 0, applied.stderr || applied.stdout);
    const tested = await container.exec(['psql', '--username=postgres', '--dbname=innorder_occ', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--file=/tmp/tests/run_all.sql']);
    assert.equal(tested.exitCode, 0, tested.stderr || tested.stdout);
    assert.match(tested.stdout, /all single-session schema tests passed/u);
  } finally {
    await container?.stop();
  }
});
