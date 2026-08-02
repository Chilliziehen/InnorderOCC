# Evidence Workflow Integration

Task 5 does not call Flowable or mutate process/task internals. Evidence commands persist
`occ.evidence_workflow_intent` in the same kernel transaction as the evidence head, immutable
version/review, audit record, domain outbox event, and notification intent.

The delivery adapter is a separate component. It must claim `PENDING` or retryable `FAILED`
rows with a bounded lease, invoke the workflow engine after the evidence transaction commits,
and mark the intent `DELIVERED` only after the engine acknowledges the correlation. It must not
infer review semantics from the evidence head. The stable intent carries the exact review
outcome, aggregate gate result, follow-up requirement and due time, prior assignee, evidence
version, and correlation ID.

Delivery is at-least-once. Adapters must deduplicate on `event_id`; notification consumers must
deduplicate on `(event_id, recipient_selector)`. A delivery failure must never roll back or
rewrite immutable evidence history.

Production content inspection requires `EVIDENCE_DOCKER_EXECUTABLE`,
`EVIDENCE_PARSER_IMAGE`, and `EVIDENCE_SCANNER_IMAGE`. Both images must be digest-pinned and
implement the separately tested parser/scanner protocols. The configured process adapters run
with no network, a read-only filesystem, dropped capabilities, bounded memory/PIDs/tmpfs, and a
deadline.
