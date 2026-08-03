# Platform Security Baseline Design

## Goal

Seed the immutable platform catalog, role, and policy baseline on every startup independently of optional one-shot administrator creation. A fresh Compose database with no administrator password must still provision risk runtime identities and reach readiness without a USER account.

## Components And Order

`PlatformSecurityBaseline` is an unconditional `ApplicationRunner` and reusable service. It owns the deterministic platform package, published USER/ROLE/SYSTEM types, role assignment definition, built-in role principals, and active platform policy release. Its order is `0`.

`BootstrapAdministrator` remains conditional on a configured password file and moves to order `10`. It calls `PlatformSecurityBaseline.ensure()` for direct invocation safety, then creates only the first USER administrator, account, and administrator role relationship. `RiskRuntimeIdentityProvisioner` moves to order `20`; `RiskRuntimeIdentityValidator` moves to order `30`.

## Transactions And Locks

Baseline seeding runs in its own transaction. It takes the existing platform bootstrap advisory transaction lock first, then `authz.lock_authorization_state_for_change()` before role or policy authorization facts. Exact selectors, immutable published content hashes, release hashes, and policy manifests are preserved.

Administrator creation runs in a separate transaction after baseline commit and takes the same advisory lock followed by the authorization-state change lock before inserting the admin relationship. A configured secret failure aborts readiness and creates no administrator, but the valid baseline remains committed.

Repeated baseline, admin, and risk provisioning calls verify exact rows and perform no writes when already initialized. Any ID, natural-key, published hash, role, or policy collision fails closed and rolls back the active operation.

## Behavior

- Empty database without an admin password: baseline and configured risk identities are created; no USER principal or `iam.user_account` row is created.
- Configured one-shot password: baseline commits, then exactly one administrator is created.
- Restart: all runners verify existing state without duplicate relationships or authorization revision bumps.
- Admin secret failure: baseline remains; no administrator rows are created; application readiness is not reached.
- Baseline collision: the baseline transaction rolls back and later runners do not execute.

## Verification

Real PostgreSQL tests cover no-password startup, optional one-shot admin startup, restart idempotency, collision rollback, authorization revision counts, secret-failure persistence, and runner order. Existing bootstrap integration tests remain authoritative for secret handling and exact published hashes. Forced risk/context tests, Compose contracts, and pinned OPA 1.5.1 strict/behavior tests complete verification. No migration is added or modified.
