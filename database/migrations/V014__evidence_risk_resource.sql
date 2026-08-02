-- Preflight immutable history before adding constraints. No legacy fact is rewritten.
LOCK TABLE occ.upload_session IN ACCESS EXCLUSIVE MODE;
LOCK TABLE occ.evidence IN ACCESS EXCLUSIVE MODE;
LOCK TABLE occ.evidence_version IN ACCESS EXCLUSIVE MODE;
LOCK TABLE occ.evidence_review IN ACCESS EXCLUSIVE MODE;
LOCK TABLE occ.risk IN ACCESS EXCLUSIVE MODE;
LOCK TABLE occ.managed_resource IN ACCESS EXCLUSIVE MODE;
LOCK TABLE occ.resource_reservation IN ACCESS EXCLUSIVE MODE;
LOCK TABLE occ.task_projection IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
    legacy_review_ids text;
    legacy_exclusive_ids text;
    legacy_capacity_ids text;
    legacy_task_process_ids text;
BEGIN
    SELECT pg_catalog.string_agg(review_group, '; ' ORDER BY review_group)
    INTO legacy_review_ids
    FROM (
        SELECT er.evidence_version_id::text || ':'
               || pg_catalog.string_agg(er.id::text, ',' ORDER BY er.id) AS review_group
        FROM occ.evidence_review er
        GROUP BY er.evidence_version_id
        HAVING pg_catalog.count(*) > 1
    ) duplicate_reviews;

    IF legacy_review_ids IS NOT NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'V014 preflight found legacy multiple reviews: ' || legacy_review_ids;
    END IF;

    SELECT pg_catalog.string_agg(conflict_pair, ',' ORDER BY conflict_pair)
    INTO legacy_exclusive_ids
    FROM (
        SELECT r1.id::text || '/' || r2.id::text AS conflict_pair
        FROM occ.resource_reservation r1
        JOIN occ.resource_reservation r2
          ON r1.resource_id = r2.resource_id
         AND r1.id < r2.id
         AND r1.time_range && r2.time_range
        WHERE r1.state IN ('PENDING', 'CONFIRMED')
          AND r2.state IN ('PENDING', 'CONFIRMED')
          AND (r1.exclusive OR r2.exclusive)
    ) exclusive_conflicts;

    IF legacy_exclusive_ids IS NOT NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '23P01',
            MESSAGE = 'V014 preflight found legacy exclusive reservation conflicts: ' || legacy_exclusive_ids;
    END IF;

    WITH boundaries AS (
        SELECT resource_id, lower(time_range) AS boundary_at
        FROM occ.resource_reservation
        WHERE state IN ('PENDING', 'CONFIRMED')
        UNION
        SELECT resource_id, upper(time_range) AS boundary_at
        FROM occ.resource_reservation
        WHERE state IN ('PENDING', 'CONFIRMED')
    ), capacity_conflicts AS (
        SELECT b.resource_id, b.boundary_at,
               pg_catalog.string_agg(r.id::text, ',' ORDER BY r.id) AS reservation_ids
        FROM boundaries b
        JOIN occ.managed_resource mr ON mr.id = b.resource_id
        JOIN occ.resource_reservation r
          ON r.resource_id = b.resource_id
         AND r.state IN ('PENDING', 'CONFIRMED')
         AND r.time_range @> b.boundary_at
        GROUP BY b.resource_id, b.boundary_at, mr.capacity
        HAVING pg_catalog.sum(r.capacity) > mr.capacity
    )
    SELECT pg_catalog.string_agg(
               resource_id::text || '@' || boundary_at::text || ':' || reservation_ids,
               '; ' ORDER BY resource_id, boundary_at
           )
    INTO legacy_capacity_ids
    FROM capacity_conflicts;

    IF legacy_capacity_ids IS NOT NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '23P01',
            MESSAGE = 'V014 preflight found legacy capacity violations: ' || legacy_capacity_ids;
    END IF;

    SELECT pg_catalog.string_agg(r.id::text, ',' ORDER BY r.id)
    INTO legacy_task_process_ids
    FROM occ.resource_reservation r
    LEFT JOIN occ.task_projection task ON task.id = r.task_id
    WHERE r.task_id IS NOT NULL
      AND (r.process_instance_id IS NULL OR task.id IS NULL
           OR task.process_instance_id IS DISTINCT FROM r.process_instance_id);

    IF legacy_task_process_ids IS NOT NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'V014 preflight found reservation task/process mismatches: ' || legacy_task_process_ids;
    END IF;
END;
$$;

ALTER TABLE occ.upload_session
    DROP CONSTRAINT upload_session_status_check,
    ADD COLUMN requirement_id uuid REFERENCES catalog.evidence_requirement(id),
    ADD COLUMN evidence_id uuid REFERENCES occ.evidence(id),
    ADD COLUMN slot_key text,
    ADD COLUMN normalized_extension text,
    ADD COLUMN quarantine_object_key text,
    ADD COLUMN immutable_object_key text,
    ADD COLUMN actual_sha256 text,
    ADD COLUMN actual_size_bytes bigint,
    ADD COLUMN detected_media_type text,
    ADD COLUMN scanner_engine text,
    ADD COLUMN scanner_version text,
    ADD COLUMN scanner_result_ref text,
    ADD COLUMN lease_owner uuid,
    ADD COLUMN lease_acquired_at timestamptz,
    ADD COLUMN lease_heartbeat_at timestamptz,
    ADD COLUMN lease_expires_at timestamptz,
    ADD COLUMN absolute_deadline_at timestamptz,
    ADD COLUMN failure_code text,
    ADD COLUMN cleanup_after timestamptz,
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    ADD CONSTRAINT ck_upload_session_status CHECK (status IN (
        'CREATED', 'UPLOADED', 'STREAMING', 'INSPECTING', 'SCANNING', 'PROMOTING',
        'CONFIRMED', 'FAILED', 'EXPIRED'
    )),
    ADD CONSTRAINT ck_upload_session_actual_sha CHECK (
        actual_sha256 IS NULL OR actual_sha256 ~ '^[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT ck_upload_session_actual_size CHECK (
        actual_size_bytes IS NULL OR actual_size_bytes > 0
    ),
    ADD CONSTRAINT ck_upload_session_slot CHECK (
        slot_key IS NULL OR (pg_catalog.length(slot_key) BETWEEN 1 AND 128)
    ),
    ADD CONSTRAINT ck_upload_session_extension CHECK (
        normalized_extension IS NULL OR normalized_extension ~ '^[a-z0-9][a-z0-9._-]{0,31}$'
    );

CREATE UNIQUE INDEX uq_upload_session_quarantine_object
ON occ.upload_session (quarantine_object_key)
WHERE quarantine_object_key IS NOT NULL;

CREATE UNIQUE INDEX uq_upload_session_immutable_object
ON occ.upload_session (immutable_object_key)
WHERE immutable_object_key IS NOT NULL;

CREATE INDEX ix_upload_session_lease_expiry
ON occ.upload_session (lease_expires_at, id)
WHERE status IN ('STREAMING', 'INSPECTING', 'SCANNING', 'PROMOTING');

ALTER TABLE occ.evidence
    ADD COLUMN target_entity_id uuid REFERENCES authz.entity(id),
    ADD COLUMN slot_key text,
    ADD COLUMN legal_hold_at timestamptz,
    ADD COLUMN legal_hold_by uuid REFERENCES iam.principal(id),
    ADD COLUMN legal_hold_reason text,
    ADD CONSTRAINT ck_evidence_slot CHECK (
        slot_key IS NULL OR (pg_catalog.length(slot_key) BETWEEN 1 AND 128)
    ),
    ADD CONSTRAINT ck_evidence_legal_hold CHECK (
        (legal_hold_at IS NULL AND legal_hold_by IS NULL AND legal_hold_reason IS NULL)
        OR (legal_hold_at IS NOT NULL AND legal_hold_by IS NOT NULL
            AND pg_catalog.length(legal_hold_reason) BETWEEN 1 AND 512)
    );

CREATE UNIQUE INDEX uq_evidence_target_requirement_slot
ON occ.evidence (target_entity_id, requirement_id, slot_key)
WHERE target_entity_id IS NOT NULL AND slot_key IS NOT NULL;

ALTER TABLE occ.evidence_version
    ADD COLUMN upload_session_id uuid REFERENCES occ.upload_session(id),
    ADD COLUMN detected_media_type text,
    ADD COLUMN normalized_extension text,
    ADD COLUMN scanner_engine text,
    ADD COLUMN scanner_version text,
    ADD COLUMN scanner_result text,
    ADD COLUMN scanner_result_ref text,
    ADD CONSTRAINT ck_evidence_version_scanner_result CHECK (
        scanner_result IS NULL OR scanner_result = 'CLEAN'
    );

ALTER TABLE occ.evidence_review
    ADD COLUMN follow_up_due_at timestamptz,
    ADD COLUMN gate_satisfied boolean,
    ADD CONSTRAINT ck_evidence_review_follow_up CHECK (
        (decision = 'CONDITIONAL' AND follow_up_due_at IS NOT NULL)
        OR (decision <> 'CONDITIONAL' AND follow_up_due_at IS NULL)
    ) NOT VALID;

CREATE TABLE occ.evidence_object_disposition (
    id uuid PRIMARY KEY,
    evidence_version_id uuid REFERENCES occ.evidence_version(id),
    upload_session_id uuid REFERENCES occ.upload_session(id),
    object_key text NOT NULL UNIQUE,
    disposition_state text NOT NULL CHECK (disposition_state IN (
        'RETAINED', 'CLEANUP_PENDING', 'DELETING', 'DELETE_FAILED', 'DELETED'
    )),
    retained_until timestamptz,
    legal_hold_at timestamptz,
    legal_hold_by uuid REFERENCES iam.principal(id),
    legal_hold_reason text,
    backup_snapshot_id text,
    cleanup_lease_owner uuid,
    cleanup_lease_expires_at timestamptz,
    cleanup_attempts integer NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
    cleanup_last_error text,
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK (evidence_version_id IS NOT NULL OR upload_session_id IS NOT NULL),
    CHECK ((disposition_state = 'DELETED') = (deleted_at IS NOT NULL)),
    CHECK (
        (legal_hold_at IS NULL AND legal_hold_by IS NULL AND legal_hold_reason IS NULL)
        OR (legal_hold_at IS NOT NULL AND legal_hold_by IS NOT NULL
            AND pg_catalog.length(legal_hold_reason) BETWEEN 1 AND 512)
    ),
    CHECK (cleanup_last_error IS NULL OR pg_catalog.length(cleanup_last_error) <= 1024)
);

CREATE UNIQUE INDEX uq_evidence_object_disposition_version
ON occ.evidence_object_disposition (evidence_version_id)
WHERE evidence_version_id IS NOT NULL;

CREATE UNIQUE INDEX uq_evidence_object_disposition_upload
ON occ.evidence_object_disposition (upload_session_id, object_key)
WHERE upload_session_id IS NOT NULL;

CREATE INDEX ix_evidence_object_disposition_cleanup
ON occ.evidence_object_disposition (cleanup_lease_expires_at, retained_until, id)
WHERE disposition_state IN ('CLEANUP_PENDING', 'DELETE_FAILED');

CREATE FUNCTION occ.validate_upload_session_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
    evidence_head occ.evidence%ROWTYPE;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'CREATED' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'upload session must start in CREATED state';
        END IF;
        IF NEW.requirement_id IS NULL OR NEW.evidence_id IS NULL OR NEW.slot_key IS NULL
           OR NEW.normalized_extension IS NULL OR NEW.quarantine_object_key IS NULL
           OR NEW.immutable_object_key IS NULL OR NEW.absolute_deadline_at IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'new upload session requires complete lease and object provenance';
        END IF;
        IF NEW.object_key IS DISTINCT FROM NEW.quarantine_object_key THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'new upload object key must identify its quarantine object';
        END IF;
    END IF;

    IF NEW.evidence_id IS NOT NULL THEN
        SELECT * INTO STRICT evidence_head
        FROM occ.evidence
        WHERE id = NEW.evidence_id
        FOR UPDATE;
        IF NEW.requirement_id IS DISTINCT FROM evidence_head.requirement_id
           OR NEW.target_entity_id IS DISTINCT FROM evidence_head.target_entity_id
           OR NEW.slot_key IS DISTINCT FROM evidence_head.slot_key THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'upload session does not match evidence requirement, target, and slot';
        END IF;
    END IF;
    IF NEW.absolute_deadline_at <= NEW.created_at
       OR NEW.absolute_deadline_at > NEW.created_at + interval '2 hours'
       OR NEW.expires_at > NEW.created_at + interval '30 minutes' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'upload session deadlines exceed bounded lifetime';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.uploader_id IS DISTINCT FROM OLD.uploader_id
           OR NEW.target_entity_id IS DISTINCT FROM OLD.target_entity_id
           OR NEW.requirement_id IS DISTINCT FROM OLD.requirement_id
           OR NEW.evidence_id IS DISTINCT FROM OLD.evidence_id
           OR NEW.slot_key IS DISTINCT FROM OLD.slot_key
           OR NEW.object_key IS DISTINCT FROM OLD.object_key
           OR NEW.expected_sha256 IS DISTINCT FROM OLD.expected_sha256
           OR NEW.expected_size_bytes IS DISTINCT FROM OLD.expected_size_bytes
           OR NEW.normalized_extension IS DISTINCT FROM OLD.normalized_extension
           OR NEW.quarantine_object_key IS DISTINCT FROM OLD.quarantine_object_key
           OR NEW.immutable_object_key IS DISTINCT FROM OLD.immutable_object_key
           OR NEW.absolute_deadline_at IS DISTINCT FROM OLD.absolute_deadline_at
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
           OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'upload session provenance is immutable';
        END IF;
        IF OLD.status IN ('CONFIRMED', 'FAILED', 'EXPIRED') AND NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal upload session is immutable';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
            (OLD.status = 'CREATED' AND NEW.status IN ('STREAMING', 'FAILED', 'EXPIRED'))
            OR (OLD.status = 'UPLOADED' AND NEW.status IN ('INSPECTING', 'FAILED', 'EXPIRED'))
            OR (OLD.status = 'STREAMING' AND NEW.status IN ('INSPECTING', 'FAILED'))
            OR (OLD.status = 'INSPECTING' AND NEW.status IN ('SCANNING', 'FAILED'))
            OR (OLD.status = 'SCANNING' AND NEW.status IN ('PROMOTING', 'FAILED'))
            OR (OLD.status = 'PROMOTING' AND NEW.status IN ('CONFIRMED', 'FAILED'))
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid upload session transition';
        END IF;
        NEW.updated_at := statement_timestamp();
    END IF;
    IF NEW.status IN ('STREAMING', 'INSPECTING', 'SCANNING', 'PROMOTING') AND (
        NEW.lease_owner IS NULL OR NEW.lease_acquired_at IS NULL
        OR NEW.lease_heartbeat_at IS NULL OR NEW.lease_expires_at IS NULL
        OR NEW.absolute_deadline_at IS NULL OR NEW.lease_expires_at > NEW.absolute_deadline_at
        OR NEW.lease_acquired_at < NEW.created_at
        OR NEW.lease_acquired_at > NEW.lease_heartbeat_at
        OR NEW.lease_heartbeat_at >= NEW.lease_expires_at
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'active upload session requires a bounded lease';
    END IF;
    IF NEW.status IN ('PROMOTING', 'CONFIRMED') AND (
        NEW.actual_sha256 IS DISTINCT FROM NEW.expected_sha256
        OR NEW.actual_size_bytes IS DISTINCT FROM NEW.expected_size_bytes
        OR NEW.detected_media_type IS NULL OR NEW.scanner_engine IS NULL
        OR NEW.scanner_version IS NULL OR NEW.scanner_result_ref IS NULL
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'promoted upload requires verified content and scanner provenance';
    END IF;
    IF NEW.status = 'CONFIRMED' AND (TG_OP = 'INSERT' OR OLD.status <> 'CONFIRMED') THEN
        PERFORM 1
        FROM occ.evidence_version ev
        WHERE ev.upload_session_id = NEW.id
          AND ev.evidence_id = NEW.evidence_id
          AND ev.version = evidence_head.current_version
          AND ev.object_key = NEW.immutable_object_key
          AND ev.sha256 = NEW.actual_sha256
          AND ev.size_bytes = NEW.actual_size_bytes
          AND ev.detected_media_type = NEW.detected_media_type
          AND ev.normalized_extension = NEW.normalized_extension
          AND ev.scanner_engine = NEW.scanner_engine
          AND ev.scanner_version = NEW.scanner_version
          AND ev.scanner_result_ref = NEW.scanner_result_ref
        FOR KEY SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'confirmed upload requires a matching immutable evidence version';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_upload_session_lifecycle
BEFORE INSERT OR UPDATE ON occ.upload_session
FOR EACH ROW EXECUTE FUNCTION occ.validate_upload_session_lifecycle();

CREATE FUNCTION occ.validate_evidence_version_provenance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
    upload occ.upload_session%ROWTYPE;
    evidence_head occ.evidence%ROWTYPE;
BEGIN
    IF NEW.upload_session_id IS NULL OR NEW.detected_media_type IS NULL
       OR NEW.normalized_extension IS NULL OR NEW.scanner_engine IS NULL
       OR NEW.scanner_version IS NULL OR NEW.scanner_result IS NULL
       OR NEW.scanner_result_ref IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'new evidence version requires complete upload and scanner provenance';
    END IF;

    SELECT * INTO STRICT upload
    FROM occ.upload_session
    WHERE id = NEW.upload_session_id
    FOR UPDATE;
    SELECT * INTO STRICT evidence_head
    FROM occ.evidence
    WHERE id = NEW.evidence_id
    FOR UPDATE;

    IF upload.evidence_id IS DISTINCT FROM NEW.evidence_id
       OR upload.requirement_id IS DISTINCT FROM evidence_head.requirement_id
       OR upload.target_entity_id IS DISTINCT FROM evidence_head.target_entity_id
       OR upload.slot_key IS DISTINCT FROM evidence_head.slot_key
       OR upload.status NOT IN ('PROMOTING', 'CONFIRMED')
       OR upload.immutable_object_key IS DISTINCT FROM NEW.object_key
       OR upload.actual_sha256 IS DISTINCT FROM NEW.sha256
       OR upload.actual_size_bytes IS DISTINCT FROM NEW.size_bytes
       OR upload.uploader_id IS DISTINCT FROM NEW.submitted_by
       OR upload.detected_media_type IS DISTINCT FROM NEW.detected_media_type
       OR upload.normalized_extension IS DISTINCT FROM NEW.normalized_extension
       OR upload.scanner_engine IS DISTINCT FROM NEW.scanner_engine
       OR upload.scanner_version IS DISTINCT FROM NEW.scanner_version
       OR upload.scanner_result_ref IS DISTINCT FROM NEW.scanner_result_ref
       OR NEW.mime_type IS DISTINCT FROM NEW.detected_media_type
       OR NEW.scanner_result <> 'CLEAN' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'evidence version does not match confirmed upload provenance';
    END IF;
    IF NEW.version <> coalesce(evidence_head.current_version, 0) + 1 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'evidence version must increase by exactly one';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_evidence_version_provenance
BEFORE INSERT ON occ.evidence_version
FOR EACH ROW EXECUTE FUNCTION occ.validate_evidence_version_provenance();

CREATE FUNCTION occ.validate_evidence_review_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
    evidence_row occ.evidence%ROWTYPE;
    submitter uuid;
BEGIN
    SELECT e.*
    INTO STRICT evidence_row
    FROM occ.evidence_version ev
    JOIN occ.evidence e ON e.id = ev.evidence_id
    WHERE ev.id = NEW.evidence_version_id
    FOR UPDATE OF e;
    SELECT ev.submitted_by INTO STRICT submitter
    FROM occ.evidence_version ev
    WHERE ev.id = NEW.evidence_version_id;

    IF evidence_row.current_version IS DISTINCT FROM (
        SELECT version FROM occ.evidence_version WHERE id = NEW.evidence_version_id
    ) OR evidence_row.state <> 'SUBMITTED' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'review requires the current submitted evidence version';
    END IF;
    IF NEW.reviewer_id = submitter OR NEW.reviewer_id = evidence_row.created_by THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'reviewer must differ from submitter and evidence creator';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM occ.evidence_review
        WHERE evidence_version_id = NEW.evidence_version_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'evidence version already has a review';
    END IF;
    IF NEW.gate_satisfied IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'review requires a gate result';
    END IF;
    IF (NEW.decision = 'CONDITIONAL') IS DISTINCT FROM (NEW.follow_up_due_at IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'conditional review requires a follow-up due time';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_evidence_review_validate
BEFORE INSERT ON occ.evidence_review
FOR EACH ROW EXECUTE FUNCTION occ.validate_evidence_review_insert();

CREATE FUNCTION occ.validate_evidence_head_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.target_entity_id IS NULL OR NEW.slot_key IS NULL OR NEW.state <> 'PENDING' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'new evidence requires a target slot in PENDING state';
        END IF;
        IF NEW.target_entity_id IS DISTINCT FROM NEW.task_id
           AND NEW.target_entity_id IS DISTINCT FROM NEW.business_object_id THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'evidence target must match its task or business object';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.requirement_id IS DISTINCT FROM OLD.requirement_id
       OR NEW.task_id IS DISTINCT FROM OLD.task_id
       OR NEW.business_object_id IS DISTINCT FROM OLD.business_object_id
       OR NEW.target_entity_id IS DISTINCT FROM OLD.target_entity_id
       OR NEW.slot_key IS DISTINCT FROM OLD.slot_key
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'evidence identity is immutable';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        (OLD.state = 'PENDING' AND NEW.state IN ('SUBMITTED', 'ARCHIVED'))
        OR (OLD.state = 'SUBMITTED' AND NEW.state IN ('ACCEPTED', 'REJECTED', 'ARCHIVED'))
        OR (OLD.state = 'REJECTED' AND NEW.state IN ('PENDING', 'SUBMITTED', 'ARCHIVED'))
        OR (OLD.state = 'ACCEPTED' AND NEW.state = 'ARCHIVED')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid evidence state transition';
    END IF;
    IF OLD.state = 'ARCHIVED' AND (
        (to_jsonb(NEW) - ARRAY['legal_hold_at', 'legal_hold_by', 'legal_hold_reason', 'row_version', 'updated_at'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['legal_hold_at', 'legal_hold_by', 'legal_hold_reason', 'row_version', 'updated_at'])
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'archived evidence is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_evidence_head_lifecycle
BEFORE INSERT OR UPDATE ON occ.evidence
FOR EACH ROW EXECUTE FUNCTION occ.validate_evidence_head_lifecycle();

CREATE FUNCTION occ.validate_evidence_object_disposition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
    disposition_evidence_id uuid;
    version_upload_session_id uuid;
    version_object_key text;
    upload_evidence_id uuid;
    upload_quarantine_object_key text;
    upload_immutable_object_key text;
    evidence_legal_hold_at timestamptz;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'evidence object disposition cannot be deleted';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.evidence_version_id IS DISTINCT FROM OLD.evidence_version_id
           OR NEW.upload_session_id IS DISTINCT FROM OLD.upload_session_id
           OR NEW.object_key IS DISTINCT FROM OLD.object_key
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'evidence object disposition identity is immutable';
        END IF;
        IF OLD.disposition_state = 'DELETED' AND NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'deleted evidence object disposition is immutable';
        END IF;
        IF NEW.disposition_state IS DISTINCT FROM OLD.disposition_state AND NOT (
            (OLD.disposition_state = 'RETAINED' AND NEW.disposition_state = 'CLEANUP_PENDING')
            OR (OLD.disposition_state IN ('CLEANUP_PENDING', 'DELETE_FAILED') AND NEW.disposition_state = 'DELETING')
            OR (OLD.disposition_state = 'DELETING' AND NEW.disposition_state IN ('DELETED', 'DELETE_FAILED'))
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid evidence object disposition transition';
        END IF;
        NEW.updated_at := statement_timestamp();
    END IF;

    IF NEW.evidence_version_id IS NOT NULL THEN
        SELECT ev.evidence_id, ev.upload_session_id, ev.object_key
        INTO STRICT disposition_evidence_id, version_upload_session_id, version_object_key
        FROM occ.evidence_version ev
        WHERE ev.id = NEW.evidence_version_id;
    END IF;
    IF NEW.upload_session_id IS NOT NULL THEN
        SELECT us.evidence_id, us.quarantine_object_key, us.immutable_object_key
        INTO STRICT upload_evidence_id, upload_quarantine_object_key, upload_immutable_object_key
        FROM occ.upload_session us
        WHERE id = NEW.upload_session_id
        FOR KEY SHARE;
    END IF;
    IF NEW.evidence_version_id IS NOT NULL AND NEW.upload_session_id IS NOT NULL AND (
        version_upload_session_id IS DISTINCT FROM NEW.upload_session_id
        OR disposition_evidence_id IS DISTINCT FROM upload_evidence_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mismatched disposition provenance';
    END IF;
    disposition_evidence_id := coalesce(disposition_evidence_id, upload_evidence_id);
    IF NEW.evidence_version_id IS NOT NULL
       AND NEW.object_key IS DISTINCT FROM version_object_key THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'disposition object key does not match evidence version';
    END IF;
    IF NEW.evidence_version_id IS NULL
       AND NEW.object_key IS DISTINCT FROM upload_quarantine_object_key
       AND NEW.object_key IS DISTINCT FROM upload_immutable_object_key THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'disposition object key does not match upload session';
    END IF;
    SELECT e.legal_hold_at INTO STRICT evidence_legal_hold_at
    FROM occ.evidence e
    WHERE id = disposition_evidence_id
    FOR UPDATE;
    IF NEW.disposition_state IN ('CLEANUP_PENDING', 'DELETING', 'DELETE_FAILED', 'DELETED') AND (
        NEW.legal_hold_at IS NOT NULL OR NEW.backup_snapshot_id IS NOT NULL
        OR evidence_legal_hold_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'legal hold or backup snapshot prevents object cleanup';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_evidence_object_disposition_identity
BEFORE INSERT OR UPDATE OR DELETE ON occ.evidence_object_disposition
FOR EACH ROW EXECUTE FUNCTION occ.validate_evidence_object_disposition();

ALTER TABLE occ.risk
    ADD COLUMN occurrence_key text,
    ADD COLUMN detected_at timestamptz,
    ADD COLUMN evaluated_at timestamptz,
    ADD COLUMN calendar_version text,
    ADD COLUMN owner_relationship_id uuid REFERENCES authz.relationship(id),
    ADD COLUMN last_escalation_level integer,
    ADD COLUMN last_escalated_at timestamptz,
    ADD CONSTRAINT ck_risk_escalation_level CHECK (
        last_escalation_level IS NULL OR last_escalation_level >= 0
    );

CREATE TABLE occ.risk_occurrence (
    id uuid PRIMARY KEY,
    risk_id uuid NOT NULL UNIQUE REFERENCES occ.risk(id),
    rule_definition_id uuid NOT NULL REFERENCES catalog.risk_rule_definition(id),
    target_entity_id uuid NOT NULL REFERENCES authz.entity(id),
    occurrence_key text NOT NULL CHECK (pg_catalog.length(occurrence_key) BETWEEN 1 AND 512),
    triggering_fact_ids jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(triggering_fact_ids) = 'array'),
    threshold_kind text NOT NULL CHECK (threshold_kind IN ('ELAPSED', 'BUSINESS')),
    calendar_version text NOT NULL,
    evaluated_at timestamptz NOT NULL,
    detected_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (rule_definition_id, target_entity_id, occurrence_key)
);

CREATE TABLE occ.risk_action (
    id uuid PRIMARY KEY,
    risk_id uuid NOT NULL REFERENCES occ.risk(id),
    actor_id uuid NOT NULL REFERENCES iam.principal(id),
    action_type text NOT NULL CHECK (action_type IN (
        'ACKNOWLEDGED', 'ASSIGNED', 'ESCALATED', 'MITIGATED', 'RESOLVED', 'DISMISSED'
    )),
    escalation_level integer CHECK (escalation_level IS NULL OR escalation_level >= 0),
    reason text,
    action_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(action_data)),
    acted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    UNIQUE (risk_id, escalation_level)
);

CREATE TABLE occ.risk_adjudication (
    id uuid PRIMARY KEY,
    reporting_period_start date NOT NULL,
    reporting_period_end date NOT NULL,
    evaluator_id uuid NOT NULL REFERENCES iam.principal(id),
    known_event_key text NOT NULL,
    target_entity_id uuid NOT NULL REFERENCES authz.entity(id),
    severe_event boolean NOT NULL,
    risk_id uuid REFERENCES occ.risk(id),
    outcome text NOT NULL CHECK (outcome IN (
        'TRUE_POSITIVE', 'FALSE_POSITIVE', 'MISSED', 'NOT_APPLICABLE'
    )),
    reason text NOT NULL,
    adjudication_version integer NOT NULL CHECK (adjudication_version > 0),
    supersedes_adjudication_id uuid REFERENCES occ.risk_adjudication(id),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK (reporting_period_end > reporting_period_start),
    CHECK ((outcome = 'MISSED' AND risk_id IS NULL) OR outcome <> 'MISSED'),
    UNIQUE (known_event_key, target_entity_id, adjudication_version),
    UNIQUE (supersedes_adjudication_id)
);

CREATE TABLE occ.risk_intervention (
    id uuid PRIMARY KEY,
    risk_id uuid NOT NULL REFERENCES occ.risk(id),
    source_action_id uuid REFERENCES occ.risk_action(id),
    intervention_type text NOT NULL,
    owner_relationship_id uuid REFERENCES authz.relationship(id),
    due_at timestamptz,
    intervention_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (platform.is_json_object(intervention_data)),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE INDEX ix_risk_occurrence_target
ON occ.risk_occurrence (target_entity_id, evaluated_at DESC, id);

CREATE INDEX ix_risk_action_history
ON occ.risk_action (risk_id, acted_at, id);

CREATE INDEX ix_risk_adjudication_period
ON occ.risk_adjudication (reporting_period_start, reporting_period_end, outcome);

CREATE INDEX ix_risk_intervention_queue
ON occ.risk (due_at, severity DESC, id)
WHERE severity IN ('YELLOW', 'RED') AND state IN ('OPEN', 'ACKNOWLEDGED');

CREATE UNIQUE INDEX uq_risk_head_occurrence_identity
ON occ.risk (rule_definition_id, target_entity_id, occurrence_key)
WHERE occurrence_key IS NOT NULL;

CREATE FUNCTION occ.validate_risk_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'OPEN' OR NEW.occurrence_key IS NULL
           OR NEW.detected_at IS NULL OR NEW.evaluated_at IS NULL
           OR NEW.calendar_version IS NULL OR NEW.resolved_at IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'new risk requires immutable occurrence facts in OPEN state';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.rule_definition_id IS DISTINCT FROM OLD.rule_definition_id
       OR NEW.target_entity_id IS DISTINCT FROM OLD.target_entity_id
       OR NEW.occurrence_key IS DISTINCT FROM OLD.occurrence_key
       OR NEW.detected_at IS DISTINCT FROM OLD.detected_at
       OR NEW.evaluated_at IS DISTINCT FROM OLD.evaluated_at
       OR NEW.calendar_version IS DISTINCT FROM OLD.calendar_version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'risk occurrence facts are immutable';
    END IF;
    IF OLD.state IN ('RESOLVED', 'DISMISSED') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal risk is immutable';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        (OLD.state = 'OPEN' AND NEW.state IN ('ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'))
        OR (OLD.state = 'ACKNOWLEDGED' AND NEW.state IN ('RESOLVED', 'DISMISSED'))
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid risk state transition';
    END IF;
    IF (NEW.state = 'RESOLVED') IS DISTINCT FROM (NEW.resolved_at IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'resolved risk requires resolved_at';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_risk_lifecycle
BEFORE INSERT OR UPDATE ON occ.risk
FOR EACH ROW EXECUTE FUNCTION occ.validate_risk_lifecycle();

CREATE FUNCTION occ.validate_risk_occurrence_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
    risk_head occ.risk%ROWTYPE;
BEGIN
    SELECT * INTO STRICT risk_head
    FROM occ.risk
    WHERE id = NEW.risk_id
    FOR UPDATE;
    IF risk_head.rule_definition_id IS DISTINCT FROM NEW.rule_definition_id
       OR risk_head.target_entity_id IS DISTINCT FROM NEW.target_entity_id
       OR risk_head.occurrence_key IS DISTINCT FROM NEW.occurrence_key
       OR risk_head.calendar_version IS DISTINCT FROM NEW.calendar_version
       OR risk_head.evaluated_at IS DISTINCT FROM NEW.evaluated_at
       OR risk_head.detected_at IS DISTINCT FROM NEW.detected_at THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'risk occurrence does not match risk head facts';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_risk_occurrence_validate
BEFORE INSERT ON occ.risk_occurrence
FOR EACH ROW EXECUTE FUNCTION occ.validate_risk_occurrence_insert();

CREATE FUNCTION occ.enforce_risk_occurrence_completeness()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
    risk_id_to_check uuid;
    risk_head occ.risk%ROWTYPE;
    matching_occurrences bigint;
BEGIN
    risk_id_to_check := coalesce(
        (to_jsonb(NEW) ->> 'risk_id')::uuid,
        (to_jsonb(NEW) ->> 'id')::uuid
    );
    SELECT * INTO STRICT risk_head
    FROM occ.risk
    WHERE id = risk_id_to_check;
    IF risk_head.occurrence_key IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT count(*) INTO matching_occurrences
    FROM occ.risk_occurrence ro
    WHERE ro.risk_id = risk_head.id
      AND ro.rule_definition_id = risk_head.rule_definition_id
      AND ro.target_entity_id = risk_head.target_entity_id
      AND ro.occurrence_key = risk_head.occurrence_key
      AND ro.calendar_version = risk_head.calendar_version
      AND ro.evaluated_at = risk_head.evaluated_at
      AND ro.detected_at = risk_head.detected_at;
    IF matching_occurrences <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'risk head requires exactly one matching occurrence fact';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_risk_occurrence_complete_from_risk
AFTER INSERT OR UPDATE ON occ.risk
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION occ.enforce_risk_occurrence_completeness();

CREATE CONSTRAINT TRIGGER trg_risk_occurrence_complete_from_child
AFTER INSERT ON occ.risk_occurrence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION occ.enforce_risk_occurrence_completeness();

CREATE FUNCTION occ.validate_risk_action_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
    risk_state text;
BEGIN
    SELECT state INTO STRICT risk_state
    FROM occ.risk
    WHERE id = NEW.risk_id
    FOR UPDATE;
    IF risk_state IN ('RESOLVED', 'DISMISSED') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal risk rejects new actions';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_risk_action_validate
BEFORE INSERT ON occ.risk_action
FOR EACH ROW EXECUTE FUNCTION occ.validate_risk_action_insert();

CREATE FUNCTION occ.validate_risk_adjudication_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
    prior occ.risk_adjudication%ROWTYPE;
BEGIN
    IF NEW.supersedes_adjudication_id IS NULL THEN
        IF NEW.adjudication_version <> 1 THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'initial adjudication version must be one';
        END IF;
        RETURN NEW;
    END IF;
    SELECT * INTO STRICT prior
    FROM occ.risk_adjudication
    WHERE id = NEW.supersedes_adjudication_id
    FOR KEY SHARE;
    IF NEW.known_event_key IS DISTINCT FROM prior.known_event_key
       OR NEW.target_entity_id IS DISTINCT FROM prior.target_entity_id
       OR NEW.adjudication_version <> prior.adjudication_version + 1 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'adjudication supersession must preserve identity and increment version';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_risk_adjudication_validate
BEFORE INSERT ON occ.risk_adjudication
FOR EACH ROW EXECUTE FUNCTION occ.validate_risk_adjudication_insert();

CREATE TRIGGER trg_risk_occurrence_immutable
BEFORE UPDATE OR DELETE ON occ.risk_occurrence
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();

CREATE TRIGGER trg_risk_action_immutable
BEFORE UPDATE OR DELETE ON occ.risk_action
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();

CREATE TRIGGER trg_risk_adjudication_immutable
BEFORE UPDATE OR DELETE ON occ.risk_adjudication
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();

CREATE TRIGGER trg_risk_intervention_immutable
BEFORE UPDATE OR DELETE ON occ.risk_intervention
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();

ALTER TABLE occ.task_projection
    ADD CONSTRAINT uq_task_projection_id_process UNIQUE (id, process_instance_id);

ALTER TABLE occ.resource_reservation
    DROP CONSTRAINT resource_reservation_resource_id_time_range_excl,
    ADD COLUMN confirmed_at timestamptz,
    ADD COLUMN cancelled_at timestamptz,
    ADD COLUMN completed_at timestamptz,
    ADD CONSTRAINT ck_resource_reservation_canonical_range CHECK (
        NOT isempty(time_range) AND lower(time_range) IS NOT NULL AND upper(time_range) IS NOT NULL
        AND lower_inc(time_range) AND NOT upper_inc(time_range)
    ) NOT VALID,
    ADD CONSTRAINT ck_resource_reservation_lifecycle_times CHECK (
        (state = 'PENDING' AND confirmed_at IS NULL AND cancelled_at IS NULL AND completed_at IS NULL)
        OR (state = 'CONFIRMED' AND confirmed_at IS NOT NULL AND cancelled_at IS NULL AND completed_at IS NULL)
        OR (state = 'CANCELLED' AND cancelled_at IS NOT NULL AND completed_at IS NULL)
        OR (state = 'COMPLETED' AND confirmed_at IS NOT NULL AND cancelled_at IS NULL AND completed_at IS NOT NULL)
    ) NOT VALID,
    ADD CONSTRAINT ck_resource_reservation_task_process_present CHECK (
        task_id IS NULL OR process_instance_id IS NOT NULL
    ) NOT VALID,
    ADD CONSTRAINT fk_resource_reservation_task_process
        FOREIGN KEY (task_id, process_instance_id)
        REFERENCES occ.task_projection(id, process_instance_id) NOT VALID;

ALTER TABLE occ.resource_reservation
    VALIDATE CONSTRAINT ck_resource_reservation_task_process_present,
    VALIDATE CONSTRAINT fk_resource_reservation_task_process;

CREATE TABLE occ.resource_reservation_history (
    history_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id uuid NOT NULL REFERENCES occ.resource_reservation(id),
    resource_id uuid NOT NULL,
    requester_entity_id uuid NOT NULL,
    process_instance_id uuid,
    task_id uuid,
    time_range tstzrange NOT NULL,
    capacity numeric NOT NULL,
    exclusive boolean NOT NULL,
    state text NOT NULL,
    row_version bigint NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    confirmed_at timestamptz,
    cancelled_at timestamptz,
    completed_at timestamptz,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX ix_resource_reservation_history_latest
ON occ.resource_reservation_history (resource_id, reservation_id, recorded_at DESC, history_id DESC);

INSERT INTO occ.resource_reservation_history
    (reservation_id, resource_id, requester_entity_id, process_instance_id, task_id,
     time_range, capacity, exclusive, state, row_version, created_at,
     updated_at, confirmed_at, cancelled_at, completed_at, recorded_at)
SELECT id, resource_id, requester_entity_id, process_instance_id, task_id,
       time_range, capacity, exclusive, state, row_version, created_at,
       updated_at, confirmed_at, cancelled_at, completed_at, statement_timestamp()
FROM occ.resource_reservation;

CREATE FUNCTION occ.snapshot_resource_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, occ
AS $$
BEGIN
    INSERT INTO occ.resource_reservation_history
        (reservation_id, resource_id, requester_entity_id, process_instance_id, task_id,
         time_range, capacity, exclusive, state, row_version, created_at,
         updated_at, confirmed_at, cancelled_at, completed_at, recorded_at)
    VALUES
        (NEW.id, NEW.resource_id, NEW.requester_entity_id, NEW.process_instance_id, NEW.task_id,
         NEW.time_range, NEW.capacity, NEW.exclusive, NEW.state, NEW.row_version, NEW.created_at,
         NEW.updated_at, NEW.confirmed_at, NEW.cancelled_at, NEW.completed_at, clock_timestamp());
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_resource_reservation_snapshot
AFTER INSERT OR UPDATE ON occ.resource_reservation
FOR EACH ROW EXECUTE FUNCTION occ.snapshot_resource_reservation();

CREATE TRIGGER trg_resource_reservation_history_immutable
BEFORE UPDATE OR DELETE ON occ.resource_reservation_history
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();

CREATE TABLE occ.resource_availability (
    id uuid PRIMARY KEY,
    resource_id uuid NOT NULL REFERENCES occ.managed_resource(id),
    time_range tstzrange NOT NULL,
    mode text NOT NULL CHECK (mode IN ('AVAILABLE', 'UNAVAILABLE')),
    reason text,
    created_by uuid NOT NULL REFERENCES iam.principal(id),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK (reason IS NULL OR pg_catalog.length(reason) <= 512),
    CHECK (
        NOT isempty(time_range) AND lower(time_range) IS NOT NULL AND upper(time_range) IS NOT NULL
        AND lower_inc(time_range) AND NOT upper_inc(time_range)
    )
);

CREATE INDEX ix_resource_availability_range
ON occ.resource_availability USING gist (resource_id, time_range);

CREATE INDEX ix_resource_reservation_schedule
ON occ.resource_reservation USING gist (resource_id, time_range)
WHERE state IN ('PENDING', 'CONFIRMED');

CREATE INDEX ix_resource_reservation_cursor
ON occ.resource_reservation (resource_id, created_at, id)
WHERE state IN ('PENDING', 'CONFIRMED');

CREATE FUNCTION occ.validate_resource_availability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
BEGIN
    PERFORM 1
    FROM occ.managed_resource
    WHERE id = NEW.resource_id
    FOR UPDATE;
    IF NOT (lower_inc(NEW.time_range) AND NOT upper_inc(NEW.time_range))
       OR lower(NEW.time_range) IS NULL OR upper(NEW.time_range) IS NULL
       OR isempty(NEW.time_range) THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'availability range must be finite and canonical [)';
    END IF;
    IF NEW.mode = 'UNAVAILABLE' AND EXISTS (
        SELECT 1
        FROM occ.resource_reservation r
        WHERE r.resource_id = NEW.resource_id
          AND r.state IN ('PENDING', 'CONFIRMED')
          AND r.time_range && NEW.time_range
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'unavailability conflicts with an active reservation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_resource_availability_validate
BEFORE INSERT ON occ.resource_availability
FOR EACH ROW EXECUTE FUNCTION occ.validate_resource_availability();

CREATE TRIGGER trg_resource_availability_immutable
BEFORE UPDATE OR DELETE ON occ.resource_availability
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();

CREATE FUNCTION occ.validate_resource_reservation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
    resource occ.managed_resource%ROWTYPE;
    available_ranges tstzmultirange;
    peak_capacity numeric;
BEGIN
    IF TG_OP = 'UPDATE' AND (
        OLD.resource_id IS DISTINCT FROM NEW.resource_id
        OR OLD.requester_entity_id IS DISTINCT FROM NEW.requester_entity_id
        OR OLD.process_instance_id IS DISTINCT FROM NEW.process_instance_id
        OR OLD.task_id IS DISTINCT FROM NEW.task_id
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'reservation parent links are immutable';
    END IF;

    SELECT * INTO STRICT resource
    FROM occ.managed_resource
    WHERE id = NEW.resource_id
    FOR UPDATE;

    IF NEW.task_id IS NOT NULL THEN
        IF NEW.process_instance_id IS NULL OR NOT EXISTS (
            SELECT 1
            FROM occ.task_projection task
            WHERE task.id = NEW.task_id
              AND task.process_instance_id = NEW.process_instance_id
            FOR KEY SHARE
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'reservation task must belong to process';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.state IN ('CANCELLED', 'COMPLETED') AND NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal reservation is immutable';
        END IF;
        IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
            (OLD.state = 'PENDING' AND NEW.state IN ('CONFIRMED', 'CANCELLED'))
            OR (OLD.state = 'CONFIRMED' AND NEW.state IN ('CANCELLED', 'COMPLETED'))
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid reservation state transition';
        END IF;
    END IF;

    IF NOT (lower_inc(NEW.time_range) AND NOT upper_inc(NEW.time_range))
       OR lower(NEW.time_range) IS NULL OR upper(NEW.time_range) IS NULL
       OR isempty(NEW.time_range) THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'reservation range must be finite and canonical [)';
    END IF;
    IF NEW.capacity <= 0 OR NEW.capacity > resource.capacity THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'reservation capacity exceeds resource capacity';
    END IF;
    IF NOT (
        (NEW.state = 'PENDING' AND NEW.confirmed_at IS NULL AND NEW.cancelled_at IS NULL AND NEW.completed_at IS NULL)
        OR (NEW.state = 'CONFIRMED' AND NEW.confirmed_at IS NOT NULL AND NEW.cancelled_at IS NULL AND NEW.completed_at IS NULL)
        OR (NEW.state = 'CANCELLED' AND NEW.cancelled_at IS NOT NULL AND NEW.completed_at IS NULL)
        OR (NEW.state = 'COMPLETED' AND NEW.confirmed_at IS NOT NULL AND NEW.cancelled_at IS NULL AND NEW.completed_at IS NOT NULL)
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'reservation lifecycle timestamps do not match state';
    END IF;

    IF NEW.state NOT IN ('PENDING', 'CONFIRMED') THEN
        RETURN NEW;
    END IF;
    IF resource.state <> 'AVAILABLE' THEN
        RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'resource is not available for reservations';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM occ.resource_availability a
        WHERE a.resource_id = NEW.resource_id
          AND a.mode = 'UNAVAILABLE'
          AND a.time_range && NEW.time_range
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'reservation overlaps unavailable time';
    END IF;
    SELECT range_agg(a.time_range) INTO available_ranges
    FROM occ.resource_availability a
    WHERE a.resource_id = NEW.resource_id AND a.mode = 'AVAILABLE';
    IF available_ranges IS NOT NULL AND NOT (available_ranges @> NEW.time_range) THEN
        RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'reservation is outside configured availability';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM occ.resource_reservation existing
        WHERE existing.resource_id = NEW.resource_id
          AND existing.id <> NEW.id
          AND existing.state IN ('PENDING', 'CONFIRMED')
          AND existing.time_range && NEW.time_range
          AND (NEW.exclusive OR existing.exclusive)
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'reservation conflicts with exclusivity';
    END IF;

    IF NOT NEW.exclusive THEN
        WITH reservation_ranges AS (
            SELECT lower(NEW.time_range) AS boundary_at, NEW.capacity AS delta, 1 AS event_order
            UNION ALL
            SELECT upper(NEW.time_range), -NEW.capacity, 0
            UNION ALL
            SELECT lower(existing.time_range), existing.capacity, 1
            FROM occ.resource_reservation existing
            WHERE existing.resource_id = NEW.resource_id
              AND existing.id <> NEW.id
              AND existing.state IN ('PENDING', 'CONFIRMED')
              AND NOT existing.exclusive
              AND existing.time_range && NEW.time_range
            UNION ALL
            SELECT upper(existing.time_range), -existing.capacity, 0
            FROM occ.resource_reservation existing
            WHERE existing.resource_id = NEW.resource_id
              AND existing.id <> NEW.id
              AND existing.state IN ('PENDING', 'CONFIRMED')
              AND NOT existing.exclusive
              AND existing.time_range && NEW.time_range
        ), running_capacity AS (
            SELECT pg_catalog.sum(delta) OVER (
                       ORDER BY boundary_at, event_order ROWS UNBOUNDED PRECEDING
                   ) AS committed_capacity
            FROM reservation_ranges
        )
        SELECT pg_catalog.max(committed_capacity) INTO peak_capacity
        FROM running_capacity;
        IF peak_capacity > resource.capacity THEN
            RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'reservation exceeds peak resource capacity';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_resource_reservation_validate
BEFORE INSERT OR UPDATE ON occ.resource_reservation
FOR EACH ROW EXECUTE FUNCTION occ.validate_resource_reservation();

CREATE FUNCTION occ.reject_resource_reservation_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'reservation history cannot be deleted';
END;
$$;

CREATE TRIGGER trg_resource_reservation_no_delete
BEFORE DELETE ON occ.resource_reservation
FOR EACH ROW EXECUTE FUNCTION occ.reject_resource_reservation_delete();

CREATE FUNCTION occ.validate_managed_resource_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
    peak_capacity numeric;
BEGIN
    IF OLD.state = 'ARCHIVED' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'archived resource is immutable';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND OLD.state <> 'ARCHIVED' AND NOT (
        (OLD.state = 'AVAILABLE' AND NEW.state IN ('UNAVAILABLE', 'MAINTENANCE', 'ARCHIVED'))
        OR (OLD.state IN ('UNAVAILABLE', 'MAINTENANCE') AND NEW.state IN ('AVAILABLE', 'ARCHIVED'))
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid managed resource state transition';
    END IF;
    IF NEW.capacity IS DISTINCT FROM OLD.capacity THEN
        WITH events AS (
            SELECT lower(time_range) AS boundary_at, capacity AS delta, 1 AS event_order
            FROM occ.resource_reservation
            WHERE resource_id = NEW.id AND state IN ('PENDING', 'CONFIRMED')
            UNION ALL
            SELECT upper(time_range), -capacity, 0
            FROM occ.resource_reservation
            WHERE resource_id = NEW.id AND state IN ('PENDING', 'CONFIRMED')
        ), running_capacity AS (
            SELECT pg_catalog.sum(delta) OVER (
                       ORDER BY boundary_at, event_order ROWS UNBOUNDED PRECEDING
                   ) AS committed_capacity
            FROM events
        )
        SELECT coalesce(pg_catalog.max(committed_capacity), 0)
        INTO peak_capacity
        FROM running_capacity;
        IF peak_capacity > NEW.capacity THEN
            RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'resource capacity is below active commitments';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_managed_resource_capacity
BEFORE UPDATE OF capacity, state ON occ.managed_resource
FOR EACH ROW EXECUTE FUNCTION occ.validate_managed_resource_change();

-- V014 exposes no callable function API. The history snapshot trigger runs as the
-- migration owner; all functions remain unavailable to the runtime role.
REVOKE EXECUTE ON FUNCTION occ.validate_upload_session_lifecycle() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION occ.validate_evidence_version_provenance() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION occ.validate_evidence_review_insert() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION occ.validate_evidence_head_lifecycle() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION occ.validate_evidence_object_disposition() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION occ.validate_risk_lifecycle() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION occ.validate_risk_occurrence_insert() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION occ.enforce_risk_occurrence_completeness() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION occ.validate_risk_action_insert() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION occ.validate_risk_adjudication_insert() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION occ.validate_resource_availability() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION occ.validate_resource_reservation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION occ.reject_resource_reservation_delete() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION occ.validate_managed_resource_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION occ.snapshot_resource_reservation() FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    occ.evidence_object_disposition,
    occ.risk_occurrence,
    occ.risk_action,
    occ.risk_adjudication,
    occ.risk_intervention,
    occ.resource_availability
TO innorder_runtime;

REVOKE INSERT, UPDATE, DELETE ON TABLE occ.resource_reservation_history FROM innorder_runtime;
GRANT SELECT ON TABLE occ.resource_reservation_history TO innorder_runtime;
