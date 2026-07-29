# Compose Host Access Gateway Design

## Problem

Docker Desktop does not install host port forwarding for containers connected
only to an `internal: true` network. The OCC services are healthy on the
internal `backend` network, but the documented `127.0.0.1` endpoints are not
reachable from the desktop application or host tools.

## Decision

Keep every business and infrastructure service exclusively on the internal
`backend` network. Add one digest-pinned, non-root TCP gateway connected to both
`backend` and a normal `host-access` bridge network. Only the gateway publishes
ports, all bound to `127.0.0.1`.

The gateway forwards the existing host ports to these unchanged backend
targets: PostgreSQL, Kafka, Redis, MinIO API and console, OPA, AI, and Core.
Kafka retains separate INTERNAL and EXTERNAL listeners so broker metadata sent
to host clients continues to advertise the configured localhost port.

## Security Boundaries

- Business services have no route through `host-access` and continue to
  communicate only over `backend`.
- The gateway receives no secrets, persistent volumes, Docker socket, or write
  access to configuration.
- Published sockets remain bound to loopback and are not LAN-accessible.
- The gateway runs as a fixed non-root UID with a read-only filesystem and
  dropped Linux capabilities except those required to bind unprivileged ports.

## Failure Handling

The gateway healthcheck verifies that its generated listener configuration is
active. Individual service healthchecks remain authoritative for backend
readiness. A failed backend produces a connection failure at the corresponding
gateway port without affecting unrelated routes.

## Verification

- Compose AST tests enforce network membership, loopback-only publication,
  target mappings, pinned image, non-root runtime, and absence of secrets.
- `docker compose config` verifies interpolation with external secret files.
- A full stack run must report every long-running service healthy and both
  one-shot MinIO jobs successful.
- Host probes must reach Core, AI, OPA, MinIO, Kafka, Redis, and PostgreSQL.
- `npm run verify:full` must pass after the topology change.
