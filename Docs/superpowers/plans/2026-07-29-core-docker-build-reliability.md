# Core Docker Build Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make interrupted Core Docker cold builds retain verified Gradle downloads without weakening reproducibility or supply-chain checks.

**Architecture:** Keep the existing digest-pinned Temurin builder and Gradle wrapper. Add a locked BuildKit cache mount to the existing `bootJar` step so `/root/.gradle` persists across failed build attempts while remaining outside the runtime image.

**Tech Stack:** Docker BuildKit, Gradle Wrapper 8.14.3, Node test runner, dockerfile-ast, Docker Compose.

---

### Task 1: Persist the Core Gradle build cache

**Files:**
- Modify: `infra/compose/compose.contract.test.mjs`
- Modify: `services/core/Dockerfile`

- [ ] **Step 1: Write the failing Dockerfile contract**

Add this assertion beside the existing Core Dockerfile runtime assertions in
`infra/compose/compose.contract.test.mjs`:

```js
assert.match(read("services/core/Dockerfile"), /RUN --mount=type=cache,target=\/root\/\.gradle,sharing=locked chmod \+x gradlew/u);
```

- [ ] **Step 2: Run the contract to verify RED**

Run:

```powershell
$env:OPA_PATH='C:\Users\30367\AppData\Local\Temp\opencode\opa-1.5.1.exe'
npm run test:infra
```

Expected: the Dockerfile AST test fails because the Core `RUN` starts with
`RUN chmod +x gradlew` and has no cache mount. All unrelated tests pass.

- [ ] **Step 3: Add the minimal cache mount**

Change the Core build step in `services/core/Dockerfile` to:

```dockerfile
RUN --mount=type=cache,target=/root/.gradle,sharing=locked chmod +x gradlew \
    && ./gradlew :services:core:bootJar --no-daemon \
    && find services/core/build/libs -maxdepth 1 -name 'core-*.jar' ! -name '*-plain.jar' -exec cp {} /workspace/app.jar \;
```

Do not change the builder image, Gradle command, dependency verification, or
runtime stage.

- [ ] **Step 4: Run the contract to verify GREEN**

Run:

```powershell
$env:OPA_PATH='C:\Users\30367\AppData\Local\Temp\opencode\opa-1.5.1.exe'
npm run test:infra
```

Expected: 12 tests pass with zero failures and zero skips.

### Task 2: Prefer Maven Central for Gradle plugins

**Files:**
- Modify: `scripts/dependency-provenance.test.mjs`
- Modify: `settings.gradle.kts`

- [ ] **Step 1: Write the failing repository-order contract**

Read the `pluginManagement` section of `settings.gradle.kts` and assert that
`mavenCentral()` occurs before `gradlePluginPortal()`.

- [ ] **Step 2: Run `npm run test:provenance` and verify RED**

Expected: the Gradle repository-order test fails while the npm provenance tests
pass.

- [ ] **Step 3: Put Maven Central before the Plugin Portal**

Keep both official repositories. Use Maven Central for published plugin markers
and dependencies, then fall back to the Plugin Portal for markers such as
Foojay that are absent from Central.

- [ ] **Step 4: Run `npm run test:provenance` and verify GREEN**

Expected: all provenance tests pass.

### Task 3: Verify the cold-build behavior and repository

**Files:**
- Verify: `services/core/Dockerfile`
- Verify: `infra/compose/compose.contract.test.mjs`
- Verify: all modified and untracked repository files

- [ ] **Step 1: Build the Core image through Compose**

Run:

```powershell
$env:PATH='C:\Program Files\Docker\Docker\resources\bin;' + $env:PATH
docker compose --env-file 'C:\Users\30367\AppData\Local\Temp\opencode\occ-compose\compose.env' -f infra/compose/compose.yml build core
```

Expected: `innorder-occ-core` builds successfully. If an external DNS or TLS
request fails, retain the cache and repeat the identical command only after an
exact endpoint probe succeeds; do not weaken TLS or Gradle verification.

- [ ] **Step 2: Run strict full verification**

Run:

```powershell
$env:PATH='C:\Program Files\Docker\Docker\resources\bin;' + $env:PATH
$env:OPA_PATH='C:\Users\30367\AppData\Local\Temp\opencode\opa-1.5.1.exe'
npm run verify:full
```

Expected: the final line is `[verify] full verification passed`.

- [ ] **Step 3: Inspect repository hygiene**

Run:

```powershell
git -c safe.directory=D:/Repositories/ComplexProjects/InnorderOCC diff --check
git -c safe.directory=D:/Repositories/ComplexProjects/InnorderOCC status --short --branch
git -c safe.directory=D:/Repositories/ComplexProjects/InnorderOCC diff --stat
```

Expected: no whitespace errors, no temporary Compose secret files, and only
intended source, test, documentation, and Gradle verification files are listed.

Do not create a Git commit unless the user explicitly requests one.
