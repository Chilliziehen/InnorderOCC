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
   'ONE_TO_MANY', false, false, true),
  ('55000000-0000-7000-8000-000000000002', '51000000-0000-7000-8000-000000000001',
   'temporal_one_to_one', '52000000-0000-7000-8000-000000000001', '52000000-0000-7000-8000-000000000002',
   'ONE_TO_ONE', false, false, false),
  ('55000000-0000-7000-8000-000000000003', '51000000-0000-7000-8000-000000000001',
   'temporal_one_to_many', '52000000-0000-7000-8000-000000000001', '52000000-0000-7000-8000-000000000002',
   'ONE_TO_MANY', false, false, false),
  ('55000000-0000-7000-8000-000000000004', '51000000-0000-7000-8000-000000000001',
   'temporal_acyclic', '52000000-0000-7000-8000-000000000001', '52000000-0000-7000-8000-000000000001',
   'MANY_TO_MANY', true, true, false),
  ('55000000-0000-7000-8000-000000000005', '51000000-0000-7000-8000-000000000002',
   'draft_history', '52000000-0000-7000-8000-000000000001', '52000000-0000-7000-8000-000000000002',
   'MANY_TO_MANY', false, false, false);
INSERT INTO catalog.evidence_requirement
  (id, package_version_id, requirement_key, allowed_types, min_count, validation_schema)
VALUES ('55000000-0000-7000-8000-000000000010', '51000000-0000-7000-8000-000000000001',
  'gate-evidence', '[]', 1, '{}');
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
  ('59000000-0000-7000-8000-000000000003', '52000000-0000-7000-8000-000000000004', '53000000-0000-7000-8000-000000000004', 'task:terminal-insert', 'ACTIVE', '{}', 1),
  ('5a000000-0000-7000-8000-000000000010', '52000000-0000-7000-8000-000000000004', '53000000-0000-7000-8000-000000000004', 'evidence:gate', 'ACTIVE', '{}', 1),
  ('5a000000-0000-7000-8000-000000000011', '52000000-0000-7000-8000-000000000004', '53000000-0000-7000-8000-000000000004', 'resource:gate', 'ACTIVE', '{}', 1),
  ('5a000000-0000-7000-8000-000000000012', '52000000-0000-7000-8000-000000000004', '53000000-0000-7000-8000-000000000004', 'evidence:other-task', 'ACTIVE', '{}', 1),
  ('5a000000-0000-7000-8000-000000000013', '52000000-0000-7000-8000-000000000004', '53000000-0000-7000-8000-000000000004', 'resource:other-task', 'ACTIVE', '{}', 1),
  ('5a000000-0000-7000-8000-000000000014', '52000000-0000-7000-8000-000000000004', '53000000-0000-7000-8000-000000000004', 'evidence:review-two', 'ACTIVE', '{}', 1);
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
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM authz.active_relationships_at(transaction_timestamp())
   WHERE relation_definition_id = '55000000-0000-7000-8000-000000000001'
     AND subject_entity_id = '56000000-0000-7000-8000-000000000001'
     AND object_entity_id = '57000000-0000-7000-8000-000000000001'),
  'cohort owner projection is visible at the transaction snapshot');
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
CREATE TEMP TABLE cohort_owner_transfer_revision_before AS
SELECT current_revision FROM authz.authorization_state WHERE singleton = true;
SELECT pg_temp.assert_raises(
  $$UPDATE occ.cohort SET package_version_id = '51000000-0000-7000-8000-000000000002'
    WHERE id = '57000000-0000-7000-8000-000000000001'$$,
  '55000', 'cohort package is immutable');
UPDATE occ.cohort SET owner_principal_id = '56000000-0000-7000-8000-000000000003',
  updated_by = '56000000-0000-7000-8000-000000000003'
WHERE id = '57000000-0000-7000-8000-000000000001';
SELECT pg_temp.assert_true(
  (SELECT state.current_revision = before.current_revision + 1
   FROM authz.authorization_state state CROSS JOIN cohort_owner_transfer_revision_before before
   WHERE state.singleton = true),
  'cohort owner transfer increments authorization revision exactly once');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM authz.relationship
   WHERE relation_definition_id = '55000000-0000-7000-8000-000000000001'
     AND subject_entity_id = '56000000-0000-7000-8000-000000000003'
     AND object_entity_id = '57000000-0000-7000-8000-000000000001' AND revoked_at IS NULL),
  'cohort ownership transfer updates projection');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM authz.active_relationships_at(transaction_timestamp())
   WHERE relation_definition_id = '55000000-0000-7000-8000-000000000001'
     AND subject_entity_id = '56000000-0000-7000-8000-000000000003'
     AND object_entity_id = '57000000-0000-7000-8000-000000000001')
  AND (SELECT count(*) = 0 FROM authz.active_relationships_at(transaction_timestamp())
       WHERE relation_definition_id = '55000000-0000-7000-8000-000000000001'
         AND subject_entity_id = '56000000-0000-7000-8000-000000000001'
         AND object_entity_id = '57000000-0000-7000-8000-000000000001')
  AND (SELECT bool_and(valid_from = transaction_timestamp()) FROM authz.relationship
       WHERE relation_definition_id = '55000000-0000-7000-8000-000000000001'
         AND object_entity_id = '57000000-0000-7000-8000-000000000001')
  AND (SELECT bool_and(revoked_at = transaction_timestamp()) FROM authz.relationship
       WHERE relation_definition_id = '55000000-0000-7000-8000-000000000001'
         AND object_entity_id = '57000000-0000-7000-8000-000000000001' AND revoked_at IS NOT NULL),
  'cohort owner transfer has one snapshot-visible owner and no validity gap');
SELECT pg_temp.assert_raises(
  $$UPDATE authz.relationship SET revoked_at = transaction_timestamp(),
      revoked_by = '56000000-0000-7000-8000-000000000003'
    WHERE relation_definition_id = '55000000-0000-7000-8000-000000000001'
      AND object_entity_id = '57000000-0000-7000-8000-000000000001' AND revoked_at IS NULL$$,
  '55000', 'cohort owner projection cannot be revoked directly');
SELECT pg_temp.assert_true(
  (SELECT row_version = 2 FROM occ.cohort WHERE id = '57000000-0000-7000-8000-000000000001'),
  'cohort row version increments from explicit version one');

INSERT INTO authz.relationship
  (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until, source_kind, source_ref)
VALUES
  ('5f100000-0000-7000-8000-000000000001', '55000000-0000-7000-8000-000000000002',
   '56000000-0000-7000-8000-000000000001', '57000000-0000-7000-8000-000000000001',
   transaction_timestamp() - interval '4 hours', transaction_timestamp() - interval '3 hours', 'SYSTEM', 'one-to-one-expired'),
  ('5f100000-0000-7000-8000-000000000002', '55000000-0000-7000-8000-000000000002',
   '56000000-0000-7000-8000-000000000002', '57000000-0000-7000-8000-000000000001',
   transaction_timestamp() - interval '3 hours', transaction_timestamp() - interval '2 hours', 'SYSTEM', 'one-to-one-reentry'),
  ('5f100000-0000-7000-8000-000000000003', '55000000-0000-7000-8000-000000000003',
   '56000000-0000-7000-8000-000000000001', '57000000-0000-7000-8000-000000000002',
   transaction_timestamp() - interval '4 hours', transaction_timestamp() - interval '3 hours', 'SYSTEM', 'one-to-many-expired'),
  ('5f100000-0000-7000-8000-000000000004', '55000000-0000-7000-8000-000000000003',
   '56000000-0000-7000-8000-000000000002', '57000000-0000-7000-8000-000000000002',
   transaction_timestamp() - interval '3 hours', transaction_timestamp() - interval '2 hours', 'SYSTEM', 'one-to-many-reentry');
SELECT pg_temp.assert_raises(
  $$INSERT INTO authz.relationship
      (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until, source_kind, source_ref)
    VALUES ('5f100000-0000-7000-8000-000000000005', '55000000-0000-7000-8000-000000000002',
      '56000000-0000-7000-8000-000000000003', '57000000-0000-7000-8000-000000000001',
      transaction_timestamp() - interval '150 minutes', transaction_timestamp() - interval '90 minutes',
      'SYSTEM', 'one-to-one-overlap')$$,
  '23514', 'ONE_TO_ONE rejects an overlapping subject for the same object');
SELECT pg_temp.assert_raises(
  $$INSERT INTO authz.relationship
      (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until, source_kind, source_ref)
    VALUES ('5f100000-0000-7000-8000-000000000006', '55000000-0000-7000-8000-000000000003',
      '56000000-0000-7000-8000-000000000003', '57000000-0000-7000-8000-000000000002',
      transaction_timestamp() - interval '150 minutes', transaction_timestamp() - interval '90 minutes',
      'SYSTEM', 'one-to-many-overlap')$$,
  '23514', 'ONE_TO_MANY rejects overlapping subjects for the same object');
SELECT pg_temp.assert_raises(
  $$INSERT INTO authz.relationship
      (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until,
       revoked_at, revoked_by, source_kind, source_ref)
    VALUES ('5f100000-0000-7000-8000-000000000020', '55000000-0000-7000-8000-000000000005',
      '56000000-0000-7000-8000-000000000001', '57000000-0000-7000-8000-000000000001',
      transaction_timestamp() - interval '4 hours', transaction_timestamp() - interval '2 hours',
      transaction_timestamp() - interval '3 hours', '56000000-0000-7000-8000-000000000001',
      'SYSTEM', 'invalid-draft-history')$$,
  '23514', 'revoked history requires a published relationship definition');
SELECT pg_temp.assert_raises(
  $$INSERT INTO authz.relationship
      (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until,
       revoked_at, revoked_by, source_kind, source_ref)
    VALUES ('5f100000-0000-7000-8000-000000000021', '55000000-0000-7000-8000-000000000002',
      '57000000-0000-7000-8000-000000000001', '57000000-0000-7000-8000-000000000002',
      transaction_timestamp() - interval '4 hours', transaction_timestamp() - interval '2 hours',
      transaction_timestamp() - interval '3 hours', '56000000-0000-7000-8000-000000000001',
      'SYSTEM', 'invalid-endpoint-history')$$,
  '23514', 'revoked history enforces relationship endpoint types');
SELECT pg_temp.assert_raises(
  $$INSERT INTO authz.relationship
      (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until,
       revoked_at, revoked_by, source_kind, source_ref)
    VALUES ('5f100000-0000-7000-8000-000000000022', '55000000-0000-7000-8000-000000000002',
      '56000000-0000-7000-8000-000000000003', '57000000-0000-7000-8000-000000000001',
      transaction_timestamp() - interval '150 minutes', transaction_timestamp() - interval '90 minutes',
      transaction_timestamp() - interval '135 minutes', '56000000-0000-7000-8000-000000000001',
      'SYSTEM', 'invalid-cardinality-history')$$,
  '23514', 'revoked history enforces effective interval cardinality');
INSERT INTO authz.relationship
  (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until,
   revoked_at, revoked_by, source_kind, source_ref)
VALUES ('5f100000-0000-7000-8000-000000000023', '55000000-0000-7000-8000-000000000002',
  '56000000-0000-7000-8000-000000000003', '57000000-0000-7000-8000-000000000001',
  transaction_timestamp() - interval '90 minutes', transaction_timestamp() - interval '30 minutes',
  transaction_timestamp() - interval '60 minutes', '56000000-0000-7000-8000-000000000001',
  'SYSTEM', 'valid-non-overlap-history');
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM authz.relationship WHERE id = '5f100000-0000-7000-8000-000000000023'),
  'non-overlapping revoked relationship history is accepted');
UPDATE authz.relationship
SET revoked_at = transaction_timestamp(), revoked_by = '56000000-0000-7000-8000-000000000001'
WHERE id = '5f100000-0000-7000-8000-000000000001';
SELECT pg_temp.assert_true(
  (SELECT revoked_at = transaction_timestamp() FROM authz.relationship
   WHERE id = '5f100000-0000-7000-8000-000000000001'),
  'ordinary relationship revocation update remains valid');
INSERT INTO authz.relationship
  (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until,
   revoked_at, revoked_by, source_kind, source_ref)
VALUES
  ('5f100000-0000-7000-8000-000000000007', '55000000-0000-7000-8000-000000000002',
   '56000000-0000-7000-8000-000000000001', '57000000-0000-7000-8000-000000000002',
   transaction_timestamp() - interval '10 hours', transaction_timestamp() - interval '5 hours',
   transaction_timestamp() - interval '7 hours', '56000000-0000-7000-8000-000000000001', 'SYSTEM', 'one-to-one-revoked'),
  ('5f100000-0000-7000-8000-000000000008', '55000000-0000-7000-8000-000000000003',
   '56000000-0000-7000-8000-000000000001', '57000000-0000-7000-8000-000000000001',
   transaction_timestamp() - interval '10 hours', transaction_timestamp() - interval '5 hours',
   transaction_timestamp() - interval '7 hours', '56000000-0000-7000-8000-000000000001', 'SYSTEM', 'one-to-many-revoked');
SELECT pg_temp.assert_raises(
  $$INSERT INTO authz.relationship
      (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until, source_kind, source_ref)
    VALUES ('5f100000-0000-7000-8000-000000000009', '55000000-0000-7000-8000-000000000002',
      '56000000-0000-7000-8000-000000000002', '57000000-0000-7000-8000-000000000002',
      transaction_timestamp() - interval '9 hours', transaction_timestamp() - interval '8 hours',
      'SYSTEM', 'one-to-one-revoked-overlap')$$,
  '23514', 'ONE_TO_ONE counts the effective interval before revocation');
SELECT pg_temp.assert_raises(
  $$INSERT INTO authz.relationship
      (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until, source_kind, source_ref)
    VALUES ('5f100000-0000-7000-8000-000000000010', '55000000-0000-7000-8000-000000000003',
      '56000000-0000-7000-8000-000000000002', '57000000-0000-7000-8000-000000000001',
      transaction_timestamp() - interval '9 hours', transaction_timestamp() - interval '8 hours',
      'SYSTEM', 'one-to-many-revoked-overlap')$$,
  '23514', 'ONE_TO_MANY counts the effective interval before revocation');
INSERT INTO authz.relationship
  (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until,
   revoked_at, revoked_by, source_kind, source_ref)
VALUES
  ('5f100000-0000-7000-8000-000000000011', '55000000-0000-7000-8000-000000000004',
   '56000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000002',
   transaction_timestamp() - interval '10 hours', transaction_timestamp() - interval '5 hours',
   transaction_timestamp() - interval '7 hours', '56000000-0000-7000-8000-000000000001', 'SYSTEM', 'cycle-revoked-one'),
  ('5f100000-0000-7000-8000-000000000012', '55000000-0000-7000-8000-000000000004',
   '56000000-0000-7000-8000-000000000002', '56000000-0000-7000-8000-000000000003',
   transaction_timestamp() - interval '10 hours', transaction_timestamp() - interval '5 hours',
   transaction_timestamp() - interval '7 hours', '56000000-0000-7000-8000-000000000001', 'SYSTEM', 'cycle-revoked-two');
SELECT pg_temp.assert_raises(
  $$INSERT INTO authz.relationship
      (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until,
       revoked_at, revoked_by, source_kind, source_ref)
    VALUES ('5f100000-0000-7000-8000-000000000024', '55000000-0000-7000-8000-000000000004',
      '56000000-0000-7000-8000-000000000003', '56000000-0000-7000-8000-000000000001',
      transaction_timestamp() - interval '9 hours', transaction_timestamp() - interval '8 hours',
      transaction_timestamp() - interval '8 hours 30 minutes', '56000000-0000-7000-8000-000000000001',
      'SYSTEM', 'invalid-cycle-history')$$,
  '23514', 'revoked history enforces acyclic effective intervals');
SELECT pg_temp.assert_raises(
  $$INSERT INTO authz.relationship
      (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until, source_kind, source_ref)
    VALUES ('5f100000-0000-7000-8000-000000000013', '55000000-0000-7000-8000-000000000004',
      '56000000-0000-7000-8000-000000000003', '56000000-0000-7000-8000-000000000001',
      transaction_timestamp() - interval '9 hours', transaction_timestamp() - interval '8 hours',
      'SYSTEM', 'cycle-revoked-overlap')$$,
  '23514', 'acyclic validation counts the effective interval before revocation');
INSERT INTO authz.relationship
  (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until, source_kind, source_ref)
VALUES
  ('5f100000-0000-7000-8000-000000000014', '55000000-0000-7000-8000-000000000004',
   '56000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000002',
   transaction_timestamp() - interval '6 hours', transaction_timestamp() - interval '5 hours', 'SYSTEM', 'cycle-expired-one'),
  ('5f100000-0000-7000-8000-000000000015', '55000000-0000-7000-8000-000000000004',
   '56000000-0000-7000-8000-000000000002', '56000000-0000-7000-8000-000000000003',
   transaction_timestamp() - interval '6 hours', transaction_timestamp() - interval '5 hours', 'SYSTEM', 'cycle-expired-two'),
  ('5f100000-0000-7000-8000-000000000016', '55000000-0000-7000-8000-000000000004',
   '56000000-0000-7000-8000-000000000003', '56000000-0000-7000-8000-000000000001',
   transaction_timestamp() - interval '5 hours', transaction_timestamp() - interval '4 hours', 'SYSTEM', 'cycle-after-expiry');

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
INSERT INTO occ.process_instance
  (id, definition_binding_id, package_version_id, flowable_instance_id, business_key, state,
   row_version, started_by, cohort_id, started_for_participant_id, participant_id, route_key, route_version)
VALUES ('58000000-0000-7000-8000-000000000002', '5a000000-0000-7000-8000-000000000001',
  '51000000-0000-7000-8000-000000000001', 'instance-2', 'business-2', 'RUNNING', 1,
  '56000000-0000-7000-8000-000000000001', '57000000-0000-7000-8000-000000000001',
  '56000000-0000-7000-8000-000000000003', '56000000-0000-7000-8000-000000000003', 'route', 1);
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
INSERT INTO occ.task_projection
  (id, process_instance_id, activity_key, activity_name, flowable_task_id, flowable_execution_id, state, row_version)
VALUES ('59000000-0000-7000-8000-000000000002', '58000000-0000-7000-8000-000000000001',
  'review', 'Review', 'flowable-task-review', 'execution-review', 'AVAILABLE', 1);
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
    SELECT '59000000-0000-7000-8000-000000000003', process_instance_id,
      activity_key, 'Work again', 'flowable-task-2', flowable_execution_id, 'AVAILABLE', created_at
    FROM occ.task_projection WHERE id = '59000000-0000-7000-8000-000000000001'$$,
  '23505', 'task occurrence identity is unique');
UPDATE occ.task_projection SET state = 'CLAIMED', assignee_id = '56000000-0000-7000-8000-000000000002',
  claimed_at = transaction_timestamp()
WHERE id = '59000000-0000-7000-8000-000000000001';
UPDATE occ.task_projection SET state = 'CLAIMED', assignee_id = '56000000-0000-7000-8000-000000000002',
  claimed_at = transaction_timestamp()
WHERE id = '59000000-0000-7000-8000-000000000002';
INSERT INTO occ.evidence
  (id, task_id, requirement_id, state, row_version, created_by)
VALUES ('5a000000-0000-7000-8000-000000000010', '59000000-0000-7000-8000-000000000001',
  '55000000-0000-7000-8000-000000000010', 'PENDING', 1, '56000000-0000-7000-8000-000000000002');
INSERT INTO occ.evidence
  (id, task_id, requirement_id, state, row_version, created_by)
VALUES ('5a000000-0000-7000-8000-000000000012', '59000000-0000-7000-8000-000000000002',
  '55000000-0000-7000-8000-000000000010', 'PENDING', 1, '56000000-0000-7000-8000-000000000002');
INSERT INTO occ.evidence
  (id, task_id, requirement_id, state, row_version, created_by)
VALUES ('5a000000-0000-7000-8000-000000000014', '59000000-0000-7000-8000-000000000002',
  '55000000-0000-7000-8000-000000000010', 'PENDING', 1, '56000000-0000-7000-8000-000000000002');
INSERT INTO occ.evidence_version
  (id, evidence_id, version, object_key, sha256, mime_type, size_bytes, submitted_by)
VALUES
  ('5e000000-0000-7000-8000-000000000010', '5a000000-0000-7000-8000-000000000010', 1,
   'review/task-one', repeat('a', 64), 'application/pdf', 10, '56000000-0000-7000-8000-000000000002'),
  ('5e000000-0000-7000-8000-000000000011', '5a000000-0000-7000-8000-000000000012', 1,
   'review/task-two-one', repeat('b', 64), 'application/pdf', 10, '56000000-0000-7000-8000-000000000002'),
  ('5e000000-0000-7000-8000-000000000013', '5a000000-0000-7000-8000-000000000014', 1,
   'review/task-two-two', repeat('c', 64), 'application/pdf', 10, '56000000-0000-7000-8000-000000000002');
INSERT INTO occ.managed_resource
  (id, resource_type, capacity, state, data, row_version)
VALUES ('5a000000-0000-7000-8000-000000000011', 'test-resource', 1, 'AVAILABLE', '{}', 1);
INSERT INTO occ.managed_resource
  (id, resource_type, capacity, state, data, row_version)
VALUES ('5a000000-0000-7000-8000-000000000013', 'other-resource', 1, 'AVAILABLE', '{}', 1);
INSERT INTO occ.resource_reservation
  (id, resource_id, requester_entity_id, process_instance_id, task_id, time_range, capacity, state)
VALUES
  ('5a000000-0000-7000-8000-000000000020', '5a000000-0000-7000-8000-000000000011',
   '56000000-0000-7000-8000-000000000002', '58000000-0000-7000-8000-000000000001',
   '59000000-0000-7000-8000-000000000001', tstzrange(transaction_timestamp(), transaction_timestamp() + interval '1 hour', '[)'), 1, 'CONFIRMED'),
  ('5a000000-0000-7000-8000-000000000021', '5a000000-0000-7000-8000-000000000013',
   '56000000-0000-7000-8000-000000000002', '58000000-0000-7000-8000-000000000001',
   '59000000-0000-7000-8000-000000000002', tstzrange(transaction_timestamp(), transaction_timestamp() + interval '1 hour', '[)'), 1, 'CONFIRMED');
INSERT INTO occ.task_gate_requirement (task_id, provider_key)
VALUES
  ('59000000-0000-7000-8000-000000000001', 'evidence.required'),
  ('59000000-0000-7000-8000-000000000001', 'resource.capacity'),
  ('59000000-0000-7000-8000-000000000001', 'process.lifecycle'),
  ('59000000-0000-7000-8000-000000000002', 'unknown.provider'),
  ('59000000-0000-7000-8000-000000000002', 'resource.capacity');
UPDATE occ.resource_reservation
SET time_range = tstzrange(transaction_timestamp() + interval '1 hour', transaction_timestamp() + interval '2 hours', '[)')
WHERE id = '5a000000-0000-7000-8000-000000000021';
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_gate_provider_state
      (task_id, provider_key, status, source_entity_id, source_row_version)
    VALUES ('59000000-0000-7000-8000-000000000002', 'resource.capacity', 'READY',
      '5a000000-0000-7000-8000-000000000013', 1)$$,
  '23514', 'future reservation cannot make a resource provider ready');
UPDATE occ.resource_reservation
SET time_range = tstzrange(transaction_timestamp() - interval '2 hours', transaction_timestamp() - interval '1 hour', '[)')
WHERE id = '5a000000-0000-7000-8000-000000000021';
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_gate_provider_state
      (task_id, provider_key, status, source_entity_id, source_row_version)
    VALUES ('59000000-0000-7000-8000-000000000002', 'resource.capacity', 'READY',
      '5a000000-0000-7000-8000-000000000013', 1)$$,
  '23514', 'expired reservation cannot make a resource provider ready');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_gate_provider_state (task_id, provider_key, status)
    VALUES ('59000000-0000-7000-8000-000000000001', 'evidence.required', 'READY')$$,
  '23514', 'READY gate state requires a source');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_gate_provider_state
      (task_id, provider_key, status, source_entity_id, source_row_version)
    VALUES ('59000000-0000-7000-8000-000000000001', 'evidence.required', 'READY',
      '59000000-0000-7000-8000-000000000001', 2)$$,
  '23514', 'evidence provider rejects a non-evidence source');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_gate_provider_state
      (task_id, provider_key, status, source_entity_id, source_row_version)
    VALUES ('59000000-0000-7000-8000-000000000001', 'resource.capacity', 'READY',
      '5a000000-0000-7000-8000-000000000010', 1)$$,
  '23514', 'resource provider rejects a non-resource source');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_gate_provider_state
      (task_id, provider_key, status, source_entity_id, source_row_version)
    VALUES ('59000000-0000-7000-8000-000000000001', 'evidence.required', 'READY',
      '5a000000-0000-7000-8000-000000000012', 1)$$,
  '23514', 'evidence provider rejects evidence owned by another task');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_gate_provider_state
      (task_id, provider_key, status, source_entity_id, source_row_version)
    VALUES ('59000000-0000-7000-8000-000000000001', 'process.lifecycle', 'READY',
      '58000000-0000-7000-8000-000000000002', 1)$$,
  '23514', 'process provider rejects another process');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_gate_provider_state
      (task_id, provider_key, status, source_entity_id, source_row_version)
    VALUES ('59000000-0000-7000-8000-000000000001', 'resource.capacity', 'READY',
      '5a000000-0000-7000-8000-000000000013', 1)$$,
  '23514', 'resource provider rejects a reservation owned by another task');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_gate_provider_state
      (task_id, provider_key, status, source_entity_id, source_row_version)
    VALUES ('59000000-0000-7000-8000-000000000002', 'unknown.provider', 'READY',
      '58000000-0000-7000-8000-000000000001', 1)$$,
  '23514', 'unknown providers fail closed');
SELECT pg_temp.assert_raises(
  $$UPDATE occ.task_projection SET state = 'COMPLETED', completed_at = transaction_timestamp()
    WHERE id = '59000000-0000-7000-8000-000000000001'$$,
  '55000', 'missing gate provider state fails closed');
INSERT INTO occ.task_gate_provider_state
  (task_id, provider_key, status, source_entity_id, source_row_version)
VALUES
  ('59000000-0000-7000-8000-000000000001', 'evidence.required', 'READY', '5a000000-0000-7000-8000-000000000010', 1),
  ('59000000-0000-7000-8000-000000000001', 'resource.capacity', 'READY', '5a000000-0000-7000-8000-000000000011', 1),
  ('59000000-0000-7000-8000-000000000001', 'process.lifecycle', 'READY', '58000000-0000-7000-8000-000000000001', 1);
UPDATE occ.evidence SET state = 'SUBMITTED'
WHERE id = '5a000000-0000-7000-8000-000000000010';
SELECT pg_temp.assert_true(
  (SELECT status = 'STALE' FROM occ.task_gate_provider_state
   WHERE task_id = '59000000-0000-7000-8000-000000000001' AND provider_key = 'evidence.required'),
  'evidence version advance marks referencing provider stale');
SELECT pg_temp.assert_raises(
  $$UPDATE occ.task_projection SET state = 'COMPLETED', completed_at = transaction_timestamp()
    WHERE id = '59000000-0000-7000-8000-000000000001'$$,
  '55000', 'stale evidence provider prevents completion');
INSERT INTO occ.task_gate_provider_state
  (task_id, provider_key, status, source_entity_id, source_row_version, safe_failure_code, refreshed_at)
VALUES ('59000000-0000-7000-8000-000000000001', 'evidence.required', 'UNAVAILABLE',
  '5a000000-0000-7000-8000-000000000010', 2, 'provider_timeout', transaction_timestamp() + interval '1 second')
ON CONFLICT (task_id, provider_key) DO UPDATE
SET status = EXCLUDED.status, source_entity_id = EXCLUDED.source_entity_id,
    source_row_version = EXCLUDED.source_row_version, safe_failure_code = EXCLUDED.safe_failure_code,
    refreshed_at = EXCLUDED.refreshed_at;
INSERT INTO occ.task_gate_provider_state
  (task_id, provider_key, status, source_entity_id, source_row_version, refreshed_at)
VALUES ('59000000-0000-7000-8000-000000000001', 'evidence.required', 'READY',
  '5a000000-0000-7000-8000-000000000010', 2, transaction_timestamp() + interval '2 seconds')
ON CONFLICT (task_id, provider_key) DO UPDATE
SET status = EXCLUDED.status, source_entity_id = EXCLUDED.source_entity_id,
    source_row_version = EXCLUDED.source_row_version, safe_failure_code = NULL,
    refreshed_at = EXCLUDED.refreshed_at;
UPDATE occ.managed_resource SET data = '{"changed":true}'
WHERE id = '5a000000-0000-7000-8000-000000000011';
SELECT pg_temp.assert_true(
  (SELECT status = 'STALE' FROM occ.task_gate_provider_state
   WHERE task_id = '59000000-0000-7000-8000-000000000001' AND provider_key = 'resource.capacity'),
  'resource version advance marks referencing provider stale');
INSERT INTO occ.task_gate_provider_state
  (task_id, provider_key, status, source_entity_id, source_row_version, refreshed_at)
VALUES ('59000000-0000-7000-8000-000000000001', 'resource.capacity', 'READY',
  '5a000000-0000-7000-8000-000000000011', 2, transaction_timestamp() + interval '2 seconds')
ON CONFLICT (task_id, provider_key) DO UPDATE
SET status = EXCLUDED.status, source_entity_id = EXCLUDED.source_entity_id,
    source_row_version = EXCLUDED.source_row_version, safe_failure_code = NULL,
    refreshed_at = EXCLUDED.refreshed_at;
UPDATE occ.process_instance SET state = 'SUSPENDED'
WHERE id = '58000000-0000-7000-8000-000000000001';
SELECT pg_temp.assert_true(
  (SELECT status = 'STALE' FROM occ.task_gate_provider_state
   WHERE task_id = '59000000-0000-7000-8000-000000000001' AND provider_key = 'process.lifecycle'),
  'process version advance marks referencing provider stale');
UPDATE occ.process_instance SET state = 'RUNNING'
WHERE id = '58000000-0000-7000-8000-000000000001';
INSERT INTO occ.task_gate_provider_state
  (task_id, provider_key, status, source_entity_id, source_row_version, refreshed_at)
VALUES ('59000000-0000-7000-8000-000000000001', 'process.lifecycle', 'READY',
  '58000000-0000-7000-8000-000000000001', 3, transaction_timestamp() + interval '2 seconds')
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
    WHERE task_id = '59000000-0000-7000-8000-000000000001' AND provider_key = 'evidence.required'$$,
  '55000', 'gate requirements cannot be deleted');
SELECT pg_temp.assert_raises(
  $$DELETE FROM occ.task_gate_provider_state
    WHERE task_id = '59000000-0000-7000-8000-000000000001' AND provider_key = 'evidence.required'$$,
  '55000', 'gate provider states cannot be deleted');
SELECT pg_temp.assert_raises(
  $$DELETE FROM occ.task_blocker WHERE id = '59000000-0000-7000-8000-000000000010'$$,
  '55000', 'task blockers cannot be deleted');
UPDATE occ.task_projection SET state = 'COMPLETED', completed_at = transaction_timestamp()
WHERE id = '59000000-0000-7000-8000-000000000001';
UPDATE occ.evidence SET state = 'ACCEPTED'
WHERE id = '5a000000-0000-7000-8000-000000000010';
UPDATE occ.managed_resource SET data = '{"changed":"after-completion"}'
WHERE id = '5a000000-0000-7000-8000-000000000011';
UPDATE occ.process_instance SET state = 'SUSPENDED'
WHERE id = '58000000-0000-7000-8000-000000000001';
SELECT pg_temp.assert_true(
  (SELECT count(*) = 3
      AND bool_and(status = 'READY')
      AND bool_and(source_row_version = CASE provider_key
        WHEN 'evidence.required' THEN 2
        WHEN 'resource.capacity' THEN 2
        WHEN 'process.lifecycle' THEN 3
      END)
   FROM occ.task_gate_provider_state
   WHERE task_id = '59000000-0000-7000-8000-000000000001'),
  'terminal task sources evolve without rewriting provider projections');
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
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_review_projection_fact
      (id, task_id, fact_kind, review_sequence, evidence_id, evidence_version_id, submission_idempotency_id, prior_assignee_id)
    VALUES ('5e000000-0000-7000-8000-000000000030', '59000000-0000-7000-8000-000000000002',
      'SUBMITTED', 1, '5e000000-0000-7000-8000-000000000099', '5e000000-0000-7000-8000-000000000098',
      '5d000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000002')$$,
  '23503', 'review submission requires existing evidence and version');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_review_projection_fact
      (id, task_id, fact_kind, review_sequence, evidence_id, evidence_version_id, submission_idempotency_id, prior_assignee_id)
    VALUES ('5e000000-0000-7000-8000-000000000031', '59000000-0000-7000-8000-000000000002',
      'SUBMITTED', 1, '5a000000-0000-7000-8000-000000000012', '5e000000-0000-7000-8000-000000000010',
      '5d000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000002')$$,
  '23503', 'review evidence version must belong to its evidence');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_review_projection_fact
      (id, task_id, fact_kind, review_sequence, evidence_id, evidence_version_id, submission_idempotency_id, prior_assignee_id)
    VALUES ('5e000000-0000-7000-8000-000000000032', '59000000-0000-7000-8000-000000000002',
      'SUBMITTED', 1, '5a000000-0000-7000-8000-000000000010', '5e000000-0000-7000-8000-000000000010',
      '5d000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000002')$$,
  '23514', 'review evidence must belong to its task');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_review_projection_fact
      (id, task_id, fact_kind, review_sequence, evidence_id, evidence_version_id, submission_idempotency_id, prior_assignee_id)
    VALUES ('5e000000-0000-7000-8000-000000000033', '59000000-0000-7000-8000-000000000002',
      'SUBMITTED', 2, '5a000000-0000-7000-8000-000000000012', '5e000000-0000-7000-8000-000000000011',
      '5d000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000002')$$,
  '23514', 'first review submission sequence must be one');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_review_projection_fact
      (id, task_id, fact_kind, review_sequence, evidence_id, evidence_version_id, submission_idempotency_id, prior_assignee_id)
    VALUES ('5e000000-0000-7000-8000-000000000005', '59000000-0000-7000-8000-000000000002',
      'SUBMITTED', 1, '5e000000-0000-7000-8000-000000000014', '5e000000-0000-7000-8000-000000000015',
      '5d000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000001')$$,
  '23514', 'submitted review projection rejects a false prior assignee');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_review_projection_fact
      (id, task_id, fact_kind, review_sequence, evidence_id, evidence_version_id, submission_idempotency_id, prior_assignee_id)
    VALUES ('5e000000-0000-7000-8000-000000000006', '59000000-0000-7000-8000-000000000001',
      'SUBMITTED', 1, '5e000000-0000-7000-8000-000000000016', '5e000000-0000-7000-8000-000000000017',
      '5d000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000002')$$,
  '23514', 'submitted review projection rejects a completed task');
INSERT INTO occ.task_review_projection_fact
  (id, task_id, fact_kind, review_sequence, evidence_id, evidence_version_id, submission_idempotency_id, prior_assignee_id)
VALUES ('5e000000-0000-7000-8000-000000000001', '59000000-0000-7000-8000-000000000002',
  'SUBMITTED', 1, '5a000000-0000-7000-8000-000000000012', '5e000000-0000-7000-8000-000000000011',
  '5d000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000002');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_review_projection_fact
      (id, task_id, fact_kind, review_sequence, evidence_id, evidence_version_id, submission_idempotency_id, prior_assignee_id)
    VALUES ('5e000000-0000-7000-8000-000000000034', '59000000-0000-7000-8000-000000000002',
      'SUBMITTED', 2, '5a000000-0000-7000-8000-000000000014', '5e000000-0000-7000-8000-000000000013',
      '5d000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000002')$$,
  '23514', 'next review submission requires the prior decision');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_review_projection_fact
      (id, task_id, fact_kind, review_sequence, evidence_id, evidence_version_id, submission_idempotency_id)
    VALUES ('5e000000-0000-7000-8000-000000000004', '59000000-0000-7000-8000-000000000002',
      'SUBMITTED', 2, '5e000000-0000-7000-8000-000000000012', '5e000000-0000-7000-8000-000000000013',
      '5d000000-0000-7000-8000-000000000001')$$,
  '23514', 'submitted review projection requires the prior assignee');
INSERT INTO occ.task_review_projection_fact
  (id, task_id, fact_kind, review_sequence, submission_fact_id, review_id, review_version, decision)
VALUES ('5e000000-0000-7000-8000-000000000002', '59000000-0000-7000-8000-000000000002',
  'DECIDED', 1, '5e000000-0000-7000-8000-000000000001', '5e000000-0000-7000-8000-000000000020', 1, 'ACCEPTED');
INSERT INTO occ.task_review_projection_fact
  (id, task_id, fact_kind, review_sequence, evidence_id, evidence_version_id, submission_idempotency_id, prior_assignee_id)
VALUES ('5e000000-0000-7000-8000-000000000035', '59000000-0000-7000-8000-000000000002',
  'SUBMITTED', 2, '5a000000-0000-7000-8000-000000000014', '5e000000-0000-7000-8000-000000000013',
  '5d000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000002');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.task_review_projection_fact
      (id, task_id, fact_kind, review_sequence, submission_fact_id, review_id, review_version, decision)
    VALUES ('5e000000-0000-7000-8000-000000000003', '59000000-0000-7000-8000-000000000002',
      'DECIDED', 1, '5e000000-0000-7000-8000-000000000001', '5e000000-0000-7000-8000-000000000021', 1, 'REJECTED')$$,
  '23514', 'decision requires the current pending submission');
SELECT pg_temp.assert_raises(
  $$DELETE FROM occ.task_review_projection_fact WHERE id = '5e000000-0000-7000-8000-000000000002'$$,
  '55000', 'review facts are append only');

INSERT INTO occ.notification
  (id, recipient_id, type, severity, resource_type, resource_id, event_id)
VALUES ('5f000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000002',
  'task.completed', 'INFO', 'task', '59000000-0000-7000-8000-000000000001',
  '5b000000-0000-7000-8000-000000000001');
SELECT pg_temp.assert_true(
  (SELECT row_version = 0 FROM occ.notification WHERE id = '5f000000-0000-7000-8000-000000000001'),
  'notification starts at row version zero');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.notification
      (id, recipient_id, type, severity, resource_type, resource_id, event_id, row_version)
    VALUES ('5f000000-0000-7000-8000-000000000002', '56000000-0000-7000-8000-000000000003',
      'task.completed.versioned', 'INFO', 'task', '59000000-0000-7000-8000-000000000001',
      '5b000000-0000-7000-8000-000000000001', 7)$$,
  '55000', 'notification cannot be created with a client-supplied version');
SELECT pg_temp.assert_raises(
  $$UPDATE occ.notification SET severity = 'WARNING'
    WHERE id = '5f000000-0000-7000-8000-000000000001'$$,
  '55000', 'notification content is immutable');
SELECT pg_temp.assert_raises(
  $$UPDATE occ.notification SET read_at = transaction_timestamp(), row_version = 7
    WHERE id = '5f000000-0000-7000-8000-000000000001'$$,
  '55000', 'notification row version is database-managed');
SELECT pg_temp.assert_raises(
  $$INSERT INTO occ.notification
      (id, recipient_id, type, severity, resource_type, resource_id, event_id, read_at)
    VALUES ('5f000000-0000-7000-8000-000000000002', '56000000-0000-7000-8000-000000000003',
      'task.completed', 'INFO', 'task', '59000000-0000-7000-8000-000000000001',
      '5b000000-0000-7000-8000-000000000001', transaction_timestamp())$$,
  '55000', 'notification must be created unread');
UPDATE occ.notification SET read_at = transaction_timestamp()
WHERE id = '5f000000-0000-7000-8000-000000000001';
SELECT pg_temp.assert_true(
  (SELECT row_version = 1 FROM occ.notification WHERE id = '5f000000-0000-7000-8000-000000000001'),
  'notification mark-read increments row version exactly once');
SELECT pg_temp.assert_raises(
  $$UPDATE occ.notification SET read_at = NULL WHERE id = '5f000000-0000-7000-8000-000000000001'$$,
  '55000', 'notification read state is one way');
SELECT pg_temp.assert_raises(
  $$UPDATE occ.notification SET read_at = read_at
    WHERE id = '5f000000-0000-7000-8000-000000000001'$$,
  '55000', 'read notification rejects no-op updates');

UPDATE occ.process_instance SET state = 'COMPLETED', ended_at = transaction_timestamp()
WHERE id = '58000000-0000-7000-8000-000000000002';
INSERT INTO occ.cohort
  (id, customer_instance_id, code, name, package_version_id, owner_principal_id, start_date, status, created_by, updated_by)
VALUES ('57000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001',
  'archive-guard', 'Archive guard', '51000000-0000-7000-8000-000000000001',
  '56000000-0000-7000-8000-000000000001', current_date, 'DRAFT',
  '56000000-0000-7000-8000-000000000001', '56000000-0000-7000-8000-000000000001');
UPDATE occ.cohort SET status = 'ACTIVE'
WHERE id = '57000000-0000-7000-8000-000000000002';
UPDATE occ.cohort SET status = 'ARCHIVED', archived_at = transaction_timestamp()
WHERE id = '57000000-0000-7000-8000-000000000002';
SELECT pg_temp.assert_raises(
  $$UPDATE occ.cohort SET name = name
    WHERE id = '57000000-0000-7000-8000-000000000002'$$,
  '55000', 'archived cohort rejects no-op updates before touch triggers run');
INSERT INTO occ.task_projection
  (id, process_instance_id, activity_key, activity_name, flowable_task_id, flowable_execution_id, state)
VALUES ('59000000-0000-7000-8000-000000000003', '58000000-0000-7000-8000-000000000002',
  'delete-guard', 'Delete guard', 'flowable-delete-guard', 'execution-delete-guard', 'AVAILABLE');
UPDATE occ.task_projection SET state = 'CANCELLED', cancelled_at = transaction_timestamp()
WHERE id = '59000000-0000-7000-8000-000000000003';
SELECT pg_temp.assert_raises(
  $$DELETE FROM occ.cohort WHERE id = '57000000-0000-7000-8000-000000000002'$$,
  '55000', 'archived cohort cannot be physically deleted');
SELECT pg_temp.assert_raises(
  $$DELETE FROM occ.process_instance WHERE id = '58000000-0000-7000-8000-000000000002'$$,
  '55000', 'terminal process cannot be physically deleted');
SELECT pg_temp.assert_raises(
  $$DELETE FROM occ.task_projection WHERE id = '59000000-0000-7000-8000-000000000003'$$,
  '55000', 'terminal task cannot be physically deleted');
SELECT pg_temp.assert_raises(
  $$DELETE FROM occ.notification WHERE id = '5f000000-0000-7000-8000-000000000001'$$,
  '55000', 'notification history cannot be physically deleted');
SELECT pg_temp.assert_raises(
  $$TRUNCATE authz.relationship$$,
  '55000', 'relationship and owner history cannot be truncated');

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
  has_table_privilege('innorder_runtime', 'occ.cohort', 'SELECT,INSERT,UPDATE')
  AND NOT has_table_privilege('innorder_runtime', 'occ.cohort', 'DELETE')
  AND has_table_privilege('innorder_runtime', 'occ.process_instance', 'SELECT,INSERT,UPDATE')
  AND NOT has_table_privilege('innorder_runtime', 'occ.process_instance', 'DELETE')
  AND has_table_privilege('innorder_runtime', 'occ.task_projection', 'SELECT,INSERT,UPDATE')
  AND NOT has_table_privilege('innorder_runtime', 'occ.task_projection', 'DELETE')
  AND has_table_privilege('innorder_runtime', 'occ.task_gate_requirement', 'SELECT,INSERT')
  AND NOT has_table_privilege('innorder_runtime', 'occ.task_gate_requirement', 'UPDATE,DELETE')
  AND has_table_privilege('innorder_runtime', 'occ.task_gate_provider_state', 'SELECT,INSERT,UPDATE')
  AND NOT has_table_privilege('innorder_runtime', 'occ.task_gate_provider_state', 'DELETE')
  AND has_table_privilege('innorder_runtime', 'occ.task_blocker', 'SELECT,INSERT,UPDATE')
  AND NOT has_table_privilege('innorder_runtime', 'occ.task_blocker', 'DELETE')
  AND NOT has_table_privilege('innorder_runtime', 'authz.relationship', 'TRUNCATE')
  AND has_table_privilege('innorder_runtime', 'audit.dependency_failure_attempt', 'SELECT,INSERT')
  AND NOT has_table_privilege('innorder_runtime', 'audit.dependency_failure_attempt', 'UPDATE,DELETE'),
  'runtime has bounded workflow DML');
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'occ' AND indexname = 'ix_task_projection_assignee_state')
  AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'occ' AND indexname = 'ix_notification_recipient_cursor'),
  'workflow query indexes exist');

ROLLBACK;
