CREATE TABLE authz.ai_authorization_grant (
    id uuid PRIMARY KEY,
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    operation text NOT NULL CHECK (operation <> ''),
    jti text NOT NULL UNIQUE CHECK (octet_length(jti) BETWEEN 1 AND 256),
    principal_id uuid NOT NULL REFERENCES authz.entity(id),
    target_entity_id uuid NOT NULL REFERENCES authz.entity(id),
    purpose text NOT NULL CHECK (octet_length(purpose) BETWEEN 1 AND 256),
    authorization_revision bigint NOT NULL CHECK (authorization_revision >= 0),
    policy_release_id uuid NOT NULL REFERENCES authz.policy_release(id),
    policy_release_digest text NOT NULL CHECK (policy_release_digest ~ '^[0-9a-f]{64}$'),
    authorized_set_digest text NOT NULL CHECK (authorized_set_digest ~ '^[0-9a-f]{64}$'),
    context_digest text NOT NULL CHECK (context_digest ~ '^[0-9a-f]{64}$'),
    bounded_context jsonb NOT NULL CHECK (
        platform.is_json_object(bounded_context)
        AND octet_length(bounded_context::text) <= 16384
    ),
    classification_ceiling text NOT NULL
        CHECK (classification_ceiling IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    event_id uuid NOT NULL,
    run_id uuid UNIQUE,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK (issued_at <= created_at + interval '1 minute'),
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '5 minutes'),
    CHECK ((consumed_at IS NULL AND run_id IS NULL) OR (consumed_at IS NOT NULL AND run_id IS NOT NULL)),
    CHECK (consumed_at IS NULL OR (consumed_at >= issued_at AND consumed_at < expires_at))
);

CREATE TABLE authz.ai_authorized_document (
    grant_id uuid NOT NULL REFERENCES authz.ai_authorization_grant(id) ON DELETE CASCADE,
    document_version_id uuid NOT NULL REFERENCES ai.knowledge_document_version(id),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (grant_id, document_version_id)
);

ALTER TABLE ai.ai_run
    ADD COLUMN authorization_grant_id uuid UNIQUE REFERENCES authz.ai_authorization_grant(id);
ALTER TABLE authz.ai_authorization_grant
    ADD CONSTRAINT fk_ai_authorization_grant_run
    FOREIGN KEY (run_id) REFERENCES ai.ai_run(id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION authz.enforce_ai_authorization_grant_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AI authorization grant cannot be deleted';
    END IF;
    IF OLD.consumed_at IS NOT NULL
       OR (to_jsonb(NEW) - ARRAY['consumed_at', 'run_id'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['consumed_at', 'run_id'])
       OR OLD.run_id IS NOT NULL OR OLD.consumed_at IS NOT NULL
       OR NEW.run_id IS NULL OR NEW.consumed_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AI authorization grant lifecycle is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ai_authorization_grant_lifecycle
BEFORE UPDATE OR DELETE ON authz.ai_authorization_grant
FOR EACH ROW EXECUTE FUNCTION authz.enforce_ai_authorization_grant_lifecycle();

CREATE FUNCTION authz.enforce_ai_authorized_document_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    PERFORM 1 FROM authz.ai_authorization_grant WHERE id = NEW.grant_id FOR UPDATE;
    IF (SELECT count(*) FROM authz.ai_authorized_document WHERE grant_id = NEW.grant_id) >= 500 THEN
        RAISE EXCEPTION USING ERRCODE = '54000', MESSAGE = 'authorized document limit of 500 exceeded';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ai_authorized_document_limit
BEFORE INSERT ON authz.ai_authorized_document
FOR EACH ROW EXECUTE FUNCTION authz.enforce_ai_authorized_document_limit();
CREATE TRIGGER trg_ai_authorized_document_immutable
BEFORE UPDATE OR DELETE ON authz.ai_authorized_document
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();

CREATE TABLE ai.ingestion_job (
    id uuid PRIMARY KEY,
    source_id uuid NOT NULL REFERENCES ai.knowledge_source(id),
    document_id uuid REFERENCES ai.knowledge_document(id),
    source_version text NOT NULL,
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    parser_version text NOT NULL,
    corpus_manifest_digest text NOT NULL CHECK (corpus_manifest_digest ~ '^[0-9a-f]{64}$'),
    checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(checkpoint)),
    stage text NOT NULL CHECK (stage IN ('DISCOVER', 'FETCH', 'PARSE', 'CHUNK', 'EMBED', 'COMPLETE')),
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'RETRY', 'COMPLETED', 'DEAD')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
    next_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    lease_owner text,
    lease_expires_at timestamptz,
    sanitized_error text CHECK (sanitized_error IS NULL OR (
        octet_length(sanitized_error) BETWEEN 1 AND 2048 AND sanitized_error !~ '[[:cntrl:]]'
    )),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (source_id, source_version, content_hash, parser_version),
    CHECK ((status = 'PROCESSING') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK (lease_expires_at IS NULL OR lease_expires_at > created_at),
    CHECK (status <> 'DEAD' OR sanitized_error IS NOT NULL)
);

CREATE TABLE ai.ingestion_attempt (
    id uuid PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES ai.ingestion_job(id),
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    worker_id text NOT NULL,
    stage text NOT NULL CHECK (stage IN ('DISCOVER', 'FETCH', 'PARSE', 'CHUNK', 'EMBED', 'COMPLETE')),
    checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(checkpoint)),
    status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
    sanitized_error text CHECK (sanitized_error IS NULL OR octet_length(sanitized_error) BETWEEN 1 AND 2048),
    started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    completed_at timestamptz,
    UNIQUE (job_id, attempt_number),
    CHECK ((status = 'RUNNING') = (completed_at IS NULL)),
    CHECK (status <> 'FAILED' OR sanitized_error IS NOT NULL)
);

CREATE TABLE ai.event_consumption (
    id uuid PRIMARY KEY,
    consumer_key text NOT NULL,
    event_id uuid NOT NULL,
    event_type text NOT NULL,
    schema_version integer NOT NULL CHECK (schema_version > 0),
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    aggregate_version bigint NOT NULL CHECK (aggregate_version >= 0),
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'RETRY', 'COMPLETED', 'DEAD')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts integer NOT NULL DEFAULT 10 CHECK (max_attempts BETWEEN 1 AND 100),
    next_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    lease_owner text,
    lease_expires_at timestamptz,
    sanitized_terminal_error text CHECK (sanitized_terminal_error IS NULL OR (
        octet_length(sanitized_terminal_error) BETWEEN 1 AND 2048
        AND sanitized_terminal_error !~ '[[:cntrl:]]'
    )),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    completed_at timestamptz,
    UNIQUE (consumer_key, event_id),
    CHECK ((status = 'PROCESSING') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK (status <> 'DEAD' OR sanitized_terminal_error IS NOT NULL),
    CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL)
);

CREATE TABLE ai.model_invocation (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES ai.ai_run(id),
    model_profile_id uuid NOT NULL REFERENCES ai.model_profile(id),
    operation text NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    response_hash text CHECK (response_hash IS NULL OR response_hash ~ '^[0-9a-f]{64}$'),
    provider_request_id text,
    capability_hash text NOT NULL CHECK (capability_hash ~ '^[0-9a-f]{64}$'),
    input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cost numeric NOT NULL DEFAULT 0 CHECK (cost >= 0),
    started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    completed_at timestamptz,
    latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
    status text NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED', 'CANCELLED')),
    sanitized_error text CHECK (sanitized_error IS NULL OR octet_length(sanitized_error) BETWEEN 1 AND 2048),
    CHECK (status <> 'FAILED' OR sanitized_error IS NOT NULL),
    CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE ai.retrieval_trace (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES ai.ai_run(id),
    grant_id uuid NOT NULL REFERENCES authz.ai_authorization_grant(id),
    embedding_space_id uuid NOT NULL REFERENCES ai.embedding_space(id),
    query_hash text NOT NULL CHECK (query_hash ~ '^[0-9a-f]{64}$'),
    authorized_set_digest text NOT NULL CHECK (authorized_set_digest ~ '^[0-9a-f]{64}$'),
    authorized_document_count integer NOT NULL CHECK (authorized_document_count BETWEEN 0 AND 500),
    classification_ceiling text NOT NULL CHECK (classification_ceiling IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
    lexical_candidate_count integer NOT NULL CHECK (lexical_candidate_count >= 0),
    vector_candidate_count integer NOT NULL CHECK (vector_candidate_count >= 0),
    result_count integer NOT NULL CHECK (result_count >= 0),
    ranking_config jsonb NOT NULL CHECK (platform.is_json_object(ranking_config)),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    retention_until timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '1 year'),
    CHECK (retention_until >= created_at + interval '1 year')
);

CREATE TABLE ai.retrieval_hit (
    trace_id uuid NOT NULL REFERENCES ai.retrieval_trace(id) ON DELETE CASCADE,
    document_version_id uuid NOT NULL REFERENCES ai.knowledge_document_version(id),
    chunk_id uuid NOT NULL,
    lexical_score double precision,
    vector_score double precision,
    fused_score double precision NOT NULL,
    rank integer NOT NULL CHECK (rank > 0),
    excerpt_hash text NOT NULL CHECK (excerpt_hash ~ '^[0-9a-f]{64}$'),
    injection_detected boolean NOT NULL DEFAULT false,
    PRIMARY KEY (trace_id, rank),
    UNIQUE (trace_id, chunk_id),
    FOREIGN KEY (chunk_id, document_version_id) REFERENCES ai.knowledge_chunk(id, document_version_id)
);

CREATE TABLE ai.embedding_space_gate_result (
    id uuid PRIMARY KEY,
    dataset_version_id uuid NOT NULL REFERENCES ai.evaluation_dataset_version(id),
    corpus_manifest_digest text NOT NULL CHECK (corpus_manifest_digest ~ '^[0-9a-f]{64}$'),
    expected_active_space_id uuid NOT NULL REFERENCES ai.embedding_space(id),
    eligible_count bigint NOT NULL CHECK (eligible_count >= 0),
    embedded_count bigint NOT NULL CHECK (embedded_count >= 0 AND embedded_count <= eligible_count),
    leakage_count bigint NOT NULL CHECK (leakage_count >= 0),
    citation_numerator bigint NOT NULL CHECK (citation_numerator >= 0),
    citation_denominator bigint NOT NULL CHECK (citation_denominator >= citation_numerator),
    citation_precision numeric GENERATED ALWAYS AS (
        CASE WHEN citation_denominator = 0 THEN 1::numeric ELSE citation_numerator::numeric / citation_denominator END
    ) STORED,
    recall_sum numeric NOT NULL CHECK (recall_sum >= 0),
    recall_count bigint NOT NULL CHECK (recall_count >= 0),
    recall_mean numeric GENERATED ALWAYS AS (
        CASE WHEN recall_count = 0 THEN 1::numeric ELSE recall_sum / recall_count END
    ) STORED,
    minimum_coverage numeric NOT NULL CHECK (minimum_coverage BETWEEN 0 AND 1),
    maximum_leakage bigint NOT NULL CHECK (maximum_leakage >= 0),
    minimum_citation_precision numeric NOT NULL CHECK (minimum_citation_precision BETWEEN 0 AND 1),
    minimum_recall numeric NOT NULL CHECK (minimum_recall BETWEEN 0 AND 1),
    decision text NOT NULL CHECK (decision IN ('PASS', 'FAIL')),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
    evaluated_at timestamptz NOT NULL,
    retention_until timestamptz NOT NULL,
    CHECK (retention_until >= evaluated_at + interval '1 year'),
    CHECK ((decision = 'PASS') = (
        (CASE WHEN eligible_count = 0 THEN 1::numeric ELSE embedded_count::numeric / eligible_count END) >= minimum_coverage
        AND leakage_count <= maximum_leakage
        AND (CASE WHEN citation_denominator = 0 THEN 1::numeric ELSE citation_numerator::numeric / citation_denominator END) >= minimum_citation_precision
        AND (CASE WHEN recall_count = 0 THEN 1::numeric ELSE recall_sum / recall_count END) >= minimum_recall
    )),
    UNIQUE (dataset_version_id, corpus_manifest_digest, expected_active_space_id)
);

CREATE TABLE ai.legal_hold (
    id uuid PRIMARY KEY,
    hold_key text NOT NULL UNIQUE,
    reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 1024),
    placed_by uuid NOT NULL REFERENCES iam.principal(id),
    placed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    released_by uuid REFERENCES iam.principal(id),
    released_at timestamptz,
    CHECK ((released_by IS NULL) = (released_at IS NULL)),
    CHECK (released_at IS NULL OR released_at >= placed_at)
);

CREATE TABLE ai.legal_hold_object (
    hold_id uuid NOT NULL REFERENCES ai.legal_hold(id),
    object_kind text NOT NULL CHECK (object_kind IN ('RUN', 'TRACE', 'INVOCATION', 'ARTIFACT', 'GATE_RESULT', 'AUTHORIZATION_GRANT')),
    object_id uuid NOT NULL,
    fact_key text NOT NULL DEFAULT '',
    held_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (hold_id, object_kind, object_id, fact_key)
);

CREATE FUNCTION ai.enforce_ingestion_job_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ingestion job cannot be deleted';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.document_id IS DISTINCT FROM OLD.document_id
       OR NEW.source_version IS DISTINCT FROM OLD.source_version
       OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
       OR NEW.parser_version IS DISTINCT FROM OLD.parser_version
       OR NEW.corpus_manifest_digest IS DISTINCT FROM OLD.corpus_manifest_digest
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ingestion job deterministic identity is immutable';
    END IF;
    IF OLD.status IN ('COMPLETED', 'DEAD') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal ingestion job is immutable';
    END IF;
    IF NEW.attempts < OLD.attempts OR NEW.attempts > NEW.max_attempts THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ingestion attempts cannot decrease or exceed the retry bound';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status IN ('PENDING', 'RETRY') AND NEW.status IN ('PROCESSING', 'DEAD'))
        OR (OLD.status = 'PROCESSING' AND NEW.status IN ('RETRY', 'COMPLETED', 'DEAD'))
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid ingestion job lifecycle transition';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ingestion_job_lifecycle
BEFORE UPDATE OR DELETE ON ai.ingestion_job
FOR EACH ROW EXECUTE FUNCTION ai.enforce_ingestion_job_lifecycle();

CREATE FUNCTION ai.enforce_ingestion_attempt_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ingestion attempt cannot be deleted';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.job_id IS DISTINCT FROM OLD.job_id
       OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
       OR NEW.worker_id IS DISTINCT FROM OLD.worker_id OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ingestion attempt identity is immutable';
    END IF;
    IF OLD.status IN ('SUCCEEDED', 'FAILED') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal ingestion attempt is immutable';
    END IF;
    IF NEW.status NOT IN ('RUNNING', 'SUCCEEDED', 'FAILED') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid ingestion attempt transition';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ingestion_attempt_lifecycle
BEFORE UPDATE OR DELETE ON ai.ingestion_attempt
FOR EACH ROW EXECUTE FUNCTION ai.enforce_ingestion_attempt_lifecycle();

CREATE FUNCTION ai.enforce_event_consumption_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'event consumption cannot be deleted';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.consumer_key IS DISTINCT FROM OLD.consumer_key
       OR NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.event_type IS DISTINCT FROM OLD.event_type
       OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
       OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
       OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
       OR NEW.aggregate_version IS DISTINCT FROM OLD.aggregate_version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'event consumption identity is immutable';
    END IF;
    IF OLD.status IN ('COMPLETED', 'DEAD') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal event consumption is immutable';
    END IF;
    IF NEW.attempts < OLD.attempts OR NEW.attempts > NEW.max_attempts THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'event attempts cannot decrease or exceed the retry bound';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status IN ('PENDING', 'RETRY') AND NEW.status IN ('PROCESSING', 'DEAD'))
        OR (OLD.status = 'PROCESSING' AND NEW.status IN ('RETRY', 'COMPLETED', 'DEAD'))
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid event consumption lifecycle transition';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_event_consumption_lifecycle
BEFORE UPDATE OR DELETE ON ai.event_consumption
FOR EACH ROW EXECUTE FUNCTION ai.enforce_event_consumption_lifecycle();

CREATE FUNCTION ai.enforce_model_invocation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'model invocation cannot be deleted';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.model_profile_id IS DISTINCT FROM OLD.model_profile_id
       OR NEW.operation IS DISTINCT FROM OLD.operation
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.capability_hash IS DISTINCT FROM OLD.capability_hash
       OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'model invocation request identity is immutable';
    END IF;
    IF OLD.status IN ('COMPLETED', 'FAILED', 'CANCELLED') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal model invocation is immutable';
    END IF;
    IF NEW.status NOT IN ('STARTED', 'COMPLETED', 'FAILED', 'CANCELLED') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid model invocation transition';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_model_invocation_lifecycle
BEFORE UPDATE OR DELETE ON ai.model_invocation
FOR EACH ROW EXECUTE FUNCTION ai.enforce_model_invocation_lifecycle();

CREATE TRIGGER trg_retrieval_trace_immutable
BEFORE UPDATE OR DELETE ON ai.retrieval_trace FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
CREATE TRIGGER trg_retrieval_hit_immutable
BEFORE UPDATE OR DELETE ON ai.retrieval_hit FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
CREATE TRIGGER trg_embedding_space_gate_result_immutable
BEFORE UPDATE OR DELETE ON ai.embedding_space_gate_result FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
CREATE TRIGGER trg_legal_hold_object_immutable
BEFORE UPDATE OR DELETE ON ai.legal_hold_object FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();

CREATE INDEX ix_ai_authorization_grant_expiry ON authz.ai_authorization_grant (expires_at) WHERE consumed_at IS NULL;
CREATE INDEX ix_ai_authorized_document_version ON authz.ai_authorized_document (document_version_id, grant_id);
CREATE INDEX ix_ingestion_job_claim ON ai.ingestion_job (next_attempt_at, created_at) WHERE status IN ('PENDING', 'RETRY');
CREATE INDEX ix_ingestion_job_stale_lease ON ai.ingestion_job (lease_expires_at) WHERE status = 'PROCESSING';
CREATE INDEX ix_ingestion_attempt_job ON ai.ingestion_attempt (job_id, attempt_number DESC);
CREATE INDEX ix_event_consumption_claim ON ai.event_consumption (next_attempt_at, created_at) WHERE status IN ('PENDING', 'RETRY');
CREATE INDEX ix_event_consumption_stale_lease ON ai.event_consumption (lease_expires_at) WHERE status = 'PROCESSING';
CREATE INDEX ix_event_consumption_dead ON ai.event_consumption (created_at) WHERE status = 'DEAD';
CREATE INDEX ix_model_invocation_run ON ai.model_invocation (run_id, started_at);
CREATE INDEX ix_model_invocation_provider_request ON ai.model_invocation (provider_request_id) WHERE provider_request_id IS NOT NULL;
CREATE INDEX ix_retrieval_trace_run ON ai.retrieval_trace (run_id, created_at);
CREATE INDEX ix_retrieval_hit_document ON ai.retrieval_hit (document_version_id, chunk_id);
CREATE INDEX ix_legal_hold_object_lookup ON ai.legal_hold_object (object_kind, object_id) INCLUDE (fact_key);

CREATE FUNCTION authz.consume_ai_authorization_grant(
    p_token_hash text,
    p_run_id uuid,
    p_agent_version_id uuid,
    p_model_profile_id uuid,
    p_prompt_version_id uuid,
    p_package_version_id uuid
)
RETURNS TABLE (run_id uuid, authorized_document_version_ids uuid[], bounded_context jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    grant_row authz.ai_authorization_grant%ROWTYPE;
    current_auth_revision bigint;
    current_release_digest text;
    authorized_ids uuid[];
BEGIN
    SELECT * INTO grant_row
    FROM authz.ai_authorization_grant
    WHERE token_hash = p_token_hash
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'AI authorization grant is invalid';
    END IF;
    IF grant_row.consumed_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AI authorization grant replay: already consumed';
    END IF;
    IF transaction_timestamp() < grant_row.issued_at OR transaction_timestamp() >= grant_row.expires_at THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'AI authorization grant expired';
    END IF;
    SELECT current_revision INTO STRICT current_auth_revision
    FROM authz.authorization_state WHERE singleton FOR SHARE;
    IF current_auth_revision <> grant_row.authorization_revision THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'AI authorization grant has stale authorization revision';
    END IF;
    SELECT content_hash INTO STRICT current_release_digest
    FROM authz.policy_release WHERE id = grant_row.policy_release_id;
    IF current_release_digest <> grant_row.policy_release_digest THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'AI authorization grant has stale policy release';
    END IF;
    SELECT coalesce(array_agg(document_version_id ORDER BY document_version_id), ARRAY[]::uuid[])
    INTO authorized_ids
    FROM authz.ai_authorized_document WHERE grant_id = grant_row.id;

    INSERT INTO ai.ai_run (
        id, agent_version_id, model_profile_id, prompt_version_id, package_version_id,
        policy_release_id, triggered_by, target_entity_id, status, authorization_grant_id
    ) VALUES (
        p_run_id, p_agent_version_id, p_model_profile_id, p_prompt_version_id, p_package_version_id,
        grant_row.policy_release_id, grant_row.principal_id, grant_row.target_entity_id, 'QUEUED', grant_row.id
    );
    UPDATE authz.ai_authorization_grant
    SET consumed_at = transaction_timestamp(), run_id = p_run_id
    WHERE id = grant_row.id;
    RETURN QUERY SELECT p_run_id, authorized_ids, grant_row.bounded_context;
END;
$$;

CREATE FUNCTION ai.claim_ingestion_jobs(p_worker_id text, p_limit integer, p_lease interval)
RETURNS SETOF ai.ingestion_job
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR p_limit NOT BETWEEN 1 AND 100
       OR p_lease <= interval '0' OR p_lease > interval '15 minutes' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid ingestion claim bounds';
    END IF;
    RETURN QUERY
    WITH candidates AS (
        SELECT id FROM ai.ingestion_job
        WHERE ((status IN ('PENDING', 'RETRY') AND next_attempt_at <= transaction_timestamp())
               OR (status = 'PROCESSING' AND lease_expires_at <= transaction_timestamp()))
          AND attempts < max_attempts
        ORDER BY next_attempt_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
    )
    UPDATE ai.ingestion_job job
    SET status = 'PROCESSING', lease_owner = p_worker_id,
        lease_expires_at = transaction_timestamp() + p_lease,
        attempts = job.attempts + 1, updated_at = statement_timestamp()
    FROM candidates WHERE job.id = candidates.id RETURNING job.*;
END;
$$;

CREATE FUNCTION ai.claim_event_consumptions(p_worker_id text, p_limit integer, p_lease interval)
RETURNS SETOF ai.event_consumption
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR p_limit NOT BETWEEN 1 AND 100
       OR p_lease <= interval '0' OR p_lease > interval '15 minutes' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid event claim bounds';
    END IF;
    RETURN QUERY
    WITH candidates AS (
        SELECT id FROM ai.event_consumption
        WHERE ((status IN ('PENDING', 'RETRY') AND next_attempt_at <= transaction_timestamp())
               OR (status = 'PROCESSING' AND lease_expires_at <= transaction_timestamp()))
          AND attempts < max_attempts
        ORDER BY next_attempt_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
    )
    UPDATE ai.event_consumption event
    SET status = 'PROCESSING', lease_owner = p_worker_id,
        lease_expires_at = transaction_timestamp() + p_lease,
        attempts = event.attempts + 1
    FROM candidates WHERE event.id = candidates.id RETURNING event.*;
END;
$$;

CREATE FUNCTION ai.authorized_hybrid_retrieval(
    p_run_id uuid,
    p_space_id uuid,
    p_query text,
    p_query_embedding public.vector,
    p_lexical_limit integer,
    p_vector_limit integer,
    p_result_limit integer
)
RETURNS TABLE (
    chunk_id uuid, document_version_id uuid, content text,
    lexical_score double precision, vector_score double precision,
    fused_score double precision, rank bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF p_lexical_limit NOT BETWEEN 1 AND 200 OR p_vector_limit NOT BETWEEN 1 AND 200
       OR p_result_limit NOT BETWEEN 1 AND 100 OR octet_length(p_query) > 8192 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid retrieval bounds';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM authz.ai_authorization_grant grant_row
        WHERE grant_row.run_id = p_run_id AND grant_row.consumed_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'run has no consumed AI authorization grant';
    END IF;
    RETURN QUERY
    WITH grant_scope AS (
        SELECT grant_row.id, grant_row.classification_ceiling
        FROM authz.ai_authorization_grant grant_row WHERE grant_row.run_id = p_run_id
    ), lexical AS (
        SELECT chunk.id, chunk.document_version_id,
               ts_rank_cd(chunk.search_vector, plainto_tsquery('simple', p_query))::double precision AS score,
               row_number() OVER (ORDER BY ts_rank_cd(chunk.search_vector, plainto_tsquery('simple', p_query)) DESC, chunk.id) AS position
        FROM grant_scope scope
        JOIN authz.ai_authorized_document allowed ON allowed.grant_id = scope.id
        JOIN ai.knowledge_document_version document ON document.id = allowed.document_version_id
        JOIN ai.knowledge_chunk chunk ON chunk.document_version_id = allowed.document_version_id
        WHERE chunk.search_vector @@ plainto_tsquery('simple', p_query)
          AND CASE document.data_classification WHEN 'PUBLIC' THEN 1 WHEN 'INTERNAL' THEN 2 WHEN 'CONFIDENTIAL' THEN 3 ELSE 4 END
              <= CASE scope.classification_ceiling WHEN 'PUBLIC' THEN 1 WHEN 'INTERNAL' THEN 2 WHEN 'CONFIDENTIAL' THEN 3 ELSE 4 END
        ORDER BY score DESC, chunk.id LIMIT p_lexical_limit
    ), vector_candidates AS (
        SELECT chunk.id, chunk.document_version_id,
               (1 - (embedding.embedding OPERATOR(public.<=>) p_query_embedding))::double precision AS score,
               row_number() OVER (ORDER BY embedding.embedding OPERATOR(public.<=>) p_query_embedding, chunk.id) AS position
        FROM grant_scope scope
        JOIN authz.ai_authorized_document allowed ON allowed.grant_id = scope.id
        JOIN ai.knowledge_document_version document ON document.id = allowed.document_version_id
        JOIN ai.knowledge_chunk chunk ON chunk.document_version_id = allowed.document_version_id
        JOIN ai.chunk_embedding embedding ON embedding.chunk_id = chunk.id AND embedding.embedding_space_id = p_space_id
        WHERE CASE document.data_classification WHEN 'PUBLIC' THEN 1 WHEN 'INTERNAL' THEN 2 WHEN 'CONFIDENTIAL' THEN 3 ELSE 4 END
              <= CASE scope.classification_ceiling WHEN 'PUBLIC' THEN 1 WHEN 'INTERNAL' THEN 2 WHEN 'CONFIDENTIAL' THEN 3 ELSE 4 END
        ORDER BY embedding.embedding OPERATOR(public.<=>) p_query_embedding, chunk.id LIMIT p_vector_limit
    ), fused AS (
        SELECT coalesce(lexical.id, vector_candidates.id) AS id,
               coalesce(lexical.document_version_id, vector_candidates.document_version_id) AS document_version_id,
               lexical.score AS lexical_score, vector_candidates.score AS vector_score,
               (coalesce(1.0 / (60 + lexical.position), 0)
                + coalesce(1.0 / (60 + vector_candidates.position), 0))::double precision AS fused_score
        FROM lexical FULL JOIN vector_candidates USING (id, document_version_id)
    ), ranked AS (
        SELECT fused.*, row_number() OVER (ORDER BY fused.fused_score DESC, fused.id) AS final_rank
        FROM fused
    )
    SELECT ranked.id, ranked.document_version_id, chunk.content,
           ranked.lexical_score, ranked.vector_score, ranked.fused_score, ranked.final_rank
    FROM ranked JOIN ai.knowledge_chunk chunk ON chunk.id = ranked.id
    ORDER BY ranked.final_rank LIMIT p_result_limit;
END;
$$;

REVOKE ALL ON SCHEMA platform FROM innorder_ai_runtime;
REVOKE ALL ON SCHEMA catalog FROM innorder_ai_runtime;
REVOKE ALL ON SCHEMA iam FROM innorder_ai_runtime;
REVOKE ALL ON SCHEMA authz FROM innorder_ai_runtime;
REVOKE ALL ON SCHEMA occ FROM innorder_ai_runtime;
REVOKE ALL ON SCHEMA audit FROM innorder_ai_runtime;
REVOKE ALL ON SCHEMA ai FROM innorder_ai_runtime;
REVOKE ALL ON SCHEMA flowable FROM innorder_ai_runtime;
REVOKE ALL ON SCHEMA public FROM innorder_ai_runtime;
GRANT USAGE ON SCHEMA ai, public TO innorder_ai_runtime;
GRANT USAGE ON SCHEMA authz TO innorder_ai_runtime;

GRANT SELECT ON ai.model_profile, ai.prompt_template_version, ai.agent_definition_version,
    ai.tool_definition, ai.agent_tool_grant, ai.embedding_space,
    ai.evaluation_dataset_version, ai.evaluation_case
TO innorder_ai_runtime;
GRANT SELECT, INSERT ON ai.knowledge_document_version, ai.knowledge_chunk, ai.chunk_embedding
TO innorder_ai_runtime;
GRANT SELECT, INSERT, UPDATE ON ai.ingestion_job, ai.ingestion_attempt, ai.event_consumption,
    ai.model_invocation
TO innorder_ai_runtime;
GRANT SELECT, INSERT ON ai.retrieval_trace, ai.retrieval_hit TO innorder_ai_runtime;
GRANT SELECT ON ai.embedding_space_gate_result TO innorder_ai_runtime;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA authz, ai FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA authz, ai TO innorder_runtime;
REVOKE ALL ON FUNCTION authz.consume_ai_authorization_grant(text, uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai.claim_ingestion_jobs(text, integer, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai.claim_event_consumptions(text, integer, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai.authorized_hybrid_retrieval(uuid, uuid, text, public.vector, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.consume_ai_authorization_grant(text, uuid, uuid, uuid, uuid, uuid) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.claim_ingestion_jobs(text, integer, interval) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.claim_event_consumptions(text, integer, interval) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.authorized_hybrid_retrieval(uuid, uuid, text, public.vector, integer, integer, integer) TO innorder_ai_runtime;
