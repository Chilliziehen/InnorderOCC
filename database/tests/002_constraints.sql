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
    ('12000000-0000-7000-8000-000000000002', '10000000-0000-7000-8000-000000000001', 'work_item', 'Work item', 'RESOURCE', true);

INSERT INTO catalog.entity_type_version (
    id, entity_type_id, package_version_id, schema_version, json_schema, ui_schema, auth_schema, index_spec
) VALUES
    ('13000000-0000-7000-8000-000000000001', '12000000-0000-7000-8000-000000000001', '11000000-0000-7000-8000-000000000001', 1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb),
    ('13000000-0000-7000-8000-000000000002', '12000000-0000-7000-8000-000000000002', '11000000-0000-7000-8000-000000000001', 1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);

INSERT INTO catalog.relation_definition (
    id, package_version_id, relation_key, subject_type_id, object_type_id,
    cardinality, transitive, acyclic, auth_relevant
) VALUES (
    '14000000-0000-7000-8000-000000000001',
    '11000000-0000-7000-8000-000000000001',
    'owner_of',
    '12000000-0000-7000-8000-000000000001',
    '12000000-0000-7000-8000-000000000002',
    'ONE_TO_ONE', false, true, true
);

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
    ('20000000-0000-7000-8000-000000000003', '12000000-0000-7000-8000-000000000002', '13000000-0000-7000-8000-000000000002', 'work:two', 'ACTIVE', '{}'::jsonb, 0, now(), now());

INSERT INTO iam.principal (
    id, principal_kind, display_name, status, profile, row_version, created_at, updated_at
) VALUES (
    '20000000-0000-7000-8000-000000000001', 'USER', 'User One', 'ACTIVE', '{}'::jsonb, 0, now(), now()
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
    (SELECT current_revision = 1 FROM authz.authorization_state WHERE singleton),
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
SET revoked_at = now(), revoked_by = '20000000-0000-7000-8000-000000000001'
WHERE id = '21000000-0000-7000-8000-000000000001';

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
