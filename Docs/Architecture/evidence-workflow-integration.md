# Evidence Workflow Integration

Evidence commands persist `occ.evidence_workflow_intent` and
`occ.evidence_notification_intent` in the same kernel transaction as the evidence head,
immutable version/review, audit record, and domain outbox event. The service then invokes every
bound workflow and notification port before that transaction commits. Adapter rejection rolls
the complete command back.

The workflow adapter must implement `Agent01TransactionalEvidenceWorkflowPort`, use Core's
datasource and transaction manager, obtain the prior assignee from its workflow snapshot, and
apply the review outcome in the caller transaction. The notification adapter must implement
`TransactionalDomainNotificationPort`. Neither adapter may infer review semantics from the
evidence head. The stable intent carries the exact review outcome, aggregate gate result,
follow-up requirement and due time, prior assignee, evidence version, and correlation ID.

Persisted intents remain the at-least-once reconciliation source. Adapters must deduplicate on
`event_id`; notification consumers must deduplicate on `(event_id, recipient_selector)`. A
synchronous adapter rejection rolls back the command. A later retry or reconciliation failure
must not rewrite immutable evidence history.

`occ.evidence.production-enabled=true` runs a startup verifier that requires both marker-typed
transactional bindings. Production Compose sets this flag. The agent01 branch is intentionally
not merged here, so wiring its concrete Flowable adapter and the production notification sink is
the explicit agent06 integration boundary; production startup fails until those bindings exist.

Production content inspection requires `EVIDENCE_DOCKER_EXECUTABLE`,
`EVIDENCE_PARSER_IMAGE`, and `EVIDENCE_SCANNER_IMAGE`. Both images must be digest-pinned and
implement the separately tested parser/scanner protocols. The configured process adapters run
with no network, a read-only filesystem, dropped capabilities, bounded memory/PIDs/tmpfs, and a
deadline.
