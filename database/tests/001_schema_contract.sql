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

SELECT pg_temp.assert_true(
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'authz' AND indexname = 'uq_policy_release_active'),
    'single-active policy release index exists'
);

SELECT pg_temp.assert_true(
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'ai' AND indexname = 'uq_embedding_space_active'),
    'single-active embedding space index exists'
);
