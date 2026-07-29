# OCC Software Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable monorepo foundation containing the desktop client, deterministic Core service, AI service, shared contracts, OPA baseline, and private-deployment configuration.

**Architecture:** npm workspaces own TypeScript applications and contracts, while a root Gradle build owns the Kotlin Core module. Each runtime exposes a small versioned system-status boundary and has isolated tests. Infrastructure files wire approved dependencies without coupling application builds to Docker availability.

**Tech Stack:** Electron Forge, React 19, Ant Design, TypeScript, Fastify 5, LangChain, Zod, Kotlin, Spring Boot 3, Flowable 7, Gradle, OPA/Rego, Docker Compose

---

### Task 1: Root Build and Shared Contracts

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.editorconfig`
- Modify: `.gitignore`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/system-status.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/system-status.test.ts`
- Create: `packages/contracts/openapi/occ-core.yaml`

- [x] Write a failing Vitest contract test that accepts `READY|DEGRADED|UNREACHABLE|CHECKING`, validates ISO timestamps, and rejects unknown fields.
- [x] Run `npm test -w @innorder/contracts`; expect failure because schemas are absent.
- [x] Implement Zod schemas and exported TypeScript types.
- [x] Add the OpenAPI `/api/v1/system/status` response matching the Zod wire shape.
- [x] Run contracts tests and `npm run build -w @innorder/contracts`; expect success.

### Task 2: AI Service

**Files:**
- Create: `services/ai/package.json`
- Create: `services/ai/tsconfig.json`
- Create: `services/ai/src/config.ts`
- Create: `services/ai/src/provider-registry.ts`
- Create: `services/ai/src/app.ts`
- Create: `services/ai/src/server.ts`
- Create: `services/ai/test/app.test.ts`

- [x] Write Fastify injection tests for `/health`, `/api/v1/system/status`, and `/api/v1/providers/capabilities`.
- [x] Run `npm test -w @innorder/ai-service`; expect missing implementation failure.
- [x] Implement environment validation, provider capability registry, structured responses, and correlation IDs.
- [x] Keep LangChain behind the provider registry; no Agent may mutate Core state.
- [x] Run AI tests and TypeScript build; expect success.

### Task 3: OCC Core

**Files:**
- Create: `settings.gradle.kts`
- Create: `build.gradle.kts`
- Create: `gradle.properties`
- Create: `services/core/build.gradle.kts`
- Create: `services/core/src/main/kotlin/com/innorder/occ/OccCoreApplication.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/system/SystemStatus.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/system/SystemStatusService.kt`
- Create: `services/core/src/main/kotlin/com/innorder/occ/system/SystemStatusController.kt`
- Create: `services/core/src/main/resources/application.yml`
- Create: `services/core/src/test/kotlin/com/innorder/occ/system/SystemStatusControllerTest.kt`

- [x] Write a standalone MockMvc test for the exact `/api/v1/system/status` JSON contract.
- [x] Run `gradle :services:core:test`; expect compilation failure before implementation.
- [x] Implement the Spring Boot application and deterministic status service.
- [x] Declare PostgreSQL, Flyway, Flowable, Kafka, Redis, Actuator, Security, and Testcontainers dependencies without requiring infrastructure for unit tests.
- [x] Generate the Gradle wrapper and run Core tests/build; expect success on Java 21 target.

### Task 4: Electron Desktop

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/forge.config.ts`
- Create: `apps/desktop/vite.main.config.ts`
- Create: `apps/desktop/vite.preload.config.ts`
- Create: `apps/desktop/vite.renderer.config.ts`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/preload.ts`
- Create: `apps/desktop/src/global.d.ts`
- Create: `apps/desktop/src/renderer/index.html`
- Create: `apps/desktop/src/renderer/main.tsx`
- Create: `apps/desktop/src/renderer/App.tsx`
- Create: `apps/desktop/src/renderer/status-client.ts`
- Create: `apps/desktop/src/renderer/styles.css`
- Create: `apps/desktop/test/App.test.tsx`
- Create: `apps/desktop/test/setup.ts`

- [x] Write renderer tests for fixed service rows, degraded rendering, and unreachable endpoints.
- [x] Run `npm test -w @innorder/desktop`; expect missing component failure.
- [x] Implement sandboxed Electron main/preload boundaries.
- [x] Implement a restrained operations workspace with navigation, system status, active workflow summary, intervention queue, and no marketing surface.
- [x] Run renderer tests, TypeScript checks, and Forge package; expect success.

### Task 5: OPA and Infrastructure

**Files:**
- Create: `policies/opa/platform/authz.rego`
- Create: `policies/opa/platform/authz_test.rego`
- Create: `infra/compose/compose.yml`
- Create: `infra/compose/.env.example`
- Create: `infra/compose/README.md`

- [x] Define OPA tests for default deny, explicit deny override, and matching allow.
- [x] Implement the platform policy without customer-specific roles.
- [x] Define PostgreSQL/pgvector, Kafka KRaft, Redis, MinIO, OPA, Core, and AI services with health checks and named volumes.
- [x] Ensure `.env.example` contains names but no real secrets.
- [x] Run `opa test policies/opa` when available; otherwise run static Rego contract checks.

### Task 6: Integration and Documentation

**Files:**
- Create: `README.md`
- Modify: `Docs/superpowers/specs/2026-07-28-software-foundation-design.md`

- [x] Install npm workspaces and produce `package-lock.json`.
- [x] Run `npm test`, `npm run build`, and `gradlew.bat :services:core:build`.
- [x] Run database static and PGlite smoke tests.
- [x] Document exact start commands, ports, boundaries, and current infrastructure prerequisites.
- [x] Run `git diff --check`, placeholder scans, and the official-registry dependency audit.
- [ ] Run an independent code review (no subagent/reviewer facility was available in this environment).

No Git commit, push, merge, or PR is created unless the user explicitly requests it.
