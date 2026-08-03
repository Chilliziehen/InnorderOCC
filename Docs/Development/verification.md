# Verification

Run commands from the repository root. Node.js 22+, Java 21, npm dependencies, and a responding Docker daemon are required for the full gate. Strict authorization tests require the trusted OPA 1.5.1 executable; other OPA versions are rejected.

## Commands

Quick, without network audit or packaged Electron smoke:

```powershell
npm run verify
```

Local, including PGlite, npm audits, and packaged Electron smoke on Windows:

```powershell
npm run verify:local
```

Full on Windows:

```powershell
$env:OPA_PATH = 'C:\Tools\opa\opa_windows_amd64.exe'
npm run verify:full
```

Full on Linux:

```bash
export OPA_PATH=/opt/opa/opa
npm run verify:full
```

Focused security and Flowable acceptance:

```powershell
$env:OPA_PATH = 'C:\Tools\opa\opa_windows_amd64.exe'
./gradlew.bat :services:core:test --tests com.innorder.occ.PlatformSecurityKernelIntegrationTest --tests com.innorder.occ.FlowableProductionStartupIntegrationTest --tests com.innorder.occ.PostgreSqlFlowableIntegrationTest --dependency-verification strict
```

Use `./gradlew` instead of `./gradlew.bat` on Linux. `OPA_PATH` must report `Version: 1.5.1` from `opa version`.

## Platform Matrix

| Gate | Windows | Linux |
| --- | --- | --- |
| Contracts, Core, database, infra, real OPA, Kafka | Mandatory | Mandatory |
| Electron build and provenance | Mandatory | Mandatory |
| Packaged Electron smoke | Mandatory | Not launched |

A skipped JUnit suite is not a successful full gate. Full verification reruns the complete Core test task under Docker and trusted OPA settings, validates every emitted JUnit XML, and rejects malformed, zero-test, skipped, failed, or errored suites. It also discovers every concrete top-level `*Test.kt` class and requires its corresponding XML. Abstract fixtures and nested classes are deliberately excluded from that source-to-suite check. Non-full infrastructure runs may skip a real OPA subprocess only when `OPA_PATH` is absent; `verify:full` never permits that skip.

The explicit mandatory integration guards remain in `scripts/verify.mjs` in addition to complete-suite discovery. They include the production Flowable startup chain, security kernel, real PostgreSQL/Flowable, auth, authorization, command, bootstrap, real Kafka, and outbox suites, so critical acceptance XML cannot disappear through discovery changes.

## Flowable

Production defaults `FLOWABLE_DATABASE_SCHEMA_UPDATE=false`. Compose runs `postgres-init` after PostgreSQL health, then runs `flowable-init` once with the explicit `flowable-init` profile and schema update enabled. Core starts only after that completion gate, with schema mutation disabled. A startup verifier rejects a Flowable datasource or transaction manager that differs from the application boundary, and rejects schema update outside `development`, `test`, or `flowable-init`.

Flowable operations and OCC projection, audit, and outbox writes share the Spring transaction manager. The PostgreSQL acceptance test proves both rollback and commit behavior with real Flowable runtime/history tables.

## Troubleshooting

- Docker failures: run `docker info` and resolve daemon access before retrying.
- OPA failures: run `& $env:OPA_PATH version` on Windows or `$OPA_PATH version` on Linux and confirm exactly 1.5.1.
- npm cache permission failures: point npm at a writable cache, for example `$env:npm_config_cache = "$env:TEMP\innorder-npm-cache"` on Windows or `export npm_config_cache="${TMPDIR:-/tmp}/innorder-npm-cache"` on Linux.
- Flowable startup failures: confirm Flyway completed, the `flowable-init` service exited successfully, `ACT_*` tables exist, and Core has `FLOWABLE_DATABASE_SCHEMA_UPDATE=false`.
