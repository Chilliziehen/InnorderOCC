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
