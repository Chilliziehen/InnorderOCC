CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA platform;
CREATE SCHEMA catalog;
CREATE SCHEMA iam;
CREATE SCHEMA authz;
CREATE SCHEMA occ;
CREATE SCHEMA audit;
CREATE SCHEMA ai;
CREATE SCHEMA flowable;

CREATE FUNCTION platform.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := statement_timestamp();
    IF NEW.row_version IS NOT NULL THEN
        NEW.row_version := OLD.row_version + 1;
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION platform.reject_immutable_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = format('%I.%I row is immutable', TG_TABLE_SCHEMA, TG_TABLE_NAME);
END;
$$;

CREATE FUNCTION platform.is_json_object(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT value IS NOT NULL AND jsonb_typeof(value) = 'object'
$$;

CREATE TABLE platform.instance (
    id uuid PRIMARY KEY,
    singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
    instance_key text NOT NULL UNIQUE,
    display_name text NOT NULL,
    deployment_mode text NOT NULL CHECK (deployment_mode IN ('PILOT', 'PRODUCTION')),
    config_version bigint NOT NULL DEFAULT 0 CHECK (config_version >= 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
