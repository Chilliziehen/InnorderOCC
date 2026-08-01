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
./gradlew.bat :services:core:test --tests com.innorder.occ.PlatformSecurityKernelIntegrationTest --tests com.innorder.occ.PostgreSqlFlowableIntegrationTest --dependency-verification strict
```

Use `./gradlew` instead of `./gradlew.bat` on Linux. `OPA_PATH` must report `Version: 1.5.1` from `opa version`.

## Platform Matrix

| Gate | Windows | Linux |
| --- | --- | --- |
| Contracts, Core, database, infra, real OPA, Kafka | Mandatory | Mandatory |
| Electron build and provenance | Mandatory | Mandatory |
| Packaged Electron smoke | Mandatory | Not launched |

A skipped JUnit suite is not a successful full gate. Full verification reads structured JUnit XML and rejects missing, malformed, zero-test, skipped, failed, or errored mandatory suites. Non-full infrastructure runs may skip a real OPA subprocess only when `OPA_PATH` is absent; `verify:full` never permits that skip.

Mandatory Core suites are every class selected by the strict command in `scripts/verify.mjs`: the platform/Flowable integration suites and all test classes under the auth, authz, command, bootstrap, Flowable configuration, and outbox/event kernel. This includes the real Kafka `KafkaOutboxEventSenderProtocolIntegrationTest`; the list in the verifier is authoritative and deliberately explicit so missing XML cannot disappear through test discovery changes.

## Flowable

Production defaults `FLOWABLE_DATABASE_SCHEMA_UPDATE=false`. Compose runs `flowable-init` once, after PostgreSQL health and before Core, with the explicit `flowable-init` profile and schema update enabled. Core then starts with schema mutation disabled. A startup verifier rejects a Flowable datasource or transaction manager that differs from the application boundary, and rejects schema update outside `development`, `test`, or `flowable-init`.

Flowable operations and OCC projection, audit, and outbox writes share the Spring transaction manager. The PostgreSQL acceptance test proves both rollback and commit behavior with real Flowable runtime/history tables.

## Troubleshooting

- Docker failures: run `docker info` and resolve daemon access before retrying.
- OPA failures: run `& $env:OPA_PATH version` on Windows or `$OPA_PATH version` on Linux and confirm exactly 1.5.1.
- npm cache permission failures: point npm at a writable cache, for example `$env:npm_config_cache = "$env:TEMP\innorder-npm-cache"` on Windows or `export npm_config_cache="${TMPDIR:-/tmp}/innorder-npm-cache"` on Linux.
- Flowable startup failures: confirm Flyway completed, the `flowable-init` service exited successfully, `ACT_*` tables exist, and Core has `FLOWABLE_DATABASE_SCHEMA_UPDATE=false`.
