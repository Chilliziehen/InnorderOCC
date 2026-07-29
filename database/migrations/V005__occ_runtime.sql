CREATE TABLE occ.business_object (
    id uuid PRIMARY KEY REFERENCES authz.entity(id),
    entity_type_version_id uuid NOT NULL REFERENCES catalog.entity_type_version(id),
    lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
    data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(data)),
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_by uuid REFERENCES iam.principal(id),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_by uuid REFERENCES iam.principal(id),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    archived_at timestamptz,
    CHECK ((lifecycle_state = 'ARCHIVED' AND archived_at IS NOT NULL) OR lifecycle_state <> 'ARCHIVED')
);

CREATE TRIGGER trg_business_object_touch
BEFORE UPDATE ON occ.business_object
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE occ.object_index_value (
    object_id uuid NOT NULL REFERENCES occ.business_object(id) ON DELETE CASCADE,
    field_key text NOT NULL,
    ordinal integer NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
    value_type text NOT NULL CHECK (value_type IN ('TEXT', 'NUMBER', 'TIMESTAMP', 'BOOLEAN')),
    text_value text,
    numeric_value numeric,
    timestamp_value timestamptz,
    boolean_value boolean,
    PRIMARY KEY (object_id, field_key, ordinal),
    CHECK (
        (value_type = 'TEXT' AND text_value IS NOT NULL AND numeric_value IS NULL AND timestamp_value IS NULL AND boolean_value IS NULL)
        OR (value_type = 'NUMBER' AND text_value IS NULL AND numeric_value IS NOT NULL AND timestamp_value IS NULL AND boolean_value IS NULL)
        OR (value_type = 'TIMESTAMP' AND text_value IS NULL AND numeric_value IS NULL AND timestamp_value IS NOT NULL AND boolean_value IS NULL)
        OR (value_type = 'BOOLEAN' AND text_value IS NULL AND numeric_value IS NULL AND timestamp_value IS NULL AND boolean_value IS NOT NULL)
    )
);

CREATE TABLE occ.data_migration (
    id uuid PRIMARY KEY,
    entity_type_id uuid NOT NULL REFERENCES catalog.entity_type(id),
    source_version_id uuid NOT NULL REFERENCES catalog.entity_type_version(id),
    target_version_id uuid NOT NULL REFERENCES catalog.entity_type_version(id),
    status text NOT NULL CHECK (status IN ('PLANNED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED')),
    plan jsonb NOT NULL CHECK (platform.is_json_object(plan)),
    created_by uuid NOT NULL REFERENCES iam.principal(id),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    started_at timestamptz,
    completed_at timestamptz,
    CHECK (source_version_id <> target_version_id)
);

CREATE TABLE occ.data_migration_item (
    migration_id uuid NOT NULL REFERENCES occ.data_migration(id) ON DELETE CASCADE,
    object_id uuid NOT NULL REFERENCES occ.business_object(id),
    source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    target_hash text CHECK (target_hash IS NULL OR target_hash ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED')),
    error_code text,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    PRIMARY KEY (migration_id, object_id)
);

CREATE TABLE occ.process_definition_binding (
    id uuid PRIMARY KEY,
    workflow_definition_id uuid NOT NULL REFERENCES catalog.workflow_definition(id),
    package_version_id uuid NOT NULL REFERENCES catalog.package_version(id),
    bpmn_key text NOT NULL,
    flowable_deployment_id text NOT NULL UNIQUE,
    flowable_definition_id text NOT NULL UNIQUE,
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (package_version_id, bpmn_key)
);

CREATE TABLE occ.process_instance (
    id uuid PRIMARY KEY REFERENCES authz.entity(id),
    definition_binding_id uuid NOT NULL REFERENCES occ.process_definition_binding(id),
    package_version_id uuid NOT NULL REFERENCES catalog.package_version(id),
    business_object_id uuid REFERENCES occ.business_object(id),
    flowable_instance_id text NOT NULL UNIQUE,
    business_key text NOT NULL,
    state text NOT NULL CHECK (state IN ('RUNNING', 'SUSPENDED', 'COMPLETED', 'CANCELLED', 'FAILED')),
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    started_by uuid REFERENCES iam.principal(id),
    started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    ended_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (definition_binding_id, business_key),
    CHECK ((state IN ('COMPLETED', 'CANCELLED', 'FAILED') AND ended_at IS NOT NULL) OR state IN ('RUNNING', 'SUSPENDED'))
);

CREATE TRIGGER trg_process_instance_touch
BEFORE UPDATE ON occ.process_instance
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE occ.task_projection (
    id uuid PRIMARY KEY REFERENCES authz.entity(id),
    process_instance_id uuid NOT NULL REFERENCES occ.process_instance(id),
    activity_key text NOT NULL,
    flowable_task_id text NOT NULL UNIQUE,
    state text NOT NULL CHECK (state IN ('CREATED', 'CLAIMED', 'COMPLETED', 'CANCELLED', 'FAILED')),
    due_at timestamptz,
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    completed_at timestamptz,
    CHECK ((state = 'COMPLETED' AND completed_at IS NOT NULL) OR state <> 'COMPLETED')
);

CREATE TRIGGER trg_task_projection_touch
BEFORE UPDATE ON occ.task_projection
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE occ.upload_session (
    id uuid PRIMARY KEY,
    uploader_id uuid NOT NULL REFERENCES iam.principal(id),
    target_entity_id uuid NOT NULL REFERENCES authz.entity(id),
    object_key text NOT NULL UNIQUE,
    expected_sha256 text NOT NULL CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
    expected_size_bytes bigint NOT NULL CHECK (expected_size_bytes > 0),
    status text NOT NULL CHECK (status IN ('CREATED', 'UPLOADED', 'CONFIRMED', 'EXPIRED', 'FAILED')),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    expires_at timestamptz NOT NULL,
    CHECK (expires_at > created_at)
);

CREATE TABLE occ.evidence (
    id uuid PRIMARY KEY REFERENCES authz.entity(id),
    task_id uuid REFERENCES occ.task_projection(id),
    business_object_id uuid REFERENCES occ.business_object(id),
    requirement_id uuid NOT NULL REFERENCES catalog.evidence_requirement(id),
    state text NOT NULL CHECK (state IN ('PENDING', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'ARCHIVED')),
    current_version integer CHECK (current_version IS NULL OR current_version > 0),
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_by uuid NOT NULL REFERENCES iam.principal(id),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK (task_id IS NOT NULL OR business_object_id IS NOT NULL)
);

CREATE TRIGGER trg_evidence_touch
BEFORE UPDATE ON occ.evidence
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE occ.evidence_version (
    id uuid PRIMARY KEY,
    evidence_id uuid NOT NULL REFERENCES occ.evidence(id),
    version integer NOT NULL CHECK (version > 0),
    object_key text NOT NULL UNIQUE,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    submitted_by uuid NOT NULL REFERENCES iam.principal(id),
    submitted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (evidence_id, version)
);

CREATE TABLE occ.evidence_review (
    id uuid PRIMARY KEY,
    evidence_version_id uuid NOT NULL REFERENCES occ.evidence_version(id),
    reviewer_id uuid NOT NULL REFERENCES iam.principal(id),
    decision text NOT NULL CHECK (decision IN ('ACCEPTED', 'REJECTED', 'CONDITIONAL')),
    reason text,
    conditions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(conditions)),
    reviewed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (evidence_version_id, reviewer_id, reviewed_at)
);

CREATE TABLE occ.risk (
    id uuid PRIMARY KEY REFERENCES authz.entity(id),
    rule_definition_id uuid NOT NULL REFERENCES catalog.risk_rule_definition(id),
    target_entity_id uuid NOT NULL REFERENCES authz.entity(id),
    severity text NOT NULL CHECK (severity IN ('INFO', 'YELLOW', 'RED')),
    state text NOT NULL CHECK (state IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED')),
    confidence numeric(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    reason text NOT NULL,
    due_at timestamptz,
    resolved_at timestamptz,
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK ((state = 'RESOLVED' AND resolved_at IS NOT NULL) OR state <> 'RESOLVED')
);

CREATE TRIGGER trg_risk_touch
BEFORE UPDATE ON occ.risk
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE occ.managed_resource (
    id uuid PRIMARY KEY REFERENCES authz.entity(id),
    resource_type text NOT NULL,
    capacity numeric NOT NULL CHECK (capacity > 0),
    state text NOT NULL CHECK (state IN ('AVAILABLE', 'UNAVAILABLE', 'MAINTENANCE', 'ARCHIVED')),
    data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(data)),
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TRIGGER trg_managed_resource_touch
BEFORE UPDATE ON occ.managed_resource
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE occ.resource_reservation (
    id uuid PRIMARY KEY,
    resource_id uuid NOT NULL REFERENCES occ.managed_resource(id),
    requester_entity_id uuid NOT NULL REFERENCES authz.entity(id),
    process_instance_id uuid REFERENCES occ.process_instance(id),
    task_id uuid REFERENCES occ.task_projection(id),
    time_range tstzrange NOT NULL,
    capacity numeric NOT NULL CHECK (capacity > 0),
    exclusive boolean NOT NULL DEFAULT false,
    state text NOT NULL CHECK (state IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED')),
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK (NOT isempty(time_range) AND lower(time_range) IS NOT NULL AND upper(time_range) IS NOT NULL),
    EXCLUDE USING gist (resource_id WITH =, time_range WITH &&)
        WHERE (exclusive AND state IN ('PENDING', 'CONFIRMED'))
);

CREATE TRIGGER trg_resource_reservation_touch
BEFORE UPDATE ON occ.resource_reservation
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
