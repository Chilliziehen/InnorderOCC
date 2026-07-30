CREATE TABLE platform.customer_instance (
    id uuid PRIMARY KEY,
    singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
    instance_key text NOT NULL UNIQUE,
    row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK (instance_key <> '' AND instance_key = lower(btrim(instance_key))),
    CHECK (instance_key ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'),
    CHECK (updated_at >= created_at)
);

-- Stable deployment identity for development and default single-customer installations.
INSERT INTO platform.customer_instance (id, instance_key)
VALUES ('00000000-0000-7000-8000-000000000001', 'default');

CREATE FUNCTION platform.protect_customer_instance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'customer instance singleton cannot be removed';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.singleton IS DISTINCT FROM OLD.singleton
       OR NEW.instance_key IS DISTINCT FROM OLD.instance_key THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'customer instance identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_customer_instance_identity
BEFORE UPDATE OF id, singleton, instance_key ON platform.customer_instance
FOR EACH ROW EXECUTE FUNCTION platform.protect_customer_instance();
CREATE TRIGGER trg_customer_instance_no_delete
BEFORE DELETE ON platform.customer_instance
FOR EACH ROW EXECUTE FUNCTION platform.protect_customer_instance();
CREATE TRIGGER trg_customer_instance_no_truncate
BEFORE TRUNCATE ON platform.customer_instance
FOR EACH STATEMENT EXECUTE FUNCTION platform.protect_customer_instance();
CREATE TRIGGER trg_customer_instance_touch
BEFORE UPDATE ON platform.customer_instance
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE iam.auth_session (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES iam.principal(id),
    token_version integer NOT NULL DEFAULT 0 CHECK (token_version >= 0),
    refresh_token_hash text NOT NULL UNIQUE
        CHECK (refresh_token_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    last_used_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    replaced_by_session_id uuid REFERENCES iam.auth_session(id),
    client_fingerprint text,
    CHECK (expires_at > created_at),
    CHECK (last_used_at >= created_at AND last_used_at <= expires_at),
    CHECK (revoked_at IS NULL OR (revoked_at >= created_at AND revoked_at <= expires_at)),
    CHECK (revoked_at IS NULL OR last_used_at <= revoked_at),
    CHECK (replaced_by_session_id IS NULL OR replaced_by_session_id <> id),
    CHECK (replaced_by_session_id IS NULL OR revoked_at IS NOT NULL),
    CHECK (client_fingerprint IS NULL OR (
        octet_length(client_fingerprint) BETWEEN 1 AND 256
        AND client_fingerprint = btrim(client_fingerprint)
        AND client_fingerprint !~ '[[:cntrl:]]'
    ))
);

CREATE FUNCTION iam.enforce_auth_session_rotation_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    replacement_principal_id uuid;
    replacement_created_at timestamptz;
BEGIN
    IF TG_OP = 'UPDATE' AND (
        NEW.id IS DISTINCT FROM OLD.id
        OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'auth session identity is immutable';
    END IF;

    IF NEW.replaced_by_session_id IS NOT NULL THEN
        IF NEW.revoked_at IS NULL OR NEW.replaced_by_session_id = NEW.id THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rotated session must be revoked and cannot replace itself';
        END IF;
        SELECT principal_id, created_at
        INTO replacement_principal_id, replacement_created_at
        FROM iam.auth_session
        WHERE id = NEW.replaced_by_session_id
        FOR KEY SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'replacement session must exist';
        END IF;
        IF replacement_principal_id <> NEW.principal_id THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'replacement session must belong to the same principal';
        END IF;
        IF replacement_created_at < NEW.created_at THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'replacement session cannot predate rotated session';
        END IF;
        IF EXISTS (
            WITH RECURSIVE rotation_chain(id, replaced_by_session_id) AS (
                SELECT s.id, s.replaced_by_session_id
                FROM iam.auth_session s
                WHERE s.id = NEW.replaced_by_session_id
                UNION
                SELECT s.id, s.replaced_by_session_id
                FROM iam.auth_session s
                JOIN rotation_chain c ON s.id = c.replaced_by_session_id
            )
            SELECT 1 FROM rotation_chain WHERE id = NEW.id
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'auth session rotation chain cannot contain a cycle';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auth_session_rotation_integrity
BEFORE INSERT OR UPDATE ON iam.auth_session
FOR EACH ROW EXECUTE FUNCTION iam.enforce_auth_session_rotation_integrity();

CREATE INDEX ix_auth_session_active_principal_expiry
ON iam.auth_session (principal_id, expires_at)
WHERE (revoked_at IS NULL);

ALTER TABLE audit.idempotency_record
    ADD COLUMN state text,
    ADD COLUMN response_body jsonb,
    ADD COLUMN updated_at timestamptz;

UPDATE audit.idempotency_record
SET state = CASE
        WHEN response_status IS NOT NULL AND response_digest IS NOT NULL THEN 'COMPLETED'
        WHEN response_status IS NULL AND response_digest IS NULL AND resource_id IS NULL THEN 'IN_PROGRESS'
        ELSE 'FAILED'
    END,
    updated_at = created_at;

ALTER TABLE audit.idempotency_record
    ALTER COLUMN state SET DEFAULT 'IN_PROGRESS',
    ALTER COLUMN state SET NOT NULL,
    ALTER COLUMN updated_at SET DEFAULT statement_timestamp(),
    ALTER COLUMN updated_at SET NOT NULL,
    ADD CONSTRAINT ck_idempotency_state
        CHECK (state IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
    ADD CONSTRAINT ck_idempotency_response_body
        CHECK (response_body IS NULL OR (
            platform.is_json_object(response_body)
            AND octet_length(response_body::text) <= 65536
        )),
    ADD CONSTRAINT ck_idempotency_timestamps
        CHECK (updated_at >= created_at AND expires_at > created_at),
    ADD CONSTRAINT ck_idempotency_state_payload
        CHECK (
            (state = 'IN_PROGRESS'
             AND response_status IS NULL
             AND response_digest IS NULL
             AND response_body IS NULL
             AND resource_id IS NULL)
            OR
            (state = 'COMPLETED'
             AND response_status IS NOT NULL
             AND response_digest IS NOT NULL)
            OR (state = 'FAILED'
                AND (response_status IS NOT NULL
                     OR response_digest IS NOT NULL
                     OR resource_id IS NOT NULL))
        );

CREATE FUNCTION audit.enforce_idempotency_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'idempotency request_hash is immutable';
    END IF;
    IF OLD.state IN ('COMPLETED', 'FAILED') AND NEW.state IS DISTINCT FROM OLD.state THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal idempotency state cannot transition';
    END IF;
    IF OLD.state IN ('COMPLETED', 'FAILED')
       AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'terminal idempotency payload is immutable';
    END IF;
    IF OLD.state = 'IN_PROGRESS'
       AND NEW.state NOT IN ('IN_PROGRESS', 'COMPLETED', 'FAILED') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid idempotency lifecycle transition';
    END IF;
    NEW.updated_at := greatest(statement_timestamp(), OLD.updated_at + interval '1 microsecond');
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_idempotency_record_lifecycle
BEFORE UPDATE ON audit.idempotency_record
FOR EACH ROW EXECUTE FUNCTION audit.enforce_idempotency_lifecycle();

ALTER TABLE audit.outbox_event
    ADD COLUMN customer_instance_id uuid,
    ADD COLUMN actor_entity_id uuid,
    ADD COLUMN causation_id uuid,
    ADD COLUMN last_error text,
    ADD COLUMN next_attempt_at timestamptz,
    ADD COLUMN claimed_at timestamptz;

UPDATE audit.outbox_event
SET customer_instance_id = '00000000-0000-7000-8000-000000000001',
    next_attempt_at = available_at,
    published_at = CASE
        WHEN status = 'PUBLISHED' THEN greatest(published_at, created_at)
        ELSE NULL
    END,
    claimed_at = CASE
        WHEN status = 'PUBLISHED' THEN greatest(published_at, created_at)
        WHEN status = 'PUBLISHING' THEN created_at
        ELSE NULL
    END,
    last_error = CASE WHEN status = 'DEAD' THEN 'delivery failed' ELSE NULL END;

ALTER TABLE audit.outbox_event
    ALTER COLUMN customer_instance_id SET NOT NULL,
    ALTER COLUMN customer_instance_id SET DEFAULT '00000000-0000-7000-8000-000000000001',
    ALTER COLUMN next_attempt_at SET NOT NULL,
    ALTER COLUMN next_attempt_at SET DEFAULT statement_timestamp(),
    ADD CONSTRAINT fk_outbox_customer_instance
        FOREIGN KEY (customer_instance_id) REFERENCES platform.customer_instance(id),
    ADD CONSTRAINT fk_outbox_actor_entity
        FOREIGN KEY (actor_entity_id) REFERENCES authz.entity(id),
    ADD CONSTRAINT ck_outbox_last_error
        CHECK (last_error IS NULL OR (
            octet_length(last_error) BETWEEN 1 AND 2048
            AND last_error = btrim(last_error)
            AND last_error !~ '[[:cntrl:]]'
        )),
    ADD CONSTRAINT ck_outbox_retry_schedule
        CHECK (next_attempt_at >= available_at),
    ADD CONSTRAINT ck_outbox_claim_publish_time
        CHECK ((claimed_at IS NULL OR claimed_at >= created_at)
               AND (published_at IS NULL OR (claimed_at IS NOT NULL AND published_at >= claimed_at))),
    ADD CONSTRAINT ck_outbox_lifecycle
        CHECK (
            (status = 'PENDING' AND claimed_at IS NULL AND published_at IS NULL)
            OR (status = 'PUBLISHING' AND claimed_at IS NOT NULL AND published_at IS NULL)
            OR (status = 'PUBLISHED' AND claimed_at IS NOT NULL AND published_at IS NOT NULL AND last_error IS NULL)
            OR (status = 'DEAD' AND published_at IS NULL AND last_error IS NOT NULL)
        );

CREATE FUNCTION audit.enforce_outbox_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'PENDING' AND NEW.status IN ('PUBLISHING', 'DEAD'))
        OR (OLD.status = 'PUBLISHING' AND NEW.status IN ('PENDING', 'PUBLISHED', 'DEAD'))
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid outbox lifecycle transition';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_outbox_event_lifecycle
BEFORE UPDATE OF status ON audit.outbox_event
FOR EACH ROW EXECUTE FUNCTION audit.enforce_outbox_lifecycle();

DROP INDEX audit.ix_outbox_pending;
CREATE INDEX ix_outbox_pending_claim
ON audit.outbox_event (next_attempt_at, created_at)
WHERE (status = 'PENDING');

DROP INDEX authz.uq_relationship_active;

ALTER TABLE catalog.relation_definition
    ADD COLUMN max_subjects integer CHECK (max_subjects IS NULL OR max_subjects > 0),
    ADD COLUMN max_objects integer CHECK (max_objects IS NULL OR max_objects > 0);

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
          AND r.revoked_at IS NULL
          AND r.id <> NEW.id
          AND r.subject_entity_id = NEW.subject_entity_id
          AND r.object_entity_id = NEW.object_entity_id
          AND tstzrange(r.valid_from, r.valid_until, '[)')
              && tstzrange(NEW.valid_from, NEW.valid_until, '[)')
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
              AND r.revoked_at IS NULL
              AND r.id <> NEW.id
              AND r.subject_entity_id = NEW.subject_entity_id
              AND tstzrange(r.valid_from, r.valid_until, '[)')
                  && tstzrange(NEW.valid_from, NEW.valid_until, '[)')
        )
        SELECT 1
        FROM boundary b
        WHERE (
            SELECT count(*)
            FROM authz.relationship r
            WHERE r.relation_definition_id = NEW.relation_definition_id
              AND r.revoked_at IS NULL
              AND r.id <> NEW.id
              AND r.subject_entity_id = NEW.subject_entity_id
              AND tstzrange(r.valid_from, r.valid_until, '[)') @> b.point_at
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
              AND r.revoked_at IS NULL
              AND r.id <> NEW.id
              AND r.object_entity_id = NEW.object_entity_id
              AND tstzrange(r.valid_from, r.valid_until, '[)')
                  && tstzrange(NEW.valid_from, NEW.valid_until, '[)')
        )
        SELECT 1
        FROM boundary b
        WHERE (
            SELECT count(*)
            FROM authz.relationship r
            WHERE r.relation_definition_id = NEW.relation_definition_id
              AND r.revoked_at IS NULL
              AND r.id <> NEW.id
              AND r.object_entity_id = NEW.object_entity_id
              AND tstzrange(r.valid_from, r.valid_until, '[)') @> b.point_at
        ) >= subject_limit
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'relationship max_subjects exceeded in validity window';
    END IF;

    IF definition.acyclic AND EXISTS (
        WITH RECURSIVE reachable(entity_id, window_from, window_until, path) AS (
            SELECT NEW.object_entity_id,
                   NEW.valid_from,
                   coalesce(NEW.valid_until, 'infinity'::timestamptz),
                   ARRAY[NEW.object_entity_id]
            UNION ALL
            SELECT r.object_entity_id,
                   greatest(p.window_from, r.valid_from),
                   least(p.window_until, coalesce(r.valid_until, 'infinity'::timestamptz)),
                   p.path || r.object_entity_id
            FROM authz.relationship r
            JOIN reachable p ON r.subject_entity_id = p.entity_id
            WHERE r.relation_definition_id = NEW.relation_definition_id
              AND r.revoked_at IS NULL
              AND r.id <> NEW.id
              AND p.entity_id <> NEW.subject_entity_id
              AND greatest(p.window_from, r.valid_from)
                  < least(p.window_until, coalesce(r.valid_until, 'infinity'::timestamptz))
              AND (r.object_entity_id = NEW.subject_entity_id OR NOT r.object_entity_id = ANY(p.path))
        )
        SELECT 1 FROM reachable WHERE entity_id = NEW.subject_entity_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'acyclic relationship would create a cycle';
    END IF;

    RETURN NEW;
END;
$$;

CREATE INDEX ix_relationship_active_window
ON authz.relationship (
    relation_definition_id, revoked_at, valid_from, valid_until,
    subject_entity_id, object_entity_id
);

DROP TRIGGER trg_relationship_authorization_revision ON authz.relationship;

-- Authorization revision tracks relationship fact mutations, not natural time boundaries.
-- Every snapshot filters validity with a single transaction timestamp; future grants cannot
-- rely solely on revision, and later AI grants carry a five-minute expiry.
CREATE FUNCTION authz.bump_relationship_revision_statement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    facts_changed boolean := false;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT EXISTS (
            SELECT 1
            FROM new_relationships r
            JOIN catalog.relation_definition definition ON definition.id = r.relation_definition_id
            WHERE definition.auth_relevant
              AND r.revoked_at IS NULL
              AND r.valid_from <= statement_timestamp()
              AND (r.valid_until IS NULL OR r.valid_until > statement_timestamp())
        ) INTO facts_changed;
    ELSIF TG_OP = 'DELETE' THEN
        SELECT EXISTS (
            SELECT 1
            FROM old_relationships r
            JOIN catalog.relation_definition definition ON definition.id = r.relation_definition_id
            WHERE definition.auth_relevant
              AND r.revoked_at IS NULL
              AND r.valid_from <= statement_timestamp()
              AND (r.valid_until IS NULL OR r.valid_until > statement_timestamp())
        ) INTO facts_changed;
    ELSE
        SELECT EXISTS (
            SELECT 1
            FROM old_relationships old_r
            JOIN catalog.relation_definition definition ON definition.id = old_r.relation_definition_id
            LEFT JOIN new_relationships new_r ON new_r.id = old_r.id
            WHERE definition.auth_relevant
              AND old_r.revoked_at IS NULL
              AND old_r.valid_from <= statement_timestamp()
              AND (old_r.valid_until IS NULL OR old_r.valid_until > statement_timestamp())
              AND NOT (
                  new_r.revoked_at IS NULL
                  AND new_r.valid_from <= statement_timestamp()
                  AND (new_r.valid_until IS NULL OR new_r.valid_until > statement_timestamp())
              )
            UNION ALL
            SELECT 1
            FROM new_relationships new_r
            JOIN catalog.relation_definition definition ON definition.id = new_r.relation_definition_id
            LEFT JOIN old_relationships old_r ON old_r.id = new_r.id
            WHERE definition.auth_relevant
              AND new_r.revoked_at IS NULL
              AND new_r.valid_from <= statement_timestamp()
              AND (new_r.valid_until IS NULL OR new_r.valid_until > statement_timestamp())
              AND NOT (
                  old_r.revoked_at IS NULL
                  AND old_r.valid_from <= statement_timestamp()
                  AND (old_r.valid_until IS NULL OR old_r.valid_until > statement_timestamp())
              )
            LIMIT 1
        ) INTO facts_changed;
    END IF;
    IF facts_changed THEN
        PERFORM authz.bump_authorization_revision();
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_relationship_authorization_revision_insert
AFTER INSERT ON authz.relationship
REFERENCING NEW TABLE AS new_relationships
FOR EACH STATEMENT EXECUTE FUNCTION authz.bump_relationship_revision_statement();
CREATE TRIGGER trg_relationship_authorization_revision_update
AFTER UPDATE ON authz.relationship
REFERENCING OLD TABLE AS old_relationships NEW TABLE AS new_relationships
FOR EACH STATEMENT EXECUTE FUNCTION authz.bump_relationship_revision_statement();
CREATE TRIGGER trg_relationship_authorization_revision_delete
AFTER DELETE ON authz.relationship
REFERENCING OLD TABLE AS old_relationships
FOR EACH STATEMENT EXECUTE FUNCTION authz.bump_relationship_revision_statement();

CREATE FUNCTION authz.bump_principal_status_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM authz.bump_authorization_revision();
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_principal_status_authorization_revision
AFTER UPDATE OF status ON iam.principal
FOR EACH ROW EXECUTE FUNCTION authz.bump_principal_status_revision();
