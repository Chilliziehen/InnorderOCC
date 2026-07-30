\set ON_ERROR_STOP on

SELECT pg_temp.assert_true(
    (SELECT count(*) = 8 FROM pg_namespace
      WHERE nspname IN ('platform', 'catalog', 'iam', 'authz', 'occ', 'audit', 'ai', 'flowable')),
    'all application schemas exist'
);

SELECT pg_temp.assert_true(
    EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector'),
    'vector extension exists'
);

SELECT pg_temp.assert_true(
    EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'),
    'btree_gist extension exists'
);

SELECT pg_temp.assert_true(to_regclass('catalog.package_version') IS NOT NULL, 'catalog.package_version exists');
SELECT pg_temp.assert_true(to_regclass('authz.entity') IS NOT NULL, 'authz.entity exists');
SELECT pg_temp.assert_true(to_regclass('authz.relationship') IS NOT NULL, 'authz.relationship exists');
SELECT pg_temp.assert_true(to_regclass('authz.policy_release') IS NOT NULL, 'authz.policy_release exists');
SELECT pg_temp.assert_true(to_regclass('occ.business_object') IS NOT NULL, 'occ.business_object exists');
SELECT pg_temp.assert_true(to_regclass('occ.process_instance') IS NOT NULL, 'occ.process_instance exists');
SELECT pg_temp.assert_true(to_regclass('audit.outbox_event') IS NOT NULL, 'audit.outbox_event exists');
SELECT pg_temp.assert_true(to_regclass('ai.knowledge_chunk') IS NOT NULL, 'ai.knowledge_chunk exists');
SELECT pg_temp.assert_true(to_regclass('ai.chunk_embedding') IS NOT NULL, 'ai.chunk_embedding exists');
SELECT pg_temp.assert_true(to_regclass('platform.customer_instance') IS NOT NULL, 'platform.customer_instance exists');
SELECT pg_temp.assert_true(to_regclass('iam.auth_session') IS NOT NULL, 'iam.auth_session exists');

SELECT pg_temp.assert_true(
    (SELECT count(*) = 1
            AND count(*) FILTER (WHERE id = '00000000-0000-7000-8000-000000000001'::uuid) = 1
       FROM platform.customer_instance),
    'one stable default customer instance exists'
);

SELECT pg_temp.assert_true(
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'authz' AND indexname = 'ix_relationship_active_window'),
    'relationship active-window index exists'
);

SELECT pg_temp.assert_true(
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'audit' AND indexname = 'ix_outbox_pending_claim'),
    'outbox pending claim index exists'
);
SELECT pg_temp.assert_true(
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'audit' AND indexname = 'ix_outbox_stale_publishing'),
    'outbox stale publishing recovery index exists'
);
SELECT pg_temp.assert_true(
    to_regprocedure('authz.lock_authorization_state_for_change()') IS NOT NULL
    AND to_regprocedure('authz.lock_authorization_state_for_snapshot()') IS NOT NULL,
    'authorization lock-order APIs exist'
);
SELECT pg_temp.assert_true(
    (SELECT count(*) = 4
       FROM pg_trigger
      WHERE tgname IN (
          'trg_relationship_authorization_lock',
          'trg_principal_status_authorization_lock',
          'trg_entity_authorization_lock',
          'trg_policy_release_authorization_lock'
      ) AND NOT tgisinternal),
    'authorization fact writes acquire the exclusive state lock before mutation'
);

SELECT pg_temp.assert_true(
    has_table_privilege('innorder_runtime', 'platform.customer_instance', 'SELECT,INSERT,UPDATE,DELETE')
    AND has_table_privilege('innorder_runtime', 'iam.auth_session', 'SELECT,INSERT,UPDATE,DELETE'),
    'V009 default grants cover V010 tables'
);

SELECT pg_temp.assert_true(
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'authz' AND indexname = 'uq_policy_release_active'),
    'single-active policy release index exists'
);

SELECT pg_temp.assert_true(
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'ai' AND indexname = 'uq_embedding_space_active'),
    'single-active embedding space index exists'
);
