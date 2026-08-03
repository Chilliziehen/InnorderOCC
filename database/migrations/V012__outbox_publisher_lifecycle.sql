ALTER TABLE audit.outbox_event
    DROP CONSTRAINT ck_outbox_claim_publish_time,
    DROP CONSTRAINT ck_outbox_lifecycle;

ALTER TABLE audit.outbox_event DISABLE TRIGGER trg_outbox_event_lifecycle;

UPDATE audit.outbox_event
SET claimed_at = NULL
WHERE status IN ('PUBLISHED', 'DEAD');

ALTER TABLE audit.outbox_event ENABLE TRIGGER trg_outbox_event_lifecycle;

ALTER TABLE audit.outbox_event
    ADD CONSTRAINT ck_outbox_claim_publish_time
        CHECK ((claimed_at IS NULL OR claimed_at >= created_at)
               AND (published_at IS NULL OR published_at >= created_at)),
    ADD CONSTRAINT ck_outbox_lifecycle
        CHECK (
            (status = 'PENDING' AND claimed_at IS NULL AND published_at IS NULL)
            OR (status = 'PUBLISHING' AND claimed_at IS NOT NULL AND published_at IS NULL)
            OR (status = 'PUBLISHED' AND claimed_at IS NULL AND published_at IS NOT NULL AND last_error IS NULL)
            OR (status = 'DEAD' AND claimed_at IS NULL AND published_at IS NULL AND last_error IS NOT NULL)
        );
