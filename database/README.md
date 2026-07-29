# OCC Database Schema

This directory contains the complete OCC application schema as ordered PostgreSQL migrations.

## Prerequisites

- PostgreSQL 16 or newer
- `vector` extension from pgvector
- Permission to install `vector` and `btree_gist`
- Permission to create the `innorder_runtime` role when using the full-schema entrypoint
- UTF-8 database encoding

Flowable owns its internal tables. These migrations create the `flowable` schema but intentionally do not copy version-specific vendor DDL. Configure the pinned Flowable release to use that schema and let its supported migration process create or upgrade engine tables.

## Apply

Apply the complete schema with `psql`:

```powershell
psql $env:SCHEMA_ADMIN_DATABASE_URL -v ON_ERROR_STOP=1 -f database/innorder_occ_full_schema.sql
```

`SCHEMA_ADMIN_DATABASE_URL` must be supplied by deployment secret management and identify a role allowed to create extensions, schemas, and roles. The full-schema entrypoint first runs `database/bootstrap/001-create-runtime-role.sql`. This idempotently creates `innorder_runtime` as `NOLOGIN` when absent, without setting a password, and then runs `V001` through `V009`.

For Flyway-only installation, `innorder_runtime` must exist before `V009`. An administrator can safely establish only that prerequisite before Flyway starts:

```powershell
psql $env:SCHEMA_ADMIN_DATABASE_URL -v ON_ERROR_STOP=1 -f database/bootstrap/001-create-runtime-role.sql
```

Then point `flyway.locations` at `filesystem:database/migrations`; files must run in lexical version order from `V001` through `V009`. The bootstrap role remains `NOLOGIN`. Production and Compose deployment bootstrap must separately provision the `innorder_flyway` login and explicitly configure login credentials for `innorder_runtime`; credentials are never part of schema SQL.

The Compose deployment uses `innorder_flyway` for migrations and
`innorder_runtime` for the Core datasource. The migration role owns application
schemas, including `flowable`. The runtime role receives DML and sequence access
through `V009`; it has `USAGE, CREATE` only on the Flyway-owned `flowable`
schema so Flowable can own its version-specific `ACT_*` tables without owning
the schema. `infra/compose/postgres/010-create-roles.sh` performs
deployment-specific login and password provisioning from secret files.

## Verify

Run static contracts without PostgreSQL:

```powershell
node --test database/tests/schema-static.test.mjs
```

Run database contracts after applying all migrations:

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database/tests/run_all.sql
```

The database tests run mutations inside a transaction and roll them back.

The current workspace was also validated from an empty database with PGlite 0.5.4, a PostgreSQL WASM build. That smoke test executes the runtime-role bootstrap twice, verifies the role remains `NOLOGIN`, and uses a compatibility domain for the `vector` type because PGlite does not bundle pgvector. A real PostgreSQL + pgvector environment must still execute `ai.create_embedding_partition(...)` to verify HNSW operator classes and index creation.

## Authorization Transactions

Before a normal authorization-sensitive business write, hold a shared lock for the transaction:

```sql
SELECT current_revision
FROM authz.authorization_state
WHERE singleton
FOR SHARE;
```

Commands that change relationships, active policy releases, entity authorization attributes, or entity authorization state must take `FOR UPDATE` instead. They increment the revision through schema triggers. Core must send the locked revision to OPA and reject a response with a different policy release or authorization revision.

The `authz.relationship_closure` table is a rebuildable query projection. It must never be used as the final allow fact; OPA receives direct relationships for its decision.

## Embedding Spaces

Create an `ai.embedding_space` row in `BUILDING` state, then create its vector partition before inserting embeddings:

```sql
SELECT ai.create_embedding_partition(
    '018f0f26-8c66-7d70-9000-000000000001'::uuid,
    1536,
    'COSINE'
);
```

The helper verifies the configured dimensions and distance metric, creates a list partition, adds a dimension check, and builds the matching HNSW index. Only one embedding space can have `ACTIVE` status.

## Partitioned Logs

`authz.decision_log` and `audit.audit_record` are range-partitioned and include default partitions so deployments remain writable at any date. Production operations should create monthly partitions ahead of time and move matching rows out of the default partition during a maintenance window before attaching those partitions.

## Migration Policy

- Core schema changes are forward-only Flyway migrations.
- Published package, policy, evidence, document-version, message, audit, and decision rows are immutable.
- Domain packages may add versioned definitions and JSONB data but cannot execute DDL.
- Schema changes and the pinned Flowable migration must be tested together from a restored previous-release backup.
