DO $runtime_role$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles
        WHERE rolname = 'innorder_runtime'
    ) THEN
        CREATE ROLE innorder_runtime
            NOLOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOREPLICATION;
    END IF;
END
$runtime_role$;

ALTER ROLE innorder_runtime SET search_path TO flowable, pg_catalog;

DO $ai_runtime_role$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles
        WHERE rolname = 'innorder_ai_runtime'
    ) THEN
        CREATE ROLE innorder_ai_runtime
            NOLOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOREPLICATION;
    END IF;
END
$ai_runtime_role$;

ALTER ROLE innorder_ai_runtime SET search_path TO pg_catalog;
