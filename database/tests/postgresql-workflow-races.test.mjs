import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { GenericContainer, Wait } from 'testcontainers';

const { Pool } = pg;
const IMAGE = 'pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9';
const migrationRoot = fileURLToPath(new URL('../migrations/', import.meta.url));

async function expectOneSuccess(promises, message) {
  const settled = await Promise.allSettled(promises);
  assert.equal(settled.filter((value) => value.status === 'fulfilled').length, 1, message);
  return settled;
}

test('workflow uniqueness, expected-version, and relationship windows serialize races', { timeout: 180_000 }, async () => {
  const migrations = readdirSync(migrationRoot).filter((name) => /^V\d+__.*\.sql$/u.test(name)).sort();
  const schema = `${readFileSync(fileURLToPath(new URL('../bootstrap/001-create-runtime-role.sql', import.meta.url)), 'utf8')}\n${migrations.map((name) => readFileSync(`${migrationRoot}/${name}`, 'utf8')).join('\n')}`;
  let container;
  let pool;
  try {
    container = await new GenericContainer(IMAGE)
      .withEnvironment({ POSTGRES_DB: 'innorder_occ', POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'postgres-test-only' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/u, 2))
      .withStartupTimeout(120_000)
      .start();
    await container.copyContentToContainer([{ content: schema, target: '/tmp/schema.sql' }]);
    const applied = await container.exec(['psql', '--username=postgres', '--dbname=innorder_occ', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--file=/tmp/schema.sql']);
    assert.equal(applied.exitCode, 0, applied.stderr || applied.stdout);
    pool = new Pool({
      host: container.getHost(), port: container.getMappedPort(5432), database: 'innorder_occ',
      user: 'postgres', password: 'postgres-test-only', max: 8,
    });
    await pool.query(`
      INSERT INTO catalog.domain_package (id, package_key, name, status) VALUES ('61000000-0000-7000-8000-000000000001', 'race.workflow', 'Race', 'ACTIVE');
      INSERT INTO catalog.package_version (id, package_id, semver, status, manifest) VALUES ('62000000-0000-7000-8000-000000000001', '61000000-0000-7000-8000-000000000001', '1.0.0', 'DRAFT', '{}');
      INSERT INTO catalog.entity_type (id, package_id, type_key, name, entity_kind) VALUES
        ('63000000-0000-7000-8000-000000000001', '61000000-0000-7000-8000-000000000001', 'person', 'Person', 'PRINCIPAL'),
        ('63000000-0000-7000-8000-000000000002', '61000000-0000-7000-8000-000000000001', 'cohort', 'Cohort', 'RESOURCE'),
        ('63000000-0000-7000-8000-000000000003', '61000000-0000-7000-8000-000000000001', 'process', 'Process', 'RESOURCE'),
        ('63000000-0000-7000-8000-000000000004', '61000000-0000-7000-8000-000000000001', 'task', 'Task', 'RESOURCE');
      INSERT INTO catalog.entity_type_version (id, entity_type_id, package_version_id, schema_version, json_schema) VALUES
        ('64000000-0000-7000-8000-000000000001', '63000000-0000-7000-8000-000000000001', '62000000-0000-7000-8000-000000000001', 1, '{}'),
        ('64000000-0000-7000-8000-000000000002', '63000000-0000-7000-8000-000000000002', '62000000-0000-7000-8000-000000000001', 1, '{}'),
        ('64000000-0000-7000-8000-000000000003', '63000000-0000-7000-8000-000000000003', '62000000-0000-7000-8000-000000000001', 1, '{}'),
        ('64000000-0000-7000-8000-000000000004', '63000000-0000-7000-8000-000000000004', '62000000-0000-7000-8000-000000000001', 1, '{}');
      INSERT INTO catalog.workflow_definition (id, package_version_id, workflow_key, bpmn_object_key, content_hash) VALUES ('65000000-0000-7000-8000-000000000001', '62000000-0000-7000-8000-000000000001', 'route', 'route.bpmn', repeat('a',64));
      INSERT INTO catalog.relation_definition (id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality, transitive, acyclic, auth_relevant) VALUES
        ('66000000-0000-7000-8000-000000000001', '62000000-0000-7000-8000-000000000001', 'cohort_owner', '63000000-0000-7000-8000-000000000001', '63000000-0000-7000-8000-000000000002', 'ONE_TO_MANY', false, false, true),
        ('66000000-0000-7000-8000-000000000002', '62000000-0000-7000-8000-000000000001', 'membership', '63000000-0000-7000-8000-000000000001', '63000000-0000-7000-8000-000000000002', 'MANY_TO_MANY', false, false, true);
      UPDATE catalog.package_version SET status='PUBLISHED', content_hash=repeat('b',64), published_at=now() WHERE id='62000000-0000-7000-8000-000000000001';
      INSERT INTO authz.entity (id, entity_type_id, entity_type_version_id, entity_key, state) VALUES
        ('67000000-0000-7000-8000-000000000001', '63000000-0000-7000-8000-000000000001', '64000000-0000-7000-8000-000000000001', 'person:owner', 'ACTIVE'),
        ('67000000-0000-7000-8000-000000000002', '63000000-0000-7000-8000-000000000001', '64000000-0000-7000-8000-000000000001', 'person:participant', 'ACTIVE'),
        ('68000000-0000-7000-8000-000000000001', '63000000-0000-7000-8000-000000000002', '64000000-0000-7000-8000-000000000002', 'cohort:race', 'ACTIVE'),
        ('69000000-0000-7000-8000-000000000001', '63000000-0000-7000-8000-000000000003', '64000000-0000-7000-8000-000000000003', 'process:one', 'ACTIVE'),
        ('69000000-0000-7000-8000-000000000002', '63000000-0000-7000-8000-000000000003', '64000000-0000-7000-8000-000000000003', 'process:two', 'ACTIVE'),
        ('6a000000-0000-7000-8000-000000000001', '63000000-0000-7000-8000-000000000004', '64000000-0000-7000-8000-000000000004', 'task:race', 'ACTIVE');
      INSERT INTO iam.principal (id, principal_kind, display_name, status) VALUES
        ('67000000-0000-7000-8000-000000000001', 'USER', 'Owner', 'ACTIVE'),
        ('67000000-0000-7000-8000-000000000002', 'USER', 'Participant', 'ACTIVE');
      INSERT INTO occ.cohort (id, customer_instance_id, code, name, package_version_id, owner_principal_id, start_date, status, created_by, updated_by)
        VALUES ('68000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000001', 'race', 'Race', '62000000-0000-7000-8000-000000000001', '67000000-0000-7000-8000-000000000001', current_date, 'DRAFT', '67000000-0000-7000-8000-000000000001', '67000000-0000-7000-8000-000000000001');
      INSERT INTO occ.process_definition_binding (id, workflow_definition_id, package_version_id, bpmn_key, flowable_deployment_id, flowable_definition_id, content_hash)
        VALUES ('6b000000-0000-7000-8000-000000000001', '65000000-0000-7000-8000-000000000001', '62000000-0000-7000-8000-000000000001', 'route', 'race-deployment', 'race-definition', repeat('c',64));
    `);
    const processInsert = (id, flowable) => pool.query(`INSERT INTO occ.process_instance
      (id, definition_binding_id, package_version_id, flowable_instance_id, business_key, state, cohort_id,
       started_for_participant_id, participant_id, route_key, route_version)
      VALUES ($1, '6b000000-0000-7000-8000-000000000001', '62000000-0000-7000-8000-000000000001', $2, $2,
       'RUNNING', '68000000-0000-7000-8000-000000000001', '67000000-0000-7000-8000-000000000002',
       '67000000-0000-7000-8000-000000000002', 'route', 1)`, [id, flowable]);
    await expectOneSuccess([
      processInsert('69000000-0000-7000-8000-000000000001', 'race-instance-one'),
      processInsert('69000000-0000-7000-8000-000000000002', 'race-instance-two'),
    ], 'participant start race must admit one process');
    const processId = (await pool.query(`SELECT id FROM occ.process_instance WHERE cohort_id='68000000-0000-7000-8000-000000000001'`)).rows[0].id;
    await pool.query(`INSERT INTO occ.task_projection
      (id, process_instance_id, activity_key, activity_name, flowable_task_id, flowable_execution_id, state)
      VALUES ('6a000000-0000-7000-8000-000000000001', $1, 'work', 'Work', 'race-task', 'race-execution', 'AVAILABLE')`, [processId]);
    const claims = await Promise.all([
      pool.query(`UPDATE occ.task_projection SET state='CLAIMED', assignee_id='67000000-0000-7000-8000-000000000002', claimed_at=now() WHERE id='6a000000-0000-7000-8000-000000000001' AND row_version=0 RETURNING id`),
      pool.query(`UPDATE occ.task_projection SET state='CLAIMED', assignee_id='67000000-0000-7000-8000-000000000001', claimed_at=now() WHERE id='6a000000-0000-7000-8000-000000000001' AND row_version=0 RETURNING id`),
    ]);
    assert.deepEqual(claims.map((result) => result.rowCount).sort(), [0, 1], 'expected-version claim race admits one update');
    const start = new Date(Date.now() + 60_000);
    const middle = new Date(start.getTime() + 60_000);
    const end = new Date(middle.getTime() + 60_000);
    await pool.query(`INSERT INTO authz.relationship (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until, source_kind, source_ref)
      VALUES ('6c000000-0000-7000-8000-000000000001', '66000000-0000-7000-8000-000000000002', '67000000-0000-7000-8000-000000000002', '68000000-0000-7000-8000-000000000001', $1, $2, 'SYSTEM', 'race-one')`, [start, middle]);
    await pool.query(`INSERT INTO authz.relationship (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until, source_kind, source_ref)
      VALUES ('6c000000-0000-7000-8000-000000000002', '66000000-0000-7000-8000-000000000002', '67000000-0000-7000-8000-000000000002', '68000000-0000-7000-8000-000000000001', $1, $2, 'SYSTEM', 'race-adjacent')`, [middle, end]);
    await assert.rejects(pool.query(`INSERT INTO authz.relationship (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until, source_kind, source_ref)
      VALUES ('6c000000-0000-7000-8000-000000000003', '66000000-0000-7000-8000-000000000002', '67000000-0000-7000-8000-000000000002', '68000000-0000-7000-8000-000000000001', $1, $2, 'SYSTEM', 'race-overlap')`, [new Date(start.getTime() + 30_000), end]), /overlap|exclusion/u);
    const exclusion = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname='ex_relationship_effective_window' AND contype='x'`);
    assert.equal(exclusion.rowCount, 1, 'relationship overlap protection must be concurrency-safe exclusion');
  } finally {
    await pool?.end();
    await container?.stop();
  }
});
