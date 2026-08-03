# Guidance Result Recovery Design

## Goal

After provider output passes validation, preserve the canonical recommendation and exact provider accounting in at least one durable channel before returning or rethrowing. Replays must recover without a second provider call whenever either channel succeeded.

## Durable Channels

The primary channel is one PostgreSQL transaction that idempotently finalizes the model invocation and creates the `PREPARED` recommendation submission. This transaction runs before ordinary trace artifact upload.

The fallback channel is a deterministic canonical JSON recovery envelope stored through the existing SSE-AES256, one-year Governance Object-Locked artifact store. Its object key is derived from the run and operation, not a random identifier. It contains only the canonical validated submission payload, response hash, provider-request-id hash when present, exact token counts, cost, latency, classification, invocation identity, and deterministic ordinary artifact identity/hash. It excludes prompts, raw provider bodies, and unvalidated output.

## Flow

After validation, the runner constructs the canonical submission payload, ordinary trace artifact, accounting, and recovery envelope once. It first calls the atomic database prepare operation. If that succeeds, the runner uploads the ordinary artifact and persists its metadata. If either artifact step fails, replay loads the prepared submission and retries the same deterministic artifact before Core dispatch.

If database preparation fails, the runner writes and verifies the deterministic recovery envelope. Replay of a `RUNNING` run with no prepared submission probes the deterministic envelope, validates its key binding and content hash, invokes the same idempotent database prepare transaction, then retries the ordinary artifact and metadata. Core submission is permitted only after database preparation and ordinary artifact metadata persistence.

If both durable channels fail, the runner attempts the bounded idempotent invocation finalization path with the exact response hash, provider-request-id hash, token counts, cost, and timing. The run remains `RECONCILIATION_PENDING`; exact accounting is never replaced by zero or null values after provider completion.

## Object Store Semantics

The artifact store gains bounded verified reads and idempotent create semantics. A precondition conflict is accepted only after reading the retained object and proving its byte hash equals the expected deterministic hash. Recovery reads enforce size, checksum, encryption, Object Lock mode, retention, and expected content hash.

## Replay State

Prepared submissions include enough deterministic artifact metadata to finish the ordinary trace boundary. A replay probes PostgreSQL first. When no submission exists, it always attempts the deterministic recovery object before returning pending. Recovery import is idempotent and rejects any run, operation, invocation, payload, accounting, or artifact hash mismatch.

## Tests

Runner tests fail each boundary independently: ordinary artifact upload, artifact metadata persistence, database prepare, and invocation finalization. Each test restarts with replay and proves exact accounting, the same ordinary artifact, one authoritative Core recommendation, and no second provider call. A dual-channel failure test proves pending behavior and exact bounded accounting attempts. Repository, migration, static schema, and MinIO tests cover atomic preparation, deterministic envelope verification, encryption/Object Lock requirements, idempotent conflicts, and malformed or mismatched envelope rejection.
