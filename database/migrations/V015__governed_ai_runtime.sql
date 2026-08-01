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
        AND octet_length(bounded_context::text) <= 32768
    ),
    classification_ceiling text NOT NULL
        CHECK (classification_ceiling IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
    agent_version_id uuid NOT NULL REFERENCES ai.agent_definition_version(id),
    model_profile_id uuid NOT NULL REFERENCES ai.model_profile(id),
    prompt_version_id uuid NOT NULL REFERENCES ai.prompt_template_version(id),
    package_version_id uuid NOT NULL REFERENCES catalog.package_version(id),
    embedding_space_id uuid NOT NULL REFERENCES ai.embedding_space(id),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    event_id uuid NOT NULL,
    intended_run_id uuid NOT NULL UNIQUE,
    run_id uuid UNIQUE,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK (issued_at <= created_at + interval '1 minute'),
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '5 minutes'),
    CHECK ((consumed_at IS NULL AND run_id IS NULL) OR (consumed_at IS NOT NULL AND run_id IS NOT NULL)),
    CHECK (consumed_at IS NULL OR (consumed_at >= issued_at AND consumed_at < expires_at)),
    UNIQUE (id, run_id),
    UNIQUE (id, agent_version_id, model_profile_id, prompt_version_id,
            package_version_id, policy_release_id, embedding_space_id)
);

CREATE TABLE authz.ai_authorized_document (
    grant_id uuid NOT NULL REFERENCES authz.ai_authorization_grant(id) ON DELETE CASCADE,
    document_version_id uuid NOT NULL REFERENCES ai.knowledge_document_version(id),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (grant_id, document_version_id)
);

ALTER TABLE ai.ai_run
    ADD COLUMN authorization_grant_id uuid UNIQUE REFERENCES authz.ai_authorization_grant(id),
    ADD COLUMN embedding_space_id uuid REFERENCES ai.embedding_space(id),
    ADD CONSTRAINT uq_ai_run_grant UNIQUE (id, authorization_grant_id);
ALTER TABLE ai.ai_run
    ADD CONSTRAINT fk_ai_run_grant_configuration
    FOREIGN KEY (authorization_grant_id, agent_version_id, model_profile_id, prompt_version_id,
                 package_version_id, policy_release_id, embedding_space_id)
    REFERENCES authz.ai_authorization_grant
        (id, agent_version_id, model_profile_id, prompt_version_id,
         package_version_id, policy_release_id, embedding_space_id);
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
    produced_document_version_id uuid REFERENCES ai.knowledge_document_version(id),
    source_version text NOT NULL,
    source_object_hash text NOT NULL CHECK (source_object_hash ~ '^[0-9a-f]{64}$'),
    normalized_content_hash text NOT NULL CHECK (normalized_content_hash ~ '^[0-9a-f]{64}$'),
    parser_version text NOT NULL CHECK (octet_length(parser_version) BETWEEN 1 AND 128 AND parser_version !~ '[[:cntrl:]]'),
    chunker_version text NOT NULL CHECK (octet_length(chunker_version) BETWEEN 1 AND 128 AND chunker_version !~ '[[:cntrl:]]'),
    corpus_manifest_digest text NOT NULL CHECK (corpus_manifest_digest ~ '^[0-9a-f]{64}$'),
    checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(checkpoint)),
    stage text NOT NULL CHECK (stage IN ('DISCOVER', 'FETCH', 'PARSE', 'CHUNK', 'EMBED', 'COMPLETE')),
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'RETRY', 'COMPLETED', 'FAILED')),
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
    completed_at timestamptz,
    UNIQUE (source_id, source_version, source_object_hash, normalized_content_hash, parser_version, chunker_version),
    CHECK ((status = 'PROCESSING') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK (lease_expires_at IS NULL OR lease_expires_at > created_at),
    CHECK (status <> 'FAILED' OR (sanitized_error IS NOT NULL AND completed_at IS NOT NULL)),
    CHECK (status <> 'COMPLETED' OR (produced_document_version_id IS NOT NULL AND completed_at IS NOT NULL)),
    CHECK (status IN ('COMPLETED', 'FAILED') OR completed_at IS NULL)
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
    lease_expires_at timestamptz NOT NULL,
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
    dead_at timestamptz,
    UNIQUE (consumer_key, event_id),
    CHECK ((status = 'PROCESSING') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK (status <> 'DEAD' OR (sanitized_terminal_error IS NOT NULL AND dead_at IS NOT NULL)),
    CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL),
    CHECK (status = 'DEAD' OR dead_at IS NULL)
);

CREATE TABLE ai.retention_policy (
    object_kind text PRIMARY KEY CHECK (object_kind IN ('TRACE', 'RETRIEVAL_HIT', 'INVOCATION', 'GATE_RESULT', 'GATE_EVIDENCE', 'ARTIFACT')),
    retention_interval interval NOT NULL DEFAULT interval '1 year'
        CHECK (retention_interval >= interval '1 year'),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

INSERT INTO ai.retention_policy (object_kind)
VALUES ('TRACE'), ('RETRIEVAL_HIT'), ('INVOCATION'), ('GATE_RESULT'), ('GATE_EVIDENCE'), ('ARTIFACT');

CREATE TABLE ai.model_invocation (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES ai.ai_run(id),
    model_profile_id uuid NOT NULL REFERENCES ai.model_profile(id),
    operation text NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    response_hash text CHECK (response_hash IS NULL OR response_hash ~ '^[0-9a-f]{64}$'),
    provider_request_id_hash text CHECK (provider_request_id_hash IS NULL OR provider_request_id_hash ~ '^[0-9a-f]{64}$'),
    capability_hash text NOT NULL CHECK (capability_hash ~ '^[0-9a-f]{64}$'),
    input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cost numeric NOT NULL DEFAULT 0 CHECK (cost >= 0),
    started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    completed_at timestamptz,
    latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
    status text NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED', 'CANCELLED')),
    sanitized_error text CHECK (sanitized_error IS NULL OR octet_length(sanitized_error) BETWEEN 1 AND 2048),
    retention_until timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '1 year'),
    legal_hold_id uuid,
    CHECK (status <> 'FAILED' OR sanitized_error IS NOT NULL),
    CHECK (completed_at IS NULL OR completed_at >= started_at),
    CHECK (retention_until >= started_at + interval '1 year')
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
    legal_hold_id uuid,
    CHECK (retention_until >= created_at + interval '1 year'),
    CONSTRAINT fk_retrieval_trace_grant_run FOREIGN KEY (grant_id, run_id)
        REFERENCES authz.ai_authorization_grant(id, run_id),
    CONSTRAINT fk_retrieval_trace_run_grant FOREIGN KEY (run_id, grant_id)
        REFERENCES ai.ai_run(id, authorization_grant_id)
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
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    retention_until timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '1 year'),
    legal_hold_id uuid,
    PRIMARY KEY (trace_id, rank),
    UNIQUE (trace_id, chunk_id),
    FOREIGN KEY (chunk_id, document_version_id) REFERENCES ai.knowledge_chunk(id, document_version_id),
    CHECK (retention_until >= created_at + interval '1 year')
);

CREATE TABLE ai.embedding_space_gate_evaluation (
    id uuid PRIMARY KEY,
    dataset_version_id uuid NOT NULL REFERENCES ai.evaluation_dataset_version(id),
    dataset_content_hash text NOT NULL CHECK (dataset_content_hash ~ '^[0-9a-f]{64}$'),
    corpus_manifest_digest text NOT NULL CHECK (corpus_manifest_digest ~ '^[0-9a-f]{64}$'),
    document_manifest text NOT NULL CHECK (octet_length(document_manifest) > 0),
    candidate_embedding_space_id uuid NOT NULL REFERENCES ai.embedding_space(id),
    expected_active_space_id uuid NOT NULL REFERENCES ai.embedding_space(id),
    eligible_count bigint NOT NULL CHECK (eligible_count > 0),
    embedded_count bigint NOT NULL CHECK (embedded_count >= 0 AND embedded_count <= eligible_count),
    leakage_count bigint NOT NULL CHECK (leakage_count >= 0),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    retention_until timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '1 year'),
    legal_hold_id uuid,
    CHECK (retention_until >= created_at + interval '1 year'),
    UNIQUE (dataset_version_id, corpus_manifest_digest, candidate_embedding_space_id),
    UNIQUE (id, dataset_version_id, dataset_content_hash, document_manifest)
);

CREATE TABLE ai.embedding_space_gate_case_evidence (
    evaluation_id uuid NOT NULL REFERENCES ai.embedding_space_gate_evaluation(id),
    case_id uuid NOT NULL REFERENCES ai.evaluation_case(id),
    citation_numerator bigint NOT NULL CHECK (citation_numerator >= 0),
    citation_denominator bigint NOT NULL CHECK (citation_denominator > 0 AND citation_denominator >= citation_numerator),
    recall_at_10 numeric NOT NULL CHECK (recall_at_10 BETWEEN 0 AND 1),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    retention_until timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '1 year'),
    legal_hold_id uuid,
    PRIMARY KEY (evaluation_id, case_id),
    CHECK (retention_until >= created_at + interval '1 year')
);

CREATE TABLE ai.embedding_space_gate_result (
    id uuid PRIMARY KEY REFERENCES ai.embedding_space_gate_evaluation(id),
    dataset_version_id uuid NOT NULL REFERENCES ai.evaluation_dataset_version(id),
    dataset_content_hash text NOT NULL CHECK (dataset_content_hash ~ '^[0-9a-f]{64}$'),
    corpus_manifest_digest text NOT NULL CHECK (corpus_manifest_digest ~ '^[0-9a-f]{64}$'),
    document_manifest text NOT NULL CHECK (octet_length(document_manifest) > 0),
    candidate_embedding_space_id uuid NOT NULL REFERENCES ai.embedding_space(id),
    expected_active_space_id uuid NOT NULL REFERENCES ai.embedding_space(id),
    eligible_count bigint NOT NULL CHECK (eligible_count > 0),
    embedded_count bigint NOT NULL CHECK (embedded_count >= 0 AND embedded_count <= eligible_count),
    leakage_count bigint NOT NULL CHECK (leakage_count >= 0),
    citation_numerator bigint NOT NULL CHECK (citation_numerator >= 0),
    citation_denominator bigint NOT NULL CHECK (citation_denominator > 0 AND citation_denominator >= citation_numerator),
    citation_precision numeric GENERATED ALWAYS AS (citation_numerator::numeric / citation_denominator) STORED,
    recall_sum numeric NOT NULL CHECK (recall_sum >= 0),
    recall_count bigint NOT NULL CHECK (recall_count > 0),
    recall_mean numeric GENERATED ALWAYS AS (recall_sum / recall_count) STORED,
    minimum_coverage numeric NOT NULL DEFAULT 1.0 CHECK (minimum_coverage = 1.0),
    maximum_leakage bigint NOT NULL DEFAULT 0 CHECK (maximum_leakage = 0),
    minimum_citation_precision numeric NOT NULL DEFAULT 0.95 CHECK (minimum_citation_precision = 0.95),
    minimum_recall_at_10 numeric NOT NULL DEFAULT 0.85 CHECK (minimum_recall_at_10 = 0.85),
    decision text NOT NULL CHECK (decision IN ('PASS', 'FAIL')),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
    evaluated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    retention_until timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '1 year'),
    legal_hold_id uuid,
    CHECK (retention_until >= evaluated_at + interval '1 year'),
    CHECK ((decision = 'PASS') = (
        embedded_count::numeric / eligible_count >= minimum_coverage
        AND leakage_count <= maximum_leakage
        AND citation_numerator::numeric / citation_denominator >= minimum_citation_precision
        AND recall_sum / recall_count >= minimum_recall_at_10
    )),
    UNIQUE (dataset_version_id, corpus_manifest_digest, candidate_embedding_space_id),
    FOREIGN KEY (id, dataset_version_id, dataset_content_hash, document_manifest)
        REFERENCES ai.embedding_space_gate_evaluation(id, dataset_version_id, dataset_content_hash, document_manifest)
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

ALTER TABLE ai.model_invocation
    ADD CONSTRAINT fk_model_invocation_legal_hold FOREIGN KEY (legal_hold_id) REFERENCES ai.legal_hold(id);
ALTER TABLE ai.retrieval_trace
    ADD CONSTRAINT fk_retrieval_trace_legal_hold FOREIGN KEY (legal_hold_id) REFERENCES ai.legal_hold(id);
ALTER TABLE ai.retrieval_hit
    ADD CONSTRAINT fk_retrieval_hit_legal_hold FOREIGN KEY (legal_hold_id) REFERENCES ai.legal_hold(id);
ALTER TABLE ai.embedding_space_gate_evaluation
    ADD CONSTRAINT fk_gate_evaluation_legal_hold FOREIGN KEY (legal_hold_id) REFERENCES ai.legal_hold(id);
ALTER TABLE ai.embedding_space_gate_case_evidence
    ADD CONSTRAINT fk_gate_case_evidence_legal_hold FOREIGN KEY (legal_hold_id) REFERENCES ai.legal_hold(id);
ALTER TABLE ai.embedding_space_gate_result
    ADD CONSTRAINT fk_gate_result_legal_hold FOREIGN KEY (legal_hold_id) REFERENCES ai.legal_hold(id);
UPDATE ai.ai_run_artifact
SET retention_until = created_at + interval '1 year'
WHERE retention_until < created_at + interval '1 year';
ALTER TABLE ai.ai_run_artifact
    ALTER COLUMN retention_until SET DEFAULT (statement_timestamp() + interval '1 year'),
    ADD COLUMN legal_hold_id uuid REFERENCES ai.legal_hold(id),
    ADD CONSTRAINT ck_ai_run_artifact_one_year_retention
        CHECK (retention_until >= created_at + interval '1 year');

CREATE FUNCTION ai.enforce_run_artifact_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    table_owner text;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AI run artifact is immutable';
    END IF;
    SELECT pg_get_userbyid(relowner) INTO STRICT table_owner
    FROM pg_class WHERE oid = TG_RELID;
    IF current_setting('innorder.artifact_cleanup', true) IS DISTINCT FROM 'on'
       OR current_user IS DISTINCT FROM table_owner THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'artifact deletion requires bounded retention cleanup';
    END IF;
    IF OLD.retention_until > statement_timestamp() THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'artifact retention period has not elapsed';
    END IF;
    IF EXISTS (
        SELECT 1 FROM ai.legal_hold hold_row
        WHERE hold_row.id = OLD.legal_hold_id AND hold_row.released_at IS NULL
    ) OR EXISTS (
        SELECT 1 FROM ai.legal_hold_object held
        JOIN ai.legal_hold hold_row ON hold_row.id = held.hold_id
        WHERE held.object_kind = 'ARTIFACT' AND held.object_id = OLD.id
          AND hold_row.released_at IS NULL
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'artifact is under an active legal hold';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER trg_ai_run_artifact_lifecycle
BEFORE UPDATE OR DELETE ON ai.ai_run_artifact
FOR EACH ROW EXECUTE FUNCTION ai.enforce_run_artifact_lifecycle();

CREATE FUNCTION ai.cleanup_expired_run_artifacts(p_before timestamptz, p_limit integer)
RETURNS TABLE (artifact_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF p_before IS NULL OR p_before > statement_timestamp()
       OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid artifact cleanup bounds';
    END IF;
    PERFORM set_config('innorder.artifact_cleanup', 'on', true);
    RETURN QUERY
    WITH candidates AS (
        SELECT artifact.id
        FROM ai.ai_run_artifact artifact
        WHERE artifact.retention_until <= p_before
          AND artifact.retention_until <= statement_timestamp()
          AND NOT EXISTS (
              SELECT 1 FROM ai.legal_hold hold_row
              WHERE hold_row.id = artifact.legal_hold_id AND hold_row.released_at IS NULL
          )
          AND NOT EXISTS (
              SELECT 1 FROM ai.legal_hold_object held
              JOIN ai.legal_hold hold_row ON hold_row.id = held.hold_id
              WHERE held.object_kind = 'ARTIFACT' AND held.object_id = artifact.id
                AND hold_row.released_at IS NULL
          )
        ORDER BY artifact.retention_until, artifact.id
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
    )
    DELETE FROM ai.ai_run_artifact artifact
    USING candidates
    WHERE artifact.id = candidates.id
    RETURNING artifact.id;
    PERFORM set_config('innorder.artifact_cleanup', 'off', true);
END;
$$;

CREATE FUNCTION ai.enforce_evaluation_dataset_version_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'DRAFT' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'evaluation dataset versions must be inserted in DRAFT state';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF OLD.status IN ('PUBLISHED', 'RETIRED') THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'published evaluation dataset version is immutable';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.status = 'RETIRED' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'retired evaluation dataset version is immutable';
    END IF;
    IF OLD.status = 'PUBLISHED' THEN
        IF NEW.status = 'RETIRED' AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'published evaluation dataset version is immutable';
    END IF;
    IF NEW.status = 'RETIRED' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'evaluation dataset version must be published before retirement';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_evaluation_dataset_version_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON ai.evaluation_dataset_version
FOR EACH ROW EXECUTE FUNCTION ai.enforce_evaluation_dataset_version_lifecycle();

CREATE FUNCTION ai.enforce_evaluation_case_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    old_dataset_status text;
    new_dataset_status text;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        SELECT status INTO STRICT old_dataset_status
        FROM ai.evaluation_dataset_version WHERE id = OLD.dataset_version_id FOR SHARE;
        IF old_dataset_status IN ('PUBLISHED', 'RETIRED') THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'evaluation cases for published or retired datasets are immutable';
        END IF;
    END IF;
    IF TG_OP <> 'DELETE' THEN
        SELECT status INTO STRICT new_dataset_status
        FROM ai.evaluation_dataset_version WHERE id = NEW.dataset_version_id FOR SHARE;
        IF new_dataset_status <> 'DRAFT' THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'evaluation cases for published or retired datasets are immutable';
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_evaluation_case_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON ai.evaluation_case
FOR EACH ROW EXECUTE FUNCTION ai.enforce_evaluation_case_lifecycle();

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
       OR NEW.source_object_hash IS DISTINCT FROM OLD.source_object_hash
       OR NEW.normalized_content_hash IS DISTINCT FROM OLD.normalized_content_hash
       OR NEW.parser_version IS DISTINCT FROM OLD.parser_version
       OR NEW.chunker_version IS DISTINCT FROM OLD.chunker_version
       OR NEW.corpus_manifest_digest IS DISTINCT FROM OLD.corpus_manifest_digest
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ingestion job deterministic identity is immutable';
    END IF;
    IF OLD.produced_document_version_id IS NOT NULL
       AND NEW.produced_document_version_id IS DISTINCT FROM OLD.produced_document_version_id THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'produced ingestion document version is immutable';
    END IF;
    IF OLD.status IN ('COMPLETED', 'FAILED') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal ingestion job is immutable';
    END IF;
    IF NEW.attempts < OLD.attempts OR NEW.attempts > NEW.max_attempts THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ingestion attempts cannot decrease or exceed the retry bound';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status IN ('PENDING', 'RETRY') AND NEW.status IN ('PROCESSING', 'FAILED'))
        OR (OLD.status = 'PROCESSING' AND NEW.status IN ('RETRY', 'COMPLETED', 'FAILED'))
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

CREATE FUNCTION ai.validate_retrieval_hit_authorized()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM ai.retrieval_trace trace
        JOIN authz.ai_authorized_document allowed
          ON allowed.grant_id = trace.grant_id
         AND allowed.document_version_id = NEW.document_version_id
        WHERE trace.id = NEW.trace_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retrieval hit document is not authorized by grant';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_retrieval_hit_authorized
BEFORE INSERT ON ai.retrieval_hit
FOR EACH ROW EXECUTE FUNCTION ai.validate_retrieval_hit_authorized();

CREATE TRIGGER trg_retrieval_trace_immutable
BEFORE UPDATE OR DELETE ON ai.retrieval_trace FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
CREATE TRIGGER trg_retrieval_hit_immutable
BEFORE UPDATE OR DELETE ON ai.retrieval_hit FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
CREATE TRIGGER trg_embedding_space_gate_result_immutable
BEFORE UPDATE OR DELETE ON ai.embedding_space_gate_result FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
CREATE TRIGGER trg_embedding_space_gate_evaluation_immutable
BEFORE UPDATE OR DELETE ON ai.embedding_space_gate_evaluation FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
CREATE TRIGGER trg_embedding_space_gate_case_evidence_immutable
BEFORE UPDATE OR DELETE ON ai.embedding_space_gate_case_evidence FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
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
CREATE INDEX ix_model_invocation_provider_request_hash ON ai.model_invocation (provider_request_id_hash)
WHERE provider_request_id_hash IS NOT NULL;
CREATE INDEX ix_retrieval_trace_run ON ai.retrieval_trace (run_id, created_at);
CREATE INDEX ix_retrieval_hit_document ON ai.retrieval_hit (document_version_id, chunk_id);
CREATE INDEX ix_legal_hold_object_lookup ON ai.legal_hold_object (object_kind, object_id) INCLUDE (fact_key);

CREATE FUNCTION authz.consume_ai_authorization_grant(
    p_token_hash text,
    p_event_id uuid,
    p_operation text,
    p_authorization_revision bigint,
    p_policy_release_digest text,
    p_authorized_set_digest text,
    p_context_digest text,
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
    IF p_token_hash IS NULL OR p_event_id IS NULL OR p_operation IS NULL
       OR p_authorization_revision IS NULL OR p_policy_release_digest IS NULL
       OR p_authorized_set_digest IS NULL OR p_context_digest IS NULL OR p_run_id IS NULL
       OR p_agent_version_id IS NULL OR p_model_profile_id IS NULL
       OR p_prompt_version_id IS NULL OR p_package_version_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22004', MESSAGE = 'signed AI grant claims cannot be NULL';
    END IF;
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
    IF grant_row.event_id IS DISTINCT FROM p_event_id THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'grant token event mismatch';
    END IF;
    IF grant_row.operation IS DISTINCT FROM p_operation THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'grant token operation mismatch';
    END IF;
    IF grant_row.intended_run_id IS DISTINCT FROM p_run_id
       OR (grant_row.run_id IS NOT NULL AND grant_row.run_id IS DISTINCT FROM p_run_id) THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'grant token run mismatch';
    END IF;
    IF grant_row.authorized_set_digest IS DISTINCT FROM p_authorized_set_digest THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'grant token authorized-set digest mismatch';
    END IF;
    IF grant_row.context_digest IS DISTINCT FROM p_context_digest THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'grant token context digest mismatch';
    END IF;
    IF grant_row.policy_release_digest IS DISTINCT FROM p_policy_release_digest THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'grant token release digest mismatch';
    END IF;
    IF grant_row.authorization_revision IS DISTINCT FROM p_authorization_revision THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'grant token authorization revision mismatch';
    END IF;
    IF grant_row.agent_version_id IS DISTINCT FROM p_agent_version_id THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'grant token agent version mismatch';
    END IF;
    IF grant_row.model_profile_id IS DISTINCT FROM p_model_profile_id THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'grant token model profile mismatch';
    END IF;
    IF grant_row.prompt_version_id IS DISTINCT FROM p_prompt_version_id THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'grant token prompt version mismatch';
    END IF;
    IF grant_row.package_version_id IS DISTINCT FROM p_package_version_id THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'grant token package version mismatch';
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
        policy_release_id, triggered_by, target_entity_id, status, authorization_grant_id,
        embedding_space_id
    ) VALUES (
        grant_row.intended_run_id, grant_row.agent_version_id, grant_row.model_profile_id,
        grant_row.prompt_version_id, grant_row.package_version_id, grant_row.policy_release_id,
        grant_row.principal_id, grant_row.target_entity_id, 'QUEUED', grant_row.id,
        grant_row.embedding_space_id
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
    IF p_worker_id IS NULL OR btrim(p_worker_id) = ''
       OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
       OR p_lease IS NULL OR p_lease <= interval '0' OR p_lease > interval '15 minutes' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid ingestion claim bounds';
    END IF;
    UPDATE ai.ingestion_attempt attempt
    SET status = 'FAILED', sanitized_error = 'LEASE_EXPIRED_MAX_ATTEMPTS',
        completed_at = statement_timestamp()
    FROM ai.ingestion_job job
    WHERE attempt.job_id = job.id AND attempt.attempt_number = job.attempts
      AND attempt.status = 'RUNNING' AND job.status = 'PROCESSING'
      AND job.lease_expires_at <= transaction_timestamp() AND job.attempts >= job.max_attempts;

    UPDATE ai.ingestion_attempt attempt
    SET status = 'FAILED', sanitized_error = 'LEASE_EXPIRED_RETRY',
        completed_at = statement_timestamp()
    FROM ai.ingestion_job job
    WHERE attempt.job_id = job.id AND attempt.attempt_number = job.attempts
      AND attempt.status = 'RUNNING' AND job.status = 'PROCESSING'
      AND job.lease_expires_at <= transaction_timestamp() AND job.attempts < job.max_attempts;

    UPDATE ai.ingestion_job
    SET status = 'FAILED', sanitized_error = 'LEASE_EXPIRED_MAX_ATTEMPTS',
        completed_at = statement_timestamp(), lease_owner = NULL, lease_expires_at = NULL,
        updated_at = statement_timestamp()
    WHERE status = 'PROCESSING' AND lease_expires_at <= transaction_timestamp()
      AND attempts >= max_attempts;

    UPDATE ai.ingestion_job
    SET status = 'RETRY', sanitized_error = 'LEASE_EXPIRED_RETRY',
        lease_owner = NULL, lease_expires_at = NULL, updated_at = statement_timestamp()
    WHERE status = 'PROCESSING' AND lease_expires_at <= transaction_timestamp()
      AND attempts < max_attempts;

    RETURN QUERY
    WITH candidates AS (
        SELECT id FROM ai.ingestion_job
        WHERE status IN ('PENDING', 'RETRY') AND next_attempt_at <= transaction_timestamp()
          AND attempts < max_attempts
        ORDER BY next_attempt_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
    ), claimed AS (
    UPDATE ai.ingestion_job job
    SET status = 'PROCESSING', lease_owner = p_worker_id,
        lease_expires_at = transaction_timestamp() + p_lease,
        attempts = job.attempts + 1, sanitized_error = NULL,
        updated_at = statement_timestamp()
    FROM candidates WHERE job.id = candidates.id RETURNING job.*
    ), attempts AS (
        INSERT INTO ai.ingestion_attempt
            (id, job_id, attempt_number, worker_id, stage, checkpoint, status,
             lease_expires_at, started_at)
        SELECT md5(claimed.id::text || ':' || claimed.attempts::text)::uuid,
               claimed.id, claimed.attempts, p_worker_id, claimed.stage, claimed.checkpoint,
               'RUNNING', claimed.lease_expires_at, statement_timestamp()
        FROM claimed
        RETURNING job_id
    )
    SELECT claimed.* FROM claimed JOIN attempts ON attempts.job_id = claimed.id;
END;
$$;

CREATE FUNCTION ai.claim_event_consumptions(p_worker_id text, p_limit integer, p_lease interval)
RETURNS SETOF ai.event_consumption
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF p_worker_id IS NULL OR btrim(p_worker_id) = ''
       OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
       OR p_lease IS NULL OR p_lease <= interval '0' OR p_lease > interval '15 minutes' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid event claim bounds';
    END IF;
    UPDATE ai.event_consumption
    SET status = 'DEAD', sanitized_terminal_error = 'LEASE_EXPIRED_MAX_ATTEMPTS',
        completed_at = statement_timestamp(), dead_at = statement_timestamp(),
        lease_owner = NULL, lease_expires_at = NULL
    WHERE status = 'PROCESSING' AND lease_expires_at <= transaction_timestamp()
      AND attempts >= max_attempts;

    UPDATE ai.event_consumption
    SET status = 'RETRY', sanitized_terminal_error = NULL,
        lease_owner = NULL, lease_expires_at = NULL
    WHERE status = 'PROCESSING' AND lease_expires_at <= transaction_timestamp()
      AND attempts < max_attempts;

    RETURN QUERY
    WITH candidates AS (
        SELECT id FROM ai.event_consumption
        WHERE status IN ('PENDING', 'RETRY') AND next_attempt_at <= transaction_timestamp()
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

CREATE FUNCTION ai.persist_ingestion_document_version(
    p_job_id uuid, p_worker_id text, p_document_version_id uuid, p_version integer,
    p_object_key text, p_normalized_content_hash text, p_mime_type text, p_data_classification text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    job ai.ingestion_job%ROWTYPE;
BEGIN
    SELECT * INTO STRICT job FROM ai.ingestion_job WHERE id = p_job_id FOR UPDATE;
    IF job.status <> 'PROCESSING' OR job.lease_owner <> p_worker_id
       OR job.lease_expires_at <= transaction_timestamp() OR job.document_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ingestion lease is not owned or has expired';
    END IF;
    IF p_normalized_content_hash <> job.normalized_content_hash THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'normalized ingestion content hash does not match claimed job';
    END IF;
    INSERT INTO ai.knowledge_document_version
        (id, document_id, version, object_key, content_hash, mime_type, parser_version, data_classification)
    VALUES (p_document_version_id, job.document_id, p_version, p_object_key, p_normalized_content_hash,
            p_mime_type, job.parser_version, p_data_classification);
    UPDATE ai.ingestion_job SET produced_document_version_id = p_document_version_id
    WHERE id = p_job_id;
    RETURN p_document_version_id;
END;
$$;

CREATE FUNCTION ai.persist_ingestion_chunk_embedding(
    p_job_id uuid, p_worker_id text, p_document_version_id uuid, p_chunk_id uuid,
    p_ordinal integer, p_content text, p_content_hash text, p_token_count integer,
    p_metadata jsonb, p_embedding_space_id uuid, p_embedding public.vector
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    job ai.ingestion_job%ROWTYPE;
    version_document_id uuid;
    space_manifest text;
    space_status text;
BEGIN
    SELECT * INTO STRICT job FROM ai.ingestion_job WHERE id = p_job_id FOR UPDATE;
    IF job.status <> 'PROCESSING' OR job.lease_owner <> p_worker_id
       OR job.lease_expires_at <= transaction_timestamp() THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ingestion lease is not owned or has expired';
    END IF;
    IF p_document_version_id <> job.produced_document_version_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'chunk must use the produced document version for the claimed job';
    END IF;
    SELECT document_id INTO STRICT version_document_id
    FROM ai.knowledge_document_version WHERE id = p_document_version_id;
    IF version_document_id <> job.document_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ingestion document version does not belong to claimed job';
    END IF;
    SELECT corpus_version, status INTO STRICT space_manifest, space_status
    FROM ai.embedding_space WHERE id = p_embedding_space_id;
    IF space_status <> 'BUILDING' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'embedding space is not BUILDING';
    END IF;
    IF space_manifest <> job.corpus_manifest_digest THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'embedding space corpus manifest does not match claimed job';
    END IF;
    INSERT INTO ai.knowledge_chunk
        (id, document_version_id, ordinal, content, content_hash, token_count, metadata)
    VALUES (p_chunk_id, p_document_version_id, p_ordinal, p_content, p_content_hash, p_token_count, p_metadata);
    INSERT INTO ai.chunk_embedding (embedding_space_id, chunk_id, embedding)
    VALUES (p_embedding_space_id, p_chunk_id, p_embedding);
    RETURN p_chunk_id;
END;
$$;

CREATE FUNCTION ai.checkpoint_ingestion_attempt(
    p_job_id uuid, p_worker_id text, p_stage text, p_checkpoint jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    UPDATE ai.ingestion_attempt attempt
    SET stage = p_stage, checkpoint = p_checkpoint
    FROM ai.ingestion_job job
    WHERE attempt.job_id = job.id AND attempt.attempt_number = job.attempts
      AND attempt.status = 'RUNNING' AND job.id = p_job_id
      AND job.status = 'PROCESSING' AND job.lease_owner = p_worker_id
      AND job.lease_expires_at > transaction_timestamp();
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ingestion attempt lease is not owned or has expired';
    END IF;
    UPDATE ai.ingestion_job SET stage = p_stage, checkpoint = p_checkpoint,
        updated_at = statement_timestamp() WHERE id = p_job_id;
END;
$$;

CREATE FUNCTION ai.finalize_ingestion_job(p_job_id uuid, p_worker_id text, p_checkpoint jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    UPDATE ai.ingestion_attempt attempt
    SET status = 'SUCCEEDED', stage = 'COMPLETE', checkpoint = p_checkpoint,
        completed_at = statement_timestamp(), sanitized_error = NULL
    FROM ai.ingestion_job job
    WHERE attempt.job_id = job.id AND attempt.attempt_number = job.attempts
      AND attempt.status = 'RUNNING' AND job.id = p_job_id
      AND job.status = 'PROCESSING' AND job.lease_owner = p_worker_id
      AND job.lease_expires_at > transaction_timestamp();
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ingestion attempt lease is not owned or has expired';
    END IF;
    UPDATE ai.ingestion_job
    SET status = 'COMPLETED', stage = 'COMPLETE', checkpoint = p_checkpoint,
        lease_owner = NULL, lease_expires_at = NULL, sanitized_error = NULL,
        updated_at = statement_timestamp(), completed_at = statement_timestamp()
    WHERE id = p_job_id AND status = 'PROCESSING' AND lease_owner = p_worker_id
      AND lease_expires_at > transaction_timestamp();
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ingestion lease is not owned or has expired';
    END IF;
END;
$$;

CREATE FUNCTION ai.fail_ingestion_job(
    p_job_id uuid, p_worker_id text, p_sanitized_error text, p_retry_after interval
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    next_status text;
BEGIN
    IF p_retry_after < interval '0' OR p_retry_after > interval '1 day' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid ingestion retry bound';
    END IF;
    UPDATE ai.ingestion_attempt attempt
    SET status = 'FAILED', sanitized_error = p_sanitized_error,
        completed_at = statement_timestamp()
    FROM ai.ingestion_job job
    WHERE attempt.job_id = job.id AND attempt.attempt_number = job.attempts
      AND attempt.status = 'RUNNING' AND job.id = p_job_id
      AND job.status = 'PROCESSING' AND job.lease_owner = p_worker_id
      AND job.lease_expires_at > transaction_timestamp();
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ingestion attempt lease is not owned or has expired';
    END IF;
    UPDATE ai.ingestion_job
    SET status = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'RETRY' END,
        next_attempt_at = transaction_timestamp() + p_retry_after,
        lease_owner = NULL, lease_expires_at = NULL, sanitized_error = p_sanitized_error,
        updated_at = statement_timestamp(),
        completed_at = CASE WHEN attempts >= max_attempts THEN statement_timestamp() ELSE NULL END
    WHERE id = p_job_id AND status = 'PROCESSING' AND lease_owner = p_worker_id
      AND lease_expires_at > transaction_timestamp()
    RETURNING status INTO next_status;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ingestion lease is not owned or has expired';
    END IF;
    RETURN next_status;
END;
$$;

CREATE FUNCTION ai.register_event_consumption(
    p_id uuid, p_consumer_key text, p_event_id uuid, p_event_type text,
    p_schema_version integer, p_aggregate_type text, p_aggregate_id uuid, p_aggregate_version bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    registered_id uuid;
    existing ai.event_consumption%ROWTYPE;
BEGIN
    INSERT INTO ai.event_consumption
        (id, consumer_key, event_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version)
    VALUES (p_id, p_consumer_key, p_event_id, p_event_type, p_schema_version,
            p_aggregate_type, p_aggregate_id, p_aggregate_version)
    ON CONFLICT (consumer_key, event_id) DO NOTHING
    RETURNING id INTO registered_id;
    IF registered_id IS NULL THEN
        SELECT * INTO STRICT existing FROM ai.event_consumption
        WHERE consumer_key = p_consumer_key AND event_id = p_event_id;
        IF existing.event_type <> p_event_type OR existing.schema_version <> p_schema_version
           OR existing.aggregate_type <> p_aggregate_type OR existing.aggregate_id <> p_aggregate_id
           OR existing.aggregate_version <> p_aggregate_version THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'event dedup key reused with different immutable envelope';
        END IF;
        registered_id := existing.id;
    END IF;
    RETURN registered_id;
END;
$$;

CREATE FUNCTION ai.finalize_event_consumption(p_id uuid, p_worker_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    UPDATE ai.event_consumption
    SET status = 'COMPLETED', completed_at = statement_timestamp(),
        lease_owner = NULL, lease_expires_at = NULL, sanitized_terminal_error = NULL
    WHERE id = p_id AND status = 'PROCESSING' AND lease_owner = p_worker_id
      AND lease_expires_at > transaction_timestamp();
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'event lease is not owned or has expired';
    END IF;
END;
$$;

CREATE FUNCTION ai.fail_event_consumption(
    p_id uuid, p_worker_id text, p_sanitized_error text, p_retry_after interval
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    next_status text;
BEGIN
    IF p_retry_after < interval '0' OR p_retry_after > interval '1 day' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid event retry bound';
    END IF;
    UPDATE ai.event_consumption
    SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'RETRY' END,
        next_attempt_at = transaction_timestamp() + p_retry_after,
        lease_owner = NULL, lease_expires_at = NULL,
        sanitized_terminal_error = CASE WHEN attempts >= max_attempts THEN p_sanitized_error ELSE NULL END,
        completed_at = CASE WHEN attempts >= max_attempts THEN statement_timestamp() ELSE NULL END,
        dead_at = CASE WHEN attempts >= max_attempts THEN statement_timestamp() ELSE NULL END
    WHERE id = p_id AND status = 'PROCESSING' AND lease_owner = p_worker_id
      AND lease_expires_at > transaction_timestamp()
    RETURNING status INTO next_status;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'event lease is not owned or has expired';
    END IF;
    RETURN next_status;
END;
$$;

CREATE FUNCTION ai.transition_ai_run(p_run_id uuid, p_status text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    old_status text;
BEGIN
    SELECT status INTO STRICT old_status FROM ai.ai_run
    WHERE id = p_run_id AND authorization_grant_id IS NOT NULL FOR UPDATE;
    IF NOT ((old_status = 'QUEUED' AND p_status IN ('RUNNING', 'CANCELLED'))
        OR (old_status = 'RUNNING' AND p_status IN ('COMPLETED', 'FAILED', 'CANCELLED'))) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid governed AI run transition';
    END IF;
    UPDATE ai.ai_run
    SET status = p_status,
        started_at = CASE WHEN p_status = 'RUNNING' THEN statement_timestamp() ELSE started_at END,
        completed_at = CASE WHEN p_status IN ('COMPLETED', 'FAILED', 'CANCELLED') THEN statement_timestamp() ELSE NULL END
    WHERE id = p_run_id;
    RETURN p_status;
END;
$$;

CREATE FUNCTION ai.start_model_invocation(
    p_id uuid, p_run_id uuid, p_model_profile_id uuid, p_operation text,
    p_request_hash text, p_capability_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    grant_operation text;
    run_model_profile_id uuid;
BEGIN
    SELECT grant_row.operation, run.model_profile_id INTO grant_operation, run_model_profile_id
    FROM ai.ai_run run
    JOIN authz.ai_authorization_grant grant_row ON grant_row.id = run.authorization_grant_id
    WHERE run.id = p_run_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'model invocation requires a governed run';
    END IF;
    IF run_model_profile_id IS DISTINCT FROM p_model_profile_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'model profile does not match governed run';
    END IF;
    IF grant_operation <> p_operation THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invocation operation does not match grant';
    END IF;
    INSERT INTO ai.model_invocation
        (id, run_id, model_profile_id, operation, request_hash, capability_hash, status)
    VALUES (p_id, p_run_id, p_model_profile_id, p_operation, p_request_hash, p_capability_hash, 'STARTED');
    RETURN p_id;
END;
$$;

CREATE FUNCTION ai.finalize_model_invocation(
    p_id uuid, p_status text, p_response_hash text, p_provider_request_id_hash text,
    p_input_tokens bigint, p_output_tokens bigint, p_cost numeric,
    p_latency_ms integer, p_sanitized_error text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF p_status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid terminal invocation status';
    END IF;
    IF p_provider_request_id_hash IS NOT NULL AND p_provider_request_id_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'provider request id hash must be lowercase SHA-256';
    END IF;
    UPDATE ai.model_invocation
    SET status = p_status, response_hash = p_response_hash, provider_request_id_hash = p_provider_request_id_hash,
        input_tokens = p_input_tokens, output_tokens = p_output_tokens, cost = p_cost,
        latency_ms = p_latency_ms, sanitized_error = p_sanitized_error,
        completed_at = statement_timestamp()
    WHERE id = p_id AND status = 'STARTED';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'model invocation is not active';
    END IF;
END;
$$;

CREATE FUNCTION ai.persist_run_artifact(
    p_id uuid, p_run_id uuid, p_artifact_kind text, p_object_key text,
    p_sha256 text, p_data_classification text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ai.ai_run WHERE id = p_run_id AND authorization_grant_id IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'artifact requires a governed run';
    END IF;
    INSERT INTO ai.ai_run_artifact
        (id, run_id, artifact_kind, object_key, sha256, data_classification, retention_until)
    VALUES (p_id, p_run_id, p_artifact_kind, p_object_key, p_sha256,
            p_data_classification, statement_timestamp() + interval '1 year');
    RETURN p_id;
END;
$$;

CREATE FUNCTION ai.record_retrieval_trace(
    p_id uuid, p_run_id uuid, p_embedding_space_id uuid, p_query_hash text,
    p_lexical_candidate_count integer, p_vector_candidate_count integer,
    p_result_count integer, p_ranking_config jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    grant_row authz.ai_authorization_grant%ROWTYPE;
    document_count integer;
BEGIN
    SELECT * INTO STRICT grant_row FROM authz.ai_authorization_grant
    WHERE run_id = p_run_id AND consumed_at IS NOT NULL;
    IF NOT EXISTS (
        SELECT 1 FROM ai.ai_run run
        WHERE run.id = p_run_id AND run.embedding_space_id = p_embedding_space_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'embedding space does not match governed run';
    END IF;
    SELECT count(*) INTO document_count FROM authz.ai_authorized_document WHERE grant_id = grant_row.id;
    INSERT INTO ai.retrieval_trace
        (id, run_id, grant_id, embedding_space_id, query_hash, authorized_set_digest,
         authorized_document_count, classification_ceiling, lexical_candidate_count,
         vector_candidate_count, result_count, ranking_config)
    VALUES (p_id, p_run_id, grant_row.id, p_embedding_space_id, p_query_hash,
            grant_row.authorized_set_digest, document_count, grant_row.classification_ceiling,
            p_lexical_candidate_count, p_vector_candidate_count, p_result_count, p_ranking_config);
    RETURN p_id;
END;
$$;

CREATE FUNCTION ai.record_retrieval_hit(
    p_trace_id uuid, p_document_version_id uuid, p_chunk_id uuid,
    p_lexical_score double precision, p_vector_score double precision,
    p_fused_score double precision, p_rank integer, p_excerpt_hash text, p_injection_detected boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    INSERT INTO ai.retrieval_hit
        (trace_id, document_version_id, chunk_id, lexical_score, vector_score,
         fused_score, rank, excerpt_hash, injection_detected)
    VALUES (p_trace_id, p_document_version_id, p_chunk_id, p_lexical_score, p_vector_score,
            p_fused_score, p_rank, p_excerpt_hash, p_injection_detected);
    RETURN p_chunk_id;
END;
$$;

CREATE FUNCTION ai.begin_embedding_space_gate(
    p_id uuid, p_dataset_version_id uuid, p_candidate_embedding_space_id uuid,
    p_corpus_manifest_digest text, p_expected_active_space_id uuid, p_evidence_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    candidate_manifest text;
    candidate_status text;
    active_status text;
    dataset_content_hash text;
    dataset_status text;
    eligible bigint;
    embedded bigint;
    leakage bigint;
    document_manifest text;
BEGIN
    SELECT content_hash, status INTO STRICT dataset_content_hash, dataset_status
    FROM ai.evaluation_dataset_version WHERE id = p_dataset_version_id FOR SHARE;
    IF dataset_status <> 'PUBLISHED' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'evaluation dataset version is not PUBLISHED';
    END IF;
    SELECT corpus_version, status INTO STRICT candidate_manifest, candidate_status
    FROM ai.embedding_space WHERE id = p_candidate_embedding_space_id FOR UPDATE;
    SELECT status INTO STRICT active_status FROM ai.embedding_space WHERE id = p_expected_active_space_id FOR SHARE;
    IF candidate_manifest <> p_corpus_manifest_digest OR candidate_status <> 'BUILDING' OR active_status <> 'ACTIVE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'stale corpus manifest or expected active space';
    END IF;
    WITH eligible_versions AS MATERIALIZED (
        SELECT DISTINCT version.id, version.content_hash
        FROM ai.ingestion_job job
        JOIN ai.knowledge_document_version version ON version.id = job.produced_document_version_id
        WHERE job.corpus_manifest_digest = p_corpus_manifest_digest AND job.status = 'COMPLETED'
    ), eligible_chunks AS (
        SELECT DISTINCT chunk.id
        FROM eligible_versions version
        JOIN ai.knowledge_chunk chunk ON chunk.document_version_id = version.id
    )
    SELECT count(*), count(embedding.chunk_id),
           (SELECT count(*) FROM ai.chunk_embedding all_embedding
            LEFT JOIN eligible_chunks allowed ON allowed.id = all_embedding.chunk_id
            WHERE all_embedding.embedding_space_id = p_candidate_embedding_space_id AND allowed.id IS NULL),
           (SELECT string_agg(version.id::text || ':' || version.content_hash, ',' ORDER BY version.id)
            FROM eligible_versions version)
    INTO eligible, embedded, leakage, document_manifest
    FROM eligible_chunks eligible_chunk
    LEFT JOIN ai.chunk_embedding embedding
      ON embedding.chunk_id = eligible_chunk.id AND embedding.embedding_space_id = p_candidate_embedding_space_id;
    IF eligible = 0 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'empty gate evidence: eligible corpus is empty';
    END IF;
    INSERT INTO ai.embedding_space_gate_evaluation
        (id, dataset_version_id, dataset_content_hash, corpus_manifest_digest, document_manifest, candidate_embedding_space_id,
         expected_active_space_id, eligible_count, embedded_count, leakage_count, evidence_hash)
    VALUES (p_id, p_dataset_version_id, dataset_content_hash, p_corpus_manifest_digest, document_manifest, p_candidate_embedding_space_id,
            p_expected_active_space_id, eligible, embedded, leakage, p_evidence_hash);
    RETURN p_id;
END;
$$;

CREATE FUNCTION ai.record_embedding_gate_case(
    p_evaluation_id uuid, p_case_id uuid, p_citation_numerator bigint,
    p_citation_denominator bigint, p_recall_at_10 numeric, p_evidence_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    expected_dataset uuid;
    case_dataset uuid;
    case_input jsonb;
    case_expected_properties jsonb;
BEGIN
    SELECT dataset_version_id INTO STRICT expected_dataset
    FROM ai.embedding_space_gate_evaluation WHERE id = p_evaluation_id;
    SELECT dataset_version_id, input, expected_properties
    INTO STRICT case_dataset, case_input, case_expected_properties
    FROM ai.evaluation_case WHERE id = p_case_id;
    IF case_dataset <> expected_dataset THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'gate case is outside evaluation dataset';
    END IF;
    IF NOT (jsonb_typeof(case_input) = 'object' AND case_input <> '{}'::jsonb)
       OR NOT (jsonb_typeof(case_expected_properties) = 'object' AND case_expected_properties <> '{}'::jsonb) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'evaluation case must contain non-empty input and expected properties';
    END IF;
    INSERT INTO ai.embedding_space_gate_case_evidence
        (evaluation_id, case_id, citation_numerator, citation_denominator, recall_at_10, evidence_hash)
    VALUES (p_evaluation_id, p_case_id, p_citation_numerator, p_citation_denominator, p_recall_at_10, p_evidence_hash);
    RETURN p_case_id;
END;
$$;

CREATE FUNCTION ai.finalize_embedding_space_gate(p_evaluation_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    evaluation ai.embedding_space_gate_evaluation%ROWTYPE;
    current_manifest text;
    candidate_status text;
    active_status text;
    current_document_manifest text;
    current_eligible bigint;
    current_embedded bigint;
    current_leakage bigint;
    dataset_content_hash text;
    dataset_status text;
    citation_num bigint;
    citation_den bigint;
    recall_total numeric;
    cases bigint;
    dataset_cases bigint;
    evidence_cases bigint;
    foreign_cases bigint;
    empty_cases bigint;
    gate_decision text;
BEGIN
    SELECT * INTO STRICT evaluation FROM ai.embedding_space_gate_evaluation
    WHERE id = p_evaluation_id FOR SHARE;
    SELECT content_hash, status INTO STRICT dataset_content_hash, dataset_status
    FROM ai.evaluation_dataset_version WHERE id = evaluation.dataset_version_id FOR SHARE;
    IF dataset_status <> 'PUBLISHED' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'evaluation dataset version is not PUBLISHED';
    END IF;
    IF dataset_content_hash <> evaluation.dataset_content_hash THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'evaluation dataset version content hash changed';
    END IF;
    SELECT corpus_version, status INTO STRICT current_manifest, candidate_status FROM ai.embedding_space
    WHERE id = evaluation.candidate_embedding_space_id FOR UPDATE;
    SELECT status INTO STRICT active_status FROM ai.embedding_space
    WHERE id = evaluation.expected_active_space_id FOR SHARE;
    IF candidate_status <> 'BUILDING' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'candidate embedding space is not BUILDING';
    END IF;
    IF current_manifest IS DISTINCT FROM evaluation.corpus_manifest_digest OR active_status <> 'ACTIVE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'stale corpus manifest or expected active space';
    END IF;
    PERFORM 1 FROM ai.ingestion_job job
    WHERE job.corpus_manifest_digest = evaluation.corpus_manifest_digest AND job.status = 'COMPLETED'
    FOR SHARE;
    PERFORM 1
    FROM ai.ingestion_job job
    JOIN ai.knowledge_document_version version ON version.id = job.produced_document_version_id
    WHERE job.corpus_manifest_digest = evaluation.corpus_manifest_digest AND job.status = 'COMPLETED'
    FOR UPDATE OF version;
    PERFORM 1
    FROM ai.ingestion_job job
    JOIN ai.knowledge_document_version version ON version.id = job.produced_document_version_id
    JOIN ai.knowledge_chunk chunk ON chunk.document_version_id = version.id
    WHERE job.corpus_manifest_digest = evaluation.corpus_manifest_digest AND job.status = 'COMPLETED'
    FOR SHARE OF chunk;
    WITH eligible_versions AS MATERIALIZED (
        SELECT DISTINCT version.id, version.content_hash
        FROM ai.ingestion_job job
        JOIN ai.knowledge_document_version version ON version.id = job.produced_document_version_id
        WHERE job.corpus_manifest_digest = evaluation.corpus_manifest_digest AND job.status = 'COMPLETED'
    ), eligible_chunks AS (
        SELECT DISTINCT chunk.id
        FROM eligible_versions version
        JOIN ai.knowledge_chunk chunk ON chunk.document_version_id = version.id
    )
    SELECT count(*), count(embedding.chunk_id),
           (SELECT count(*) FROM ai.chunk_embedding all_embedding
            LEFT JOIN eligible_chunks allowed ON allowed.id = all_embedding.chunk_id
            WHERE all_embedding.embedding_space_id = evaluation.candidate_embedding_space_id AND allowed.id IS NULL),
           (SELECT string_agg(version.id::text || ':' || version.content_hash, ',' ORDER BY version.id)
            FROM eligible_versions version)
    INTO current_eligible, current_embedded, current_leakage, current_document_manifest
    FROM eligible_chunks eligible_chunk
    LEFT JOIN ai.chunk_embedding embedding
      ON embedding.chunk_id = eligible_chunk.id
     AND embedding.embedding_space_id = evaluation.candidate_embedding_space_id;
    IF current_eligible <> evaluation.eligible_count
       OR current_embedded <> evaluation.embedded_count
       OR current_leakage <> evaluation.leakage_count
       OR current_document_manifest IS DISTINCT FROM evaluation.document_manifest THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'gate corpus snapshot changed';
    END IF;
    SELECT count(*), count(*) FILTER (WHERE input = '{}'::jsonb OR expected_properties = '{}'::jsonb)
    INTO dataset_cases, empty_cases
    FROM ai.evaluation_case WHERE dataset_version_id = evaluation.dataset_version_id;
    IF empty_cases > 0 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'evaluation dataset contains empty cases';
    END IF;
    SELECT count(*) INTO evidence_cases
    FROM ai.embedding_space_gate_case_evidence
    WHERE evaluation_id = p_evaluation_id;
    SELECT count(*) INTO foreign_cases
    FROM ai.embedding_space_gate_case_evidence evidence
    LEFT JOIN ai.evaluation_case evaluation_case
      ON evaluation_case.id = evidence.case_id
     AND evaluation_case.dataset_version_id = evaluation.dataset_version_id
    WHERE evidence.evaluation_id = p_evaluation_id AND evaluation_case.id IS NULL;
    IF dataset_cases < 20 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'at least 20 meaningful evaluation cases are required';
    END IF;
    IF evidence_cases <> dataset_cases OR foreign_cases <> 0 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'partial evidence cannot finalize a complete evaluation dataset';
    END IF;
    SELECT coalesce(sum(evidence.citation_numerator), 0), coalesce(sum(evidence.citation_denominator), 0),
           coalesce(sum(evidence.recall_at_10), 0), count(*)
    INTO citation_num, citation_den, recall_total, cases
    FROM ai.embedding_space_gate_case_evidence evidence
    JOIN ai.evaluation_case evaluation_case ON evaluation_case.id = evidence.case_id
    WHERE evidence.evaluation_id = p_evaluation_id;
    IF citation_den = 0 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'empty gate evidence: citation evidence is required';
    END IF;
    gate_decision := CASE WHEN evaluation.embedded_count = evaluation.eligible_count
        AND evaluation.leakage_count = 0
        AND citation_num::numeric / citation_den >= 0.95
        AND recall_total / cases >= 0.85 THEN 'PASS' ELSE 'FAIL' END;
    INSERT INTO ai.embedding_space_gate_result
        (id, dataset_version_id, dataset_content_hash, corpus_manifest_digest, document_manifest, candidate_embedding_space_id,
         expected_active_space_id, eligible_count, embedded_count, leakage_count,
         citation_numerator, citation_denominator, recall_sum, recall_count,
         decision, evidence_hash)
    VALUES (evaluation.id, evaluation.dataset_version_id, evaluation.dataset_content_hash, evaluation.corpus_manifest_digest,
            evaluation.document_manifest,
            evaluation.candidate_embedding_space_id, evaluation.expected_active_space_id,
            evaluation.eligible_count, evaluation.embedded_count, evaluation.leakage_count,
            citation_num, citation_den, recall_total, cases, gate_decision, evaluation.evidence_hash);
    RETURN gate_decision;
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
    IF p_lexical_limit IS NULL OR p_vector_limit IS NULL OR p_result_limit IS NULL
       OR p_lexical_limit NOT BETWEEN 1 AND 200 OR p_vector_limit NOT BETWEEN 1 AND 200
       OR p_result_limit NOT BETWEEN 1 AND 100 OR p_query IS NULL OR octet_length(p_query) > 8192 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid retrieval bounds';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM authz.ai_authorization_grant grant_row
        WHERE grant_row.run_id = p_run_id AND grant_row.consumed_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'run has no consumed AI authorization grant';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM ai.ai_run run
        WHERE run.id = p_run_id AND run.embedding_space_id = p_space_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'embedding space does not match governed run';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ai.embedding_space WHERE id = p_space_id AND status = 'ACTIVE') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'retrieval embedding space is not active';
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

GRANT SELECT ON ai.model_provider, ai.model_profile, ai.prompt_template_version, ai.agent_definition_version,
    ai.embedding_space, ai.evaluation_dataset_version, ai.evaluation_case, ai.knowledge_document_version,
    ai.knowledge_chunk, ai.chunk_embedding, ai.ingestion_job, ai.ingestion_attempt,
    ai.event_consumption, ai.model_invocation, ai.retrieval_trace, ai.retrieval_hit,
    ai.embedding_space_gate_evaluation, ai.embedding_space_gate_case_evidence,
    ai.embedding_space_gate_result, ai.ai_run_artifact, ai.retention_policy
TO innorder_ai_runtime;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA authz, ai FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA authz, ai TO innorder_runtime;
REVOKE ALL ON FUNCTION authz.consume_ai_authorization_grant(text, uuid, text, bigint, text, text, text, uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai.claim_ingestion_jobs(text, integer, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai.claim_event_consumptions(text, integer, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai.authorized_hybrid_retrieval(uuid, uuid, text, public.vector, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai.cleanup_expired_run_artifacts(timestamptz, integer) FROM PUBLIC, innorder_runtime;
GRANT EXECUTE ON FUNCTION authz.consume_ai_authorization_grant(text, uuid, text, bigint, text, text, text, uuid, uuid, uuid, uuid, uuid) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.claim_ingestion_jobs(text, integer, interval) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.claim_event_consumptions(text, integer, interval) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.authorized_hybrid_retrieval(uuid, uuid, text, public.vector, integer, integer, integer) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.cleanup_expired_run_artifacts(timestamptz, integer) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.persist_ingestion_document_version(uuid, text, uuid, integer, text, text, text, text) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.persist_ingestion_chunk_embedding(uuid, text, uuid, uuid, integer, text, text, integer, jsonb, uuid, public.vector) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.checkpoint_ingestion_attempt(uuid, text, text, jsonb) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.finalize_ingestion_job(uuid, text, jsonb) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.fail_ingestion_job(uuid, text, text, interval) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.register_event_consumption(uuid, text, uuid, text, integer, text, uuid, bigint) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.finalize_event_consumption(uuid, text) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.fail_event_consumption(uuid, text, text, interval) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.transition_ai_run(uuid, text) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.start_model_invocation(uuid, uuid, uuid, text, text, text) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.finalize_model_invocation(uuid, text, text, text, bigint, bigint, numeric, integer, text) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.persist_run_artifact(uuid, uuid, text, text, text, text) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.record_retrieval_trace(uuid, uuid, uuid, text, integer, integer, integer, jsonb) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.record_retrieval_hit(uuid, uuid, uuid, double precision, double precision, double precision, integer, text, boolean) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.begin_embedding_space_gate(uuid, uuid, uuid, text, uuid, text) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.record_embedding_gate_case(uuid, uuid, bigint, bigint, numeric, text) TO innorder_ai_runtime;
GRANT EXECUTE ON FUNCTION ai.finalize_embedding_space_gate(uuid) TO innorder_ai_runtime;
