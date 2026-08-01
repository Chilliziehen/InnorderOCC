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

async function waitForBlockedApplications(pool, applicationNames) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query(`SELECT application_name FROM pg_stat_activity
      WHERE application_name = ANY($1) AND wait_event_type = 'Lock'`, [applicationNames]);
    if (result.rowCount === applicationNames.length) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`race did not reach lock barrier for ${applicationNames.join(', ')}`);
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
        ('6a000000-0000-7000-8000-000000000001', '63000000-0000-7000-8000-000000000004', '64000000-0000-7000-8000-000000000004', 'task:race', 'ACTIVE'),
        ('6a000000-0000-7000-8000-000000000002', '63000000-0000-7000-8000-000000000004', '64000000-0000-7000-8000-000000000004', 'task:blocker-race', 'ACTIVE');
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
    await pool.query(`INSERT INTO occ.task_projection
      (id, process_instance_id, activity_key, activity_name, flowable_task_id, flowable_execution_id, state)
      VALUES ('6a000000-0000-7000-8000-000000000002', $1, 'blocked-work', 'Blocked work', 'blocker-race-task', 'blocker-race-execution', 'AVAILABLE')`, [processId]);
    const claims = await Promise.all([
      pool.query(`UPDATE occ.task_projection SET state='CLAIMED', assignee_id='67000000-0000-7000-8000-000000000002', claimed_at=now() WHERE id='6a000000-0000-7000-8000-000000000001' AND row_version=0 RETURNING id`),
      pool.query(`UPDATE occ.task_projection SET state='CLAIMED', assignee_id='67000000-0000-7000-8000-000000000001', claimed_at=now() WHERE id='6a000000-0000-7000-8000-000000000001' AND row_version=0 RETURNING id`),
    ]);
    assert.deepEqual(claims.map((result) => result.rowCount).sort(), [0, 1], 'expected-version claim race admits one update');
    await pool.query(`UPDATE occ.task_projection SET state='CLAIMED', assignee_id='67000000-0000-7000-8000-000000000002', claimed_at=now()
      WHERE id='6a000000-0000-7000-8000-000000000002'`);
    await pool.query(`INSERT INTO occ.task_gate_requirement (task_id, provider_key)
      VALUES ('6a000000-0000-7000-8000-000000000001', 'process.lifecycle')`);
    await pool.query(`INSERT INTO occ.task_gate_provider_state
      (task_id, provider_key, status, source_entity_id, source_row_version)
      VALUES ('6a000000-0000-7000-8000-000000000001', 'process.lifecycle', 'READY', $1, 0)`, [processId]);

    const completeSource = await pool.connect();
    const changeSource = await pool.connect();
    try {
      await completeSource.query('BEGIN');
      await completeSource.query(`UPDATE occ.task_projection SET state='COMPLETED', completed_at=now()
        WHERE id='6a000000-0000-7000-8000-000000000001'`);
      await changeSource.query('BEGIN');
      await changeSource.query(`SET LOCAL application_name='workflow-source-change'`);
      const sourceChange = changeSource.query(`UPDATE occ.process_instance SET state='SUSPENDED' WHERE id=$1`, [processId]);
      await waitForBlockedApplications(pool, ['workflow-source-change']);
      await completeSource.query('COMMIT');
      await assert.rejects(sourceChange, /terminal|provider|task/i);
      await changeSource.query('ROLLBACK');
    } finally {
      await completeSource.query('ROLLBACK').catch(() => {});
      await changeSource.query('ROLLBACK').catch(() => {});
      completeSource.release();
      changeSource.release();
    }
    const sourceRaceState = await pool.query(`SELECT task.state AS task_state, process.state AS process_state, provider.status AS provider_status
      FROM occ.task_projection task
      JOIN occ.process_instance process ON process.id=task.process_instance_id
      JOIN occ.task_gate_provider_state provider ON provider.task_id=task.id
      WHERE task.id='6a000000-0000-7000-8000-000000000001'`);
    assert.deepEqual(sourceRaceState.rows, [{ task_state: 'COMPLETED', process_state: 'RUNNING', provider_status: 'READY' }],
      'completion and source change cannot commit COMPLETED plus STALE');

    const completeBlocked = await pool.connect();
    const addBlocker = await pool.connect();
    try {
      await completeBlocked.query('BEGIN');
      await completeBlocked.query(`UPDATE occ.task_projection SET state='COMPLETED', completed_at=now()
        WHERE id='6a000000-0000-7000-8000-000000000002'`);
      await addBlocker.query('BEGIN');
      await addBlocker.query(`SET LOCAL application_name='workflow-hard-blocker'`);
      const blockerInsert = addBlocker.query(`INSERT INTO occ.task_blocker
        (id, task_id, source_entity_id, source_row_version, blocker_code, severity)
        VALUES ('6d000000-0000-7000-8000-000000000001', '6a000000-0000-7000-8000-000000000002',
          '6a000000-0000-7000-8000-000000000002', 1, 'POLICY_DENIED', 'HARD')`);
      await waitForBlockedApplications(pool, ['workflow-hard-blocker']);
      await completeBlocked.query('COMMIT');
      await assert.rejects(blockerInsert, /terminal|blocker|task/i);
      await addBlocker.query('ROLLBACK');
    } finally {
      await completeBlocked.query('ROLLBACK').catch(() => {});
      await addBlocker.query('ROLLBACK').catch(() => {});
      completeBlocked.release();
      addBlocker.release();
    }
    const blockerRaceState = await pool.query(`SELECT task.state AS task_state,
      count(blocker.id) FILTER (WHERE blocker.resolved_at IS NULL AND blocker.severity='HARD')::int AS active_hard_blockers
      FROM occ.task_projection task LEFT JOIN occ.task_blocker blocker ON blocker.task_id=task.id
      WHERE task.id='6a000000-0000-7000-8000-000000000002' GROUP BY task.state`);
    assert.deepEqual(blockerRaceState.rows, [{ task_state: 'COMPLETED', active_hard_blockers: 0 }],
      'completion and blocker insert cannot commit COMPLETED plus active hard blocker');
    const start = new Date(Date.now() - 60_000);
    const middle = new Date(Date.now() + 60_000);
    const end = new Date(middle.getTime() + 60_000);
    await pool.query(`INSERT INTO authz.relationship (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, source_kind, source_ref)
      VALUES ('6c000000-0000-7000-8000-000000000001', '66000000-0000-7000-8000-000000000002', '67000000-0000-7000-8000-000000000002', '68000000-0000-7000-8000-000000000001', $1, 'SYSTEM', 'race-revoked')`, [start]);
    const revoker = await pool.connect();
    const replacementA = await pool.connect();
    const replacementB = await pool.connect();
    try {
      await revoker.query('BEGIN');
      await revoker.query(`UPDATE authz.relationship SET revoked_at=$1 WHERE id='6c000000-0000-7000-8000-000000000001'`, [middle]);
      await replacementA.query('BEGIN');
      await replacementB.query('BEGIN');
      await replacementA.query(`SET LOCAL application_name='relationship-replacement-a'`);
      await replacementB.query(`SET LOCAL application_name='relationship-replacement-b'`);
      const insertReplacement = async (client, id, source) => {
        try {
          await client.query(`INSERT INTO authz.relationship
            (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until, source_kind, source_ref)
            VALUES ($1, '66000000-0000-7000-8000-000000000002', '67000000-0000-7000-8000-000000000002',
              '68000000-0000-7000-8000-000000000001', $2, $3, 'SYSTEM', $4)`, [id, middle, end, source]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      };
      const raceA = insertReplacement(replacementA, '6c000000-0000-7000-8000-000000000002', 'replacement-a');
      const raceB = insertReplacement(replacementB, '6c000000-0000-7000-8000-000000000003', 'replacement-b');
      await waitForBlockedApplications(pool, ['relationship-replacement-a', 'relationship-replacement-b']);
      await revoker.query('COMMIT');
      const replacements = await Promise.allSettled([raceA, raceB]);
      assert.equal(replacements.filter((result) => result.status === 'fulfilled').length, 1,
        'only one adjacent replacement wins after concurrent revocation');
    } finally {
      await revoker.query('ROLLBACK').catch(() => {});
      await replacementA.query('ROLLBACK').catch(() => {});
      await replacementB.query('ROLLBACK').catch(() => {});
      revoker.release();
      replacementA.release();
      replacementB.release();
    }
    const naturalEnd = new Date(end.getTime() + 60_000);
    await pool.query(`INSERT INTO authz.relationship (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until, source_kind, source_ref)
      VALUES ('6c000000-0000-7000-8000-000000000004', '66000000-0000-7000-8000-000000000002', '67000000-0000-7000-8000-000000000001', '68000000-0000-7000-8000-000000000001', $1, $2, 'SYSTEM', 'natural-end')`, [middle, naturalEnd]);
    const naturalA = await pool.connect();
    const naturalB = await pool.connect();
    try {
      await naturalA.query('BEGIN');
      await naturalB.query('BEGIN');
      await naturalA.query(`SET LOCAL application_name='natural-reentry-a'`);
      await naturalB.query(`SET LOCAL application_name='natural-reentry-b'`);
      const insertNatural = (client, id, source, index) => client.query(`INSERT INTO authz.relationship
        (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, source_kind, source_ref)
        VALUES ($1, '66000000-0000-7000-8000-000000000002', '67000000-0000-7000-8000-000000000001',
          '68000000-0000-7000-8000-000000000001', $2, 'SYSTEM', $3)`, [id, naturalEnd, source])
        .then(() => index);
      const naturalPromises = [
        insertNatural(naturalA, '6c000000-0000-7000-8000-000000000005', 'natural-reentry-a', 0),
        insertNatural(naturalB, '6c000000-0000-7000-8000-000000000006', 'natural-reentry-b', 1),
      ];
      const winner = await Promise.race(naturalPromises);
      const loserName = winner === 0 ? 'natural-reentry-b' : 'natural-reentry-a';
      await waitForBlockedApplications(pool, [loserName]);
      await (winner === 0 ? naturalA : naturalB).query('COMMIT');
      const naturalRace = await Promise.allSettled(naturalPromises);
      assert.equal(naturalRace.filter((result) => result.status === 'fulfilled').length, 1,
        'only one adjacent replacement wins after natural end');
      await (winner === 0 ? naturalB : naturalA).query('ROLLBACK');
    } finally {
      await naturalA.query('ROLLBACK').catch(() => {});
      await naturalB.query('ROLLBACK').catch(() => {});
      naturalA.release();
      naturalB.release();
    }
    const exclusion = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname='ex_relationship_effective_window' AND contype='x'`);
    assert.equal(exclusion.rowCount, 1, 'relationship overlap protection must be concurrency-safe exclusion');
  } finally {
    await pool?.end();
    await container?.stop();
  }
});
