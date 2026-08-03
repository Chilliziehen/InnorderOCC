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

ALTER TABLE catalog.workflow_definition
    ADD CONSTRAINT uq_workflow_definition_id_package
        UNIQUE (id, package_version_id);

ALTER TABLE occ.process_definition_binding
    ADD CONSTRAINT fk_process_binding_workflow_package
        FOREIGN KEY (workflow_definition_id, package_version_id)
        REFERENCES catalog.workflow_definition(id, package_version_id);

ALTER TABLE occ.process_instance
    ADD COLUMN cohort_id uuid NOT NULL REFERENCES occ.cohort(id),
    ADD COLUMN started_for_participant_id uuid NOT NULL REFERENCES iam.principal(id),
    ADD COLUMN participant_id uuid NOT NULL REFERENCES iam.principal(id),
    ADD COLUMN route_key text NOT NULL CHECK (route_key = btrim(route_key) AND route_key <> ''),
    ADD COLUMN route_version integer NOT NULL CHECK (route_version > 0),
    ADD CONSTRAINT fk_process_definition_package
        FOREIGN KEY (definition_binding_id, package_version_id)
        REFERENCES occ.process_definition_binding(id, package_version_id),
    ADD CONSTRAINT fk_process_cohort_package
        FOREIGN KEY (cohort_id, package_version_id)
        REFERENCES occ.cohort(id, package_version_id),
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
    CHECK (resolved_at IS NULL OR resolved_at >= created_at),
    CHECK (octet_length(safe_metadata::text) <= 4096)
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
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    CHECK (octet_length(fact_data::text) <= 8192)
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
            AND prior_assignee_id IS NOT NULL
            AND review_id IS NULL AND review_version IS NULL AND decision IS NULL)
        OR (fact_kind = 'DECIDED'
            AND evidence_id IS NULL AND evidence_version_id IS NULL
            AND submission_idempotency_id IS NULL AND prior_assignee_id IS NULL
            AND submission_fact_id IS NOT NULL AND review_id IS NOT NULL
            AND review_version IS NOT NULL AND decision IS NOT NULL)
    ),
    CHECK (
        (decision = 'CONDITIONAL' AND follow_up_due_at IS NOT NULL AND conditional_rule_version IS NOT NULL)
        OR (decision IS DISTINCT FROM 'CONDITIONAL' AND follow_up_due_at IS NULL AND conditional_rule_version IS NULL)
    )
);

ALTER TABLE occ.evidence_version
    ADD CONSTRAINT uq_evidence_version_identity UNIQUE (id, evidence_id);
ALTER TABLE occ.task_review_projection_fact
    ADD CONSTRAINT fk_task_review_evidence
        FOREIGN KEY (evidence_id) REFERENCES occ.evidence(id),
    ADD CONSTRAINT fk_task_review_evidence_version
        FOREIGN KEY (evidence_version_id, evidence_id)
        REFERENCES occ.evidence_version(id, evidence_id);

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
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    UNIQUE (recipient_id, event_id, type),
    CHECK (read_at IS NULL OR read_at >= created_at)
);

DROP INDEX IF EXISTS authz.uq_relationship_active;

CREATE OR REPLACE FUNCTION authz.validate_relationship()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    definition catalog.relation_definition%ROWTYPE;
    subject_type uuid;
    object_type uuid;
    definition_package_status text;
    subject_limit integer;
    object_limit integer;
BEGIN
    PERFORM 1
    FROM catalog.relation_definition
    WHERE id = NEW.relation_definition_id
    FOR UPDATE;

    SELECT * INTO STRICT definition
    FROM catalog.relation_definition
    WHERE id = NEW.relation_definition_id;

    SELECT status INTO STRICT definition_package_status
    FROM catalog.package_version
    WHERE id = definition.package_version_id;
    IF definition_package_status NOT IN ('PUBLISHED', 'DEPRECATED') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'relationship definition must be published';
    END IF;

    SELECT entity_type_id INTO STRICT subject_type FROM authz.entity WHERE id = NEW.subject_entity_id;
    SELECT entity_type_id INTO STRICT object_type FROM authz.entity WHERE id = NEW.object_entity_id;
    IF subject_type <> definition.subject_type_id OR object_type <> definition.object_type_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'relationship endpoint type mismatch';
    END IF;

    IF EXISTS (
        SELECT 1 FROM authz.relationship r
        WHERE r.relation_definition_id = NEW.relation_definition_id
          AND r.id <> NEW.id
          AND r.subject_entity_id = NEW.subject_entity_id
          AND r.object_entity_id = NEW.object_entity_id
          AND tstzrange(
              r.valid_from,
              least(coalesce(r.valid_until, 'infinity'::timestamptz), coalesce(r.revoked_at, 'infinity'::timestamptz)),
              '[)'
          ) && tstzrange(
              NEW.valid_from,
              least(coalesce(NEW.valid_until, 'infinity'::timestamptz), coalesce(NEW.revoked_at, 'infinity'::timestamptz)),
              '[)'
          )
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'overlapping duplicate relationship';
    END IF;

    subject_limit := CASE definition.cardinality
        WHEN 'ONE_TO_ONE' THEN 1
        WHEN 'ONE_TO_MANY' THEN 1
        ELSE definition.max_subjects
    END;
    IF definition.max_subjects IS NOT NULL THEN
        subject_limit := least(coalesce(subject_limit, definition.max_subjects), definition.max_subjects);
    END IF;
    object_limit := CASE definition.cardinality
        WHEN 'ONE_TO_ONE' THEN 1
        ELSE definition.max_objects
    END;
    IF definition.max_objects IS NOT NULL THEN
        object_limit := least(coalesce(object_limit, definition.max_objects), definition.max_objects);
    END IF;

    IF object_limit IS NOT NULL AND EXISTS (
        WITH boundary(point_at) AS (
            SELECT NEW.valid_from
            UNION
            SELECT greatest(r.valid_from, NEW.valid_from)
            FROM authz.relationship r
            WHERE r.relation_definition_id = NEW.relation_definition_id
              AND r.id <> NEW.id
              AND r.subject_entity_id = NEW.subject_entity_id
              AND tstzrange(
                  r.valid_from,
                  least(coalesce(r.valid_until, 'infinity'::timestamptz), coalesce(r.revoked_at, 'infinity'::timestamptz)),
                  '[)'
              ) && tstzrange(
                  NEW.valid_from,
                  least(coalesce(NEW.valid_until, 'infinity'::timestamptz), coalesce(NEW.revoked_at, 'infinity'::timestamptz)),
                  '[)'
              )
        )
        SELECT 1
        FROM boundary b
        WHERE (
            SELECT count(*)
            FROM authz.relationship r
            WHERE r.relation_definition_id = NEW.relation_definition_id
              AND r.id <> NEW.id
              AND r.subject_entity_id = NEW.subject_entity_id
              AND tstzrange(
                  r.valid_from,
                  least(coalesce(r.valid_until, 'infinity'::timestamptz), coalesce(r.revoked_at, 'infinity'::timestamptz)),
                  '[)'
              ) @> b.point_at
        ) >= object_limit
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'relationship max_objects exceeded in validity window';
    END IF;

    IF subject_limit IS NOT NULL AND EXISTS (
        WITH boundary(point_at) AS (
            SELECT NEW.valid_from
            UNION
            SELECT greatest(r.valid_from, NEW.valid_from)
            FROM authz.relationship r
            WHERE r.relation_definition_id = NEW.relation_definition_id
              AND r.id <> NEW.id
              AND r.object_entity_id = NEW.object_entity_id
              AND tstzrange(
                  r.valid_from,
                  least(coalesce(r.valid_until, 'infinity'::timestamptz), coalesce(r.revoked_at, 'infinity'::timestamptz)),
                  '[)'
              ) && tstzrange(
                  NEW.valid_from,
                  least(coalesce(NEW.valid_until, 'infinity'::timestamptz), coalesce(NEW.revoked_at, 'infinity'::timestamptz)),
                  '[)'
              )
        )
        SELECT 1
        FROM boundary b
        WHERE (
            SELECT count(*)
            FROM authz.relationship r
            WHERE r.relation_definition_id = NEW.relation_definition_id
              AND r.id <> NEW.id
              AND r.object_entity_id = NEW.object_entity_id
              AND tstzrange(
                  r.valid_from,
                  least(coalesce(r.valid_until, 'infinity'::timestamptz), coalesce(r.revoked_at, 'infinity'::timestamptz)),
                  '[)'
              ) @> b.point_at
        ) >= subject_limit
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'relationship max_subjects exceeded in validity window';
    END IF;

    IF definition.acyclic AND EXISTS (
        WITH RECURSIVE reachable(entity_id, window_from, window_until, path) AS (
            SELECT NEW.object_entity_id,
                   NEW.valid_from,
                   least(coalesce(NEW.valid_until, 'infinity'::timestamptz), coalesce(NEW.revoked_at, 'infinity'::timestamptz)),
                   ARRAY[NEW.object_entity_id]
            UNION ALL
            SELECT r.object_entity_id,
                   greatest(p.window_from, r.valid_from),
                   least(
                       p.window_until,
                       coalesce(r.valid_until, 'infinity'::timestamptz),
                       coalesce(r.revoked_at, 'infinity'::timestamptz)
                   ),
                   p.path || r.object_entity_id
            FROM authz.relationship r
            JOIN reachable p ON r.subject_entity_id = p.entity_id
            WHERE r.relation_definition_id = NEW.relation_definition_id
              AND r.id <> NEW.id
              AND p.entity_id <> NEW.subject_entity_id
              AND greatest(p.window_from, r.valid_from) < least(
                  p.window_until,
                  coalesce(r.valid_until, 'infinity'::timestamptz),
                  coalesce(r.revoked_at, 'infinity'::timestamptz)
              )
              AND (r.object_entity_id = NEW.subject_entity_id OR NOT r.object_entity_id = ANY(p.path))
        )
        SELECT 1 FROM reachable WHERE entity_id = NEW.subject_entity_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'acyclic relationship would create a cycle';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER trg_validate_relationship ON authz.relationship;
CREATE TRIGGER trg_validate_relationship
BEFORE INSERT OR UPDATE OF relation_definition_id, subject_entity_id, object_entity_id, revoked_at
ON authz.relationship
FOR EACH ROW EXECUTE FUNCTION authz.validate_relationship();

CREATE FUNCTION authz.align_relationship_revocation_time()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.revoked_at IS NULL
       AND NEW.revoked_at IS NOT NULL
       AND OLD.valid_from <= transaction_timestamp()
       AND NEW.revoked_at >= transaction_timestamp()
       AND NEW.revoked_at <= statement_timestamp() THEN
        NEW.revoked_at := transaction_timestamp();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_relationship_align_revocation_time
BEFORE UPDATE OF revoked_at ON authz.relationship
FOR EACH ROW EXECUTE FUNCTION authz.align_relationship_revocation_time();

CREATE FUNCTION authz.normalize_relationship_reentry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    prior_end timestamptz;
BEGIN
    IF NEW.valid_from = transaction_timestamp() THEN
        SELECT max(least(
            coalesce(relationship.valid_until, 'infinity'::timestamptz),
            coalesce(relationship.revoked_at, 'infinity'::timestamptz)
        )) INTO prior_end
        FROM authz.relationship relationship
        WHERE relationship.relation_definition_id = NEW.relation_definition_id
          AND relationship.subject_entity_id = NEW.subject_entity_id
          AND relationship.object_entity_id = NEW.object_entity_id
          AND relationship.revoked_at IS NOT NULL
          AND relationship.revoked_at <= statement_timestamp();
        IF prior_end IS NOT NULL AND prior_end <> 'infinity'::timestamptz AND prior_end > NEW.valid_from THEN
            NEW.valid_from := prior_end;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_relationship_effective_reentry
BEFORE INSERT ON authz.relationship
FOR EACH ROW EXECUTE FUNCTION authz.normalize_relationship_reentry();

ALTER TABLE authz.relationship
    ADD CONSTRAINT ex_relationship_effective_window
    EXCLUDE USING gist (
        relation_definition_id WITH =,
        subject_entity_id WITH =,
        object_entity_id WITH =,
        tstzrange(
            valid_from,
            least(
                coalesce(valid_until, 'infinity'::timestamptz),
                coalesce(revoked_at, 'infinity'::timestamptz)
            ),
            '[)'
        ) WITH &&
    );

CREATE TRIGGER trg_relationship_no_truncate
BEFORE TRUNCATE ON authz.relationship
FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_immutable_row();

CREATE FUNCTION occ.enforce_process_definition_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'process definition binding is immutable';
END;
$$;

CREATE TRIGGER trg_process_definition_binding_immutable
BEFORE UPDATE OR DELETE ON occ.process_definition_binding
FOR EACH ROW EXECUTE FUNCTION occ.enforce_process_definition_binding();

CREATE FUNCTION occ.enforce_cohort_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'DRAFT' THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'cohort must be created in DRAFT';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.status = 'ARCHIVED' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'archived cohort is immutable';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.customer_instance_id IS DISTINCT FROM OLD.customer_instance_id
       OR NEW.code IS DISTINCT FROM OLD.code
       OR NEW.package_version_id IS DISTINCT FROM OLD.package_version_id
       OR NEW.start_date IS DISTINCT FROM OLD.start_date
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'cohort identity and package are immutable';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE')
        OR (OLD.status = 'ACTIVE' AND NEW.status = 'ARCHIVED')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid cohort lifecycle transition';
    END IF;
    IF NEW.status = 'ARCHIVED' AND EXISTS (
        SELECT 1 FROM occ.process_instance p
        WHERE p.cohort_id = OLD.id AND p.state IN ('RUNNING', 'SUSPENDED')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'cohort with active processes cannot be archived';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cohort_lifecycle
BEFORE INSERT OR UPDATE ON occ.cohort
FOR EACH ROW EXECUTE FUNCTION occ.enforce_cohort_lifecycle();

CREATE TRIGGER trg_cohort_touch
BEFORE UPDATE ON occ.cohort
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE FUNCTION occ.project_cohort_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    owner_relation_id uuid;
    changed_at timestamptz := transaction_timestamp();
BEGIN
    SELECT id INTO STRICT owner_relation_id
    FROM catalog.relation_definition
    WHERE package_version_id = NEW.package_version_id
      AND relation_key = 'cohort_owner';

    IF TG_OP = 'UPDATE' AND NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id THEN
        UPDATE authz.relationship
        SET revoked_at = changed_at,
            revoked_by = NEW.updated_by,
            updated_by = NEW.updated_by
        WHERE relation_definition_id = owner_relation_id
          AND subject_entity_id = OLD.owner_principal_id
          AND object_entity_id = NEW.id
          AND revoked_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'cohort owner projection is missing';
        END IF;
    END IF;

    IF TG_OP = 'INSERT' OR NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id THEN
        INSERT INTO authz.relationship (
            id, relation_definition_id, subject_entity_id, object_entity_id,
            valid_from, source_kind, source_ref, created_by, updated_by
        ) VALUES (
            md5(NEW.id::text || NEW.owner_principal_id::text || clock_timestamp()::text)::uuid,
            owner_relation_id, NEW.owner_principal_id, NEW.id,
            changed_at, 'SYSTEM', 'cohort-owner-projection', NEW.updated_by, NEW.updated_by
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cohort_owner_projection
AFTER INSERT OR UPDATE OF owner_principal_id ON occ.cohort
FOR EACH ROW EXECUTE FUNCTION occ.project_cohort_owner();

CREATE FUNCTION occ.protect_cohort_owner_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    relation_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.relation_definition_id ELSE NEW.relation_definition_id END;
BEGIN
    IF EXISTS (
        SELECT 1 FROM catalog.relation_definition
        WHERE id = relation_id AND relation_key = 'cohort_owner'
    ) AND pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'cohort owner relationship is database-maintained';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_relationship_cohort_owner_projection
BEFORE INSERT OR UPDATE OR DELETE ON authz.relationship
FOR EACH ROW EXECUTE FUNCTION occ.protect_cohort_owner_projection();

CREATE FUNCTION occ.enforce_process_instance_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    cohort_status text;
BEGIN
    IF TG_OP = 'INSERT' OR NEW.cohort_id IS DISTINCT FROM OLD.cohort_id THEN
        SELECT status INTO STRICT cohort_status
        FROM occ.cohort
        WHERE id = NEW.cohort_id
        FOR UPDATE;
        IF cohort_status = 'ARCHIVED' THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'process cannot use an archived cohort';
        END IF;
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'RUNNING' THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'process must be created RUNNING';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.definition_binding_id IS DISTINCT FROM OLD.definition_binding_id
       OR NEW.package_version_id IS DISTINCT FROM OLD.package_version_id
       OR NEW.cohort_id IS DISTINCT FROM OLD.cohort_id
       OR NEW.started_for_participant_id IS DISTINCT FROM OLD.started_for_participant_id
       OR NEW.flowable_instance_id IS DISTINCT FROM OLD.flowable_instance_id
       OR NEW.business_key IS DISTINCT FROM OLD.business_key
       OR NEW.route_key IS DISTINCT FROM OLD.route_key
       OR NEW.route_version IS DISTINCT FROM OLD.route_version
       OR NEW.started_by IS DISTINCT FROM OLD.started_by
       OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'process identity and package are immutable';
    END IF;
    IF OLD.state IN ('COMPLETED', 'CANCELLED', 'FAILED') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal process is immutable';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        (OLD.state = 'RUNNING' AND NEW.state IN ('SUSPENDED', 'COMPLETED', 'CANCELLED', 'FAILED'))
        OR (OLD.state = 'SUSPENDED' AND NEW.state IN ('RUNNING', 'CANCELLED', 'FAILED'))
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid process lifecycle transition';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_process_instance_lifecycle
BEFORE INSERT OR UPDATE ON occ.process_instance
FOR EACH ROW EXECUTE FUNCTION occ.enforce_process_instance_lifecycle();

ALTER TABLE occ.process_instance
    DROP CONSTRAINT process_instance_check,
    ADD CONSTRAINT ck_process_instance_ended_at CHECK (
        (state IN ('COMPLETED', 'CANCELLED', 'FAILED') AND ended_at IS NOT NULL)
        OR (state IN ('RUNNING', 'SUSPENDED') AND ended_at IS NULL)
    );

CREATE FUNCTION occ.enforce_task_projection_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'AVAILABLE' THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task must be created AVAILABLE';
        END IF;
        IF NEW.assignee_id IS NOT NULL OR NEW.claimed_at IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'available task cannot have an assignee or claim time';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.process_instance_id IS DISTINCT FROM OLD.process_instance_id
       OR NEW.activity_key IS DISTINCT FROM OLD.activity_key
       OR NEW.activity_name IS DISTINCT FROM OLD.activity_name
       OR NEW.flowable_task_id IS DISTINCT FROM OLD.flowable_task_id
       OR NEW.flowable_execution_id IS DISTINCT FROM OLD.flowable_execution_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task occurrence identity is immutable';
    END IF;
    IF OLD.state IN ('COMPLETED', 'CANCELLED', 'FAILED') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal task is immutable';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        (OLD.state = 'AVAILABLE' AND NEW.state IN ('CLAIMED', 'CANCELLED', 'FAILED'))
        OR (OLD.state = 'CLAIMED' AND NEW.state IN ('AVAILABLE', 'COMPLETED', 'CANCELLED', 'FAILED'))
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid task lifecycle transition';
    END IF;
    IF NEW.state = 'AVAILABLE' AND (NEW.assignee_id IS NOT NULL OR NEW.claimed_at IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'available task cannot have an assignee or claim time';
    END IF;
    IF NEW.state IN ('CLAIMED', 'COMPLETED') AND (NEW.assignee_id IS NULL OR NEW.claimed_at IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'claimed task requires assignee and claim time';
    END IF;
    IF NEW.state = 'COMPLETED' AND EXISTS (
        SELECT 1
        FROM occ.task_gate_requirement requirement
        LEFT JOIN occ.task_gate_provider_state provider
          ON provider.task_id = requirement.task_id
         AND provider.provider_key = requirement.provider_key
        WHERE requirement.task_id = NEW.id
          AND (
              provider.status IS DISTINCT FROM 'READY'
              OR provider.source_entity_id IS NULL
              OR provider.source_row_version IS DISTINCT FROM
                  occ.task_gate_source_row_version(requirement.provider_key, provider.source_entity_id, NEW.id)
          )
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task gate provider is unavailable';
    END IF;
    IF NEW.state = 'COMPLETED' AND EXISTS (
        SELECT 1 FROM occ.task_blocker blocker
        WHERE blocker.task_id = NEW.id AND blocker.resolved_at IS NULL AND blocker.severity = 'HARD'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task has an active hard blocker';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_task_projection_lifecycle
BEFORE INSERT OR UPDATE ON occ.task_projection
FOR EACH ROW EXECUTE FUNCTION occ.enforce_task_projection_lifecycle();

CREATE UNIQUE INDEX uq_task_blocker_active
ON occ.task_blocker (task_id, source_entity_id, blocker_code)
WHERE resolved_at IS NULL;

CREATE FUNCTION occ.task_gate_source_row_version(p_provider_key text, p_entity_id uuid, p_task_id uuid)
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    current_version bigint;
BEGIN
    IF p_provider_key = 'evidence' OR p_provider_key LIKE 'evidence.%' THEN
        SELECT row_version INTO current_version
        FROM occ.evidence
        WHERE id = p_entity_id AND task_id = p_task_id;
    ELSIF p_provider_key = 'resource' OR p_provider_key LIKE 'resource.%' THEN
        SELECT resource.row_version INTO current_version
        FROM occ.managed_resource resource
        WHERE resource.id = p_entity_id
          AND EXISTS (
              SELECT 1 FROM occ.resource_reservation reservation
              WHERE reservation.resource_id = resource.id
                AND reservation.task_id = p_task_id
                AND reservation.state IN ('PENDING', 'CONFIRMED')
                AND reservation.time_range @> transaction_timestamp()
          );
    ELSIF p_provider_key = 'process' OR p_provider_key LIKE 'process.%' THEN
        SELECT process.row_version INTO current_version
        FROM occ.process_instance process
        JOIN occ.task_projection task ON task.process_instance_id = process.id
        WHERE process.id = p_entity_id AND task.id = p_task_id;
    ELSE
        RETURN NULL;
    END IF;
    RETURN current_version;
END;
$$;

CREATE FUNCTION occ.lock_resource_reservation_tasks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1
    FROM occ.task_projection task
    WHERE task.id IN (
        CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.task_id END,
        CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.task_id END
    )
    ORDER BY task.id
    FOR UPDATE;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_resource_reservation_task_lock
BEFORE INSERT OR UPDATE OR DELETE ON occ.resource_reservation
FOR EACH ROW EXECUTE FUNCTION occ.lock_resource_reservation_tasks();

CREATE FUNCTION occ.mark_resource_reservation_provider_stale()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    old_task_id uuid := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.task_id END;
    old_resource_id uuid := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.resource_id END;
    new_task_id uuid := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.task_id END;
    new_resource_id uuid := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.resource_id END;
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.state IS NOT DISTINCT FROM OLD.state
       AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id
       AND NEW.task_id IS NOT DISTINCT FROM OLD.task_id
       AND NEW.time_range IS NOT DISTINCT FROM OLD.time_range THEN
        RETURN NEW;
    END IF;

    UPDATE occ.task_gate_provider_state provider
    SET status = 'STALE',
        safe_failure_code = NULL,
        refreshed_at = greatest(provider.refreshed_at, transaction_timestamp())
    FROM occ.task_projection task,
         (VALUES (old_task_id, old_resource_id), (new_task_id, new_resource_id)) affected(task_id, resource_id)
    WHERE task.id = affected.task_id
      AND task.state IN ('AVAILABLE', 'CLAIMED')
      AND provider.task_id = affected.task_id
      AND provider.source_entity_id = affected.resource_id
      AND (provider.provider_key = 'resource' OR provider.provider_key LIKE 'resource.%')
      AND provider.status = 'READY';
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_resource_reservation_provider_stale
AFTER INSERT OR UPDATE OR DELETE ON occ.resource_reservation
FOR EACH ROW EXECUTE FUNCTION occ.mark_resource_reservation_provider_stale();

CREATE FUNCTION occ.enforce_task_gate_requirement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    task_state text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT state INTO STRICT task_state
        FROM occ.task_projection
        WHERE id = NEW.task_id
        FOR UPDATE;
        IF task_state IN ('COMPLETED', 'CANCELLED', 'FAILED') THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal task cannot acquire a gate requirement';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task gate requirement is immutable';
END;
$$;

CREATE TRIGGER trg_task_gate_requirement_immutable
BEFORE INSERT OR UPDATE OR DELETE ON occ.task_gate_requirement
FOR EACH ROW EXECUTE FUNCTION occ.enforce_task_gate_requirement();
CREATE TRIGGER trg_task_gate_requirement_no_truncate
BEFORE TRUNCATE ON occ.task_gate_requirement
FOR EACH STATEMENT EXECUTE FUNCTION occ.enforce_task_gate_requirement();

CREATE FUNCTION occ.enforce_task_gate_provider_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    authoritative_version bigint;
    task_state text;
    affected_task_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.task_id ELSE NEW.task_id END;
BEGIN
    SELECT state INTO STRICT task_state
    FROM occ.task_projection
    WHERE id = affected_task_id
    FOR UPDATE;
    IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task gate provider state cannot be deleted';
    END IF;
    IF task_state IN ('COMPLETED', 'CANCELLED', 'FAILED') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal task gate provider state is immutable';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.provider_key IS DISTINCT FROM OLD.provider_key THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task gate provider identity is immutable';
        END IF;
        IF NEW.refreshed_at < OLD.refreshed_at THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task gate provider refresh time cannot move backwards';
        END IF;
        IF NEW.source_entity_id IS NOT DISTINCT FROM OLD.source_entity_id
           AND NEW.source_row_version < OLD.source_row_version THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task gate provider source version cannot move backwards';
        END IF;
    END IF;
    IF NEW.status = 'READY' THEN
        IF NEW.source_entity_id IS NULL OR NEW.source_row_version IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'READY gate provider requires a source entity and version';
        END IF;
        authoritative_version := occ.task_gate_source_row_version(NEW.provider_key, NEW.source_entity_id, NEW.task_id);
        IF authoritative_version IS NULL OR authoritative_version IS DISTINCT FROM NEW.source_row_version THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'READY gate provider source version is not authoritative';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_task_gate_provider_state_controlled
BEFORE INSERT OR UPDATE OR DELETE ON occ.task_gate_provider_state
FOR EACH ROW EXECUTE FUNCTION occ.enforce_task_gate_provider_state();
CREATE TRIGGER trg_task_gate_provider_state_no_truncate
BEFORE TRUNCATE ON occ.task_gate_provider_state
FOR EACH STATEMENT EXECUTE FUNCTION occ.enforce_task_gate_provider_state();

CREATE FUNCTION occ.mark_task_gate_sources_stale()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.row_version > OLD.row_version THEN
        WITH active_providers AS MATERIALIZED (
            SELECT task.id AS task_id, provider.provider_key
            FROM occ.task_projection task
            JOIN occ.task_gate_provider_state provider ON provider.task_id = task.id
            WHERE provider.source_entity_id = NEW.id
              AND provider.source_row_version IS DISTINCT FROM NEW.row_version
              AND provider.status = 'READY'
              AND task.state IN ('AVAILABLE', 'CLAIMED')
            FOR UPDATE OF task
        )
        UPDATE occ.task_gate_provider_state provider
        SET status = 'STALE',
            safe_failure_code = NULL,
            refreshed_at = greatest(provider.refreshed_at, transaction_timestamp())
        FROM active_providers active
        WHERE provider.task_id = active.task_id
          AND provider.provider_key = active.provider_key
          AND provider.source_entity_id = NEW.id
          AND provider.source_row_version IS DISTINCT FROM NEW.row_version
          AND provider.status = 'READY';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_evidence_gate_source_stale
AFTER UPDATE ON occ.evidence
FOR EACH ROW EXECUTE FUNCTION occ.mark_task_gate_sources_stale();
CREATE TRIGGER trg_managed_resource_gate_source_stale
AFTER UPDATE ON occ.managed_resource
FOR EACH ROW EXECUTE FUNCTION occ.mark_task_gate_sources_stale();
CREATE TRIGGER trg_process_instance_gate_source_stale
AFTER UPDATE ON occ.process_instance
FOR EACH ROW EXECUTE FUNCTION occ.mark_task_gate_sources_stale();

CREATE FUNCTION occ.enforce_task_blocker_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    task_state text;
    affected_task_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.task_id ELSE NEW.task_id END;
BEGIN
    SELECT state INTO STRICT task_state
    FROM occ.task_projection
    WHERE id = affected_task_id
    FOR UPDATE;
    IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task blocker cannot be deleted';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF task_state IN ('COMPLETED', 'CANCELLED', 'FAILED') THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal task cannot acquire a blocker';
        END IF;
        RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - 'resolved_at') IS DISTINCT FROM (to_jsonb(OLD) - 'resolved_at') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task blocker facts are immutable';
    END IF;
    IF OLD.resolved_at IS NOT NULL OR NEW.resolved_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'task blocker can only be resolved once';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_task_blocker_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON occ.task_blocker
FOR EACH ROW EXECUTE FUNCTION occ.enforce_task_blocker_lifecycle();
CREATE TRIGGER trg_task_blocker_no_truncate
BEFORE TRUNCATE ON occ.task_blocker
FOR EACH STATEMENT EXECUTE FUNCTION occ.enforce_task_blocker_lifecycle();

CREATE TRIGGER trg_task_timeline_immutable
BEFORE UPDATE OR DELETE ON occ.task_timeline
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
CREATE TRIGGER trg_task_timeline_no_truncate
BEFORE TRUNCATE ON occ.task_timeline
FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_immutable_row();

CREATE UNIQUE INDEX uq_task_review_submission
ON occ.task_review_projection_fact (task_id, evidence_version_id)
WHERE fact_kind = 'SUBMITTED';
CREATE UNIQUE INDEX uq_task_review_decision
ON occ.task_review_projection_fact (submission_fact_id)
WHERE fact_kind = 'DECIDED';
CREATE UNIQUE INDEX uq_task_review_id
ON occ.task_review_projection_fact (review_id)
WHERE review_id IS NOT NULL;

CREATE FUNCTION occ.validate_task_review_projection_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    submission occ.task_review_projection_fact%ROWTYPE;
    task_state text;
    task_assignee_id uuid;
    latest_submission_sequence bigint;
BEGIN
    SELECT state, assignee_id INTO STRICT task_state, task_assignee_id
    FROM occ.task_projection
    WHERE id = NEW.task_id
    FOR UPDATE;

    IF NEW.fact_kind = 'DECIDED' THEN
        IF task_state <> 'CLAIMED' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'review decision requires a claimed task';
        END IF;
        SELECT * INTO STRICT submission
        FROM occ.task_review_projection_fact
        WHERE id = NEW.submission_fact_id AND fact_kind = 'SUBMITTED';
        IF submission.task_id IS DISTINCT FROM NEW.task_id
           OR submission.review_sequence IS DISTINCT FROM NEW.review_sequence THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'decision must match its submission task and sequence';
        END IF;
        IF EXISTS (
            SELECT 1 FROM occ.task_review_projection_fact decided
            WHERE decided.submission_fact_id = submission.id
              AND decided.fact_kind = 'DECIDED'
        ) OR EXISTS (
            SELECT 1 FROM occ.task_review_projection_fact later
            WHERE later.task_id = NEW.task_id
              AND later.fact_kind = 'SUBMITTED'
              AND later.review_sequence > submission.review_sequence
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'decision requires the current pending submission';
        END IF;
    ELSE
        IF task_state <> 'CLAIMED' OR task_assignee_id IS NULL
           OR NEW.prior_assignee_id IS DISTINCT FROM task_assignee_id THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'submission requires the claimed task assignee';
        END IF;
        IF EXISTS (
            SELECT 1 FROM occ.evidence evidence
            WHERE evidence.id = NEW.evidence_id
              AND evidence.task_id IS DISTINCT FROM NEW.task_id
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'submission evidence must belong to its task';
        END IF;
        IF EXISTS (
            SELECT 1
            FROM occ.task_review_projection_fact submitted
            WHERE submitted.task_id = NEW.task_id
              AND submitted.fact_kind = 'SUBMITTED'
              AND NOT EXISTS (
                  SELECT 1 FROM occ.task_review_projection_fact decided
                  WHERE decided.submission_fact_id = submitted.id
                    AND decided.fact_kind = 'DECIDED'
              )
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'prior review submission requires a decision';
        END IF;
        SELECT max(review_sequence) INTO latest_submission_sequence
        FROM occ.task_review_projection_fact
        WHERE task_id = NEW.task_id AND fact_kind = 'SUBMITTED';
        IF NEW.review_sequence IS DISTINCT FROM coalesce(latest_submission_sequence, 0) + 1 THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'review submission sequence must be contiguous';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_task_review_projection_validate
BEFORE INSERT ON occ.task_review_projection_fact
FOR EACH ROW EXECUTE FUNCTION occ.validate_task_review_projection_fact();
CREATE TRIGGER trg_task_review_projection_immutable
BEFORE UPDATE OR DELETE ON occ.task_review_projection_fact
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
CREATE TRIGGER trg_task_review_projection_no_truncate
BEFORE TRUNCATE ON occ.task_review_projection_fact
FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_immutable_row();

CREATE FUNCTION occ.enforce_notification_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.read_at IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'notification must be created unread';
        END IF;
        IF NEW.row_version <> 0 THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'notification must start at row version zero';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.read_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'read notification is immutable';
    END IF;
    IF NEW.read_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'notification update must mark it read';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['read_at', 'row_version'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['read_at', 'row_version']) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'notification identity and content are immutable';
    END IF;
    IF NEW.row_version IS DISTINCT FROM OLD.row_version THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'notification row version is database-managed';
    END IF;
    NEW.row_version := OLD.row_version + 1;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notification_lifecycle
BEFORE INSERT OR UPDATE ON occ.notification
FOR EACH ROW EXECUTE FUNCTION occ.enforce_notification_lifecycle();

CREATE FUNCTION occ.reject_workflow_fact_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = format('%I.%I facts cannot be physically deleted', TG_TABLE_SCHEMA, TG_TABLE_NAME);
END;
$$;

CREATE TRIGGER trg_cohort_no_delete
BEFORE DELETE ON occ.cohort
FOR EACH ROW EXECUTE FUNCTION occ.reject_workflow_fact_delete();
CREATE TRIGGER trg_cohort_no_truncate
BEFORE TRUNCATE ON occ.cohort
FOR EACH STATEMENT EXECUTE FUNCTION occ.reject_workflow_fact_delete();
CREATE TRIGGER trg_process_instance_no_delete
BEFORE DELETE ON occ.process_instance
FOR EACH ROW EXECUTE FUNCTION occ.reject_workflow_fact_delete();
CREATE TRIGGER trg_process_instance_no_truncate
BEFORE TRUNCATE ON occ.process_instance
FOR EACH STATEMENT EXECUTE FUNCTION occ.reject_workflow_fact_delete();
CREATE TRIGGER trg_task_projection_no_delete
BEFORE DELETE ON occ.task_projection
FOR EACH ROW EXECUTE FUNCTION occ.reject_workflow_fact_delete();
CREATE TRIGGER trg_task_projection_no_truncate
BEFORE TRUNCATE ON occ.task_projection
FOR EACH STATEMENT EXECUTE FUNCTION occ.reject_workflow_fact_delete();
CREATE TRIGGER trg_notification_no_delete
BEFORE DELETE ON occ.notification
FOR EACH ROW EXECUTE FUNCTION occ.reject_workflow_fact_delete();
CREATE TRIGGER trg_notification_no_truncate
BEFORE TRUNCATE ON occ.notification
FOR EACH STATEMENT EXECUTE FUNCTION occ.reject_workflow_fact_delete();

CREATE TABLE audit.dependency_failure_attempt (
    id uuid PRIMARY KEY,
    command_key text NOT NULL CHECK (
        command_key = lower(btrim(command_key))
        AND command_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
    ),
    actor_principal_id uuid NOT NULL REFERENCES iam.principal(id),
    target_entity_id uuid REFERENCES authz.entity(id),
    correlation_id uuid NOT NULL,
    dependency_code text NOT NULL CHECK (
        dependency_code = lower(btrim(dependency_code))
        AND dependency_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    ),
    failure_category text NOT NULL CHECK (failure_category IN (
        'UNAVAILABLE', 'TIMEOUT', 'CONFLICT', 'REJECTED', 'INCONSISTENT_STATE'
    )),
    attempted_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TRIGGER trg_dependency_failure_attempt_immutable
BEFORE UPDATE OR DELETE ON audit.dependency_failure_attempt
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
CREATE TRIGGER trg_dependency_failure_attempt_no_truncate
BEFORE TRUNCATE ON audit.dependency_failure_attempt
FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_immutable_row();

CREATE INDEX ix_cohort_customer_status
ON occ.cohort (customer_instance_id, status, start_date, id);
CREATE INDEX ix_process_cohort_state
ON occ.process_instance (cohort_id, state, started_at, id);
CREATE INDEX ix_process_participant_state
ON occ.process_instance (participant_id, state, started_at, id);
CREATE INDEX ix_task_projection_assignee_state
ON occ.task_projection (assignee_id, state, due_at, id);
CREATE INDEX ix_task_blocker_task_active
ON occ.task_blocker (task_id, severity, blocker_code)
WHERE resolved_at IS NULL;
CREATE INDEX ix_task_timeline_task_cursor
ON occ.task_timeline (task_id, cursor);
CREATE INDEX ix_task_review_task_sequence
ON occ.task_review_projection_fact (task_id, review_sequence DESC, fact_kind);
CREATE INDEX ix_notification_recipient_cursor
ON occ.notification (recipient_id, cursor DESC);
CREATE INDEX ix_notification_recipient_unread
ON occ.notification (recipient_id, cursor DESC)
WHERE read_at IS NULL;
CREATE INDEX ix_dependency_failure_correlation
ON audit.dependency_failure_attempt (correlation_id, attempted_at);

GRANT SELECT, INSERT, UPDATE ON
    occ.cohort,
    occ.task_timeline,
    occ.task_review_projection_fact,
    occ.notification
TO innorder_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON occ.task_gate_requirement FROM innorder_runtime;
REVOKE DELETE, TRUNCATE ON occ.task_gate_provider_state, occ.task_blocker FROM innorder_runtime;
GRANT SELECT, INSERT ON occ.task_gate_requirement TO innorder_runtime;
GRANT SELECT, INSERT, UPDATE ON occ.task_gate_provider_state, occ.task_blocker TO innorder_runtime;
REVOKE DELETE, TRUNCATE ON
    occ.cohort,
    occ.process_instance,
    occ.task_projection,
    occ.task_timeline,
    occ.task_review_projection_fact,
    occ.notification
FROM innorder_runtime;
REVOKE TRUNCATE ON authz.relationship FROM innorder_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA occ TO innorder_runtime;
GRANT SELECT, INSERT ON audit.dependency_failure_attempt TO innorder_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON audit.dependency_failure_attempt FROM innorder_runtime;

CREATE OR REPLACE FUNCTION authz.bump_relationship_revision_statement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    facts_changed boolean := false;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT EXISTS (
            SELECT 1 FROM new_relationships r
            JOIN catalog.relation_definition definition ON definition.id = r.relation_definition_id
            WHERE definition.auth_relevant AND definition.relation_key <> 'cohort_owner'
              AND r.revoked_at IS NULL
              AND r.valid_from <= transaction_timestamp()
              AND (r.valid_until IS NULL OR r.valid_until > transaction_timestamp())
        ) INTO facts_changed;
    ELSIF TG_OP = 'DELETE' THEN
        SELECT EXISTS (
            SELECT 1 FROM old_relationships r
            JOIN catalog.relation_definition definition ON definition.id = r.relation_definition_id
            WHERE definition.auth_relevant AND definition.relation_key <> 'cohort_owner'
              AND r.revoked_at IS NULL
              AND r.valid_from <= transaction_timestamp()
              AND (r.valid_until IS NULL OR r.valid_until > transaction_timestamp())
        ) INTO facts_changed;
    ELSE
        SELECT EXISTS (
            SELECT 1 FROM old_relationships old_r
            JOIN catalog.relation_definition definition ON definition.id = old_r.relation_definition_id
            LEFT JOIN new_relationships new_r ON new_r.id = old_r.id
            WHERE definition.auth_relevant
              AND definition.relation_key <> 'cohort_owner'
              AND old_r.revoked_at IS NULL
              AND old_r.valid_from <= transaction_timestamp()
              AND (old_r.valid_until IS NULL OR old_r.valid_until > transaction_timestamp())
              AND NOT (new_r.revoked_at IS NULL AND new_r.valid_from <= transaction_timestamp()
                       AND (new_r.valid_until IS NULL OR new_r.valid_until > transaction_timestamp()))
            UNION ALL
            SELECT 1 FROM new_relationships new_r
            JOIN catalog.relation_definition definition ON definition.id = new_r.relation_definition_id
            LEFT JOIN old_relationships old_r ON old_r.id = new_r.id
            WHERE definition.auth_relevant
              AND definition.relation_key <> 'cohort_owner'
              AND new_r.revoked_at IS NULL
              AND new_r.valid_from <= transaction_timestamp()
              AND (new_r.valid_until IS NULL OR new_r.valid_until > transaction_timestamp())
              AND NOT (old_r.revoked_at IS NULL AND old_r.valid_from <= transaction_timestamp()
                       AND (old_r.valid_until IS NULL OR old_r.valid_until > transaction_timestamp()))
            LIMIT 1
        ) INTO facts_changed;
    END IF;
    IF facts_changed THEN
        PERFORM authz.bump_authorization_revision();
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION occ.project_cohort_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    owner_relation_id uuid;
    changed_at timestamptz := transaction_timestamp();
BEGIN
    SELECT id INTO STRICT owner_relation_id
    FROM catalog.relation_definition
    WHERE package_version_id = NEW.package_version_id
      AND relation_key = 'cohort_owner';

    IF TG_OP = 'UPDATE' AND NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id THEN
        UPDATE authz.relationship
        SET revoked_at = changed_at,
            revoked_by = NEW.updated_by,
            updated_by = NEW.updated_by
        WHERE relation_definition_id = owner_relation_id
          AND subject_entity_id = OLD.owner_principal_id
          AND object_entity_id = NEW.id
          AND revoked_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'cohort owner projection is missing';
        END IF;
    END IF;

    IF TG_OP = 'INSERT' OR NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id THEN
        INSERT INTO authz.relationship (
            id, relation_definition_id, subject_entity_id, object_entity_id,
            valid_from, source_kind, source_ref, created_by, updated_by
        ) VALUES (
            md5(NEW.id::text || NEW.owner_principal_id::text || clock_timestamp()::text)::uuid,
            owner_relation_id, NEW.owner_principal_id, NEW.id,
            changed_at, 'SYSTEM', 'cohort-owner-projection', NEW.updated_by, NEW.updated_by
        );
    END IF;
    PERFORM authz.bump_authorization_revision();
    RETURN NEW;
END;
$$;

CREATE TABLE authz.authorization_revision_batch (
    transaction_id xid8 PRIMARY KEY,
    changed boolean NOT NULL DEFAULT false
);

REVOKE ALL ON authz.authorization_revision_batch FROM PUBLIC, innorder_runtime;

CREATE OR REPLACE FUNCTION authz.bump_authorization_revision()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, authz
AS $$
DECLARE
    next_revision bigint;
BEGIN
    UPDATE authz.authorization_revision_batch
    SET changed = true
    WHERE transaction_id = pg_current_xact_id();
    IF FOUND THEN
        SELECT current_revision INTO STRICT next_revision
        FROM authz.authorization_state
        WHERE singleton;
        RETURN next_revision;
    END IF;

    UPDATE authz.authorization_state
    SET current_revision = current_revision + 1,
        updated_at = statement_timestamp()
    WHERE singleton
    RETURNING current_revision INTO STRICT next_revision;
    RETURN next_revision;
END;
$$;

CREATE FUNCTION authz.begin_authorization_revision_batch()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, authz
AS $$
DECLARE
    current_revision bigint;
BEGIN
    SELECT authz.lock_authorization_state_for_change() INTO STRICT current_revision;
    INSERT INTO authz.authorization_revision_batch(transaction_id)
    VALUES (pg_current_xact_id());
    RETURN current_revision;
END;
$$;

CREATE FUNCTION authz.finish_authorization_revision_batch()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, authz
AS $$
DECLARE
    facts_changed boolean;
    current_revision bigint;
BEGIN
    DELETE FROM authz.authorization_revision_batch
    WHERE transaction_id = pg_current_xact_id()
    RETURNING changed INTO facts_changed;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'authorization revision batch is not open';
    END IF;
    IF facts_changed THEN
        RETURN authz.bump_authorization_revision();
    END IF;
    SELECT state.current_revision INTO STRICT current_revision
    FROM authz.authorization_state state
    WHERE state.singleton;
    RETURN current_revision;
END;
$$;

CREATE FUNCTION authz.enforce_authorization_revision_batch_closed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, authz
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM authz.authorization_revision_batch
        WHERE transaction_id = NEW.transaction_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'authorization revision batch must be closed';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_authorization_revision_batch_closed
AFTER INSERT ON authz.authorization_revision_batch
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION authz.enforce_authorization_revision_batch_closed();

REVOKE EXECUTE ON FUNCTION authz.begin_authorization_revision_batch() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION authz.finish_authorization_revision_batch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.begin_authorization_revision_batch() TO innorder_runtime;
GRANT EXECUTE ON FUNCTION authz.finish_authorization_revision_batch() TO innorder_runtime;
