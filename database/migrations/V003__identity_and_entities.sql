CREATE TABLE authz.entity (
    id uuid PRIMARY KEY,
    entity_type_id uuid NOT NULL REFERENCES catalog.entity_type(id),
    entity_type_version_id uuid NOT NULL,
    entity_key text NOT NULL,
    state text NOT NULL CHECK (state IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
    auth_attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(auth_attributes)),
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (entity_type_id, entity_key),
    UNIQUE (id, entity_type_version_id),
    FOREIGN KEY (entity_type_version_id, entity_type_id)
        REFERENCES catalog.entity_type_version(id, entity_type_id)
);

CREATE TRIGGER trg_entity_touch
BEFORE UPDATE ON authz.entity
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE iam.principal (
    id uuid PRIMARY KEY REFERENCES authz.entity(id),
    principal_kind text NOT NULL CHECK (principal_kind IN ('USER', 'GROUP', 'SERVICE', 'ROLE')),
    display_name text NOT NULL,
    status text NOT NULL CHECK (status IN ('ACTIVE', 'LOCKED', 'DISABLED', 'ARCHIVED')),
    profile jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(profile)),
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TRIGGER trg_principal_touch
BEFORE UPDATE ON iam.principal
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE iam.user_account (
    principal_id uuid PRIMARY KEY REFERENCES iam.principal(id),
    username text NOT NULL UNIQUE,
    password_hash text,
    password_version integer NOT NULL DEFAULT 0 CHECK (password_version >= 0),
    failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until timestamptz,
    last_login_at timestamptz,
    CHECK (username = lower(btrim(username)) AND username <> '')
);

CREATE TABLE iam.external_identity (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES iam.principal(id),
    issuer text NOT NULL,
    subject text NOT NULL,
    claims_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(claims_snapshot)),
    last_synced_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (issuer, subject)
);

CREATE TABLE authz.authorization_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    current_revision bigint NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

INSERT INTO authz.authorization_state (singleton) VALUES (true);

CREATE FUNCTION authz.bump_authorization_revision()
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    next_revision bigint;
BEGIN
    UPDATE authz.authorization_state
    SET current_revision = current_revision + 1,
        updated_at = statement_timestamp()
    WHERE singleton
    RETURNING current_revision INTO STRICT next_revision;
    RETURN next_revision;
END;
$$;

CREATE FUNCTION authz.protect_authorization_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'authorization state singleton cannot be deleted';
END;
$$;

CREATE TRIGGER trg_authorization_state_no_delete
BEFORE DELETE ON authz.authorization_state
FOR EACH ROW EXECUTE FUNCTION authz.protect_authorization_state();

CREATE TRIGGER trg_authorization_state_no_truncate
BEFORE TRUNCATE ON authz.authorization_state
FOR EACH STATEMENT EXECUTE FUNCTION authz.protect_authorization_state();

CREATE TABLE authz.relationship (
    id uuid PRIMARY KEY,
    relation_definition_id uuid NOT NULL REFERENCES catalog.relation_definition(id),
    subject_entity_id uuid NOT NULL REFERENCES authz.entity(id),
    object_entity_id uuid NOT NULL REFERENCES authz.entity(id),
    attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(attributes)),
    valid_from timestamptz NOT NULL DEFAULT statement_timestamp(),
    valid_until timestamptz,
    source_kind text NOT NULL CHECK (source_kind IN ('PLATFORM', 'DOMAIN', 'ADMIN', 'IDP', 'SYSTEM')),
    source_ref text NOT NULL,
    revoked_at timestamptz,
    revoked_by uuid,
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK (subject_entity_id <> object_entity_id),
    CHECK (valid_until IS NULL OR valid_until > valid_from),
    CHECK (revoked_at IS NULL OR revoked_at >= valid_from)
);

CREATE TRIGGER trg_relationship_touch
BEFORE UPDATE ON authz.relationship
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE authz.relationship_closure (
    relation_definition_id uuid NOT NULL REFERENCES catalog.relation_definition(id),
    ancestor_entity_id uuid NOT NULL REFERENCES authz.entity(id),
    descendant_entity_id uuid NOT NULL REFERENCES authz.entity(id),
    depth integer NOT NULL CHECK (depth > 0),
    build_revision bigint NOT NULL CHECK (build_revision >= 0),
    PRIMARY KEY (relation_definition_id, ancestor_entity_id, descendant_entity_id)
);
