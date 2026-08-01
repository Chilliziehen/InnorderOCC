\set ON_ERROR_STOP on

BEGIN;

INSERT INTO catalog.domain_package (id, package_key, name, status)
VALUES
  ('50000000-0000-7000-8000-000000000001', 'workflow.test', 'Workflow test', 'ACTIVE'),
  ('50000000-0000-7000-8000-000000000002', 'workflow.other', 'Workflow other', 'ACTIVE');
INSERT INTO catalog.package_version (id, package_id, semver, status, manifest)
VALUES
  ('51000000-0000-7000-8000-000000000001', '50000000-0000-7000-8000-000000000001', '1.0.0', 'DRAFT', '{}'),
  ('51000000-0000-7000-8000-000000000002', '50000000-0000-7000-8000-000000000002', '1.0.0', 'DRAFT', '{}');
INSERT INTO catalog.entity_type (id, package_id, type_key, name, entity_kind)
VALUES
  ('52000000-0000-7000-8000-000000000001', '50000000-0000-7000-8000-000000000001', 'person', 'Person', 'PRINCIPAL'),
  ('52000000-0000-7000-8000-000000000002', '50000000-0000-7000-8000-000000000001', 'cohort', 'Cohort', 'RESOURCE'),
  ('52000000-0000-7000-8000-000000000003', '50000000-0000-7000-8000-000000000001', 'process', 'Process', 'RESOURCE'),
  ('52000000-0000-7000-8000-000000000004', '50000000-0000-7000-8000-000000000001', 'task', 'Task', 'RESOURCE');
INSERT INTO catalog.entity_type_version
  (id, entity_type_id, package_version_id, schema_version, json_schema)
VALUES
  ('53000000-0000-7000-8000-000000000001', '52000000-0000-7000-8000-000000000001', '51000000-0000-7000-8000-000000000001', 1, '{}'),
  ('53000000-0000-7000-8000-000000000002', '52000000-0000-7000-8000-000000000002', '51000000-0000-7000-8000-000000000001', 1, '{}'),
  ('53000000-0000-7000-8000-000000000003', '52000000-0000-7000-8000-000000000003', '51000000-0000-7000-8000-000000000001', 1, '{}'),
  ('53000000-0000-7000-8000-000000000004', '52000000-0000-7000-8000-000000000004', '51000000-0000-7000-8000-000000000001', 1, '{}');
INSERT INTO catalog.workflow_definition
  (id, package_version_id, workflow_key, bpmn_object_key, content_hash)
VALUES
  ('54000000-0000-7000-8000-000000000001', '51000000-0000-7000-8000-000000000001', 'route', 'route.bpmn', repeat('a', 64)),
  ('54000000-0000-7000-8000-000000000002', '51000000-0000-7000-8000-000000000002', 'other', 'other.bpmn', repeat('b', 64));
INSERT INTO catalog.relation_definition
  (id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality, transitive, acyclic, auth_relevant)
VALUES
  ('55000000-0000-7000-8000-000000000001', '51000000-0000-7000-8000-000000000001',
   'cohort_owner', '52000000-0000-7000-8000-000000000001', '52000000-0000-7000-8000-000000000002',
   'ONE_TO_MANY', false, false, true);
UPDATE catalog.package_version
SET status = 'PUBLISHED', content_hash = repeat('c', 64), published_at = transaction_timestamp()
WHERE id = '51000000-0000-7000-8000-000000000001';

INSERT INTO authz.entity
  (id, entity_type_id, entity_type_version_id, entity_key, state, auth_attributes, row_version)
VALUES
  ('56000000-0000-7000-8000-000000000001', '52000000-0000-7000-8000-000000000001', '53000000-0000-7000-8000-000000000001', 'person:owner', 'ACTIVE', '{}', 1),
  ('56000000-0000-7000-8000-000000000002', '52000000-0000-7000-8000-000000000001', '53000000-0000-7000-8000-000000000001', 'person:participant', 'ACTIVE', '{}', 1),
  ('56000000-0000-7000-8000-000000000003', '52000000-0000-7000-8000-000000000001', '53000000-0000-7000-8000-000000000001', 'person:new-owner', 'ACTIVE', '{}', 1),
  ('57000000-0000-7000-8000-000000000001', '52000000-0000-7000-8000-000000000002', '53000000-0000-7000-8000-000000000002', 'cohort:alpha', 'ACTIVE', '{}', 1),
  ('57000000-0000-7000-8000-000000000002', '52000000-0000-7000-8000-000000000002', '53000000-0000-7000-8000-000000000002', 'cohort:invalid-insert', 'ACTIVE', '{}', 1),
  ('58000000-0000-7000-8000-000000000001', '52000000-0000-7000-8000-000000000003', '53000000-0000-7000-8000-000000000003', 'process:one', 'ACTIVE', '{}', 1),
  ('58000000-0000-7000-8000-000000000002', '52000000-0000-7000-8000-000000000003', '53000000-0000-7000-8000-000000000003', 'process:terminal-insert', 'ACTIVE', '{}', 1),
  ('59000000-0000-7000-8000-000000000001', '52000000-0000-7000-8000-000000000004', '53000000-0000-7000-8000-000000000004', 'task:one', 'ACTIVE', '{}', 1),
  ('59000000-0000-7000-8000-000000000002', '52000000-0000-7000-8000-000000000004', '53000000-0000-7000-8000-000000000004', 'task:two', 'ACTIVE', '{}', 1),
  ('59000000-0000-7000-8000-000000000003', '52000000-0000-7000-8000-000000000004', '53000000-0000-7000-8000-000000000004', 'task:terminal-insert', 'ACTIVE', '{}', 1);
INSERT INTO iam.principal (id, principal_kind, display_name, status, profile, row_version)
VALUES
  ('56000000-0000-7000-8000-000000000001', 'USER', 'Owner', 'ACTIVE', '{}', 1),
  ('56000000-0000-7000-8000-000000000002', 'USER', 'Participant', 'ACTIVE', '{}', 1),
  ('56000000-0000-7000-8000-000000000003', 'USER', 'New owner', 'ACTIVE', '{}', 1);

SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.cohort
      (id, customer_instance_id, code, name, package_version_id, owner_principal_id,
       start_date, status, row_version, created_by, updated_by)
    VALUES ('57000000-0000-7000-8000-000000000099', '00000000-0000-7000-8000-000000000001',
      ' Not-Normalized ', 'Bad', '51000000-0000-7000-8000-000000000001',
      '56000000-0000-7000-8000-000000000001', current_date, 'DRAFT', 1,
      '56000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000001')$$,
  '23514', 'cohort code is normalized');

INSERT INTO occ.cohort
  (id, customer_instance_id, code, name, package_version_id, owner_principal_id,
   start_date, status, row_version, created_by, updated_by)
VALUES
  ('57000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000001',
   'alpha', 'Alpha', '51000000-0000-7000-8000-000000000001',
   '56000000-0000-7000-8000-000000000001', current_date, 'DRAFT', 1,
   '56000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000001');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM authz.relationship
   WHERE relation_definition_id = '55000000-0000-7000-8000-000000000001'
     AND subject_entity_id = '56000000-0000-7000-8000-000000000001'
     AND object_entity_id = '57000000-0000-7000-8000-000000000001' AND revoked_at IS NULL),
  'cohort owner is projected exactly once');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.cohort
      (id, customer_instance_id, code, name, package_version_id, owner_principal_id, start_date, status, created_by, updated_by)
    VALUES ('57000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001',
      'alpha', 'Duplicate', '51000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000001',
      current_date, 'DRAFT', '56000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000001')$$,
  '23505', 'cohort code is unique per customer');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.cohort
      (id, customer_instance_id, code, name, package_version_id, owner_principal_id, start_date, status, created_by, updated_by)
    VALUES ('57000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001',
      'active-at-insert', 'Invalid active', '51000000-0000-7000-8000-000000000001',
      '56000000-0000-7000-8000-000000000001', current_date, 'ACTIVE',
      '56000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000001')$$,
  '55000', 'cohort must be created in DRAFT');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.cohort
      (id, customer_instance_id, code, name, package_version_id, owner_principal_id, start_date, status, created_by, updated_by, archived_at)
    VALUES ('57000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001',
      'archived-at-insert', 'Invalid archived', '51000000-0000-7000-8000-000000000001',
      '56000000-0000-7000-8000-000000000001', current_date, 'ARCHIVED',
      '56000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000001', transaction_timestamp())$$,
  '55000', 'cohort cannot be created archived');
SELECT pg_temp.assert_raises(
  $$UPDATE occ.cohort SET status = 'ARCHIVED', archived_at = transaction_timestamp()
    WHERE id = '57000000-0000-7000-8000-000000000001'$$,
  '55000', 'cohort cannot skip ACTIVE');
SELECT pg_temp.assert_raises(
  $$UPDATE occ.cohort SET package_version_id = '51000000-0000-7000-8000-000000000002'
    WHERE id = '57000000-0000-7000-8000-000000000001'$$,
  '55000', 'cohort package is immutable');
UPDATE occ.cohort SET owner_principal_id = '56000000-0000-7000-8000-000000000003',
  updated_by = '56000000-0000-7000-8000-000000000003'
WHERE id = '57000000-0000-7000-8000-000000000001';
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM authz.relationship
   WHERE relation_definition_id = '55000000-0000-7000-8000-000000000001'
     AND subject_entity_id = '56000000-0000-7000-8000-000000000003'
     AND object_entity_id = '57000000-0000-7000-8000-000000000001' AND revoked_at IS NULL),
  'cohort ownership transfer updates projection');
SELECT pg_temp.assert_raises(
  $$UPDATE authz.relationship SET revoked_at = transaction_timestamp(),
      revoked_by = '56000000-0000-7000-8000-000000000003'
    WHERE relation_definition_id = '55000000-0000-7000-8000-000000000001'
      AND object_entity_id = '57000000-0000-7000-8000-000000000001' AND revoked_at IS NULL$$,
  '55000', 'cohort owner projection cannot be revoked directly');
SELECT pg_temp.assert_true(
  (SELECT row_version = 2 FROM occ.cohort WHERE id = '57000000-0000-7000-8000-000000000001'),
  'cohort row version increments from explicit version one');

SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.process_definition_binding
      (id, workflow_definition_id, package_version_id, bpmn_key, flowable_deployment_id, flowable_definition_id, content_hash)
    VALUES ('5a000000-0000-7000-8000-000000000099', '54000000-0000-7000-8000-000000000001',
      '51000000-0000-7000-8000-000000000002', 'bad', 'bad-deployment', 'bad-definition', repeat('d', 64))$$,
  '23503', 'definition binding package matches workflow package');
INSERT INTO occ.process_definition_binding
  (id, workflow_definition_id, package_version_id, bpmn_key, flowable_deployment_id, flowable_definition_id, content_hash)
VALUES ('5a000000-0000-7000-8000-000000000001', '54000000-0000-7000-8000-000000000001',
  '51000000-0000-7000-8000-000000000001', 'route', 'deployment-1', 'definition-1', repeat('e', 64));

INSERT INTO occ.process_instance
  (id, definition_binding_id, package_version_id, flowable_instance_id, business_key, state,
   row_version, started_by, cohort_id, started_for_participant_id, participant_id, route_key, route_version)
VALUES ('58000000-0000-7000-8000-000000000001', '5a000000-0000-7000-8000-000000000001',
  '51000000-0000-7000-8000-000000000001', 'instance-1', 'business-1', 'RUNNING', 1,
  '56000000-0000-7000-8000-000000000001', '57000000-0000-7000-8000-000000000001',
  '56000000-0000-7000-8000-000000000002', '56000000-0000-7000-8000-000000000002', 'route', 1);
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.process_instance
      (id, definition_binding_id, package_version_id, flowable_instance_id, business_key, state,
       ended_at, cohort_id, started_for_participant_id, participant_id, route_key, route_version)
    VALUES ('58000000-0000-7000-8000-000000000002', '5a000000-0000-7000-8000-000000000001',
      '51000000-0000-7000-8000-000000000001', 'terminal-at-insert', 'terminal-at-insert', 'COMPLETED',
      transaction_timestamp(), '57000000-0000-7000-8000-000000000001',
      '56000000-0000-7000-8000-000000000003', '56000000-0000-7000-8000-000000000003', 'route', 1)$$,
  '55000', 'process must be created RUNNING');
SELECT pg_temp.assert_raises(
  $$UPDATE occ.process_instance SET definition_binding_id = definition_binding_id
    WHERE id = '58000000-0000-7000-8000-000000000001' RETURNING package_version_id + interval '0 seconds'$$,
  '42883', 'test assertion helper remains active');
SELECT pg_temp.assert_raises(
  $$UPDATE occ.process_instance SET state = 'RUNNING', ended_at = transaction_timestamp()
    WHERE id = '58000000-0000-7000-8000-000000000001'$$,
  '23514', 'active process forbids ended_at');

INSERT INTO occ.task_projection
  (id, process_instance_id, activity_key, activity_name, flowable_task_id, flowable_execution_id, state, row_version)
VALUES ('59000000-0000-7000-8000-000000000001', '58000000-0000-7000-8000-000000000001',
  'work', 'Work', 'flowable-task-1', 'execution-1', 'AVAILABLE', 1);
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_projection
      (id, process_instance_id, activity_key, activity_name, flowable_task_id, flowable_execution_id,
       state, assignee_id, claimed_at, completed_at)
    VALUES ('59000000-0000-7000-8000-000000000003', '58000000-0000-7000-8000-000000000001',
      'terminal', 'Terminal', 'flowable-task-terminal', 'execution-terminal', 'COMPLETED',
      '56000000-0000-7000-8000-000000000002', transaction_timestamp(), transaction_timestamp())$$,
  '55000', 'task must be created AVAILABLE');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_projection
      (id, process_instance_id, activity_key, activity_name, flowable_task_id, flowable_execution_id, state, created_at)
    SELECT '59000000-0000-7000-8000-000000000002', process_instance_id,
      activity_key, 'Work again', 'flowable-task-2', flowable_execution_id, 'AVAILABLE', created_at
    FROM occ.task_projection WHERE id = '59000000-0000-7000-8000-000000000001'$$,
  '23505', 'task occurrence identity is unique');
INSERT INTO occ.task_gate_requirement (task_id, provider_key)
VALUES ('59000000-0000-7000-8000-000000000001', 'evidence');
UPDATE occ.task_projection SET state = 'CLAIMED', assignee_id = '56000000-0000-7000-8000-000000000002',
  claimed_at = transaction_timestamp()
WHERE id = '59000000-0000-7000-8000-000000000001';
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_gate_provider_state (task_id, provider_key, status)
    VALUES ('59000000-0000-7000-8000-000000000001', 'evidence', 'READY')$$,
  '23514', 'READY gate state requires a source');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_gate_provider_state
      (task_id, provider_key, status, source_entity_id, source_row_version)
    VALUES ('59000000-0000-7000-8000-000000000001', 'evidence', 'READY',
      '59000000-0000-7000-8000-000000000001', 999)$$,
  '23514', 'READY gate state requires the exact source version');
SELECT pg_temp.assert_raises(
  $$UPDATE occ.task_projection SET state = 'COMPLETED', completed_at = transaction_timestamp()
    WHERE id = '59000000-0000-7000-8000-000000000001'$$,
  '55000', 'missing gate provider state fails closed');
INSERT INTO occ.task_gate_provider_state
  (task_id, provider_key, status, source_entity_id, source_row_version)
VALUES ('59000000-0000-7000-8000-000000000001', 'evidence', 'READY',
  '59000000-0000-7000-8000-000000000001', 2);
INSERT INTO occ.task_gate_provider_state
  (task_id, provider_key, status, source_entity_id, source_row_version, safe_failure_code, refreshed_at)
VALUES ('59000000-0000-7000-8000-000000000001', 'evidence', 'UNAVAILABLE',
  '59000000-0000-7000-8000-000000000001', 2, 'provider_timeout', transaction_timestamp() + interval '1 second')
ON CONFLICT (task_id, provider_key) DO UPDATE
SET status = EXCLUDED.status, source_entity_id = EXCLUDED.source_entity_id,
    source_row_version = EXCLUDED.source_row_version, safe_failure_code = EXCLUDED.safe_failure_code,
    refreshed_at = EXCLUDED.refreshed_at;
INSERT INTO occ.task_gate_provider_state
  (task_id, provider_key, status, source_entity_id, source_row_version, refreshed_at)
VALUES ('59000000-0000-7000-8000-000000000001', 'evidence', 'READY',
  '59000000-0000-7000-8000-000000000001', 2, transaction_timestamp() + interval '2 seconds')
ON CONFLICT (task_id, provider_key) DO UPDATE
SET status = EXCLUDED.status, source_entity_id = EXCLUDED.source_entity_id,
    source_row_version = EXCLUDED.source_row_version, safe_failure_code = NULL,
    refreshed_at = EXCLUDED.refreshed_at;
INSERT INTO occ.task_blocker
  (id, task_id, source_entity_id, source_row_version, blocker_code, severity)
VALUES ('59000000-0000-7000-8000-000000000010', '59000000-0000-7000-8000-000000000001',
  '59000000-0000-7000-8000-000000000001', 2, 'EVIDENCE_REQUIRED', 'HARD');
UPDATE occ.task_blocker SET resolved_at = transaction_timestamp()
WHERE id = '59000000-0000-7000-8000-000000000010';
SELECT pg_temp.assert_raises(
  $$UPDATE occ.task_blocker SET resolved_at = resolved_at + interval '1 second'
    WHERE id = '59000000-0000-7000-8000-000000000010'$$,
  '55000', 'resolved task blocker cannot be rewritten');
SELECT pg_temp.assert_raises(
  $$DELETE FROM occ.task_gate_requirement
    WHERE task_id = '59000000-0000-7000-8000-000000000001' AND provider_key = 'evidence'$$,
  '55000', 'gate requirements cannot be deleted');
SELECT pg_temp.assert_raises(
  $$DELETE FROM occ.task_gate_provider_state
    WHERE task_id = '59000000-0000-7000-8000-000000000001' AND provider_key = 'evidence'$$,
  '55000', 'gate provider states cannot be deleted');
SELECT pg_temp.assert_raises(
  $$DELETE FROM occ.task_blocker WHERE id = '59000000-0000-7000-8000-000000000010'$$,
  '55000', 'task blockers cannot be deleted');
UPDATE occ.task_projection SET state = 'COMPLETED', completed_at = transaction_timestamp()
WHERE id = '59000000-0000-7000-8000-000000000001';
INSERT INTO occ.task_gate_requirement (task_id, provider_key)
VALUES ('59000000-0000-7000-8000-000000000001', 'resource');
INSERT INTO occ.task_gate_provider_state
  (task_id, provider_key, status, source_entity_id, source_row_version)
VALUES ('59000000-0000-7000-8000-000000000001', 'resource', 'READY',
  '59000000-0000-7000-8000-000000000001', 3);
SELECT pg_temp.assert_true(
  (SELECT row_version = 3 FROM occ.task_projection WHERE id = '59000000-0000-7000-8000-000000000001'),
  'task claims and completion increment row version');
SELECT pg_temp.assert_raises(
  $$UPDATE occ.task_projection SET state = 'CLAIMED', completed_at = NULL
    WHERE id = '59000000-0000-7000-8000-000000000001'$$,
  '55000', 'terminal task cannot transition');

INSERT INTO audit.outbox_event
  (id, aggregate_type, aggregate_id, aggregate_version, event_type, schema_version, payload,
   correlation_id, customer_instance_id, status)
VALUES ('5b000000-0000-7000-8000-000000000001', 'task', '59000000-0000-7000-8000-000000000001',
  3, 'task.completed', 1, '{}', '5b000000-0000-7000-8000-000000000002',
  '00000000-0000-7000-8000-000000000001', 'PENDING');
INSERT INTO occ.task_timeline (id, task_id, fact_type, event_id)
VALUES ('5c000000-0000-7000-8000-000000000001', '59000000-0000-7000-8000-000000000001',
  'LIFECYCLE', '5b000000-0000-7000-8000-000000000001');
SELECT pg_temp.assert_raises(
  $$UPDATE occ.task_timeline SET fact_type = 'ASSIGNMENT'
    WHERE id = '5c000000-0000-7000-8000-000000000001'$$,
  '55000', 'task timeline is append only');

INSERT INTO audit.idempotency_record
  (id, principal_id, command_key, idempotency_key, request_hash, state, expires_at)
VALUES ('5d000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000002',
  'task.submit', 'submission-1', repeat('f', 64), 'IN_PROGRESS', transaction_timestamp() + interval '1 hour');
INSERT INTO occ.task_review_projection_fact
  (id, task_id, fact_kind, review_sequence, evidence_id, evidence_version_id, submission_idempotency_id, prior_assignee_id)
VALUES ('5e000000-0000-7000-8000-000000000001', '59000000-0000-7000-8000-000000000001',
  'SUBMITTED', 1, '5e000000-0000-7000-8000-000000000010', '5e000000-0000-7000-8000-000000000011',
  '5d000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000002');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_review_projection_fact
      (id, task_id, fact_kind, review_sequence, evidence_id, evidence_version_id, submission_idempotency_id)
    VALUES ('5e000000-0000-7000-8000-000000000004', '59000000-0000-7000-8000-000000000001',
      'SUBMITTED', 2, '5e000000-0000-7000-8000-000000000012', '5e000000-0000-7000-8000-000000000013',
      '5d000000-0000-7000-8000-000000000001')$$,
  '23514', 'submitted review projection requires the prior assignee');
INSERT INTO occ.task_review_projection_fact
  (id, task_id, fact_kind, review_sequence, submission_fact_id, review_id, review_version, decision)
VALUES ('5e000000-0000-7000-8000-000000000002', '59000000-0000-7000-8000-000000000001',
  'DECIDED', 1, '5e000000-0000-7000-8000-000000000001', '5e000000-0000-7000-8000-000000000020', 1, 'ACCEPTED');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_review_projection_fact
      (id, task_id, fact_kind, review_sequence, submission_fact_id, review_id, review_version, decision)
    VALUES ('5e000000-0000-7000-8000-000000000003', '59000000-0000-7000-8000-000000000001',
      'DECIDED', 1, '5e000000-0000-7000-8000-000000000001', '5e000000-0000-7000-8000-000000000021', 1, 'REJECTED')$$,
  '23505', 'one submission has one decision');
SELECT pg_temp.assert_raises(
  $$DELETE FROM occ.task_review_projection_fact WHERE id = '5e000000-0000-7000-8000-000000000002'$$,
  '55000', 'review facts are append only');

INSERT INTO occ.notification
  (id, recipient_id, type, severity, resource_type, resource_id, event_id)
VALUES ('5f000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000002',
  'task.completed', 'INFO', 'task', '59000000-0000-7000-8000-000000000001',
  '5b000000-0000-7000-8000-000000000001');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.notification
      (id, recipient_id, type, severity, resource_type, resource_id, event_id, read_at)
    VALUES ('5f000000-0000-7000-8000-000000000002', '56000000-0000-7000-8000-000000000003',
      'task.completed', 'INFO', 'task', '59000000-0000-7000-8000-000000000001',
      '5b000000-0000-7000-8000-000000000001', transaction_timestamp())$$,
  '55000', 'notification must be created unread');
UPDATE occ.notification SET read_at = transaction_timestamp()
WHERE id = '5f000000-0000-7000-8000-000000000001';
SELECT pg_temp.assert_raises(
  $$UPDATE occ.notification SET read_at = NULL WHERE id = '5f000000-0000-7000-8000-000000000001'$$,
  '55000', 'notification read state is one way');

SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ex_relationship_effective_window'),
  'relationship effective window uses an exclusion constraint');
INSERT INTO audit.dependency_failure_attempt
  (id, command_key, actor_principal_id, target_entity_id, correlation_id, dependency_code, failure_category)
VALUES ('5f000000-0000-7000-8000-000000000010', 'task.complete',
  '56000000-0000-7000-8000-000000000002', '59000000-0000-7000-8000-000000000001',
  '5f000000-0000-7000-8000-000000000011', 'flowable', 'UNAVAILABLE');
SELECT pg_temp.assert_raises(
  $$INSERT INTO audit.dependency_failure_attempt
      (id, command_key, actor_principal_id, correlation_id, dependency_code, failure_category)
    VALUES ('5f000000-0000-7000-8000-000000000012', 'Task Complete With Detail',
      '56000000-0000-7000-8000-000000000002', '5f000000-0000-7000-8000-000000000013',
      'java.exception.stacktrace', 'UNAVAILABLE')$$,
  '23514', 'dependency failure fields only accept bounded safe codes');
SELECT pg_temp.assert_raises(
  $$UPDATE audit.dependency_failure_attempt SET failure_category = 'TIMEOUT'
    WHERE id = '5f000000-0000-7000-8000-000000000010'$$,
  '55000', 'dependency failure attempts are append only');
SELECT pg_temp.assert_true(
  has_table_privilege('innorder_runtime', 'occ.cohort', 'SELECT,INSERT,UPDATE,DELETE')
  AND has_table_privilege('innorder_runtime', 'occ.task_projection', 'SELECT,INSERT,UPDATE,DELETE')
  AND has_table_privilege('innorder_runtime', 'occ.task_gate_requirement', 'SELECT,INSERT')
  AND NOT has_table_privilege('innorder_runtime', 'occ.task_gate_requirement', 'UPDATE,DELETE')
  AND has_table_privilege('innorder_runtime', 'occ.task_gate_provider_state', 'SELECT,INSERT,UPDATE')
  AND NOT has_table_privilege('innorder_runtime', 'occ.task_gate_provider_state', 'DELETE')
  AND has_table_privilege('innorder_runtime', 'occ.task_blocker', 'SELECT,INSERT,UPDATE')
  AND NOT has_table_privilege('innorder_runtime', 'occ.task_blocker', 'DELETE')
  AND has_table_privilege('innorder_runtime', 'audit.dependency_failure_attempt', 'SELECT,INSERT')
  AND NOT has_table_privilege('innorder_runtime', 'audit.dependency_failure_attempt', 'UPDATE,DELETE'),
  'runtime has bounded workflow DML');
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'occ' AND indexname = 'ix_task_projection_assignee_state')
  AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'occ' AND indexname = 'ix_notification_recipient_cursor'),
  'workflow query indexes exist');

ROLLBACK;
