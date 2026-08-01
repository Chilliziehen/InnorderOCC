DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM occ.process_instance) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'V013 cannot truthfully backfill cohort and participant ownership for legacy process instances';
    END IF;
    IF EXISTS (SELECT 1 FROM occ.task_projection) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'V013 cannot truthfully backfill engine occurrence identity for legacy task projections';
    END IF;
END;
$$;

CREATE TABLE occ.cohort (
    id uuid PRIMARY KEY REFERENCES authz.entity(id),
    customer_instance_id uuid NOT NULL REFERENCES platform.customer_instance(id),
    code text NOT NULL CHECK (code = lower(btrim(code)) AND code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 256),
    package_version_id uuid NOT NULL REFERENCES catalog.package_version(id),
    owner_principal_id uuid NOT NULL REFERENCES iam.principal(id),
    start_date date NOT NULL,
    end_date date,
    status text NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_by uuid NOT NULL REFERENCES iam.principal(id),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_by uuid NOT NULL REFERENCES iam.principal(id),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    archived_at timestamptz,
    UNIQUE (customer_instance_id, code),
    UNIQUE (id, package_version_id),
    CHECK (end_date IS NULL OR end_date >= start_date),
    CHECK (updated_at >= created_at),
    CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);

ALTER TABLE occ.process_definition_binding
    ADD CONSTRAINT uq_process_definition_binding_id_package
        UNIQUE (id, package_version_id);

ALTER TABLE occ.process_instance
    ADD COLUMN cohort_id uuid NOT NULL REFERENCES occ.cohort(id),
    ADD COLUMN started_for_participant_id uuid NOT NULL REFERENCES iam.principal(id),
    ADD COLUMN participant_id uuid NOT NULL REFERENCES iam.principal(id),
    ADD COLUMN route_key text NOT NULL CHECK (route_key = btrim(route_key) AND route_key <> ''),
    ADD COLUMN route_version integer NOT NULL CHECK (route_version > 0),
    ADD CONSTRAINT uq_process_cohort_started_participant
        UNIQUE (cohort_id, started_for_participant_id);

ALTER TABLE occ.task_projection
    DROP CONSTRAINT task_projection_state_check,
    ADD COLUMN activity_name text NOT NULL CHECK (activity_name = btrim(activity_name) AND activity_name <> ''),
    ADD COLUMN assignee_id uuid REFERENCES iam.principal(id),
    ADD COLUMN form_key text,
    ADD COLUMN flowable_execution_id text NOT NULL,
    ADD COLUMN claimed_at timestamptz,
    ADD COLUMN cancelled_at timestamptz,
    ADD COLUMN failed_at timestamptz,
    ADD COLUMN failure_code text,
    ADD CONSTRAINT ck_task_projection_state
        CHECK (state IN ('AVAILABLE', 'CLAIMED', 'COMPLETED', 'CANCELLED', 'FAILED')),
    ADD CONSTRAINT ck_task_projection_terminal_time CHECK (
        (state = 'COMPLETED' AND completed_at IS NOT NULL AND cancelled_at IS NULL AND failed_at IS NULL)
        OR (state = 'CANCELLED' AND completed_at IS NULL AND cancelled_at IS NOT NULL AND failed_at IS NULL)
        OR (state = 'FAILED' AND completed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NOT NULL)
        OR (state IN ('AVAILABLE', 'CLAIMED') AND completed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL)
    ),
    ADD CONSTRAINT ck_task_projection_failure_code CHECK (
        (state = 'FAILED') = (failure_code IS NOT NULL)
    );

CREATE UNIQUE INDEX uq_task_projection_occurrence
ON occ.task_projection (process_instance_id, flowable_execution_id, activity_key, created_at);

CREATE TABLE occ.task_blocker (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES occ.task_projection(id),
    source_entity_id uuid NOT NULL REFERENCES authz.entity(id),
    source_row_version bigint NOT NULL CHECK (source_row_version >= 0),
    blocker_code text NOT NULL CHECK (blocker_code IN (
        'PREREQUISITE_UNSATISFIED', 'EVIDENCE_REQUIRED', 'EVIDENCE_REVIEW_PENDING',
        'EVIDENCE_RETURNED', 'RESOURCE_REQUIRED', 'RESOURCE_CONFLICT', 'PROCESS_SUSPENDED',
        'PROCESS_CANCELLED', 'POLICY_DENIED', 'GATE_PROVIDER_UNAVAILABLE'
    )),
    severity text NOT NULL CHECK (severity IN ('SOFT', 'HARD')),
    safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(safe_metadata)),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    resolved_at timestamptz,
    CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);

CREATE TABLE occ.task_gate_requirement (
    task_id uuid NOT NULL REFERENCES occ.task_projection(id),
    provider_key text NOT NULL CHECK (provider_key = lower(btrim(provider_key)) AND provider_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (task_id, provider_key)
);

CREATE TABLE occ.task_gate_provider_state (
    task_id uuid NOT NULL,
    provider_key text NOT NULL,
    status text NOT NULL CHECK (status IN ('READY', 'UNAVAILABLE', 'STALE')),
    source_entity_id uuid REFERENCES authz.entity(id),
    source_row_version bigint CHECK (source_row_version IS NULL OR source_row_version >= 0),
    safe_failure_code text,
    refreshed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (task_id, provider_key),
    FOREIGN KEY (task_id, provider_key)
        REFERENCES occ.task_gate_requirement(task_id, provider_key),
    CHECK ((source_entity_id IS NULL) = (source_row_version IS NULL)),
    CHECK (status = 'UNAVAILABLE' OR safe_failure_code IS NULL)
);

CREATE TABLE occ.task_timeline (
    cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id uuid NOT NULL UNIQUE,
    task_id uuid NOT NULL REFERENCES occ.task_projection(id),
    fact_type text NOT NULL CHECK (fact_type IN ('LIFECYCLE', 'ASSIGNMENT', 'BLOCKER', 'REVIEW')),
    actor_principal_id uuid REFERENCES iam.principal(id),
    event_id uuid NOT NULL REFERENCES audit.outbox_event(id),
    fact_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(fact_data)),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE occ.task_review_projection_fact (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES occ.task_projection(id),
    fact_kind text NOT NULL CHECK (fact_kind IN ('SUBMITTED', 'DECIDED')),
    review_sequence bigint NOT NULL CHECK (review_sequence > 0),
    evidence_id uuid,
    evidence_version_id uuid,
    submission_idempotency_id uuid REFERENCES audit.idempotency_record(id),
    prior_assignee_id uuid REFERENCES iam.principal(id),
    submission_fact_id uuid REFERENCES occ.task_review_projection_fact(id),
    review_id uuid,
    review_version bigint CHECK (review_version IS NULL OR review_version > 0),
    decision text CHECK (decision IS NULL OR decision IN ('ACCEPTED', 'REJECTED', 'CONDITIONAL')),
    follow_up_due_at timestamptz,
    conditional_rule_version text,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (task_id, review_sequence, fact_kind),
    CHECK (
        (fact_kind = 'SUBMITTED'
            AND evidence_id IS NOT NULL AND evidence_version_id IS NOT NULL
            AND submission_idempotency_id IS NOT NULL AND submission_fact_id IS NULL
            AND review_id IS NULL AND review_version IS NULL AND decision IS NULL)
        OR (fact_kind = 'DECIDED'
            AND evidence_id IS NULL AND evidence_version_id IS NULL
            AND submission_idempotency_id IS NULL AND prior_assignee_id IS NULL
            AND submission_fact_id IS NOT NULL AND review_id IS NOT NULL
            AND review_version IS NOT NULL AND decision IS NOT NULL)
    ),
    CHECK (decision = 'CONDITIONAL' OR (follow_up_due_at IS NULL AND conditional_rule_version IS NULL))
);

CREATE TABLE occ.notification (
    id uuid PRIMARY KEY,
    recipient_id uuid NOT NULL REFERENCES iam.principal(id),
    type text NOT NULL CHECK (type = lower(btrim(type)) AND type ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    severity text NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
    resource_type text NOT NULL CHECK (resource_type = lower(btrim(resource_type)) AND resource_type ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    resource_id uuid NOT NULL REFERENCES authz.entity(id),
    event_id uuid NOT NULL REFERENCES audit.outbox_event(id),
    cursor bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    read_at timestamptz,
    UNIQUE (recipient_id, event_id, type),
    CHECK (read_at IS NULL OR read_at >= created_at)
);
