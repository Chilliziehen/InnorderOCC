CREATE TABLE authz.policy_bundle (
    id uuid PRIMARY KEY,
    bundle_key text NOT NULL UNIQUE,
    layer text NOT NULL CHECK (layer IN ('PLATFORM', 'DOMAIN', 'CUSTOMER')),
    package_id uuid REFERENCES catalog.domain_package(id),
    status text NOT NULL CHECK (status IN ('ACTIVE', 'DEPRECATED')),
    created_by uuid REFERENCES iam.principal(id),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK ((layer = 'DOMAIN' AND package_id IS NOT NULL) OR (layer <> 'DOMAIN' AND package_id IS NULL))
);

CREATE TABLE authz.policy_bundle_version (
    id uuid PRIMARY KEY,
    bundle_id uuid NOT NULL REFERENCES authz.policy_bundle(id),
    version integer NOT NULL CHECK (version > 0),
    status text NOT NULL CHECK (status IN ('DRAFT', 'VALIDATED', 'APPROVED', 'PUBLISHED')),
    manifest jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(manifest)),
    content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
    created_by uuid REFERENCES iam.principal(id),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    published_by uuid REFERENCES iam.principal(id),
    published_at timestamptz,
    UNIQUE (bundle_id, version),
    UNIQUE (id, bundle_id),
    CHECK (
        (status = 'PUBLISHED' AND content_hash IS NOT NULL AND published_at IS NOT NULL)
        OR status <> 'PUBLISHED'
    )
);

CREATE TABLE authz.policy_module (
    id uuid PRIMARY KEY,
    bundle_version_id uuid NOT NULL REFERENCES authz.policy_bundle_version(id) ON DELETE CASCADE,
    module_path text NOT NULL,
    rego_source text NOT NULL,
    source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    UNIQUE (bundle_version_id, module_path)
);

CREATE TABLE authz.policy_test_case (
    id uuid PRIMARY KEY,
    bundle_version_id uuid NOT NULL REFERENCES authz.policy_bundle_version(id) ON DELETE CASCADE,
    case_key text NOT NULL,
    input jsonb NOT NULL CHECK (platform.is_json_object(input)),
    expected_decision jsonb NOT NULL CHECK (platform.is_json_object(expected_decision)),
    status text NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
    UNIQUE (bundle_version_id, case_key)
);

CREATE TABLE authz.policy_approval (
    id uuid PRIMARY KEY,
    bundle_version_id uuid NOT NULL REFERENCES authz.policy_bundle_version(id),
    reviewer_id uuid NOT NULL REFERENCES iam.principal(id),
    decision text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
    comment text,
    decided_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (bundle_version_id, reviewer_id)
);

CREATE TABLE authz.policy_binding (
    id uuid PRIMARY KEY,
    bundle_version_id uuid NOT NULL REFERENCES authz.policy_bundle_version(id),
    package_version_id uuid REFERENCES catalog.package_version(id),
    scope_entity_id uuid REFERENCES authz.entity(id),
    effective_from timestamptz NOT NULL DEFAULT statement_timestamp(),
    effective_until timestamptz,
    CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE TABLE authz.policy_release (
    id uuid PRIMARY KEY,
    release_number bigint NOT NULL UNIQUE CHECK (release_number > 0),
    status text NOT NULL CHECK (status IN ('STAGED', 'ACTIVE', 'RETIRED', 'FAILED')),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    opa_revision text,
    published_by uuid REFERENCES iam.principal(id),
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK ((status IN ('ACTIVE', 'RETIRED') AND opa_revision IS NOT NULL AND published_at IS NOT NULL) OR status IN ('STAGED', 'FAILED'))
);

CREATE TABLE authz.policy_release_item (
    release_id uuid NOT NULL REFERENCES authz.policy_release(id) ON DELETE CASCADE,
    bundle_id uuid NOT NULL REFERENCES authz.policy_bundle(id),
    bundle_version_id uuid NOT NULL,
    PRIMARY KEY (release_id, bundle_version_id),
    UNIQUE (release_id, bundle_id),
    FOREIGN KEY (bundle_version_id, bundle_id)
        REFERENCES authz.policy_bundle_version(id, bundle_id)
);

CREATE TABLE authz.decision_log (
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    correlation_id uuid NOT NULL,
    policy_release_id uuid NOT NULL REFERENCES authz.policy_release(id),
    authorization_revision bigint NOT NULL CHECK (authorization_revision >= 0),
    principal_entity_id uuid NOT NULL REFERENCES authz.entity(id),
    action_key text NOT NULL,
    resource_entity_id uuid REFERENCES authz.entity(id),
    resource_ref text,
    decision text NOT NULL CHECK (decision IN ('ALLOW', 'DENY', 'ERROR')),
    reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reason_codes) = 'array'),
    matched_policies jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(matched_policies) = 'array'),
    entity_versions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(entity_versions)),
    context_digest text,
    result_digest text,
    latency_ms integer NOT NULL CHECK (latency_ms >= 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE authz.decision_log_default
PARTITION OF authz.decision_log DEFAULT;
