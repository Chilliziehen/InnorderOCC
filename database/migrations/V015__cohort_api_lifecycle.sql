CREATE OR REPLACE FUNCTION occ.enforce_cohort_lifecycle()
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
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'cohort identity and package are immutable';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'DRAFT' AND NEW.status IN ('ACTIVE', 'ARCHIVED'))
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

CREATE OR REPLACE FUNCTION authz.enforce_relationship_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'relationship history cannot be deleted';
    END IF;
    IF OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'revoked relationship is immutable';
    END IF;
    IF NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'relationship updates must revoke the existing row';
    END IF;
    IF (NEW.valid_until IS DISTINCT FROM OLD.valid_until AND NEW.valid_until IS DISTINCT FROM NEW.revoked_at)
       OR (to_jsonb(NEW) - ARRAY['valid_until', 'revoked_at', 'revoked_by', 'updated_by', 'updated_at', 'row_version'])
          IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['valid_until', 'revoked_at', 'revoked_by', 'updated_by', 'updated_at', 'row_version']) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'relationship facts cannot change during revocation';
    END IF;
    RETURN NEW;
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
