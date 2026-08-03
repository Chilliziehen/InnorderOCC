# Risk Quality Hardening Design

## Goal

Close four risk lifecycle gaps: preserve command-kernel authorization ordering for adjudication, expose stable client-safe risk errors, make due processing advance despite individual failures, and align adjudication linkage invariants across Kotlin and PostgreSQL.

## Adjudication Command Boundary

`RiskService.adjudicate` builds request bytes and an `AdjudicateRiskCommand` using only request-supplied identifiers. The descriptor uses `targetEntityId` as entity and `riskId ?: targetEntityId` as resource. No risk query, advisory lock, or cross-target check occurs before `CommandExecutor` idempotency acquisition and authorization.

After authorization, `lockCurrentVersion` takes the adjudication advisory transaction lock, locks a linked risk when present, rejects a cross-target link, and locks the latest adjudication version. Unauthorized callers receive no risk existence or target-match oracle.

## API Problems

Risk failures use bounded RFC 9457 responses with static details:

- `RiskNotFoundException`: `404`, `risk-not-found`, `OCC-RISK-NOT-FOUND`.
- `TerminalRiskException`: `409`, `risk-terminal`, `OCC-RISK-TERMINAL`.
- `InvalidRiskActionException`: `400`, `invalid-risk-action`, `OCC-RISK-ACTION`.
- `InvalidRiskRequestException`: `400`, `invalid-risk-request`, `OCC-RISK-REQUEST`.

Public risk request/date/argument checks throw explicit risk exceptions rather than `IllegalArgumentException`. Malformed JSON and constructor failures remain bounded by the existing malformed-request handler.

## Due Batch Isolation

Due selection remains deterministic and bounded. Each selected risk is passed independently to `CommandExecutor`, which owns its transaction. Per-item authorization, malformed data, conflict, or domain failures are logged without aborting later candidates. Selection scans up to the operational maximum of 100 candidates and stops after the configured number of successful commands, so an early denied item cannot starve later work even when batch size is one. Deterministic idempotency keys preserve concurrent duplicate safety.

## Adjudication Linkage

The four outcomes form two exact groups:

- `TRUE_POSITIVE`, `FALSE_POSITIVE`: `riskId` is required.
- `MISSED`, `NOT_APPLICABLE`: `riskId` is forbidden.

`NOT_APPLICABLE` represents an unlinked event excluded from scope. V014 and `RiskAdjudicationRequest` enforce the same partition. Direct runtime-role DML tests verify all valid and invalid combinations without introducing a later migration.

## Verification

TDD covers pre-authorization adjudication access, stable API problems, invalid dates/arguments, batch-size-one mixed scheduler progress, direct DML constraints, and existing lifecycle behavior. Final verification uses forced real PostgreSQL integration tests, application context tests, infra contracts, and pinned OPA 1.5.1 strict/behavior tests.
