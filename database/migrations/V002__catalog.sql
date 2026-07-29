CREATE TABLE catalog.domain_package (
    id uuid PRIMARY KEY,
    package_key text NOT NULL UNIQUE,
    name text NOT NULL,
    description text,
    status text NOT NULL CHECK (status IN ('ACTIVE', 'DEPRECATED')),
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TRIGGER trg_domain_package_touch
BEFORE UPDATE ON catalog.domain_package
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE catalog.package_version (
    id uuid PRIMARY KEY,
    package_id uuid NOT NULL REFERENCES catalog.domain_package(id),
    semver text NOT NULL,
    status text NOT NULL CHECK (status IN ('DRAFT', 'VALIDATED', 'PUBLISHED', 'DEPRECATED')),
    manifest jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(manifest)),
    content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    published_by uuid,
    published_at timestamptz,
    UNIQUE (package_id, semver),
    UNIQUE (package_id, content_hash),
    CHECK (
        (status IN ('PUBLISHED', 'DEPRECATED') AND content_hash IS NOT NULL AND published_at IS NOT NULL)
        OR status IN ('DRAFT', 'VALIDATED')
    )
);

CREATE FUNCTION catalog.enforce_package_version_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status IN ('PUBLISHED', 'DEPRECATED') THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'published package version is immutable';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.status IN ('PUBLISHED', 'DEPRECATED') THEN
        IF OLD.status = 'PUBLISHED'
           AND NEW.status = 'DEPRECATED'
           AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'published package version is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_package_version_immutable
BEFORE UPDATE OR DELETE ON catalog.package_version
FOR EACH ROW EXECUTE FUNCTION catalog.enforce_package_version_immutability();

CREATE TABLE catalog.entity_type (
    id uuid PRIMARY KEY,
    package_id uuid NOT NULL REFERENCES catalog.domain_package(id),
    type_key text NOT NULL,
    name text NOT NULL,
    entity_kind text NOT NULL CHECK (entity_kind IN ('PRINCIPAL', 'RESOURCE', 'SYSTEM')),
    authorizable boolean NOT NULL DEFAULT true,
    UNIQUE (package_id, type_key)
);

CREATE TABLE catalog.entity_type_version (
    id uuid PRIMARY KEY,
    entity_type_id uuid NOT NULL REFERENCES catalog.entity_type(id),
    package_version_id uuid NOT NULL REFERENCES catalog.package_version(id),
    schema_version integer NOT NULL CHECK (schema_version > 0),
    json_schema jsonb NOT NULL CHECK (platform.is_json_object(json_schema)),
    ui_schema jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(ui_schema)),
    auth_schema jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(auth_schema)),
    index_spec jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(index_spec)),
    UNIQUE (entity_type_id, schema_version),
    UNIQUE (entity_type_id, package_version_id),
    UNIQUE (id, entity_type_id)
);

CREATE TABLE catalog.action_definition (
    id uuid PRIMARY KEY,
    package_version_id uuid NOT NULL REFERENCES catalog.package_version(id),
    action_key text NOT NULL,
    resource_type_id uuid NOT NULL REFERENCES catalog.entity_type(id),
    context_schema jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(context_schema)),
    risk_level text NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    UNIQUE (package_version_id, action_key)
);

CREATE TABLE catalog.relation_definition (
    id uuid PRIMARY KEY,
    package_version_id uuid NOT NULL REFERENCES catalog.package_version(id),
    relation_key text NOT NULL,
    subject_type_id uuid NOT NULL REFERENCES catalog.entity_type(id),
    object_type_id uuid NOT NULL REFERENCES catalog.entity_type(id),
    cardinality text NOT NULL CHECK (cardinality IN ('ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_MANY')),
    transitive boolean NOT NULL DEFAULT false,
    acyclic boolean NOT NULL DEFAULT false,
    auth_relevant boolean NOT NULL DEFAULT true,
    UNIQUE (package_version_id, relation_key)
);

CREATE TABLE catalog.form_definition (
    id uuid PRIMARY KEY,
    package_version_id uuid NOT NULL REFERENCES catalog.package_version(id),
    form_key text NOT NULL,
    json_schema jsonb NOT NULL CHECK (platform.is_json_object(json_schema)),
    ui_schema jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(ui_schema)),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    UNIQUE (package_version_id, form_key)
);

CREATE TABLE catalog.evidence_requirement (
    id uuid PRIMARY KEY,
    package_version_id uuid NOT NULL REFERENCES catalog.package_version(id),
    requirement_key text NOT NULL,
    allowed_types jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_types) = 'array'),
    max_size_bytes bigint CHECK (max_size_bytes IS NULL OR max_size_bytes > 0),
    min_count integer NOT NULL DEFAULT 1 CHECK (min_count > 0),
    validation_schema jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(validation_schema)),
    UNIQUE (package_version_id, requirement_key)
);

CREATE TABLE catalog.risk_rule_definition (
    id uuid PRIMARY KEY,
    package_version_id uuid NOT NULL REFERENCES catalog.package_version(id),
    rule_key text NOT NULL,
    dmn_key text NOT NULL,
    severity text NOT NULL CHECK (severity IN ('INFO', 'YELLOW', 'RED')),
    deadline_policy jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(deadline_policy)),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    UNIQUE (package_version_id, rule_key)
);

CREATE TABLE catalog.workflow_definition (
    id uuid PRIMARY KEY,
    package_version_id uuid NOT NULL REFERENCES catalog.package_version(id),
    workflow_key text NOT NULL,
    bpmn_object_key text NOT NULL,
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    UNIQUE (package_version_id, workflow_key)
);
