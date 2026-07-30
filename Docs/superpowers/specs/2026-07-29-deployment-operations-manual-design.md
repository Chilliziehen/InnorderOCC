# Deployment and Operations Manual Design

## Goal

Create a detailed Chinese deployment and operations manual under
`Docs/Deployment/` for the repository's current single-customer, single-host
Docker Compose deployment. Provide complete, parallel procedures for Linux
Docker Engine and Windows Docker Desktop without inventing unsupported runtime
features.

## Audience

The manual serves deployment engineers, system administrators, on-call
operators, security reviewers, and maintainers taking over an existing OCC
instance. A reader may know Docker but should not need prior knowledge of this
repository.

## Documentation Architecture

Use a multi-file manual with `Docs/Deployment/README.md` as the entry point.
Each chapter owns one operational concern and can be followed independently
after reading the architecture and safety conventions.

The manual contains:

1. `README.md`: scope, capability limits, reading paths, safety conventions,
   and chapter index.
2. `01-architecture-and-boundaries.md`: services, startup dependencies,
   networks, gateway behavior, ports, volumes, credentials, and ownership.
3. `02-preflight-and-capacity.md`: supported platforms, required tools,
   capacity planning, DNS/TLS, ports, time, storage, and preflight commands.
4. `03-secrets-and-configuration.md`: eight external secret files, file
   permissions, environment variables, port overrides, validation, and rotation.
5. `04-deploy-windows.md`: complete PowerShell and Docker Desktop deployment,
   verification, restart, and removal procedures.
6. `05-deploy-linux.md`: complete Bash and Docker Engine deployment,
   filesystem ownership, service supervision, verification, and removal.
7. `06-daily-operations-and-monitoring.md`: health, logs, resources, capacity,
   routine inspections, alert inputs, and operator handover.
8. `07-backup-restore-and-dr.md`: component-specific backup and restore,
   consistency boundaries, recovery order, drills, RPO/RTO inputs, and disaster
   recovery procedures.
9. `08-upgrade-and-rollback.md`: release intake, provenance checks, backup
   point, image builds, database migration constraints, rollout, validation,
   rollback, and failed-upgrade handling.
10. `09-incident-runbooks.md`: symptom-driven diagnostics for Docker, gateway,
    Core, PostgreSQL/Flyway/Flowable, Kafka, Redis, MinIO, OPA, AI, networking,
    ports, DNS, TLS, and resource exhaustion.
11. `10-security-hardening.md`: loopback boundary, host controls, least
    privilege, secret handling, audit evidence, dependency provenance, patching,
    and remote-access boundaries.
12. `11-command-reference-and-checklists.md`: safe command reference and
    deployment, shutdown, upgrade, backup, restore, incident, and handover
    checklists.

## Platform Treatment

Linux and Windows are equal deployment targets in the manual. Platform-specific
chapters contain complete commands rather than referring readers to translate
another shell. Shared operational chapters present PowerShell and Bash variants
where command syntax differs.

The Windows path targets Docker Desktop with Linux containers and PowerShell
5.1-compatible commands. The Linux path targets Docker Engine with the Compose
v2 plugin and Bash. Commands execute from the repository root unless a step
explicitly states otherwise.

## Source of Truth

The manual derives executable facts from:

- `infra/compose/compose.yml`
- `infra/compose/.env.example`
- `infra/compose/README.md`
- service Dockerfiles and healthchecks
- root verification scripts and `package.json`
- database bootstrap, migrations, and tests
- OPA policy documentation and tests
- current design documents under `Docs/superpowers/`

The manual must use exact service names, environment variables, default ports,
health routes, named volumes, role names, network names, and verification
commands from those sources.

## Safety Model

Every destructive or availability-affecting operation must state:

- expected impact and affected services;
- prerequisites and required backup state;
- a confirmation checkpoint before execution;
- verification after execution;
- a recovery or rollback path where one exists.

The manual must distinguish routine `down` from destructive `down --volumes`,
logical backup from crash-consistent volume backup, application rollback from
irreversible database migration rollback, and credential rotation from initial
secret creation.

No example may contain a usable password, token, access key, or private host
address. Examples use clearly marked operator-supplied paths and values while
preserving the repository rule that `.env` contains secret file paths, never
secret values.

## Deployment Boundary

The executable mainline is the existing single-host Compose topology:

- business and infrastructure services remain on internal `backend`;
- only `host-gateway` joins `host-access` and publishes loopback ports;
- one private instance serves one customer;
- named volumes hold PostgreSQL, Kafka, Redis, and MinIO state;
- Core owns Flyway application migrations and Flowable runtime initialization.

Reverse proxies, TLS termination, remote access, HA, Kubernetes, external
managed services, and multi-host disaster recovery are extension boundaries.
The manual explains prerequisites, threats, and decision points for those
extensions but does not provide untested production configuration.

## Backup and Recovery Scope

Backup guidance is component-aware:

- PostgreSQL logical backups are the authoritative database recovery method.
- MinIO object backup must preserve bucket content separately from PostgreSQL.
- Kafka and Redis persistence are covered according to their current foundation
  roles, with explicit warnings that copying live volumes is not a consistent
  application backup.
- Secret files, the non-secret Compose environment file, source revision, image
  digests, and restoration metadata are part of the recovery set.

The recovery sequence must restore secrets and configuration first, then state
stores, then application services, followed by protocol and HTTP acceptance
tests. A restore is not considered valid until an isolated drill passes.

## Incident Runbook Pattern

Each runbook uses the same structure:

1. Symptoms and likely blast radius.
2. Immediate safety actions.
3. Evidence collection commands.
4. Decision tree from host to container to dependency.
5. Corrective actions ordered from least to most disruptive.
6. Validation and return-to-service checks.
7. Escalation evidence and prevention follow-up.

Runbooks must not recommend disabling TLS, dependency verification, secret
boundaries, health checks, or authorization as a diagnostic shortcut.

## Verification

Documentation verification includes:

1. Parse the active Compose configuration with an external secret-path env file.
2. Compare every documented service, port, route, volume, network, role, and
   variable against repository sources.
3. Verify all referenced repository paths exist.
4. Scan the manual for placeholders, accidental secret values, stale service
   names, insecure examples, and platform-shell mismatches.
5. Run Markdown-oriented structural checks for chapter titles, navigation links,
   code-fence languages, safety warnings, and required checklist sections.
6. Request independent specification and technical reviews.
7. Run `git diff --check` before completion.

Documentation commands that would destroy data are reviewed statically and are
not executed. Read-only probes, Compose configuration parsing, builds, and
non-destructive health commands may be executed against the local verified
stack.
