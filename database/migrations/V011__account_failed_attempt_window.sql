ALTER TABLE iam.user_account
    ADD COLUMN failed_window_started_at timestamptz;

UPDATE iam.user_account
SET failed_attempts = greatest(failed_attempts, 5),
    failed_window_started_at = locked_until - interval '15 minutes'
WHERE locked_until IS NOT NULL;

UPDATE iam.user_account
SET failed_window_started_at = statement_timestamp()
WHERE failed_attempts > 0
  AND failed_window_started_at IS NULL;

ALTER TABLE iam.user_account
    ADD CONSTRAINT ck_user_account_failed_window_count
        CHECK ((failed_attempts = 0) = (failed_window_started_at IS NULL)),
    ADD CONSTRAINT ck_user_account_failed_window_lock
        CHECK (locked_until IS NULL OR (
            failed_window_started_at IS NOT NULL
            AND locked_until >= failed_window_started_at
        ));

GRANT SELECT (failed_window_started_at), UPDATE (failed_window_started_at)
ON iam.user_account TO innorder_runtime;
