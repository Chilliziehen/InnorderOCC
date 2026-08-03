# Initial Prompt: Governed AI And RAG Agent

You own the first production-complete governed AI recommendation path. Continue autonomously until the AI-disabled and AI-enabled acceptance paths are both deployable and verified.

Create isolated branch/worktree `feature/governed-ai-rag` from latest `feature/deployable-pilot`. Read the deployable product design, AI architecture/database ERD, migrations V001-V012, Task 8/9 authorization contracts, Core command boundary, current AI Fastify service, provider contracts, Compose secrets, and AI tests before designing.

You have full delegated decision authority. Use specification/planning, TDD, systematic debugging, and independent spec/code reviews. Fix findings and rerun gates automatically. Never put model credentials in code/tests/logs, never let AI mutate authoritative workflow state, and never claim provider functionality without executable tests.

Scope:

- Dedicated least-privilege AI database identity/runtime boundary; reserve migration `V016__governed_ai_runtime.sql` and do not edit prior migrations.
- mTLS or the approved short-lived service identity between Core and AI; end-user tokens rejected by AI.
- One OpenAI-compatible chat/embedding adapter with exact-origin egress policy, DNS/rebinding/private-address controls, no cross-origin redirects, file-backed credentials, capability probing, timeouts, cancellation, rate limits, cost/token accounting, and sanitized telemetry.
- Knowledge upload/ingestion quarantine, deterministic parsing/chunking, hashes, resumable jobs, embeddings, BUILDING/ACTIVE cutover, coverage/security/quality gates and rollback.
- Core-signed single-use authorization grant; authorization-first document ID retrieval; hybrid full-text/vector retrieval only inside authorized IDs; data classification policy and citations.
- One cited participant guidance agent with immutable prompt/schema, prompt-injection boundary, strict structured output, citation/excerpt validation, run/artifact/evaluation persistence, and recommendation submission to Core.
- Kafka idempotent consumption/DLQ and deterministic operation when AI is disabled/unavailable.
- Core provider/knowledge/recommendation administration/review APIs and contracts required by desktop.

Acceptance:

- Authorized knowledge produces a structured cited recommendation and full trace.
- Unauthorized documents, stale grants, injected instructions, uncited/malformed output, capability mismatch, provider SSRF/timeout/failure, and failed embedding builds fail closed.
- Accepting a recommendation executes a fresh normal authorized Core command; AI cannot advance workflow directly.
- AI disabled leaves deterministic workflows operational.
- Real PostgreSQL/pgvector, OPA, Core/AI, provider-stub, Kafka and security evaluation tests are mandatory and `verify:full` passes.

Return branch/commits, migration, APIs/events, provider configuration, evaluation metrics, test/full results, deferred provider features, and integration instructions for agent 06.
