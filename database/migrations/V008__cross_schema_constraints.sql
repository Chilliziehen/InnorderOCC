ALTER TABLE catalog.domain_package
    ADD CONSTRAINT fk_domain_package_created_by FOREIGN KEY (created_by) REFERENCES iam.principal(id),
    ADD CONSTRAINT fk_domain_package_updated_by FOREIGN KEY (updated_by) REFERENCES iam.principal(id);

ALTER TABLE catalog.package_version
    ADD CONSTRAINT fk_package_version_created_by FOREIGN KEY (created_by) REFERENCES iam.principal(id),
    ADD CONSTRAINT fk_package_version_published_by FOREIGN KEY (published_by) REFERENCES iam.principal(id);

ALTER TABLE authz.entity
    ADD CONSTRAINT fk_entity_created_by FOREIGN KEY (created_by) REFERENCES iam.principal(id),
    ADD CONSTRAINT fk_entity_updated_by FOREIGN KEY (updated_by) REFERENCES iam.principal(id);

ALTER TABLE iam.principal
    ADD CONSTRAINT fk_principal_created_by FOREIGN KEY (created_by) REFERENCES iam.principal(id),
    ADD CONSTRAINT fk_principal_updated_by FOREIGN KEY (updated_by) REFERENCES iam.principal(id);

ALTER TABLE authz.relationship
    ADD CONSTRAINT fk_relationship_created_by FOREIGN KEY (created_by) REFERENCES iam.principal(id),
    ADD CONSTRAINT fk_relationship_updated_by FOREIGN KEY (updated_by) REFERENCES iam.principal(id),
    ADD CONSTRAINT fk_relationship_revoked_by FOREIGN KEY (revoked_by) REFERENCES iam.principal(id);

CREATE FUNCTION iam.validate_user_account_principal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    kind text;
BEGIN
    SELECT principal_kind INTO kind FROM iam.principal WHERE id = NEW.principal_id;
    IF kind <> 'USER' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'user_account principal must have USER kind';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_user_account_principal
BEFORE INSERT OR UPDATE OF principal_id ON iam.user_account
FOR EACH ROW EXECUTE FUNCTION iam.validate_user_account_principal();

CREATE FUNCTION iam.validate_principal_entity_kind()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    kind text;
BEGIN
    SELECT et.entity_kind INTO STRICT kind
    FROM authz.entity e
    JOIN catalog.entity_type et ON et.id = e.entity_type_id
    WHERE e.id = NEW.id;
    IF kind <> 'PRINCIPAL' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'principal requires a PRINCIPAL entity type';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_principal_entity_kind
BEFORE INSERT OR UPDATE OF id ON iam.principal
FOR EACH ROW EXECUTE FUNCTION iam.validate_principal_entity_kind();

CREATE FUNCTION platform.reject_stable_key_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_TABLE_NAME = 'instance'
       AND (to_jsonb(NEW) -> 'instance_key') IS DISTINCT FROM (to_jsonb(OLD) -> 'instance_key') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'instance_key is immutable';
    END IF;
    IF TG_TABLE_NAME = 'domain_package'
       AND (to_jsonb(NEW) -> 'package_key') IS DISTINCT FROM (to_jsonb(OLD) -> 'package_key') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'package_key is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_instance_stable_key
BEFORE UPDATE OF instance_key ON platform.instance
FOR EACH ROW EXECUTE FUNCTION platform.reject_stable_key_change();

CREATE TRIGGER trg_domain_package_stable_key
BEFORE UPDATE OF package_key ON catalog.domain_package
FOR EACH ROW EXECUTE FUNCTION platform.reject_stable_key_change();

CREATE FUNCTION catalog.reject_catalog_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_TABLE_NAME = 'package_version'
       AND (
           (to_jsonb(NEW) -> 'package_id') IS DISTINCT FROM (to_jsonb(OLD) -> 'package_id')
           OR (to_jsonb(NEW) -> 'semver') IS DISTINCT FROM (to_jsonb(OLD) -> 'semver')
       ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'package version identity is immutable';
    END IF;
    IF TG_TABLE_NAME = 'entity_type'
       AND (
           (to_jsonb(NEW) -> 'package_id') IS DISTINCT FROM (to_jsonb(OLD) -> 'package_id')
           OR (to_jsonb(NEW) -> 'type_key') IS DISTINCT FROM (to_jsonb(OLD) -> 'type_key')
           OR (to_jsonb(NEW) -> 'entity_kind') IS DISTINCT FROM (to_jsonb(OLD) -> 'entity_kind')
       ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'entity type identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_package_version_identity
BEFORE UPDATE OF package_id, semver ON catalog.package_version
FOR EACH ROW EXECUTE FUNCTION catalog.reject_catalog_identity_change();

CREATE TRIGGER trg_entity_type_identity
BEFORE UPDATE OF package_id, type_key, entity_kind ON catalog.entity_type
FOR EACH ROW EXECUTE FUNCTION catalog.reject_catalog_identity_change();

CREATE FUNCTION authz.reject_policy_bundle_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.bundle_key IS DISTINCT FROM OLD.bundle_key
       OR NEW.layer IS DISTINCT FROM OLD.layer
       OR NEW.package_id IS DISTINCT FROM OLD.package_id THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'policy bundle identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_policy_bundle_identity
BEFORE UPDATE OF bundle_key, layer, package_id ON authz.policy_bundle
FOR EACH ROW EXECUTE FUNCTION authz.reject_policy_bundle_identity_change();

CREATE FUNCTION catalog.validate_entity_type_version_package()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    type_package_id uuid;
    version_package_id uuid;
BEGIN
    SELECT et.package_id, pv.package_id
    INTO STRICT type_package_id, version_package_id
    FROM catalog.entity_type et
    CROSS JOIN catalog.package_version pv
    WHERE et.id = NEW.entity_type_id
      AND pv.id = NEW.package_version_id
    FOR KEY SHARE OF et, pv;
    IF type_package_id <> version_package_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'entity type and package version must belong to the same package';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_entity_type_version_package
BEFORE INSERT OR UPDATE OF entity_type_id, package_version_id ON catalog.entity_type_version
FOR EACH ROW EXECUTE FUNCTION catalog.validate_entity_type_version_package();

CREATE FUNCTION authz.reject_entity_stable_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.entity_type_id IS DISTINCT FROM OLD.entity_type_id
       OR NEW.entity_key IS DISTINCT FROM OLD.entity_key THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'entity stable identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_entity_stable_identity
BEFORE UPDATE OF entity_type_id, entity_key ON authz.entity
FOR EACH ROW EXECUTE FUNCTION authz.reject_entity_stable_identity_change();

CREATE FUNCTION authz.validate_relationship()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    definition catalog.relation_definition%ROWTYPE;
    subject_type uuid;
    object_type uuid;
    definition_package_status text;
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

    IF definition.cardinality = 'ONE_TO_ONE' AND EXISTS (
        SELECT 1 FROM authz.relationship r
        WHERE r.relation_definition_id = NEW.relation_definition_id
          AND r.revoked_at IS NULL
          AND r.id <> NEW.id
          AND (r.subject_entity_id = NEW.subject_entity_id OR r.object_entity_id = NEW.object_entity_id)
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ONE_TO_ONE relationship cardinality violated';
    END IF;

    IF definition.cardinality = 'ONE_TO_MANY' AND EXISTS (
        SELECT 1 FROM authz.relationship r
        WHERE r.relation_definition_id = NEW.relation_definition_id
          AND r.revoked_at IS NULL
          AND r.id <> NEW.id
          AND r.object_entity_id = NEW.object_entity_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ONE_TO_MANY relationship cardinality violated';
    END IF;

    IF definition.acyclic AND EXISTS (
        WITH RECURSIVE reachable(entity_id) AS (
            SELECT NEW.object_entity_id
            UNION
            SELECT r.object_entity_id
            FROM authz.relationship r
            JOIN reachable p ON r.subject_entity_id = p.entity_id
            WHERE r.relation_definition_id = NEW.relation_definition_id
              AND r.revoked_at IS NULL
              AND r.id <> NEW.id
        )
        SELECT 1 FROM reachable WHERE entity_id = NEW.subject_entity_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'acyclic relationship would create a cycle';
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION authz.enforce_relationship_history()
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
    IF (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by', 'updated_by', 'updated_at', 'row_version'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by', 'updated_by', 'updated_at', 'row_version']) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'relationship facts cannot change during revocation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_relationship_history
BEFORE UPDATE OR DELETE ON authz.relationship
FOR EACH ROW EXECUTE FUNCTION authz.enforce_relationship_history();

CREATE TRIGGER trg_validate_relationship
BEFORE INSERT OR UPDATE OF relation_definition_id, subject_entity_id, object_entity_id, revoked_at
ON authz.relationship
FOR EACH ROW
WHEN (NEW.revoked_at IS NULL)
EXECUTE FUNCTION authz.validate_relationship();

CREATE FUNCTION authz.bump_authorization_revision_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM authz.bump_authorization_revision();
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_relationship_authorization_revision
AFTER INSERT OR UPDATE OR DELETE ON authz.relationship
FOR EACH STATEMENT EXECUTE FUNCTION authz.bump_authorization_revision_trigger();

CREATE TRIGGER trg_entity_authorization_revision
AFTER UPDATE OF auth_attributes, state, entity_type_version_id ON authz.entity
FOR EACH STATEMENT EXECUTE FUNCTION authz.bump_authorization_revision_trigger();

CREATE TRIGGER trg_policy_release_authorization_revision
AFTER INSERT OR UPDATE OF status OR DELETE ON authz.policy_release
FOR EACH STATEMENT EXECUTE FUNCTION authz.bump_authorization_revision_trigger();

CREATE FUNCTION occ.validate_business_object_entity_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    auth_type_version uuid;
BEGIN
    SELECT entity_type_version_id INTO STRICT auth_type_version
    FROM authz.entity WHERE id = NEW.id;
    IF auth_type_version <> NEW.entity_type_version_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'business object and authorization entity type versions differ';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_business_object_entity_type
BEFORE INSERT OR UPDATE OF id, entity_type_version_id ON occ.business_object
FOR EACH ROW EXECUTE FUNCTION occ.validate_business_object_entity_type();

ALTER TABLE occ.evidence
    ADD CONSTRAINT fk_evidence_current_version
    FOREIGN KEY (id, current_version)
    REFERENCES occ.evidence_version(evidence_id, version)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE occ.business_object
    ADD CONSTRAINT fk_business_object_entity_version
    FOREIGN KEY (id, entity_type_version_id)
    REFERENCES authz.entity(id, entity_type_version_id)
    DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE occ.data_migration
    ADD CONSTRAINT fk_data_migration_source_type
        FOREIGN KEY (source_version_id, entity_type_id)
        REFERENCES catalog.entity_type_version(id, entity_type_id),
    ADD CONSTRAINT fk_data_migration_target_type
        FOREIGN KEY (target_version_id, entity_type_id)
        REFERENCES catalog.entity_type_version(id, entity_type_id);

ALTER TABLE ai.knowledge_document
    ADD CONSTRAINT fk_knowledge_document_current_version
    FOREIGN KEY (id, current_version)
    REFERENCES ai.knowledge_document_version(document_id, version)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ai.recommendation_citation
    ADD CONSTRAINT fk_recommendation_citation_chunk_version
    FOREIGN KEY (chunk_id, document_version_id)
    REFERENCES ai.knowledge_chunk(id, document_version_id);

CREATE FUNCTION catalog.reject_definition_change_when_published()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    version_id uuid;
    version_status text;
BEGIN
    version_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.package_version_id ELSE OLD.package_version_id END;
    IF TG_OP = 'UPDATE' AND NEW.package_version_id IS DISTINCT FROM OLD.package_version_id THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'definition package version is immutable';
    END IF;
    SELECT status INTO STRICT version_status
    FROM catalog.package_version
    WHERE id = version_id
    FOR UPDATE;
    IF version_status IN ('PUBLISHED', 'DEPRECATED') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'definition in a published package version is immutable';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_entity_type_version_immutable
BEFORE INSERT OR UPDATE OR DELETE ON catalog.entity_type_version
FOR EACH ROW EXECUTE FUNCTION catalog.reject_definition_change_when_published();
CREATE TRIGGER trg_action_definition_immutable
BEFORE INSERT OR UPDATE OR DELETE ON catalog.action_definition
FOR EACH ROW EXECUTE FUNCTION catalog.reject_definition_change_when_published();
CREATE TRIGGER trg_relation_definition_immutable
BEFORE INSERT OR UPDATE OR DELETE ON catalog.relation_definition
FOR EACH ROW EXECUTE FUNCTION catalog.reject_definition_change_when_published();
CREATE TRIGGER trg_form_definition_immutable
BEFORE INSERT OR UPDATE OR DELETE ON catalog.form_definition
FOR EACH ROW EXECUTE FUNCTION catalog.reject_definition_change_when_published();
CREATE TRIGGER trg_evidence_requirement_immutable
BEFORE INSERT OR UPDATE OR DELETE ON catalog.evidence_requirement
FOR EACH ROW EXECUTE FUNCTION catalog.reject_definition_change_when_published();
CREATE TRIGGER trg_risk_rule_definition_immutable
BEFORE INSERT OR UPDATE OR DELETE ON catalog.risk_rule_definition
FOR EACH ROW EXECUTE FUNCTION catalog.reject_definition_change_when_published();
CREATE TRIGGER trg_workflow_definition_immutable
BEFORE INSERT OR UPDATE OR DELETE ON catalog.workflow_definition
FOR EACH ROW EXECUTE FUNCTION catalog.reject_definition_change_when_published();

CREATE FUNCTION authz.reject_published_policy_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    old_version_status text;
    new_version_status text;
BEGIN
    IF TG_TABLE_NAME = 'policy_bundle_version' THEN
        IF OLD.status = 'PUBLISHED' THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'published policy bundle version is immutable';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT status INTO STRICT old_version_status
        FROM authz.policy_bundle_version
        WHERE id = OLD.bundle_version_id
        FOR UPDATE;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT status INTO STRICT new_version_status
        FROM authz.policy_bundle_version
        WHERE id = NEW.bundle_version_id
        FOR UPDATE;
    END IF;
    IF old_version_status = 'PUBLISHED' OR new_version_status = 'PUBLISHED' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'published policy content is immutable';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_policy_bundle_version_immutable
BEFORE UPDATE OR DELETE ON authz.policy_bundle_version
FOR EACH ROW EXECUTE FUNCTION authz.reject_published_policy_change();
CREATE TRIGGER trg_policy_module_immutable
BEFORE INSERT OR UPDATE OR DELETE ON authz.policy_module
FOR EACH ROW EXECUTE FUNCTION authz.reject_published_policy_change();
CREATE TRIGGER trg_policy_test_case_immutable
BEFORE INSERT OR UPDATE OR DELETE ON authz.policy_test_case
FOR EACH ROW EXECUTE FUNCTION authz.reject_published_policy_change();
CREATE TRIGGER trg_policy_approval_immutable
BEFORE INSERT OR UPDATE OR DELETE ON authz.policy_approval
FOR EACH ROW EXECUTE FUNCTION authz.reject_published_policy_change();
CREATE TRIGGER trg_policy_binding_immutable
BEFORE INSERT OR UPDATE OR DELETE ON authz.policy_binding
FOR EACH ROW EXECUTE FUNCTION authz.reject_published_policy_change();

CREATE FUNCTION authz.enforce_policy_release_item_mutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    release_id_to_check uuid;
    release_status text;
    bundle_status text;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.release_id IS DISTINCT FROM OLD.release_id THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'policy release item parent is immutable';
    END IF;
    release_id_to_check := CASE WHEN TG_OP = 'DELETE' THEN OLD.release_id ELSE NEW.release_id END;
    SELECT status INTO STRICT release_status
    FROM authz.policy_release
    WHERE id = release_id_to_check
    FOR UPDATE;
    IF release_status <> 'STAGED' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'policy release items can change only while staged';
    END IF;
    IF TG_OP <> 'DELETE' THEN
        SELECT status INTO STRICT bundle_status
        FROM authz.policy_bundle_version
        WHERE id = NEW.bundle_version_id;
        IF bundle_status <> 'PUBLISHED' THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'policy release requires published bundle versions';
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_policy_release_item_mutable
BEFORE INSERT OR UPDATE OR DELETE ON authz.policy_release_item
FOR EACH ROW EXECUTE FUNCTION authz.enforce_policy_release_item_mutability();

CREATE FUNCTION authz.enforce_policy_release_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.status IN ('ACTIVE', 'RETIRED') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'activated policy release is immutable';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'RETIRED' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'retired policy release is immutable';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'ACTIVE' THEN
        IF NEW.status = 'RETIRED'
           AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'active policy release content is immutable';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_policy_release_immutable
BEFORE UPDATE OR DELETE ON authz.policy_release
FOR EACH ROW EXECUTE FUNCTION authz.enforce_policy_release_lifecycle();

CREATE FUNCTION authz.enforce_policy_release_insert_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status <> 'STAGED' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'policy releases must be inserted in STAGED state';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_policy_release_insert_state
BEFORE INSERT ON authz.policy_release
FOR EACH ROW EXECUTE FUNCTION authz.enforce_policy_release_insert_state();

CREATE FUNCTION authz.validate_policy_release_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status = 'ACTIVE' AND OLD.status <> 'ACTIVE' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM authz.policy_release_item pri
            JOIN authz.policy_bundle_version pbv ON pbv.id = pri.bundle_version_id
            JOIN authz.policy_bundle pb ON pb.id = pbv.bundle_id
            WHERE pri.release_id = NEW.id
              AND pbv.status = 'PUBLISHED'
              AND pb.layer = 'PLATFORM'
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'active policy release requires a published platform bundle';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_policy_release_activate
BEFORE UPDATE OF status ON authz.policy_release
FOR EACH ROW EXECUTE FUNCTION authz.validate_policy_release_activation();

CREATE FUNCTION ai.enforce_prompt_version_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.status IN ('PUBLISHED', 'RETIRED') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'published prompt version is immutable';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'RETIRED' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'retired prompt version is immutable';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'PUBLISHED' THEN
        IF NEW.status = 'RETIRED'
           AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'published prompt version is immutable';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_prompt_template_version_immutable
BEFORE UPDATE OR DELETE ON ai.prompt_template_version
FOR EACH ROW EXECUTE FUNCTION ai.enforce_prompt_version_immutability();

CREATE FUNCTION ai.reject_agent_content_when_package_published()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    old_agent_version_id uuid;
    new_agent_version_id uuid;
    old_package_version_id uuid;
    new_package_version_id uuid;
    package_status text;
BEGIN
    IF TG_TABLE_NAME = 'agent_definition_version' THEN
        IF TG_OP IN ('UPDATE', 'DELETE') THEN
            old_package_version_id := OLD.package_version_id;
        END IF;
        IF TG_OP IN ('INSERT', 'UPDATE') THEN
            new_package_version_id := NEW.package_version_id;
        END IF;
        IF TG_OP = 'UPDATE' AND new_package_version_id IS DISTINCT FROM old_package_version_id THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'agent package version is immutable';
        END IF;
    ELSE
        IF TG_OP IN ('UPDATE', 'DELETE') THEN
            old_agent_version_id := OLD.agent_version_id;
            SELECT package_version_id INTO STRICT old_package_version_id
            FROM ai.agent_definition_version WHERE id = old_agent_version_id;
        END IF;
        IF TG_OP IN ('INSERT', 'UPDATE') THEN
            new_agent_version_id := NEW.agent_version_id;
            SELECT package_version_id INTO STRICT new_package_version_id
            FROM ai.agent_definition_version WHERE id = new_agent_version_id;
        END IF;
    END IF;

    IF old_package_version_id IS NOT NULL THEN
        SELECT status INTO STRICT package_status
        FROM catalog.package_version WHERE id = old_package_version_id FOR UPDATE;
        IF package_status IN ('PUBLISHED', 'DEPRECATED') THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'agent content in a published package is immutable';
        END IF;
    END IF;
    IF new_package_version_id IS NOT NULL AND new_package_version_id IS DISTINCT FROM old_package_version_id THEN
        SELECT status INTO STRICT package_status
        FROM catalog.package_version WHERE id = new_package_version_id FOR UPDATE;
        IF package_status IN ('PUBLISHED', 'DEPRECATED') THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'agent content in a published package is immutable';
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_agent_definition_version_immutable
BEFORE INSERT OR UPDATE OR DELETE ON ai.agent_definition_version
FOR EACH ROW EXECUTE FUNCTION ai.reject_agent_content_when_package_published();

CREATE TRIGGER trg_agent_tool_grant_immutable
BEFORE INSERT OR UPDATE OR DELETE ON ai.agent_tool_grant
FOR EACH ROW EXECUTE FUNCTION ai.reject_agent_content_when_package_published();

CREATE TRIGGER trg_evidence_version_immutable
BEFORE UPDATE OR DELETE ON occ.evidence_version
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
CREATE TRIGGER trg_evidence_review_immutable
BEFORE UPDATE OR DELETE ON occ.evidence_review
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
CREATE TRIGGER trg_audit_record_immutable
BEFORE UPDATE OR DELETE ON audit.audit_record
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
CREATE TRIGGER trg_decision_log_immutable
BEFORE UPDATE OR DELETE ON authz.decision_log
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
CREATE TRIGGER trg_knowledge_document_version_immutable
BEFORE UPDATE OR DELETE ON ai.knowledge_document_version
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();
CREATE TRIGGER trg_message_immutable
BEFORE UPDATE OR DELETE ON ai.message
FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_row();

CREATE UNIQUE INDEX uq_relationship_active
ON authz.relationship (relation_definition_id, subject_entity_id, object_entity_id)
WHERE (revoked_at IS NULL);
CREATE INDEX ix_relationship_subject
ON authz.relationship (subject_entity_id, relation_definition_id, object_entity_id)
WHERE (revoked_at IS NULL);
CREATE INDEX ix_relationship_object
ON authz.relationship (object_entity_id, relation_definition_id, subject_entity_id)
WHERE (revoked_at IS NULL);
CREATE INDEX ix_relationship_validity
ON authz.relationship (valid_from, valid_until);

CREATE UNIQUE INDEX uq_policy_release_active
ON authz.policy_release ((status))
WHERE (status = 'ACTIVE');
CREATE UNIQUE INDEX uq_embedding_space_active
ON ai.embedding_space ((status))
WHERE (status = 'ACTIVE');

CREATE INDEX ix_entity_type_state ON authz.entity (entity_type_id, state);
CREATE INDEX ix_business_object_type_state ON occ.business_object (entity_type_version_id, lifecycle_state);
CREATE INDEX ix_business_object_updated_at ON occ.business_object (updated_at);
CREATE INDEX ix_business_object_data_gin ON occ.business_object USING gin (data jsonb_path_ops);
CREATE INDEX ix_object_index_text ON occ.object_index_value (field_key, text_value) WHERE (value_type = 'TEXT');
CREATE INDEX ix_object_index_number ON occ.object_index_value (field_key, numeric_value) WHERE (value_type = 'NUMBER');
CREATE INDEX ix_object_index_timestamp ON occ.object_index_value (field_key, timestamp_value) WHERE (value_type = 'TIMESTAMP');
CREATE INDEX ix_object_index_boolean ON occ.object_index_value (field_key, boolean_value) WHERE (value_type = 'BOOLEAN');
CREATE INDEX ix_task_process_state ON occ.task_projection (process_instance_id, state);
CREATE INDEX ix_evidence_task_state ON occ.evidence (task_id, state);
CREATE INDEX ix_risk_target_state ON occ.risk (target_entity_id, state, severity);
CREATE INDEX ix_outbox_pending ON audit.outbox_event (available_at, id) WHERE (status = 'PENDING');
CREATE INDEX ix_idempotency_expiry ON audit.idempotency_record (expires_at);
CREATE INDEX ix_decision_log_created_brin ON authz.decision_log USING brin (created_at);
CREATE INDEX ix_audit_record_created_brin ON audit.audit_record USING brin (created_at);
CREATE INDEX ix_knowledge_chunk_search ON ai.knowledge_chunk USING gin (search_vector);
CREATE INDEX ix_knowledge_chunk_document ON ai.knowledge_chunk (document_version_id, ordinal);
CREATE INDEX ix_ai_run_target_created ON ai.ai_run (target_entity_id, created_at DESC);
CREATE INDEX ix_message_conversation_created ON ai.message (conversation_id, created_at);

CREATE FUNCTION ai.create_embedding_partition(
    p_space_id uuid,
    p_dimensions integer,
    p_distance_metric text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    partition_name text := 'chunk_embedding_' || pg_catalog.replace(p_space_id::text, '-', '_');
    index_name text := 'hnsw_' || pg_catalog.replace(p_space_id::text, '-', '_');
    opclass text;
    configured_dimensions integer;
    configured_metric text;
BEGIN
    SELECT dimensions, distance_metric
    INTO STRICT configured_dimensions, configured_metric
    FROM ai.embedding_space
    WHERE id = p_space_id;

    IF configured_dimensions <> p_dimensions OR configured_metric <> p_distance_metric THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'embedding partition configuration mismatch';
    END IF;

    opclass := CASE p_distance_metric
        WHEN 'COSINE' THEN 'public.vector_cosine_ops'
        WHEN 'L2' THEN 'public.vector_l2_ops'
        WHEN 'INNER_PRODUCT' THEN 'public.vector_ip_ops'
        ELSE NULL
    END;
    IF opclass IS NULL OR p_dimensions <= 0 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid embedding partition configuration';
    END IF;

    EXECUTE pg_catalog.format(
        'CREATE TABLE ai.%I PARTITION OF ai.chunk_embedding FOR VALUES IN (%L)',
        partition_name, p_space_id
    );
    EXECUTE pg_catalog.format(
        'ALTER TABLE ai.%I ADD CONSTRAINT %I CHECK (public.vector_dims(embedding) = %s)',
        partition_name, partition_name || '_dimensions', p_dimensions
    );
    EXECUTE pg_catalog.format(
        'CREATE INDEX %I ON ai.%I USING hnsw ((embedding::public.vector(%s)) %s)',
        index_name, partition_name, p_dimensions, opclass
    );
END;
$$;
