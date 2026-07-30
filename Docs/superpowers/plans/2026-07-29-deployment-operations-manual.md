# Deployment and Operations Manual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a detailed, internally consistent Chinese deployment and operations manual under `Docs/Deployment/` with complete Linux and Windows procedures for the current single-host Compose topology.

**Architecture:** Use a navigation index plus eleven focused chapters. Add a Node documentation contract that checks the file set, navigation, critical repository facts, safety warnings, and platform-specific command coverage so the manual cannot silently drift from the deployable topology.

**Tech Stack:** Markdown, Node.js test runner, Docker Compose v2, PowerShell 5.1, Bash, existing OCC verification scripts.

---

### Task 1: Documentation structure contract

**Files:**
- Create: `scripts/deployment-docs.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing documentation contract**

Create a Node test that reads `Docs/Deployment/`, requires the exact twelve-file
set from the design, and verifies:

```js
const chapters = [
  "README.md",
  "01-architecture-and-boundaries.md",
  "02-preflight-and-capacity.md",
  "03-secrets-and-configuration.md",
  "04-deploy-windows.md",
  "05-deploy-linux.md",
  "06-daily-operations-and-monitoring.md",
  "07-backup-restore-and-dr.md",
  "08-upgrade-and-rollback.md",
  "09-incident-runbooks.md",
  "10-security-hardening.md",
  "11-command-reference-and-checklists.md",
];
```

The test must require all chapters to have one H1, appear in `README.md`, and
contain no `TBD`, `TODO`, `FIXME`, `changeme`, or realistic credential examples.
It must also require exact facts including `host-gateway`, `backend`,
`host-access`, eight secret path variables, four named volumes, PostgreSQL role
names, eight default ports, Core/AI/OPA/MinIO health routes, `verify:full`, and
explicit `down --volumes` destructive warnings.

- [ ] **Step 2: Add the test command**

Add this root script without changing existing verification semantics:

```json
"test:deployment-docs": "node --test scripts/deployment-docs.test.mjs"
```

- [ ] **Step 3: Run the test to verify RED**

Run: `npm run test:deployment-docs`

Expected: FAIL because `Docs/Deployment/` and its chapters do not exist.

### Task 2: Entry point, architecture, preflight, and configuration

**Files:**
- Create: `Docs/Deployment/README.md`
- Create: `Docs/Deployment/01-architecture-and-boundaries.md`
- Create: `Docs/Deployment/02-preflight-and-capacity.md`
- Create: `Docs/Deployment/03-secrets-and-configuration.md`

- [ ] **Step 1: Write the manual entry point**

Include the exact chapter links, audience-specific reading paths, current
foundation limitations, command execution convention, and safety labels:
`安全`, `注意`, `危险`, and `验证`.

- [ ] **Step 2: Document architecture and ownership boundaries**

Derive service names, dependencies, networks, loopback publications, volumes,
roles, secret consumers, and healthchecks directly from
`infra/compose/compose.yml`. Explicitly explain that gateway health means its
listeners are active, not that every upstream is healthy.

- [ ] **Step 3: Write complete dual-platform preflight checks**

Provide PowerShell and Bash checks for OS architecture, Docker/Compose versions,
Linux container mode, engine connectivity, CPU, memory, disk, time, DNS/TLS,
required host ports, Git revision, Node/JDK/OPA availability, and repository
integrity. Capacity values must be labeled as planning baselines requiring load
validation, not guaranteed production sizing.

- [ ] **Step 4: Document secrets and configuration**

List every `.env.example` variable, default, validation rule, file permission,
consumer, rotation impact, and prohibited practice. Provide secure generation
examples using PowerShell cryptographic APIs and `/dev/urandom`/`openssl`
without printing generated values to terminal history.

- [ ] **Step 5: Run the documentation contract**

Run: `npm run test:deployment-docs`

Expected: still FAIL only for chapters not yet created; completed chapter checks
must pass.

### Task 3: Complete Windows and Linux deployment procedures

**Files:**
- Create: `Docs/Deployment/04-deploy-windows.md`
- Create: `Docs/Deployment/05-deploy-linux.md`

- [ ] **Step 1: Write the Windows procedure**

Cover Docker Desktop/Linux container checks, PowerShell 5.1 path-safe secret
creation, `.env` creation, configuration parsing, verified dependency install,
OPA setup, full verification, image build, detached startup, one-shot exit-code
handling, health and protocol acceptance tests, reboot behavior, log collection,
routine stop, and destructive cleanup confirmation.

- [ ] **Step 2: Write the Linux procedure**

Cover Docker Engine and Compose plugin prerequisites, operator group/permission
tradeoffs, repository and external secret directory ownership, restrictive
umask, configuration parsing, verification, image build, detached startup,
one-shot handling, health and protocol acceptance tests, a systemd unit that
invokes the exact Compose project safely, reboot behavior, and removal.

- [ ] **Step 3: Verify platform symmetry**

Ensure both chapters independently include prerequisites, secrets, config,
build, start, status, HTTP probes, TCP/protocol probes, restart, logs, stop, and
data deletion. Neither chapter may tell readers to translate commands from the
other shell.

- [ ] **Step 4: Run the documentation contract**

Run: `npm run test:deployment-docs`

Expected: remaining failures concern only operations/runbook chapters.

### Task 4: Daily operations, backup/recovery, and upgrade lifecycle

**Files:**
- Create: `Docs/Deployment/06-daily-operations-and-monitoring.md`
- Create: `Docs/Deployment/07-backup-restore-and-dr.md`
- Create: `Docs/Deployment/08-upgrade-and-rollback.md`

- [ ] **Step 1: Write the daily operations chapter**

Include shift/daily/weekly/monthly inspection frequencies, Compose status,
health, logs, resource and volume usage, host capacity, time synchronization,
certificate/DNS checks, alert inputs, evidence retention, and handover fields.
Distinguish signals available now from integrations that require an external
monitoring system.

- [ ] **Step 2: Write backup and restore procedures**

Provide PowerShell and Bash commands for PostgreSQL logical dump/restore, MinIO
object mirroring, Redis snapshot handling, Kafka limitations, secret/config
escrow, revision/digest manifests, checksums, retention, encryption boundary,
isolated restore drills, recovery ordering, and acceptance tests. State that
copying live named volumes is not an application-consistent backup.

- [ ] **Step 3: Write upgrade and rollback procedures**

Cover change approval, release revision, dependency/image provenance, backup
checkpoint, migration review, image build, staged validation, Compose rollout,
post-upgrade acceptance, application rollback, forward-fix requirements for
irreversible Flyway migrations, and failed-upgrade evidence collection.

- [ ] **Step 4: Run the documentation contract**

Run: `npm run test:deployment-docs`

Expected: remaining failures concern only incident/security/reference chapters.

### Task 5: Incident response, security, and command reference

**Files:**
- Create: `Docs/Deployment/09-incident-runbooks.md`
- Create: `Docs/Deployment/10-security-hardening.md`
- Create: `Docs/Deployment/11-command-reference-and-checklists.md`

- [ ] **Step 1: Write symptom-driven incident runbooks**

Use the seven-part pattern from the design for engine unavailable, image/build
failure, gateway/port failure, Core startup, Flyway/Flowable permissions,
PostgreSQL, Kafka, Redis, MinIO/init, OPA, AI, DNS/TLS, disk/memory pressure, and
partial upstream outage. Start with evidence collection and least-disruptive
actions; never recommend disabling security controls.

- [ ] **Step 2: Write the security hardening chapter**

Document loopback exposure, host firewall, remote-access prohibition by default,
Docker socket/admin risks, file permissions, unique credentials, rotation,
logging/audit evidence, image digests, npm/Electron/Gradle/OPA provenance,
patching, backup encryption, restore access, and prerequisites for an external
TLS reverse proxy. Clearly mark HA/Kubernetes as unsupported extension work.

- [ ] **Step 3: Write command reference and checklists**

Provide PowerShell and Bash command tables plus checklists for first deployment,
routine start/stop, inspection, backup, restore drill, upgrade, rollback,
credential rotation, incident handover, and decommissioning. Every destructive
command must be separated from routine commands and carry a confirmation block.

- [ ] **Step 4: Run the documentation contract to verify GREEN**

Run: `npm run test:deployment-docs`

Expected: all documentation tests pass with zero failures.

### Task 6: Repository and technical verification

**Files:**
- Verify: `Docs/Deployment/*.md`
- Verify: `scripts/deployment-docs.test.mjs`
- Verify: `package.json`

- [ ] **Step 1: Validate Compose source facts**

Run `docker compose --env-file infra/compose/.env -f infra/compose/compose.yml config --quiet`
with the operator-created external secret-path environment. Expected: exit code 0.

- [ ] **Step 2: Run documentation and infrastructure contracts**

Run:

```powershell
npm run test:deployment-docs
$env:OPA_PATH = 'C:\Users\30367\AppData\Local\Temp\opencode\opa-1.5.1.exe'
npm run test:infra
```

Expected: all documentation and infrastructure tests pass; OPA has zero skips.

- [ ] **Step 3: Check links, paths, and sensitive examples**

Use the documentation contract plus targeted repository searches to confirm
every relative link/path exists, all code fences identify PowerShell/Bash/text,
no actual external secret path or value appears, and no temporary artifacts are
tracked.

- [ ] **Step 4: Request independent reviews**

Request one specification reviewer and one operations/security reviewer. Fix
all Critical and Important findings and re-run the affected checks.

- [ ] **Step 5: Run repository hygiene checks**

Run:

```powershell
git -c safe.directory=D:/Repositories/ComplexProjects/InnorderOCC diff --check
git -c safe.directory=D:/Repositories/ComplexProjects/InnorderOCC status --short --branch
```

Expected: no whitespace errors and only the approved specification, plan,
manual, documentation test, and package script changes are present.

Do not create a Git commit unless the user explicitly requests one.
