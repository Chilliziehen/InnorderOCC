# Local Infrastructure

## Prerequisites

Install Docker Engine with Docker Compose v2. The stack requires Linux
containers and enough memory for PostgreSQL, Kafka, Core, and supporting
services.

Create nine files outside the repository. Each file must contain one unique,
non-empty value without surrounding quotes. Create `infra/compose/.env` from
`.env.example` and set these variables to the corresponding absolute paths:

- `POSTGRES_ADMIN_PASSWORD_FILE`
- `CURSOR_HMAC_KEY_FILE`
- `POSTGRES_FLYWAY_PASSWORD_FILE`
- `POSTGRES_RUNTIME_PASSWORD_FILE`
- `REDIS_PASSWORD_FILE`
- `MINIO_ROOT_USER_FILE`
- `MINIO_ROOT_PASSWORD_FILE`
- `MINIO_APP_USER_FILE`
- `MINIO_APP_PASSWORD_FILE`

The three PostgreSQL passwords must differ. The MinIO application username and
password must differ from the root credentials. Blank paths stop Compose
interpolation. Do not commit `.env` or any secret file.
The cursor HMAC key file must contain at least 32 bytes of deployment-specific
random key material.

The two risk runtime identity UUIDs in `.env.example` are stable, non-secret
defaults. They can be overridden for an installation that reserves different
IDs; the configured IDs must remain distinct.

## Start

From the repository root, validate the fully interpolated configuration:

```sh
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml config
```

Build and start the stack:

```sh
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml up --build
```

Stop it without deleting data:

```sh
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml down
```

Add `--volumes` only when intentionally deleting all local PostgreSQL, Kafka,
Redis, and MinIO data.

## Risk Runtime Identities

On Core startup, the unconditional platform security baseline first publishes
the immutable USER, ROLE, and SYSTEM types and the `role:risk-runtime` policy
role. Administrator bootstrap is optional and one-shot; Compose deliberately
configures no administrator password. The risk runtime provisioner creates the
configured SERVICE principal, stable `system:risk-report` resource, and role
assignment without an administrator password before runtime identity validation.
Restart verifies the exact existing rows without rewriting them.

The role grants only `risk.escalate` and `risk.sla_breach`; it does not grant
`occ.admin`, general execute, or read authority. An ID or stable-key collision
with any non-exact row aborts startup instead of adopting or modifying that row.

## Credential Boundaries

PostgreSQL starts with the `innorder_admin` bootstrap superuser. Its entrypoint
creates two non-superuser login roles using psql variables, then pre-installs
the extensions that require elevated privileges. Core runs Flyway as
`innorder_flyway` and normal JDBC/Flowable work as `innorder_runtime`. Flyway
owns every application schema, including `flowable`. Migration `V009` grants
the runtime role `USAGE, CREATE` on `flowable` so Flowable's runtime connection
can own its `ACT_*` tables without owning the schema. It also grants runtime
DML, sequence access, and only the bounded `ai.create_embedding_partition`
function; only the `flowable` schema grants runtime `CREATE`.

MinIO root credentials are mounted only into MinIO and the one-shot `minio-init`
service. The initializer creates the configured bucket and a bucket-scoped OCC
account. Core sees only that account. `minio-volume-init` prepares the named
volume as root, while the MinIO server itself runs as UID/GID `10001` and must
pass `/minio/health/ready`. Core startup gate is PostgreSQL only. MinIO
initialization and readiness are independent and do not gate Core in this
foundation.

Spring imports mounted secrets with
`SPRING_CONFIG_IMPORT=configtree:/run/secrets/`. Secret target filenames are
exact Spring properties, including `spring.datasource.password`,
`spring.flyway.password`, `occ.object-storage.secret-key`, and
`occ.cursor.secret`. The cursor key is mounted only into Core; missing or weak
key material prevents normal Core startup.

## Immutable Images

Every external image reference retains its exact tag and pins the registry
index with `@sha256`. The recorded indexes were checked through the Docker Hub
Registry API and verified to contain a Linux/AMD64 platform manifest.

To refresh an image, query the tag endpoint, confirm `media_type` is an OCI
index or Docker manifest list, and select an active `linux/amd64` image:

```powershell
$repo = 'library/alpine'
$tag = '3.21.3'
$result = Invoke-RestMethod "https://hub.docker.com/v2/repositories/$repo/tags/$tag"
$result.digest
$result.images | Where-Object { $_.os -eq 'linux' -and $_.architecture -eq 'amd64' }
```

Cross-check the index using the Registry API `Docker-Content-Digest` response
header, update the readable tag and digest together, then run
`npm run test:infra` and build the affected image on Linux.

## Service Boundaries

Application and infrastructure containers communicate exclusively over the
internal `backend` network. A non-root `host-gateway` is the only service also
attached to the `host-access` bridge and the only service that publishes ports.
It receives no secrets or volumes and forwards loopback traffic to the internal
service endpoints. All published ports bind to `127.0.0.1`; they are not exposed
to the LAN.

Core owns application migration startup; Compose does not run a competing
migration process. Default host ports are Core `8080`, AI `3100`, OPA `8181`,
PostgreSQL `5432`, Kafka `9092`, Redis `6379`, MinIO API `9000`, and MinIO
console `9001`.
