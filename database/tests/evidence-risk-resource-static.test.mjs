import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sql = readFileSync(
  fileURLToPath(new URL('../migrations/V014__evidence_risk_resource.sql', import.meta.url)),
  'utf8',
);

test('extends evidence storage without invalidating legacy rows', () => {
  for (const column of [
    'requirement_id', 'evidence_id', 'slot_key', 'normalized_extension',
    'quarantine_object_key', 'immutable_object_key', 'lease_owner',
    'lease_acquired_at', 'lease_heartbeat_at', 'lease_expires_at',
    'absolute_deadline_at', 'failure_code', 'detected_media_type',
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE occ\\.upload_session[\\s\\S]*ADD COLUMN ${column}\\b`, 'i'), column);
  }
  assert.match(sql, /ALTER TABLE occ\.evidence[\s\S]*ADD COLUMN slot_key\b/i);
  assert.match(sql, /ALTER TABLE occ\.evidence[\s\S]*ADD COLUMN legal_hold_at\b/i);
  assert.match(sql, /ALTER TABLE occ\.evidence_version[\s\S]*ADD COLUMN upload_session_id\b/i);
  assert.match(sql, /CREATE TRIGGER trg_evidence_version_provenance[\s\S]*BEFORE INSERT ON occ\.evidence_version/i);
  assert.match(sql, /TG_OP = 'INSERT'[\s\S]*NEW\.requirement_id IS NULL[\s\S]*NEW\.absolute_deadline_at IS NULL/i);
  assert.match(sql, /TG_OP = 'INSERT'[\s\S]*NEW\.target_entity_id IS NULL[\s\S]*NEW\.slot_key IS NULL/i);
  assert.match(sql, /CREATE TABLE occ\.evidence_object_disposition\b/i);
  assert.match(sql, /legal_hold_at timestamptz/i);
  assert.match(sql, /backup_snapshot_id text/i);
  assert.match(sql, /CREATE TRIGGER trg_evidence_object_disposition_identity/i);
  assert.match(sql, /FROM occ\.evidence_version[\s\S]*JOIN occ\.evidence[\s\S]*legal_hold_at IS NOT NULL/i);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE ON occ\.evidence_object_disposition/i);
  assert.doesNotMatch(sql, /DROP TRIGGER\s+trg_evidence_(?:version|review)_immutable/i);
});

test('enforces review segregation, follow-up facts, and one future review', () => {
  assert.match(sql, /ADD COLUMN follow_up_due_at timestamptz/i);
  assert.match(sql, /ADD COLUMN gate_satisfied boolean/i);
  assert.match(sql, /reviewer_id[\s\S]*(?:submitted_by|created_by)/i);
  assert.match(sql, /NEW\.gate_satisfied IS NULL[\s\S]*review requires a gate result/i);
  assert.match(sql, /CREATE TRIGGER trg_evidence_review_validate[\s\S]*BEFORE INSERT ON occ\.evidence_review/i);
  assert.match(sql, /FROM occ\.evidence_review[\s\S]*evidence_version_id = NEW\.evidence_version_id/i);
  assert.match(sql, /FROM occ\.evidence[\s\S]*FOR UPDATE/i);
  assert.match(sql, /OLD\.state = 'ARCHIVED'[\s\S]*ARRAY\['legal_hold_at', 'legal_hold_by', 'legal_hold_reason'/i);
  assert.match(sql, /multiple reviews[\s\S]*string_agg/i);
});

test('adds immutable risk occurrence, action, adjudication, and intervention facts', () => {
  for (const table of ['risk_occurrence', 'risk_action', 'risk_adjudication', 'risk_intervention']) {
    assert.match(sql, new RegExp(`CREATE TABLE occ\\.${table}\\b`, 'i'), table);
  }
  assert.match(sql, /occurrence_key text NOT NULL/i);
  assert.match(sql, /UNIQUE \(rule_definition_id, target_entity_id, occurrence_key\)/i);
  assert.match(sql, /UNIQUE \(risk_id, escalation_level\)/i);
  assert.match(sql, /supersedes_adjudication_id uuid/i);
  assert.match(sql, /CREATE TRIGGER trg_risk_action_immutable/i);
  assert.match(sql, /CREATE TRIGGER trg_risk_adjudication_immutable/i);
  assert.match(sql, /CREATE TRIGGER trg_risk_occurrence_immutable/i);
  assert.match(sql, /CREATE TRIGGER trg_risk_lifecycle/i);
});

test('serializes resource availability and reservation capacity on the parent row', () => {
  assert.match(sql, /CREATE TABLE occ\.resource_availability\b/i);
  assert.match(sql, /mode text NOT NULL CHECK \(mode IN \('AVAILABLE', 'UNAVAILABLE'\)\)/i);
  assert.match(sql, /CREATE TRIGGER trg_resource_availability_validate/i);
  assert.match(sql, /ADD COLUMN confirmed_at timestamptz/i);
  assert.match(sql, /ADD COLUMN cancelled_at timestamptz/i);
  assert.match(sql, /ADD COLUMN completed_at timestamptz/i);
  assert.match(sql, /state = 'COMPLETED'[\s\S]*confirmed_at IS NOT NULL[\s\S]*completed_at IS NOT NULL/i);
  assert.match(sql, /lower_inc\(NEW\.time_range\)[\s\S]*NOT upper_inc\(NEW\.time_range\)/i);
  assert.match(sql, /SELECT 1[\s\S]*FROM occ\.managed_resource[\s\S]*FOR UPDATE/i);
  assert.match(sql, /OLD\.resource_id IS DISTINCT FROM NEW\.resource_id/i);
  assert.match(sql, /OLD\.requester_entity_id IS DISTINCT FROM NEW\.requester_entity_id/i);
  assert.match(sql, /NEW\.exclusive OR existing\.exclusive/i);
  assert.match(sql, /sum\(delta\) OVER[\s\S]*ROWS UNBOUNDED PRECEDING/i);
  assert.match(sql, /ERRCODE = '23P01'/i);
  assert.match(sql, /CREATE TRIGGER trg_resource_reservation_validate/i);
  assert.match(sql, /CREATE TRIGGER trg_resource_reservation_no_delete/i);
  assert.match(sql, /CREATE TRIGGER trg_managed_resource_capacity/i);
});

test('preflights immutable legacy history and reservations under migration locks', () => {
  assert.match(sql, /LOCK TABLE occ\.evidence_review[\s\S]*IN ACCESS EXCLUSIVE MODE/i);
  assert.match(sql, /LOCK TABLE occ\.resource_reservation[\s\S]*IN ACCESS EXCLUSIVE MODE/i);
  assert.match(sql, /legacy_review_ids[\s\S]*string_agg/i);
  assert.match(sql, /legacy_exclusive_ids[\s\S]*string_agg/i);
  assert.match(sql, /legacy_capacity_ids[\s\S]*string_agg/i);
  assert.doesNotMatch(sql, /DELETE FROM occ\.(?:evidence_review|resource_reservation)/i);
  assert.doesNotMatch(sql, /UPDATE occ\.evidence_review/i);
});

test('bounds privileged functions and grants only runtime execution', () => {
  const functions = [...sql.matchAll(/CREATE FUNCTION occ\.([a-z0-9_]+)\([^]*?\$\$;/giu)];
  assert.ok(functions.length >= 8, 'expected bounded domain trigger functions');
  for (const [, name] of functions) {
    const definition = functions.find((match) => match[1] === name)?.[0] ?? '';
    assert.match(definition, /SET search_path = pg_catalog, occ/i, `${name} fixes search_path`);
    assert.match(sql, new RegExp(`REVOKE (?:ALL|EXECUTE) ON FUNCTION occ\\.${name}\\([^;]* FROM PUBLIC`, 'i'));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION occ\\.${name}\\([^;]* TO innorder_runtime`, 'i'));
  }
  assert.doesNotMatch(sql, /GRANT EXECUTE ON ALL FUNCTIONS/i);
});

test('adds supporting evidence, risk, and schedule indexes', () => {
  for (const index of [
    'uq_evidence_target_requirement_slot', 'ix_upload_session_lease_expiry',
    'ix_evidence_object_disposition_cleanup', 'ix_risk_intervention_queue',
    'ix_resource_availability_range', 'ix_resource_reservation_schedule',
  ]) {
    assert.match(sql, new RegExp(`CREATE (?:UNIQUE )?INDEX ${index}\\b`, 'i'), index);
  }
});
