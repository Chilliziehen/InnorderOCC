CREATE TABLE ai.model_provider (
    id uuid PRIMARY KEY REFERENCES authz.entity(id),
    provider_type text NOT NULL,
    base_url text NOT NULL,
    secret_ref text NOT NULL,
    capabilities jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(capabilities)),
    data_policy jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(data_policy)),
    state text NOT NULL CHECK (state IN ('ACTIVE', 'DISABLED', 'ARCHIVED')),
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TRIGGER trg_model_provider_touch
BEFORE UPDATE ON ai.model_provider
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE ai.model_profile (
    id uuid PRIMARY KEY,
    provider_id uuid NOT NULL REFERENCES ai.model_provider(id),
    model_key text NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('CHAT', 'EMBEDDING', 'RERANK', 'MODERATION')),
    parameters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(parameters)),
    capability_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(capability_snapshot)),
    timeout_ms integer NOT NULL CHECK (timeout_ms > 0),
    rate_limit jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(rate_limit)),
    cost_rule jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(cost_rule)),
    state text NOT NULL CHECK (state IN ('ACTIVE', 'DISABLED', 'ARCHIVED')),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (provider_id, model_key, purpose)
);

CREATE TABLE ai.prompt_template (
    id uuid PRIMARY KEY,
    prompt_key text NOT NULL UNIQUE,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE ai.prompt_template_version (
    id uuid PRIMARY KEY,
    prompt_template_id uuid NOT NULL REFERENCES ai.prompt_template(id),
    version integer NOT NULL CHECK (version > 0),
    template text NOT NULL,
    variable_schema jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(variable_schema)),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
    created_by uuid NOT NULL REFERENCES iam.principal(id),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    published_at timestamptz,
    UNIQUE (prompt_template_id, version),
    CHECK ((status IN ('PUBLISHED', 'RETIRED') AND published_at IS NOT NULL) OR status = 'DRAFT')
);

CREATE TABLE ai.agent_definition (
    id uuid PRIMARY KEY,
    agent_key text NOT NULL UNIQUE,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE ai.agent_definition_version (
    id uuid PRIMARY KEY,
    agent_definition_id uuid NOT NULL REFERENCES ai.agent_definition(id),
    package_version_id uuid NOT NULL REFERENCES catalog.package_version(id),
    input_schema jsonb NOT NULL CHECK (platform.is_json_object(input_schema)),
    output_schema jsonb NOT NULL CHECK (platform.is_json_object(output_schema)),
    prompt_version_id uuid NOT NULL REFERENCES ai.prompt_template_version(id),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (agent_definition_id, package_version_id)
);

CREATE TABLE ai.tool_definition (
    id uuid PRIMARY KEY,
    tool_key text NOT NULL UNIQUE,
    input_schema jsonb NOT NULL CHECK (platform.is_json_object(input_schema)),
    output_schema jsonb NOT NULL CHECK (platform.is_json_object(output_schema)),
    risk_level text NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    required_action_key text NOT NULL,
    state text NOT NULL CHECK (state IN ('ACTIVE', 'DISABLED', 'ARCHIVED')),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE ai.agent_tool_grant (
    agent_version_id uuid NOT NULL REFERENCES ai.agent_definition_version(id) ON DELETE CASCADE,
    tool_definition_id uuid NOT NULL REFERENCES ai.tool_definition(id),
    constraints jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(constraints)),
    PRIMARY KEY (agent_version_id, tool_definition_id)
);

CREATE TABLE ai.knowledge_source (
    id uuid PRIMARY KEY REFERENCES authz.entity(id),
    source_type text NOT NULL CHECK (source_type IN ('UPLOAD', 'OBJECT_STORE', 'GIT', 'HTTP', 'DATABASE')),
    sync_config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(sync_config)),
    package_version_id uuid REFERENCES catalog.package_version(id),
    state text NOT NULL CHECK (state IN ('ACTIVE', 'PAUSED', 'FAILED', 'ARCHIVED')),
    sync_cursor jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(sync_cursor)),
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TRIGGER trg_knowledge_source_touch
BEFORE UPDATE ON ai.knowledge_source
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE ai.knowledge_document (
    id uuid PRIMARY KEY REFERENCES authz.entity(id),
    source_id uuid NOT NULL REFERENCES ai.knowledge_source(id),
    document_key text NOT NULL,
    current_version integer CHECK (current_version IS NULL OR current_version > 0),
    state text NOT NULL CHECK (state IN ('PENDING', 'READY', 'FAILED', 'ARCHIVED')),
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (source_id, document_key)
);

CREATE TRIGGER trg_knowledge_document_touch
BEFORE UPDATE ON ai.knowledge_document
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE ai.knowledge_document_version (
    id uuid PRIMARY KEY,
    document_id uuid NOT NULL REFERENCES ai.knowledge_document(id),
    version integer NOT NULL CHECK (version > 0),
    object_key text NOT NULL UNIQUE,
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    mime_type text NOT NULL,
    parser_version text NOT NULL,
    data_classification text NOT NULL CHECK (data_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (document_id, version)
);

CREATE TABLE ai.knowledge_chunk (
    id uuid PRIMARY KEY,
    document_version_id uuid NOT NULL REFERENCES ai.knowledge_document_version(id) ON DELETE CASCADE,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    content text NOT NULL,
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    token_count integer NOT NULL CHECK (token_count > 0),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(metadata)),
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
    UNIQUE (document_version_id, ordinal),
    UNIQUE (id, document_version_id)
);

CREATE TABLE ai.embedding_space (
    id uuid PRIMARY KEY,
    model_profile_id uuid NOT NULL REFERENCES ai.model_profile(id),
    dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 2000),
    distance_metric text NOT NULL CHECK (distance_metric IN ('COSINE', 'L2', 'INNER_PRODUCT')),
    corpus_version text NOT NULL,
    status text NOT NULL CHECK (status IN ('BUILDING', 'ACTIVE', 'RETIRED', 'FAILED')),
    coverage numeric(6,5) NOT NULL DEFAULT 0 CHECK (coverage >= 0 AND coverage <= 1),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    activated_at timestamptz,
    CHECK ((status IN ('ACTIVE', 'RETIRED') AND activated_at IS NOT NULL) OR status IN ('BUILDING', 'FAILED'))
);

CREATE TABLE ai.chunk_embedding (
    embedding_space_id uuid NOT NULL REFERENCES ai.embedding_space(id),
    chunk_id uuid NOT NULL REFERENCES ai.knowledge_chunk(id) ON DELETE CASCADE,
    embedding vector NOT NULL,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (embedding_space_id, chunk_id)
) PARTITION BY LIST (embedding_space_id);

CREATE TABLE ai.ai_run (
    id uuid PRIMARY KEY,
    agent_version_id uuid NOT NULL REFERENCES ai.agent_definition_version(id),
    model_profile_id uuid NOT NULL REFERENCES ai.model_profile(id),
    prompt_version_id uuid NOT NULL REFERENCES ai.prompt_template_version(id),
    package_version_id uuid NOT NULL REFERENCES catalog.package_version(id),
    policy_release_id uuid NOT NULL REFERENCES authz.policy_release(id),
    triggered_by uuid NOT NULL REFERENCES authz.entity(id),
    target_entity_id uuid NOT NULL REFERENCES authz.entity(id),
    status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
    input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cost numeric NOT NULL DEFAULT 0 CHECK (cost >= 0),
    latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
    error_code text,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    started_at timestamptz,
    completed_at timestamptz
);

CREATE TABLE ai.ai_run_artifact (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES ai.ai_run(id) ON DELETE CASCADE,
    artifact_kind text NOT NULL CHECK (artifact_kind IN ('INPUT', 'OUTPUT', 'TOOL_REQUEST', 'TOOL_RESPONSE', 'TRACE')),
    object_key text NOT NULL UNIQUE,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    data_classification text NOT NULL CHECK (data_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
    retention_until timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE ai.tool_call (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES ai.ai_run(id) ON DELETE CASCADE,
    tool_definition_id uuid NOT NULL REFERENCES ai.tool_definition(id),
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    response_hash text CHECK (response_hash IS NULL OR response_hash ~ '^[0-9a-f]{64}$'),
    decision_log_id uuid NOT NULL,
    decision_log_created_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('REQUESTED', 'AUTHORIZED', 'DENIED', 'COMPLETED', 'FAILED')),
    latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    completed_at timestamptz,
    FOREIGN KEY (decision_log_id, decision_log_created_at)
        REFERENCES authz.decision_log(id, created_at)
);

CREATE TABLE ai.recommendation (
    id uuid PRIMARY KEY REFERENCES authz.entity(id),
    run_id uuid NOT NULL REFERENCES ai.ai_run(id),
    target_entity_id uuid NOT NULL REFERENCES authz.entity(id),
    recommendation_type text NOT NULL,
    payload jsonb NOT NULL CHECK (platform.is_json_object(payload)),
    confidence numeric(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    status text NOT NULL CHECK (status IN ('PROPOSED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN')),
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    reviewed_by uuid REFERENCES iam.principal(id),
    reviewed_at timestamptz
);

CREATE TRIGGER trg_recommendation_touch
BEFORE UPDATE ON ai.recommendation
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE ai.recommendation_citation (
    recommendation_id uuid NOT NULL REFERENCES ai.recommendation(id) ON DELETE CASCADE,
    document_version_id uuid NOT NULL REFERENCES ai.knowledge_document_version(id),
    chunk_id uuid NOT NULL REFERENCES ai.knowledge_chunk(id),
    excerpt_hash text NOT NULL CHECK (excerpt_hash ~ '^[0-9a-f]{64}$'),
    rank integer NOT NULL CHECK (rank > 0),
    PRIMARY KEY (recommendation_id, rank),
    UNIQUE (recommendation_id, chunk_id)
);

CREATE TABLE ai.conversation (
    id uuid PRIMARY KEY REFERENCES authz.entity(id),
    process_instance_id uuid REFERENCES occ.process_instance(id),
    task_id uuid REFERENCES occ.task_projection(id),
    package_version_id uuid NOT NULL REFERENCES catalog.package_version(id),
    state text NOT NULL CHECK (state IN ('OPEN', 'CLOSED', 'ARCHIVED')),
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK (process_instance_id IS NOT NULL OR task_id IS NOT NULL)
);

CREATE TRIGGER trg_conversation_touch
BEFORE UPDATE ON ai.conversation
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE ai.message (
    id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES ai.conversation(id),
    sender_entity_id uuid REFERENCES authz.entity(id),
    run_id uuid REFERENCES ai.ai_run(id),
    role text NOT NULL CHECK (role IN ('SYSTEM', 'USER', 'ASSISTANT', 'TOOL')),
    content jsonb NOT NULL CHECK (platform.is_json_object(content)),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    data_classification text NOT NULL CHECK (data_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK (sender_entity_id IS NOT NULL OR run_id IS NOT NULL)
);

CREATE TABLE ai.evaluation_dataset (
    id uuid PRIMARY KEY,
    dataset_key text NOT NULL UNIQUE,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE ai.evaluation_dataset_version (
    id uuid PRIMARY KEY,
    dataset_id uuid NOT NULL REFERENCES ai.evaluation_dataset(id),
    version integer NOT NULL CHECK (version > 0),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (dataset_id, version)
);

CREATE TABLE ai.evaluation_case (
    id uuid PRIMARY KEY,
    dataset_version_id uuid NOT NULL REFERENCES ai.evaluation_dataset_version(id) ON DELETE CASCADE,
    case_key text NOT NULL,
    input jsonb NOT NULL CHECK (platform.is_json_object(input)),
    expected_properties jsonb NOT NULL CHECK (platform.is_json_object(expected_properties)),
    UNIQUE (dataset_version_id, case_key)
);

CREATE TABLE ai.evaluation_run (
    id uuid PRIMARY KEY,
    dataset_version_id uuid NOT NULL REFERENCES ai.evaluation_dataset_version(id),
    agent_version_id uuid NOT NULL REFERENCES ai.agent_definition_version(id),
    model_profile_id uuid NOT NULL REFERENCES ai.model_profile(id),
    prompt_version_id uuid NOT NULL REFERENCES ai.prompt_template_version(id),
    status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
    metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(metrics)),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    completed_at timestamptz
);

CREATE TABLE ai.evaluation_result (
    evaluation_run_id uuid NOT NULL REFERENCES ai.evaluation_run(id) ON DELETE CASCADE,
    case_id uuid NOT NULL REFERENCES ai.evaluation_case(id),
    status text NOT NULL CHECK (status IN ('PASSED', 'FAILED', 'ERROR')),
    metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(metrics)),
    detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(detail)),
    PRIMARY KEY (evaluation_run_id, case_id)
);
