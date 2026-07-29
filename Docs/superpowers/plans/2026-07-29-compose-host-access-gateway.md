# Compose Host Access Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose OCC Compose endpoints on host loopback without attaching business services to a non-internal network.

**Architecture:** A small Node.js TCP gateway built from the repository's existing digest-pinned Node image connects to both `backend` and `host-access`. Business services remain exclusively on `backend`; only the gateway publishes ports.

**Tech Stack:** Docker Compose, Node.js `net`/`http`, Node test runner, dockerfile-ast, YAML contract tests.

---

### Task 1: Tested TCP gateway

**Files:**
- Create: `infra/compose/gateway.mjs`
- Create: `infra/compose/gateway.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests**

Test a single TCP route with ephemeral ports, bidirectional byte forwarding,
upstream connection failure isolation, `/health` response, and graceful close.
Export `createGateway(routes, options)` from `gateway.mjs` so tests exercise the
same implementation used in the container.

- [ ] **Step 2: Verify RED**

Run: `node --test infra/compose/gateway.test.mjs`

Expected: FAIL because `gateway.mjs` does not exist.

- [ ] **Step 3: Implement minimal gateway**

Use `node:net` servers with `client.pipe(upstream)` and
`upstream.pipe(client)`, destroy both sides on either error, track sockets for
shutdown, and expose an HTTP health server. The executable entry point maps
ports `5432`, `9092`, `6379`, `9000`, `9001`, `8181`, `3100`, and `8080` to the
same service names and ports on `backend`.

- [ ] **Step 4: Include gateway tests in infra verification**

Set `test:infra` to:

```json
"node --test infra/compose/compose.contract.test.mjs infra/compose/gateway.test.mjs"
```

- [ ] **Step 5: Verify GREEN**

Run: `npm run test:infra`

Expected: all gateway and existing Compose contract tests pass; real OPA may be
skipped unless `OPA_PATH` is provided.

### Task 2: Gateway container and topology

**Files:**
- Create: `infra/compose/gateway.Dockerfile`
- Create: `infra/compose/gateway.Dockerfile.dockerignore`
- Modify: `infra/compose/compose.yml`
- Modify: `infra/compose/compose.contract.test.mjs`

- [ ] **Step 1: Write failing topology contracts**

Require `host-gateway` to use the existing pinned Node image, run as `node`,
drop all capabilities, use a read-only filesystem, mount no secrets, connect to
`backend` and `host-access`, and own every loopback port publication. Require
all other services to have no `ports` key and only the `backend` network.

- [ ] **Step 2: Verify RED**

Run: `npm run test:infra`

Expected: FAIL because `host-gateway` and `host-access` do not exist.

- [ ] **Step 3: Add gateway image**

Build from:

```dockerfile
FROM node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854
WORKDIR /app
COPY --chown=node:node infra/compose/gateway.mjs ./gateway.mjs
USER node
HEALTHCHECK CMD ["node", "-e", "fetch('http://localhost:18000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/app/gateway.mjs"]
```

- [ ] **Step 4: Rewire Compose**

Move the existing eight `127.0.0.1` mappings to `host-gateway`, add
`host-access` as a normal bridge, and retain `backend.internal: true`. Do not
gate gateway startup on backend health: each TCP route must expose failures from
its own unavailable upstream without removing unrelated host routes.

- [ ] **Step 5: Verify GREEN**

Run with real OPA:

```powershell
$env:OPA_PATH='C:\Users\30367\AppData\Local\Temp\opencode\opa-1.5.1.exe'
npm run test:infra
```

Expected: all tests pass with zero skips.

### Task 3: Runtime and documentation

**Files:**
- Modify: `infra/compose/README.md`
- Modify: `infra/compose/.env.example`

- [ ] **Step 1: Document gateway boundary**

State that only `host-gateway` joins `host-access`, all published sockets bind
to loopback, and backend services remain internal-only.

- [ ] **Step 2: Add missing Redis port override**

Add `REDIS_PORT=` alongside the other optional host port variables.

- [ ] **Step 3: Recreate and wait for stack**

Run `docker compose ... up -d --build --wait --wait-timeout 420` with the
temporary external secret env file. Expected: all long-running services and
`host-gateway` healthy; one-shot MinIO jobs exit 0.

- [ ] **Step 4: Probe host endpoints**

Verify Core `18080`, AI `13100`, OPA `18181`, MinIO `19000`, Kafka `19092`,
Redis `16379`, and PostgreSQL `15432` from Windows host tools.

### Task 4: Final verification

**Files:**
- Verify all modified files and generated Gradle verification keyring.

- [ ] **Step 1: Run strict verification**

Run `npm run verify:full` with Docker on `PATH` and official OPA 1.5.1 in
`OPA_PATH`. Expected: `full verification passed`.

- [ ] **Step 2: Validate Docker builds and clean diffs**

Run `docker compose ... build`, `git diff --check`, and inspect `git status` and
the complete diff. Expected: all images build, no whitespace errors, no secret
files tracked, and only intended source/metadata changes remain.
