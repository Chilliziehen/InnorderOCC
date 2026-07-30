\set ON_ERROR_STOP on

BEGIN;

INSERT INTO catalog.domain_package (
    id, package_key, name, status, row_version, created_at, updated_at
) VALUES (
    '10000000-0000-7000-8000-000000000001', 'test.package', 'Test package', 'ACTIVE', 0, now(), now()
);

SELECT pg_temp.assert_raises(
    $$INSERT INTO catalog.domain_package
      (id, package_key, name, status, row_version, created_at, updated_at)
      VALUES ('10000000-0000-7000-8000-000000000002', 'test.package', 'Duplicate', 'ACTIVE', 0, now(), now())$$,
    '23505', 'package_key is unique'
);

INSERT INTO catalog.package_version (
    id, package_id, semver, status, manifest, created_at
) VALUES (
    '11000000-0000-7000-8000-000000000001',
    '10000000-0000-7000-8000-000000000001',
    '1.0.0', 'DRAFT', '{}'::jsonb, now()
);

INSERT INTO catalog.entity_type (id, package_id, type_key, name, entity_kind, authorizable)
VALUES
    ('12000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000001', 'user', 'User', 'PRINCIPAL', true),
    ('12000000-0000-7000-8000-000000000002', '10000000-0000-7000-8000-000000000001', 'work_item', 'Work item', 'RESOURCE', true),
    ('12000000-0000-7000-8000-000000000003', '10000000-0000-7000-8000-000000000001', 'node', 'Node', 'RESOURCE', true);

INSERT INTO catalog.entity_type_version (
    id, entity_type_id, package_version_id, schema_version, json_schema, ui_schema, auth_schema, index_spec
) VALUES
    ('13000000-0000-7000-8000-000000000001', '12000000-0000-7000-8000-000000000001', '11000000-0000-7000-8000-000000000001', 1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb),
    ('13000000-0000-7000-8000-000000000002', '12000000-0000-7000-8000-000000000002', '11000000-0000-7000-8000-000000000001', 1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb),
    ('13000000-0000-7000-8000-000000000004', '12000000-0000-7000-8000-000000000003', '11000000-0000-7000-8000-000000000001', 1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);

INSERT INTO catalog.relation_definition (
    id, package_version_id, relation_key, subject_type_id, object_type_id,
    cardinality, transitive, acyclic, auth_relevant, max_subjects, max_objects
) VALUES
    ('14000000-0000-7000-8000-000000000001', '11000000-0000-7000-8000-000000000001',
     'owner_of', '12000000-0000-7000-8000-000000000001', '12000000-0000-7000-8000-000000000002',
     'ONE_TO_ONE', false, true, true, NULL, NULL),
    ('14000000-0000-7000-8000-000000000002', '11000000-0000-7000-8000-000000000001',
     'viewer_of', '12000000-0000-7000-8000-000000000001', '12000000-0000-7000-8000-000000000002',
     'MANY_TO_MANY', false, false, false, NULL, NULL),
    ('14000000-0000-7000-8000-000000000003', '11000000-0000-7000-8000-000000000001',
     'parent_of', '12000000-0000-7000-8000-000000000003', '12000000-0000-7000-8000-000000000003',
     'MANY_TO_MANY', false, true, true, 1, 1);

UPDATE catalog.package_version
SET status = 'PUBLISHED', content_hash = repeat('a', 64), published_at = now()
WHERE id = '11000000-0000-7000-8000-000000000001';

INSERT INTO catalog.domain_package (
    id, package_key, name, status, row_version, created_at, updated_at
) VALUES (
    '10000000-0000-7000-8000-000000000003', 'other.package', 'Other package', 'ACTIVE', 0, now(), now()
);
INSERT INTO catalog.package_version (id, package_id, semver, status, manifest, created_at)
VALUES (
    '11000000-0000-7000-8000-000000000003',
    '10000000-0000-7000-8000-000000000003',
    '1.0.0', 'DRAFT', '{}'::jsonb, now()
);

SELECT pg_temp.assert_raises(
    $$INSERT INTO catalog.entity_type_version
      (id, entity_type_id, package_version_id, schema_version, json_schema, ui_schema, auth_schema, index_spec)
      VALUES ('13000000-0000-7000-8000-000000000003',
              '12000000-0000-7000-8000-000000000001',
              '11000000-0000-7000-8000-000000000003',
              2, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)$$,
    '23514', 'entity types and versions must belong to the same package'
);

SELECT pg_temp.assert_raises(
    $$UPDATE catalog.package_version SET manifest = '{"changed":true}'::jsonb
      WHERE id = '11000000-0000-7000-8000-000000000001'$$,
    '55000', 'published package versions are immutable'
);

SELECT pg_temp.assert_raises(
    $$UPDATE catalog.entity_type_version SET json_schema = '{"changed":true}'::jsonb
      WHERE id = '13000000-0000-7000-8000-000000000001'$$,
    '55000', 'definitions in published package versions are immutable'
);

INSERT INTO authz.entity (
    id, entity_type_id, entity_type_version_id, entity_key, state,
    auth_attributes, row_version, created_at, updated_at
) VALUES
    ('20000000-0000-7000-8000-000000000001', '12000000-0000-7000-8000-000000000001', '13000000-0000-7000-8000-000000000001', 'user:one', 'ACTIVE', '{}'::jsonb, 0, now(), now()),
    ('20000000-0000-7000-8000-000000000002', '12000000-0000-7000-8000-000000000002', '13000000-0000-7000-8000-000000000002', 'work:one', 'ACTIVE', '{}'::jsonb, 0, now(), now()),
    ('20000000-0000-7000-8000-000000000003', '12000000-0000-7000-8000-000000000002', '13000000-0000-7000-8000-000000000002', 'work:two', 'ACTIVE', '{}'::jsonb, 0, now(), now()),
    ('20000000-0000-7000-8000-000000000004', '12000000-0000-7000-8000-000000000001', '13000000-0000-7000-8000-000000000001', 'user:two', 'ACTIVE', '{}'::jsonb, 0, now(), now()),
    ('20000000-0000-7000-8000-000000000005', '12000000-0000-7000-8000-000000000003', '13000000-0000-7000-8000-000000000004', 'node:a', 'ACTIVE', '{}'::jsonb, 0, now(), now()),
    ('20000000-0000-7000-8000-000000000006', '12000000-0000-7000-8000-000000000003', '13000000-0000-7000-8000-000000000004', 'node:b', 'ACTIVE', '{}'::jsonb, 0, now(), now()),
    ('20000000-0000-7000-8000-000000000007', '12000000-0000-7000-8000-000000000003', '13000000-0000-7000-8000-000000000004', 'node:c', 'ACTIVE', '{}'::jsonb, 0, now(), now());

INSERT INTO iam.principal (
    id, principal_kind, display_name, status, profile, row_version, created_at, updated_at
) VALUES
    ('20000000-0000-7000-8000-000000000001', 'USER', 'User One', 'ACTIVE', '{}'::jsonb, 0, now(), now()),
    ('20000000-0000-7000-8000-000000000004', 'USER', 'User Two', 'ACTIVE', '{}'::jsonb, 0, now(), now());

SELECT pg_temp.assert_raises(
    $$DELETE FROM platform.customer_instance$$,
    '55000', 'customer instance cannot be deleted'
);
SELECT pg_temp.assert_raises(
    $$TRUNCATE platform.customer_instance CASCADE$$,
    '55000', 'customer instance cannot be truncated'
);
SELECT pg_temp.assert_raises(
    $$UPDATE platform.customer_instance SET id = '00000000-0000-7000-8000-000000000002'$$,
    '55000', 'customer instance id is immutable'
);
SELECT pg_temp.assert_raises(
    $$UPDATE platform.customer_instance SET instance_key = 'renamed'$$,
    '55000', 'customer instance key is immutable'
);
SELECT pg_temp.assert_raises(
    $$INSERT INTO platform.customer_instance (id, instance_key)
      VALUES ('00000000-0000-7000-8000-000000000002', 'second')$$,
    '23505', 'customer instance is a singleton'
);

INSERT INTO iam.auth_session (
    id, principal_id, token_version, refresh_token_hash, client_fingerprint,
    created_at, last_used_at, expires_at
) VALUES (
    '22000000-0000-7000-8000-000000000001',
    '20000000-0000-7000-8000-000000000001', 0, repeat('a', 64), 'desktop:test',
    statement_timestamp(), statement_timestamp(), statement_timestamp() + interval '1 hour'
);
SELECT pg_temp.assert_raises(
    $$INSERT INTO iam.auth_session
      (id, principal_id, refresh_token_hash, created_at, expires_at)
      VALUES ('22000000-0000-7000-8000-000000000002',
              '20000000-0000-7000-8000-000000000001', 'plaintext-token',
              statement_timestamp(), statement_timestamp() + interval '1 hour')$$,
    '23514', 'auth sessions store only lowercase SHA-256 token hashes'
);
SELECT pg_temp.assert_raises(
    $$UPDATE iam.auth_session
      SET replaced_by_session_id = '22000000-0000-7000-8000-000000000001'
      WHERE id = '22000000-0000-7000-8000-000000000001'$$,
    '23514', 'auth session cannot replace itself'
);
SELECT pg_temp.assert_raises(
    $$UPDATE iam.auth_session SET revoked_at = created_at - interval '1 second'
      WHERE id = '22000000-0000-7000-8000-000000000001'$$,
    '23514', 'auth session revocation cannot predate creation'
);
INSERT INTO iam.auth_session (
    id, principal_id, refresh_token_hash, created_at, last_used_at, expires_at
)
SELECT '22000000-0000-7000-8000-000000000003', principal_id, repeat('c', 64),
       created_at + interval '1 second', created_at + interval '1 second', expires_at + interval '1 second'
FROM iam.auth_session WHERE id = '22000000-0000-7000-8000-000000000001';
INSERT INTO iam.auth_session (
    id, principal_id, refresh_token_hash, created_at, last_used_at, expires_at
)
SELECT '22000000-0000-7000-8000-000000000004',
       '20000000-0000-7000-8000-000000000004', repeat('d', 64),
       created_at + interval '1 second', created_at + interval '1 second', expires_at + interval '1 second'
FROM iam.auth_session WHERE id = '22000000-0000-7000-8000-000000000001';
INSERT INTO iam.auth_session (
    id, principal_id, refresh_token_hash, created_at, last_used_at, expires_at
)
SELECT '22000000-0000-7000-8000-000000000005', principal_id, repeat('e', 64),
       created_at - interval '1 second', created_at - interval '1 second', expires_at
FROM iam.auth_session WHERE id = '22000000-0000-7000-8000-000000000001';
SELECT pg_temp.assert_raises(
    $$UPDATE iam.auth_session
      SET revoked_at = created_at + interval '500 milliseconds',
          replaced_by_session_id = '22000000-0000-7000-8000-000000000004'
      WHERE id = '22000000-0000-7000-8000-000000000001'$$,
    '23514', 'replacement session must have the same principal'
);
SELECT pg_temp.assert_raises(
    $$UPDATE iam.auth_session
      SET revoked_at = created_at + interval '500 milliseconds',
          replaced_by_session_id = '22000000-0000-7000-8000-000000000005'
      WHERE id = '22000000-0000-7000-8000-000000000001'$$,
    '23514', 'replacement session cannot predate old session'
);
SELECT pg_temp.assert_raises(
    $$UPDATE iam.auth_session
      SET last_used_at = created_at + interval '2 seconds',
          revoked_at = created_at + interval '1 second'
      WHERE id = '22000000-0000-7000-8000-000000000001'$$,
    '23514', 'session last use cannot follow revocation'
);
UPDATE iam.auth_session
SET revoked_at = created_at + interval '500 milliseconds',
    replaced_by_session_id = '22000000-0000-7000-8000-000000000003'
WHERE id = '22000000-0000-7000-8000-000000000001';
SELECT pg_temp.assert_true(
    (SELECT replaced_by_session_id = '22000000-0000-7000-8000-000000000003'
       FROM iam.auth_session WHERE id = '22000000-0000-7000-8000-000000000001'),
    'valid same-principal forward rotation is retained'
);
SELECT pg_temp.assert_raises(
    $$UPDATE iam.auth_session
      SET replaced_by_session_id = '22000000-0000-7000-8000-000000000005'
      WHERE id = '22000000-0000-7000-8000-000000000005'$$,
    '23514', 'rotation target requires revocation'
);
INSERT INTO iam.auth_session (
    id, principal_id, refresh_token_hash, created_at, last_used_at, expires_at
)
SELECT '22000000-0000-7000-8000-000000000006', principal_id, repeat('6', 64),
       created_at, created_at, expires_at
FROM iam.auth_session WHERE id = '22000000-0000-7000-8000-000000000003';
INSERT INTO iam.auth_session (
    id, principal_id, refresh_token_hash, created_at, last_used_at, expires_at
)
SELECT '22000000-0000-7000-8000-000000000007', principal_id, repeat('7', 64),
       created_at, created_at, expires_at
FROM iam.auth_session WHERE id = '22000000-0000-7000-8000-000000000003';
UPDATE iam.auth_session
SET revoked_at = created_at, replaced_by_session_id = '22000000-0000-7000-8000-000000000007'
WHERE id = '22000000-0000-7000-8000-000000000006';
SELECT pg_temp.assert_raises(
    $$UPDATE iam.auth_session
      SET revoked_at = created_at, replaced_by_session_id = '22000000-0000-7000-8000-000000000006'
      WHERE id = '22000000-0000-7000-8000-000000000007'$$,
    '23514', 'rotation chains cannot cycle'
);

INSERT INTO audit.idempotency_record (
    id, principal_id, command_key, idempotency_key, request_hash,
    state, created_at, updated_at, expires_at
) VALUES (
    '23000000-0000-7000-8000-000000000001',
    '20000000-0000-7000-8000-000000000001', 'test.command', 'idem-1', repeat('b', 64),
    'IN_PROGRESS', statement_timestamp(), statement_timestamp(), statement_timestamp() + interval '1 hour'
);
SELECT pg_temp.assert_raises(
    $$UPDATE audit.idempotency_record SET request_hash = repeat('c', 64)
      WHERE id = '23000000-0000-7000-8000-000000000001'$$,
    '55000', 'idempotency request hash is immutable'
);
SELECT pg_temp.assert_raises(
    $$UPDATE audit.idempotency_record SET state = 'COMPLETED'
      WHERE id = '23000000-0000-7000-8000-000000000001'$$,
    '23514', 'completed idempotency records require status and digest'
);
UPDATE audit.idempotency_record
SET state = 'COMPLETED', response_status = 200, response_digest = repeat('d', 64),
    response_body = '{"ok":true}'::jsonb
WHERE id = '23000000-0000-7000-8000-000000000001';
SELECT pg_temp.assert_true(
    (SELECT updated_at > created_at FROM audit.idempotency_record
      WHERE id = '23000000-0000-7000-8000-000000000001'),
    'idempotency terminal transition advances updated_at'
);
SELECT pg_temp.assert_raises(
    $$UPDATE audit.idempotency_record SET state = 'IN_PROGRESS', response_status = NULL,
          response_digest = NULL, response_body = NULL
      WHERE id = '23000000-0000-7000-8000-000000000001'$$,
    '55000', 'terminal idempotency records cannot return to in progress'
);
SELECT pg_temp.assert_raises(
    $$UPDATE audit.idempotency_record SET response_status = 201
      WHERE id = '23000000-0000-7000-8000-000000000001'$$,
    '55000', 'terminal idempotency payload is immutable'
);
UPDATE audit.idempotency_record SET state = state
WHERE id = '23000000-0000-7000-8000-000000000001';
SELECT pg_temp.assert_true(
    (SELECT state = 'COMPLETED' FROM audit.idempotency_record
      WHERE id = '23000000-0000-7000-8000-000000000001'),
    'harmless terminal no-op updates remain allowed'
);
SELECT pg_temp.assert_raises(
    $$INSERT INTO audit.idempotency_record
      (id, principal_id, command_key, idempotency_key, request_hash, state,
       response_status, response_digest, response_body, created_at, updated_at, expires_at)
      VALUES ('23000000-0000-7000-8000-000000000002',
              '20000000-0000-7000-8000-000000000001', 'test.command', 'idem-large', repeat('e', 64),
              'COMPLETED', 200, repeat('f', 64), jsonb_build_object('data', repeat('x', 65536)),
              statement_timestamp(), statement_timestamp(), statement_timestamp() + interval '1 hour')$$,
    '23514', 'idempotency response bodies are bounded to 64 KiB'
);
SELECT pg_temp.assert_raises(
    $$INSERT INTO audit.idempotency_record
      (id, principal_id, command_key, idempotency_key, request_hash, state,
       created_at, updated_at, expires_at)
      VALUES ('23000000-0000-7000-8000-000000000003',
              '20000000-0000-7000-8000-000000000001', 'test.command', 'idem-failed-invalid', repeat('1', 64),
              'FAILED', statement_timestamp(), statement_timestamp(), statement_timestamp() + interval '1 hour')$$,
    '23514', 'failed idempotency records require a response status'
);
INSERT INTO audit.idempotency_record
  (id, principal_id, command_key, idempotency_key, request_hash, state,
   response_status, response_body, created_at, updated_at, expires_at)
VALUES ('23000000-0000-7000-8000-000000000004',
        '20000000-0000-7000-8000-000000000001', 'test.command', 'idem-failed', repeat('2', 64),
        'FAILED', 500, '{"error":"failed"}'::jsonb,
        statement_timestamp(), statement_timestamp(), statement_timestamp() + interval '1 hour');
SELECT pg_temp.assert_raises(
    $$UPDATE audit.idempotency_record
      SET state = 'COMPLETED', response_digest = repeat('3', 64)
      WHERE id = '23000000-0000-7000-8000-000000000004'$$,
    '55000', 'failed idempotency records are terminal'
);

INSERT INTO audit.outbox_event (
    id, aggregate_type, aggregate_id, aggregate_version, event_type, schema_version,
    payload, correlation_id, customer_instance_id, actor_entity_id, causation_id,
    available_at, next_attempt_at, status, created_at
) VALUES (
    '24000000-0000-7000-8000-000000000001', 'work_item',
    '20000000-0000-7000-8000-000000000002', 1, 'work.created', 1,
    '{}'::jsonb, '24000000-0000-7000-8000-000000000010',
    '00000000-0000-7000-8000-000000000001', '20000000-0000-7000-8000-000000000001',
    '24000000-0000-7000-8000-000000000011',
    statement_timestamp(), statement_timestamp(), 'PENDING', statement_timestamp()
);
SELECT pg_temp.assert_true(
    (SELECT causation_id = '24000000-0000-7000-8000-000000000011'
       FROM audit.outbox_event WHERE id = '24000000-0000-7000-8000-000000000001'),
    'outbox causation metadata is retained'
);
SELECT pg_temp.assert_raises(
    $$UPDATE audit.outbox_event SET customer_instance_id = '00000000-0000-7000-8000-000000000099'
      WHERE id = '24000000-0000-7000-8000-000000000001'$$,
    '23503', 'outbox customer instance foreign key is enforced'
);
SELECT pg_temp.assert_raises(
    $$UPDATE audit.outbox_event SET actor_entity_id = '20000000-0000-7000-8000-000000000099'
      WHERE id = '24000000-0000-7000-8000-000000000001'$$,
    '23503', 'outbox actor foreign key is enforced'
);
SELECT pg_temp.assert_raises(
    $$UPDATE audit.outbox_event SET next_attempt_at = available_at - interval '1 second'
      WHERE id = '24000000-0000-7000-8000-000000000001'$$,
    '23514', 'outbox retry cannot precede availability'
);
SELECT pg_temp.assert_raises(
    $$UPDATE audit.outbox_event SET claimed_at = statement_timestamp()
      WHERE id = '24000000-0000-7000-8000-000000000001'$$,
    '23514', 'pending outbox events cannot be claimed'
);
SELECT pg_temp.assert_raises(
    $$UPDATE audit.outbox_event SET status = 'PUBLISHING'
      WHERE id = '24000000-0000-7000-8000-000000000001'$$,
    '23514', 'publishing outbox events require a claim timestamp'
);
SELECT pg_temp.assert_raises(
    $$UPDATE audit.outbox_event SET status = 'DEAD', last_error = E'unsafe\nerror'
      WHERE id = '24000000-0000-7000-8000-000000000001'$$,
    '23514', 'outbox errors reject control characters'
);
SELECT pg_temp.assert_raises(
    $$UPDATE audit.outbox_event SET status = 'DEAD', last_error = repeat('x', 2049)
      WHERE id = '24000000-0000-7000-8000-000000000001'$$,
    '23514', 'outbox errors are bounded'
);
SELECT pg_temp.assert_raises(
    $$UPDATE audit.outbox_event
      SET status = 'PUBLISHING', claimed_at = created_at - interval '1 second'
      WHERE id = '24000000-0000-7000-8000-000000000001'$$,
    '23514', 'outbox claims cannot predate event creation'
);
UPDATE audit.outbox_event
SET status = 'PUBLISHING', claimed_at = statement_timestamp()
WHERE id = '24000000-0000-7000-8000-000000000001';
SELECT pg_temp.assert_raises(
    $$UPDATE audit.outbox_event SET published_at = claimed_at - interval '1 second'
      WHERE id = '24000000-0000-7000-8000-000000000001'$$,
    '23514', 'outbox publication cannot predate claim'
);
UPDATE audit.outbox_event
SET status = 'PUBLISHED', published_at = statement_timestamp()
WHERE id = '24000000-0000-7000-8000-000000000001';
SELECT pg_temp.assert_raises(
    $$UPDATE audit.outbox_event
      SET status = 'PENDING', claimed_at = NULL, published_at = NULL
      WHERE id = '24000000-0000-7000-8000-000000000001'$$,
    '55000', 'published outbox events are terminal'
);
INSERT INTO audit.outbox_event (
    id, aggregate_type, aggregate_id, aggregate_version, event_type, schema_version,
    payload, correlation_id, customer_instance_id, available_at, next_attempt_at,
    status, last_error, created_at
) VALUES (
    '24000000-0000-7000-8000-000000000002', 'work_item',
    '20000000-0000-7000-8000-000000000002', 2, 'work.failed', 1,
    '{}'::jsonb, '24000000-0000-7000-8000-000000000012',
    '00000000-0000-7000-8000-000000000001', statement_timestamp(), statement_timestamp(),
    'DEAD', 'permanent failure', statement_timestamp()
);
SELECT pg_temp.assert_raises(
    $$UPDATE audit.outbox_event SET status = 'PENDING', last_error = NULL
      WHERE id = '24000000-0000-7000-8000-000000000002'$$,
    '55000', 'dead outbox events are terminal'
);

SELECT pg_temp.assert_raises(
    $$INSERT INTO iam.principal
      (id, principal_kind, display_name, status, profile, row_version, created_at, updated_at)
      VALUES ('20000000-0000-7000-8000-000000000002', 'USER', 'Invalid Resource User',
              'ACTIVE', '{}'::jsonb, 0, now(), now())$$,
    '23514', 'only PRINCIPAL entity types can become principals'
);

SELECT pg_temp.assert_raises(
    $$UPDATE authz.entity SET entity_key = 'user:renamed'
      WHERE id = '20000000-0000-7000-8000-000000000001'$$,
    '55000', 'entity stable identity is immutable'
);

SELECT pg_temp.assert_true(
    (SELECT current_revision = 0 FROM authz.authorization_state WHERE singleton),
    'authorization revision starts at zero'
);

CREATE TEMP TABLE revision_checkpoint (value bigint NOT NULL);
INSERT INTO revision_checkpoint
SELECT current_revision FROM authz.authorization_state WHERE singleton;

UPDATE iam.principal SET display_name = 'User One Renamed', profile = '{"locale":"en"}'::jsonb
WHERE id = '20000000-0000-7000-8000-000000000001';
SELECT pg_temp.assert_true(
    (SELECT current_revision = value FROM authz.authorization_state, revision_checkpoint WHERE singleton),
    'principal profile-only changes do not increment authorization revision'
);
UPDATE iam.principal SET status = 'LOCKED'
WHERE id IN (
    '20000000-0000-7000-8000-000000000001',
    '20000000-0000-7000-8000-000000000004'
);
SELECT pg_temp.assert_true(
    (SELECT current_revision = value + 1 FROM authz.authorization_state, revision_checkpoint WHERE singleton),
    'multi-row principal status change increments authorization revision exactly once'
);
UPDATE iam.principal SET status = status
WHERE id IN (
    '20000000-0000-7000-8000-000000000001',
    '20000000-0000-7000-8000-000000000004'
);
SELECT pg_temp.assert_true(
    (SELECT current_revision = value + 1 FROM authz.authorization_state, revision_checkpoint WHERE singleton),
    'principal status no-op statement does not increment authorization revision'
);
UPDATE revision_checkpoint SET value = value + 1;

INSERT INTO authz.relationship (
    id, relation_definition_id, subject_entity_id, object_entity_id,
    source_kind, source_ref, row_version, created_at, updated_at
) VALUES (
    '21000000-0000-7000-8000-000000000001',
    '14000000-0000-7000-8000-000000000001',
    '20000000-0000-7000-8000-000000000001',
    '20000000-0000-7000-8000-000000000002',
    'ADMIN', 'test', 0, now(), now()
);

SELECT pg_temp.assert_true(
    (SELECT current_revision = value + 1 FROM authz.authorization_state, revision_checkpoint WHERE singleton),
    'relationship insert increments authorization revision'
);

SELECT pg_temp.assert_raises(
    $$INSERT INTO authz.relationship
      (id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref, row_version, created_at, updated_at)
      VALUES ('21000000-0000-7000-8000-000000000002', '14000000-0000-7000-8000-000000000001',
              '20000000-0000-7000-8000-000000000002', '20000000-0000-7000-8000-000000000003',
              'ADMIN', 'test', 0, now(), now())$$,
    '23514', 'relationship endpoint types are enforced'
);

SELECT pg_temp.assert_raises(
    $$INSERT INTO authz.relationship
      (id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref, row_version, created_at, updated_at)
      VALUES ('21000000-0000-7000-8000-000000000003', '14000000-0000-7000-8000-000000000001',
              '20000000-0000-7000-8000-000000000001', '20000000-0000-7000-8000-000000000003',
              'ADMIN', 'test', 0, now(), now())$$,
    '23514', 'ONE_TO_ONE cardinality is enforced'
);

SELECT pg_temp.assert_raises(
    $$UPDATE authz.relationship SET attributes = '{"changed":true}'::jsonb
      WHERE id = '21000000-0000-7000-8000-000000000001'$$,
    '55000', 'relationship facts cannot be rewritten'
);

UPDATE authz.relationship
SET revoked_at = statement_timestamp(), revoked_by = '20000000-0000-7000-8000-000000000001'
WHERE id = '21000000-0000-7000-8000-000000000001';

SELECT pg_temp.assert_true(
    (SELECT current_revision = value + 2 FROM authz.authorization_state, revision_checkpoint WHERE singleton),
    'active relationship insert and revocation each increment authorization revision exactly once'
);

INSERT INTO authz.relationship (
    id, relation_definition_id, subject_entity_id, object_entity_id,
    valid_from, valid_until, source_kind, source_ref, row_version, created_at, updated_at
) VALUES (
    '21000000-0000-7000-8000-000000000004',
    '14000000-0000-7000-8000-000000000001',
    '20000000-0000-7000-8000-000000000001',
    '20000000-0000-7000-8000-000000000002',
    statement_timestamp() - interval '2 hours', statement_timestamp() - interval '1 hour',
    'ADMIN', 'expired', 0, statement_timestamp(), statement_timestamp()
);
SELECT pg_temp.assert_true(
    (SELECT current_revision = value + 2 FROM authz.authorization_state, revision_checkpoint WHERE singleton),
    'expired relationship inserts do not increment authorization revision'
);
UPDATE authz.relationship
SET revoked_at = statement_timestamp(), revoked_by = '20000000-0000-7000-8000-000000000001'
WHERE id = '21000000-0000-7000-8000-000000000004';
SELECT pg_temp.assert_true(
    (SELECT current_revision = value + 2 FROM authz.authorization_state, revision_checkpoint WHERE singleton),
    'expired relationship revocations do not increment authorization revision'
);

INSERT INTO authz.relationship (
    id, relation_definition_id, subject_entity_id, object_entity_id,
    valid_until, source_kind, source_ref, row_version, created_at, updated_at
) VALUES (
    '21000000-0000-7000-8000-000000000005',
    '14000000-0000-7000-8000-000000000001',
    '20000000-0000-7000-8000-000000000001',
    '20000000-0000-7000-8000-000000000002',
    statement_timestamp() + interval '1 hour',
    'ADMIN', 'replacement', 0, statement_timestamp(), statement_timestamp()
);
SELECT pg_temp.assert_true(
    (SELECT current_revision = value + 3 FROM authz.authorization_state, revision_checkpoint WHERE singleton),
    'expired relationships permit active replacement and active insert bumps once'
);

INSERT INTO authz.relationship (
    id, relation_definition_id, subject_entity_id, object_entity_id,
    source_kind, source_ref, row_version, created_at, updated_at
) VALUES
    ('21000000-0000-7000-8000-000000000006', '14000000-0000-7000-8000-000000000002',
     '20000000-0000-7000-8000-000000000001', '20000000-0000-7000-8000-000000000002',
     'ADMIN', 'non-auth-one', 0, statement_timestamp(), statement_timestamp()),
    ('21000000-0000-7000-8000-000000000007', '14000000-0000-7000-8000-000000000002',
     '20000000-0000-7000-8000-000000000001', '20000000-0000-7000-8000-000000000003',
     'ADMIN', 'non-auth-two', 0, statement_timestamp(), statement_timestamp());
SELECT pg_temp.assert_true(
    (SELECT current_revision = value + 3 FROM authz.authorization_state, revision_checkpoint WHERE singleton),
    'non-authorization relationship inserts do not bump revision'
);
UPDATE authz.relationship
SET revoked_at = statement_timestamp(), revoked_by = '20000000-0000-7000-8000-000000000001'
WHERE id IN ('21000000-0000-7000-8000-000000000006', '21000000-0000-7000-8000-000000000007');
SELECT pg_temp.assert_true(
    (SELECT current_revision = value + 3 FROM authz.authorization_state, revision_checkpoint WHERE singleton),
    'non-authorization relationship revocations do not bump revision'
);

INSERT INTO authz.relationship (
    id, relation_definition_id, subject_entity_id, object_entity_id,
    source_kind, source_ref, row_version, created_at, updated_at
) VALUES
    ('21000000-0000-7000-8000-000000000010', '14000000-0000-7000-8000-000000000003',
     '20000000-0000-7000-8000-000000000005', '20000000-0000-7000-8000-000000000006',
     'ADMIN', 'active-a-b', 0, statement_timestamp(), statement_timestamp()),
    ('21000000-0000-7000-8000-000000000011', '14000000-0000-7000-8000-000000000003',
     '20000000-0000-7000-8000-000000000006', '20000000-0000-7000-8000-000000000007',
     'ADMIN', 'active-b-c', 0, statement_timestamp(), statement_timestamp());
SELECT pg_temp.assert_true(
    (SELECT current_revision = value + 4 FROM authz.authorization_state, revision_checkpoint WHERE singleton),
    'multi-row active authorization insert bumps revision exactly once'
);
UPDATE authz.relationship
SET revoked_at = statement_timestamp(), revoked_by = '20000000-0000-7000-8000-000000000001'
WHERE id IN ('21000000-0000-7000-8000-000000000010', '21000000-0000-7000-8000-000000000011');
SELECT pg_temp.assert_true(
    (SELECT current_revision = value + 5 FROM authz.authorization_state, revision_checkpoint WHERE singleton),
    'multi-row active authorization revocation bumps revision exactly once'
);

INSERT INTO authz.relationship (
    id, relation_definition_id, subject_entity_id, object_entity_id,
    valid_from, valid_until, source_kind, source_ref, row_version, created_at, updated_at
) VALUES
    ('21000000-0000-7000-8000-000000000020', '14000000-0000-7000-8000-000000000003',
     '20000000-0000-7000-8000-000000000005', '20000000-0000-7000-8000-000000000006',
     statement_timestamp() + interval '2 hours', statement_timestamp() + interval '4 hours',
     'ADMIN', 'future-a-b', 0, statement_timestamp(), statement_timestamp()),
    ('21000000-0000-7000-8000-000000000021', '14000000-0000-7000-8000-000000000003',
     '20000000-0000-7000-8000-000000000006', '20000000-0000-7000-8000-000000000007',
     statement_timestamp() + interval '2 hours', statement_timestamp() + interval '4 hours',
     'ADMIN', 'future-b-c', 0, statement_timestamp(), statement_timestamp());
SELECT pg_temp.assert_raises(
    $$INSERT INTO authz.relationship
      (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until,
       source_kind, source_ref, row_version, created_at, updated_at)
      VALUES ('21000000-0000-7000-8000-000000000022', '14000000-0000-7000-8000-000000000003',
              '20000000-0000-7000-8000-000000000005', '20000000-0000-7000-8000-000000000006',
              statement_timestamp() + interval '3 hours', statement_timestamp() + interval '5 hours',
              'ADMIN', 'future-duplicate', 0, statement_timestamp(), statement_timestamp())$$,
    '23514', 'overlapping future duplicate relationships are rejected'
);
SELECT pg_temp.assert_raises(
    $$INSERT INTO authz.relationship
      (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until,
       source_kind, source_ref, row_version, created_at, updated_at)
      VALUES ('21000000-0000-7000-8000-000000000023', '14000000-0000-7000-8000-000000000003',
              '20000000-0000-7000-8000-000000000005', '20000000-0000-7000-8000-000000000007',
              statement_timestamp() + interval '3 hours', statement_timestamp() + interval '5 hours',
              'ADMIN', 'future-max-objects', 0, statement_timestamp(), statement_timestamp())$$,
    '23514', 'future overlap cannot exceed max_objects'
);
SELECT pg_temp.assert_raises(
    $$INSERT INTO authz.relationship
      (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until,
       source_kind, source_ref, row_version, created_at, updated_at)
      VALUES ('21000000-0000-7000-8000-000000000024', '14000000-0000-7000-8000-000000000003',
              '20000000-0000-7000-8000-000000000007', '20000000-0000-7000-8000-000000000006',
              statement_timestamp() + interval '3 hours', statement_timestamp() + interval '5 hours',
              'ADMIN', 'future-max-subjects', 0, statement_timestamp(), statement_timestamp())$$,
    '23514', 'future overlap cannot exceed max_subjects'
);
SELECT pg_temp.assert_raises(
    $$INSERT INTO authz.relationship
      (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until,
       source_kind, source_ref, row_version, created_at, updated_at)
      VALUES ('21000000-0000-7000-8000-000000000025', '14000000-0000-7000-8000-000000000003',
              '20000000-0000-7000-8000-000000000007', '20000000-0000-7000-8000-000000000005',
              statement_timestamp() + interval '3 hours', statement_timestamp() + interval '5 hours',
              'ADMIN', 'future-cycle', 0, statement_timestamp(), statement_timestamp())$$,
    '23514', 'overlapping future relationship cycles are rejected'
);
INSERT INTO authz.relationship (
    id, relation_definition_id, subject_entity_id, object_entity_id,
    valid_from, valid_until, source_kind, source_ref, row_version, created_at, updated_at
) VALUES (
    '21000000-0000-7000-8000-000000000026', '14000000-0000-7000-8000-000000000003',
    '20000000-0000-7000-8000-000000000005', '20000000-0000-7000-8000-000000000006',
    statement_timestamp() + interval '4 hours', statement_timestamp() + interval '5 hours',
    'ADMIN', 'future-non-overlap', 0, statement_timestamp(), statement_timestamp()
);
SELECT pg_temp.assert_true(
    (SELECT current_revision = value + 5 FROM authz.authorization_state, revision_checkpoint WHERE singleton),
    'future authorization facts do not bump mutation revision before becoming active'
);

INSERT INTO authz.relationship (
    id, relation_definition_id, subject_entity_id, object_entity_id,
    valid_from, valid_until, source_kind, source_ref, row_version, created_at, updated_at
) VALUES (
    '21000000-0000-7000-8000-000000000027', '14000000-0000-7000-8000-000000000002',
    '20000000-0000-7000-8000-000000000004', '20000000-0000-7000-8000-000000000002',
    transaction_timestamp() + interval '50 milliseconds', transaction_timestamp() + interval '1 hour',
    'ADMIN', 'snapshot-boundary', 0, statement_timestamp(), statement_timestamp()
);
CREATE TEMP TABLE snapshot_observation (visible boolean NOT NULL);
INSERT INTO snapshot_observation
SELECT EXISTS (
    SELECT 1 FROM authz.active_relationships_at()
    WHERE id = '21000000-0000-7000-8000-000000000027'
);
SELECT pg_temp.assert_true(
    NOT (SELECT visible FROM snapshot_observation)
    AND NOT EXISTS (
        SELECT 1 FROM authz.active_relationships_at()
        WHERE id = '21000000-0000-7000-8000-000000000027'
    )
    AND EXISTS (
        SELECT 1 FROM authz.active_relationships_at(transaction_timestamp() + interval '1 second')
        WHERE id = '21000000-0000-7000-8000-000000000027'
    ),
    'default authorization snapshot is stable across statements in one transaction'
);

INSERT INTO occ.business_object (
    id, entity_type_version_id, lifecycle_state, data, row_version, created_at, updated_at
) VALUES (
    '20000000-0000-7000-8000-000000000002',
    '13000000-0000-7000-8000-000000000002',
    'ACTIVE', '{}'::jsonb, 0, now(), now()
);

SELECT pg_temp.assert_raises(
    $$INSERT INTO occ.business_object
      (id, entity_type_version_id, lifecycle_state, data, row_version, created_at, updated_at)
      VALUES ('20000000-0000-7000-8000-000000000003',
              '13000000-0000-7000-8000-000000000001',
              'ACTIVE', '{}'::jsonb, 0, now(), now())$$,
    '23514', 'business object and auth entity versions must match'
);

INSERT INTO authz.policy_bundle (id, bundle_key, layer, status, created_at)
VALUES ('30000000-0000-7000-8000-000000000001', 'platform.base', 'PLATFORM', 'ACTIVE', now());

INSERT INTO authz.policy_bundle_version (
    id, bundle_id, version, status, manifest, created_at
) VALUES (
    '31000000-0000-7000-8000-000000000001',
    '30000000-0000-7000-8000-000000000001',
    1, 'DRAFT', '{}'::jsonb, now()
);

INSERT INTO authz.policy_module (id, bundle_version_id, module_path, rego_source, source_hash)
VALUES (
    '32000000-0000-7000-8000-000000000001',
    '31000000-0000-7000-8000-000000000001',
    'platform/base.rego', 'package platform.base', repeat('b', 64)
);

UPDATE authz.policy_bundle_version
SET status = 'PUBLISHED', content_hash = repeat('c', 64), published_at = now()
WHERE id = '31000000-0000-7000-8000-000000000001';

SELECT pg_temp.assert_raises(
    $$INSERT INTO authz.policy_release
      (id, release_number, status, content_hash, opa_revision, published_at, created_at)
      VALUES ('33000000-0000-7000-8000-000000000099', 99, 'ACTIVE', repeat('d', 64), 'invalid', now(), now())$$,
    '23514', 'policy releases cannot be inserted directly as active'
);

INSERT INTO authz.policy_release (id, release_number, status, content_hash, created_at)
VALUES ('33000000-0000-7000-8000-000000000001', 1, 'STAGED', repeat('d', 64), now());
INSERT INTO authz.policy_release_item (release_id, bundle_id, bundle_version_id)
VALUES (
    '33000000-0000-7000-8000-000000000001',
    '30000000-0000-7000-8000-000000000001',
    '31000000-0000-7000-8000-000000000001'
);
UPDATE authz.policy_release
SET status = 'ACTIVE', opa_revision = 'rev-1', published_at = now()
WHERE id = '33000000-0000-7000-8000-000000000001';

SELECT pg_temp.assert_raises(
    $$UPDATE authz.policy_release SET content_hash = repeat('e', 64)
      WHERE id = '33000000-0000-7000-8000-000000000001'$$,
    '55000', 'active policy release content is immutable'
);

SELECT pg_temp.assert_raises(
    $$DELETE FROM authz.policy_release_item
      WHERE release_id = '33000000-0000-7000-8000-000000000001'$$,
    '55000', 'active policy release items are immutable'
);

INSERT INTO ai.prompt_template (id, prompt_key, name)
VALUES ('40000000-0000-7000-8000-000000000001', 'planner', 'Planner');
INSERT INTO ai.prompt_template_version (
    id, prompt_template_id, version, template, variable_schema,
    content_hash, status, created_by, created_at
) VALUES (
    '41000000-0000-7000-8000-000000000001',
    '40000000-0000-7000-8000-000000000001',
    1, 'Plan {{ task }}', '{}'::jsonb, repeat('f', 64), 'DRAFT',
    '20000000-0000-7000-8000-000000000001', now()
);
UPDATE ai.prompt_template_version
SET status = 'PUBLISHED', published_at = now()
WHERE id = '41000000-0000-7000-8000-000000000001';

SELECT pg_temp.assert_raises(
    $$UPDATE ai.prompt_template_version SET template = 'Changed'
      WHERE id = '41000000-0000-7000-8000-000000000001'$$,
    '55000', 'published prompt versions are immutable'
);

ROLLBACK;
