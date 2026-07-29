# OCC Database Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a complete, ordered PostgreSQL/Flyway schema for OCC platform, extensible business data, OPA authorization, workflow projections, audit, and AI/RAG data.

**Architecture:** SQL is split into dependency-ordered Flyway migrations. Circular actor references are added after identity tables exist; cross-table type/cardinality rules use constraint triggers; extension-backed features are isolated in the first and final migrations. Plain `psql` contract tests validate object presence, immutability, shared primary keys, authorization semantics, and critical uniqueness rules.

**Tech Stack:** PostgreSQL 16+, pgvector, `btree_gist`, Flyway naming, PL/pgSQL, `psql` tests

---

## File Structure

- `database/migrations/V001__bootstrap.sql`: extensions, schemas, helper functions, instance table.
- `database/migrations/V002__catalog.sql`: domain package and versioned definition tables.
- `database/migrations/V003__identity_and_entities.sql`: unified entity directory, principals, credentials, identities, relationships, authorization revision.
- `database/migrations/V004__policy_control_plane.sql`: policy bundles, versions, modules, tests, approvals, releases, and decision logs.
- `database/migrations/V005__occ_runtime.sql`: extensible objects, migrations, Flowable mappings, evidence, risk, and resource reservations.
- `database/migrations/V006__audit_and_outbox.sql`: append-only audit, idempotency, and transactional outbox.
- `database/migrations/V007__ai_rag.sql`: providers, Agent definitions, knowledge, vectors, runs, recommendations, conversations, and evaluations.
- `database/migrations/V008__cross_schema_constraints.sql`: deferred actor FKs, type/immutability triggers, indexes, and active-version constraints.
- `database/tests/000_assert.sql`: test assertion helper.
- `database/tests/001_schema_contract.sql`: schema/table/column and extension checks.
- `database/tests/002_constraints.sql`: mutation tests rolled back after execution.
- `database/tests/run_all.sql`: ordered test entrypoint.
- `database/README.md`: execution order, prerequisites, and verification commands.

### Task 1: Contract Tests First

**Files:**
- Create: `database/tests/000_assert.sql`
- Create: `database/tests/001_schema_contract.sql`
- Create: `database/tests/002_constraints.sql`
- Create: `database/tests/run_all.sql`

- [ ] **Step 1: Define a fail-fast assertion helper**

```sql
CREATE OR REPLACE FUNCTION pg_temp.assert_true(condition boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF condition IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'assertion failed: %', message;
    END IF;
END;
$$;
```

- [ ] **Step 2: Assert required schemas, tables, and unique active states**

```sql
SELECT pg_temp.assert_true(to_regclass('authz.entity') IS NOT NULL, 'authz.entity exists');
SELECT pg_temp.assert_true(to_regclass('occ.business_object') IS NOT NULL, 'occ.business_object exists');
SELECT pg_temp.assert_true(to_regclass('ai.chunk_embedding') IS NOT NULL, 'ai.chunk_embedding exists');
```

- [ ] **Step 3: Add rollback-only constraint scenarios**

```sql
BEGIN;
-- Seed a draft package and verify duplicate keys are rejected in exception blocks.
ROLLBACK;
```

- [ ] **Step 4: Run tests before migrations**

Run: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/tests/run_all.sql`
Expected: FAIL because required schemas and tables do not exist.

### Task 2: Bootstrap and Catalog

**Files:**
- Create: `database/migrations/V001__bootstrap.sql`
- Create: `database/migrations/V002__catalog.sql`

- [ ] **Step 1: Add approved extensions and schemas**

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA platform;
CREATE SCHEMA catalog;
CREATE SCHEMA iam;
CREATE SCHEMA authz;
CREATE SCHEMA occ;
CREATE SCHEMA audit;
CREATE SCHEMA ai;
CREATE SCHEMA flowable;
```

- [ ] **Step 2: Create package and immutable definition tables**

Implement `domain_package`, `package_version`, entity/action/relation definitions, forms, evidence requirements, risk rules, and workflow definitions with JSON object checks and version uniqueness.

- [ ] **Step 3: Add a reusable published-row immutability trigger**

```sql
CREATE FUNCTION platform.reject_published_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('PUBLISHED', 'ACTIVE') THEN
        RAISE EXCEPTION 'published row is immutable';
    END IF;
    RETURN NEW;
END;
$$;
```

### Task 3: Identity and Authorization Graph

**Files:**
- Create: `database/migrations/V003__identity_and_entities.sql`

- [ ] **Step 1: Create `authz.entity` and IAM subtype tables**

Use shared UUID primary keys for `iam.principal`, while `user_account` and `external_identity` enforce normalized username and `(issuer, subject)` uniqueness.

- [ ] **Step 2: Create authorization revision and relationship facts**

```sql
CREATE TABLE authz.authorization_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    current_revision bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
```

- [ ] **Step 3: Add relationship and closure tables**

Create bidirectional indexes, active relationship uniqueness, validity checks, and a closure projection that is never authoritative for allow decisions.

### Task 4: Policy Control Plane

**Files:**
- Create: `database/migrations/V004__policy_control_plane.sql`

- [ ] **Step 1: Create bundle/version/module/test/approval tables**

- [ ] **Step 2: Create release and release-item tables**

Use a constant-expression partial unique index to permit only one `ACTIVE` release.

- [ ] **Step 3: Create monthly-partitioned decision log**

Store authorization revision, policy release, reason codes, matched policies, entity versions, and redacted digests.

### Task 5: OCC Runtime Facts

**Files:**
- Create: `database/migrations/V005__occ_runtime.sql`

- [ ] **Step 1: Create business object and typed index projection**

Add a trigger that enforces matching entity type versions between `authz.entity` and `occ.business_object`.

- [ ] **Step 2: Create explicit data migration tracking**

- [ ] **Step 3: Create process, task, evidence, risk, and managed resource tables**

- [ ] **Step 4: Add exclusion constraint for exclusive reservations**

```sql
EXCLUDE USING gist (resource_id WITH =, time_range WITH &&)
WHERE (exclusive AND state IN ('PENDING', 'CONFIRMED'));
```

### Task 6: Audit and Event Delivery

**Files:**
- Create: `database/migrations/V006__audit_and_outbox.sql`

- [ ] **Step 1: Create partitioned append-only audit records**

- [ ] **Step 2: Create idempotency records**

- [ ] **Step 3: Create outbox with aggregate-version uniqueness and pending index**

### Task 7: AI and RAG

**Files:**
- Create: `database/migrations/V007__ai_rag.sql`

- [ ] **Step 1: Create provider, model, Agent, prompt, and tool tables**

- [ ] **Step 2: Create knowledge source/document/version/chunk tables**

- [ ] **Step 3: Create single-active embedding spaces and vector storage**

- [ ] **Step 4: Create run, artifact, tool call, recommendation, conversation, message, and evaluation tables**

Internal AI runs inherit target authorization and do not use shared authorization entity IDs.

### Task 8: Cross-Schema Integrity and Indexes

**Files:**
- Create: `database/migrations/V008__cross_schema_constraints.sql`

- [ ] **Step 1: Add actor FKs after `iam.principal` exists**

- [ ] **Step 2: Add relation endpoint type/cardinality triggers**

- [ ] **Step 3: Add immutable-history triggers and all performance indexes**

- [ ] **Step 4: Add initial monthly partitions and partition maintenance helper**

### Task 9: Verification and Documentation

**Files:**
- Create: `database/README.md`
- Modify: `Docs/Project/创序OCC_数据库表设计_2026-07-28.md`

- [ ] **Step 1: Apply migrations in order**

Run:

```powershell
Get-ChildItem database/migrations/*.sql | Sort-Object Name | ForEach-Object {
  psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f $_.FullName
}
```

Expected: every migration exits 0.

- [ ] **Step 2: Run contract and constraint tests**

Run: `psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f database/tests/run_all.sql`
Expected: exits 0 and prints `all schema tests passed`.

- [ ] **Step 3: Run static checks when PostgreSQL is unavailable**

Run: `rg -n "TODO|TBD|待定" database`
Expected: no matches.

- [ ] **Step 4: Inspect intended changes**

Run: `git diff --check` and `git status --short`
Expected: no whitespace errors; only intended database, plan, and documentation files are modified.

No commit is created unless the user explicitly requests one.
