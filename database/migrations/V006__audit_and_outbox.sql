CREATE TABLE audit.audit_record (
    id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    actor_entity_id uuid REFERENCES authz.entity(id),
    action_key text NOT NULL,
    target_entity_id uuid REFERENCES authz.entity(id),
    before_version bigint,
    after_version bigint,
    reason text,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(detail)),
    correlation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (id, created_at),
    CHECK (before_version IS NULL OR before_version >= 0),
    CHECK (after_version IS NULL OR after_version >= 0)
) PARTITION BY RANGE (created_at);

CREATE TABLE audit.audit_record_default
PARTITION OF audit.audit_record DEFAULT;

CREATE TABLE audit.idempotency_record (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES iam.principal(id),
    command_key text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    response_status integer CHECK (response_status BETWEEN 100 AND 599),
    response_digest text,
    resource_id uuid REFERENCES authz.entity(id),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    expires_at timestamptz NOT NULL,
    UNIQUE (principal_id, command_key, idempotency_key),
    CHECK (expires_at > created_at)
);

CREATE TABLE audit.outbox_event (
    id uuid PRIMARY KEY,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    aggregate_version bigint NOT NULL CHECK (aggregate_version >= 0),
    event_type text NOT NULL,
    schema_version integer NOT NULL CHECK (schema_version > 0),
    payload jsonb NOT NULL CHECK (platform.is_json_object(payload)),
    correlation_id uuid NOT NULL,
    available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED', 'DEAD')),
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (aggregate_id, aggregate_version, event_type),
    CHECK ((status = 'PUBLISHED' AND published_at IS NOT NULL) OR status <> 'PUBLISHED')
);
