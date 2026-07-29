\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.assert_true(condition boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF condition IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'assertion failed: %', message;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(statement text, expected_state text, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    BEGIN
        EXECUTE statement;
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = expected_state THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'assertion failed: %, expected SQLSTATE %, got % (%)',
            message, expected_state, SQLSTATE, SQLERRM;
    END;
    RAISE EXCEPTION 'assertion failed: %, statement did not raise', message;
END;
$$;
