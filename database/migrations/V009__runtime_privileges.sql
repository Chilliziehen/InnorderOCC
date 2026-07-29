REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO innorder_runtime;

REVOKE CREATE ON SCHEMA platform, catalog, iam, authz, occ, audit, ai
FROM innorder_runtime;

GRANT USAGE ON SCHEMA platform, catalog, iam, authz, occ, audit, ai
TO innorder_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE
ON ALL TABLES IN SCHEMA platform, catalog, iam, authz, occ, audit, ai
TO innorder_runtime;

GRANT USAGE, SELECT, UPDATE
ON ALL SEQUENCES IN SCHEMA platform, catalog, iam, authz, occ, audit, ai
TO innorder_runtime;

ALTER DEFAULT PRIVILEGES
IN SCHEMA platform, catalog, iam, authz, occ, audit, ai
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO innorder_runtime;

ALTER DEFAULT PRIVILEGES
IN SCHEMA platform, catalog, iam, authz, occ, audit, ai
GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO innorder_runtime;

REVOKE ALL ON FUNCTION ai.create_embedding_partition(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.create_embedding_partition(uuid, integer, text) TO innorder_runtime;

GRANT USAGE, CREATE ON SCHEMA flowable TO innorder_runtime;
