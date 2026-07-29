# OCC Software Foundation Design

## Scope

This phase establishes a runnable repository foundation for the approved OCC architecture. It does not implement domain workflows yet. It delivers buildable service boundaries, a usable operational desktop shell, shared contracts, security defaults, and local infrastructure definitions so later vertical slices can be added without restructuring the repository.

## Repository Layout

```text
apps/desktop/              Electron + React operational client
services/core/             Kotlin + Spring Boot + embedded Flowable boundary
services/ai/               Node.js + Fastify + LangChain boundary
packages/contracts/        TypeScript schemas and OpenAPI contracts
database/                  Existing PostgreSQL/Flyway schema
policies/opa/              Rego platform baseline and policy tests
infra/compose/             Private deployment dependencies and service wiring
scripts/                   Cross-platform integrated verification orchestration
Docs/                      Product, architecture, database, and implementation docs
```

The root owns npm workspaces and the Gradle multi-project build. TypeScript packages share strict compiler settings. The wrapper pins Gradle 8.14.3 and verifies its distribution checksum. Core uses a Java 21 toolchain; on Windows, `gradlew.bat` can select an installed Java 17-24 wrapper runtime when the ambient Java is 25+, after which Gradle resolves Java 21 for compilation.

## Initial Vertical Capability

The desktop opens directly into an OCC operations workspace. It displays Core, AI, policy, database, Kafka, Redis, and object-storage readiness without pretending unavailable dependencies are healthy. Core and AI expose versioned health/info contracts. The desktop polls those HTTP endpoints and distinguishes ready, degraded, unreachable, and checking states.

Core owns deterministic state and exposes `/api/v1/system/status`. The initial implementation keeps database and Flowable dependencies behind adapters so controller tests do not require infrastructure. AI exposes `/health` and `/api/v1/providers/capabilities`; its provider registry is validated with Zod and contains no secrets. Neither service performs business state transitions in this phase.

## Security Boundaries

- Electron renderer has sandbox and context isolation enabled with Node integration disabled.
- Preload exposes a narrow typed API; renderer code cannot access environment variables or the filesystem.
- Core and AI bind configuration through environment variables and never return credentials.
- OPA baseline uses default deny and separates allow and deny reasons.
- CORS is not enabled in this phase: the Desktop renderer uses narrow preload IPC, and the Electron main process performs status requests. Any future browser origin must have an explicit allowlist before CORS is activated.
- Compose receives eight deployment-specific values through files outside the repository. PostgreSQL uses separate `innorder_admin`, `innorder_flyway`, and `innorder_runtime` roles; Core receives only Flyway and runtime credentials, and only MinIO's bucket-scoped application credentials.

## Contracts

`packages/contracts` defines service-state enums, health response schemas, and provider-capability schemas. Desktop and AI consume the TypeScript package directly. Core mirrors the JSON wire contract and is checked against an OpenAPI document. Contract fields are additive and versioned under `/api/v1`.

The existing PostgreSQL schema is ordered from `V001` through `V009`. `V009__runtime_privileges.sql` grants the runtime role DML and sequence access on application schemas and `USAGE, CREATE` only on the Flowable schema; it does not transfer schema ownership or superuser privileges.

## Deployment Reproducibility

Compose external images and every Dockerfile `FROM` retain a readable version tag and pin the registry index by SHA-256 digest. Service ports bind to loopback, containers communicate on an internal network, and secret values are not embedded in images, Compose, examples, or documentation.

## Error Handling

Health calls use bounded timeouts and return structured degraded states instead of throwing into the UI. AI startup validates environment configuration, returns bounded error envelopes, and adds correlation IDs to responses. Core currently exposes the typed status contract and uses secure Spring error defaults; it does not yet define application error codes or a correlation-ID contract. The desktop preserves its fixed layout while endpoints transition between states.

## Testing

- Contracts: schema parsing and invalid-response rejection.
- AI: Fastify injection tests for health and capabilities.
- Core: JUnit unit tests and standalone MockMvc controller tests.
- Desktop: React Testing Library tests for status rendering and unreachable states.
- OPA: static policy checks run in quick and local modes; real `opa test` runs when available locally and is mandatory in strict full mode.
- Repository quick verification: workspace tests, infrastructure/OPA static contracts, database static contracts, Core Gradle build/tests, TypeScript builds, and typechecks.
- Repository local verification: quick verification plus PGlite migrations and SQL contracts, npm vulnerability/signature audits, and packaged Electron smoke tests. Locally unavailable Docker and OPA checks may skip.
- Repository strict full verification: preflight requires Docker engine connectivity and a working OPA executable, real OPA tests run, the digest-pinned PostgreSQL Testcontainers suite is forced, and its structured JUnit result must contain no skipped or failed tests.

## Verification Prerequisites

Quick and local verification do not require Docker or OPA. They run every available check and report their limited quick or local success semantics. Strict full verification requires a responding Docker engine and an actual OPA executable before any build begins. A Docker CLI without daemon connectivity and an OPA path that cannot execute `opa version` both fail preflight.

## Completion Criteria

1. All planned directories contain focused build files and source code.
2. npm workspace install creates a lockfile and all TypeScript tests/builds pass.
3. Gradle wrapper is generated and Core tests/build pass on Java 21 target.
4. Electron renderer production build succeeds and the operational workspace is responsive.
5. Infrastructure and OPA configuration contain no placeholders or secrets.
6. Root documentation gives exact development commands and architecture boundaries.
7. CI/release completion requires strict full verification with real OPA policy tests and no skipped Docker integration tests.
