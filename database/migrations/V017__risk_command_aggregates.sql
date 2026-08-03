-- Persist the two risk aggregates that previously existed only as in-memory
-- command identities. The command kernel locks and version-checks every
-- aggregate against a real row, so both need a table of their own.

-- One row per successful risk occurrence command invocation. The identity is
-- derived from the principal, command key, and idempotency key, so the
-- idempotency record and this aggregate are created together exactly once.
CREATE TABLE occ.risk_occurrence_command (
    id uuid PRIMARY KEY,
    rule_definition_id uuid NOT NULL,
    target_entity_id uuid NOT NULL REFERENCES authz.entity (id),
    occurrence_key text NOT NULL,
    risk_id uuid NOT NULL REFERENCES occ.risk (id),
    observed_existing boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    CONSTRAINT ck_risk_occurrence_command_key CHECK (
        pg_catalog.length(occurrence_key) BETWEEN 1 AND 512
    )
);

CREATE INDEX ix_risk_occurrence_command_risk ON occ.risk_occurrence_command (risk_id, created_at DESC);

-- One row per adjudication series. The first adjudication for a
-- (known_event_key, target_entity_id) pair creates it; later ones advance it.
CREATE TABLE occ.risk_adjudication_series (
    id uuid PRIMARY KEY,
    known_event_key text NOT NULL,
    target_entity_id uuid NOT NULL REFERENCES authz.entity (id),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    CONSTRAINT uq_risk_adjudication_series UNIQUE (known_event_key, target_entity_id),
    CONSTRAINT ck_risk_adjudication_series_key CHECK (
        pg_catalog.length(known_event_key) BETWEEN 1 AND 512
    )
);

-- Both aggregates are append-only from the runtime's perspective: rows are
-- created and their version advanced, never deleted.
CREATE OR REPLACE FUNCTION occ.forbid_risk_command_aggregate_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'risk command aggregates are append-only'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_risk_occurrence_command_no_delete
    BEFORE DELETE ON occ.risk_occurrence_command
    FOR EACH ROW EXECUTE FUNCTION occ.forbid_risk_command_aggregate_delete();

CREATE TRIGGER trg_risk_adjudication_series_no_delete
    BEFORE DELETE ON occ.risk_adjudication_series
    FOR EACH ROW EXECUTE FUNCTION occ.forbid_risk_command_aggregate_delete();

GRANT SELECT, INSERT, UPDATE ON TABLE
    occ.risk_occurrence_command,
    occ.risk_adjudication_series
TO innorder_runtime;
