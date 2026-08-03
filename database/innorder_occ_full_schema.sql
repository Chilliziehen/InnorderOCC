\set ON_ERROR_STOP on
\ir bootstrap/001-create-runtime-role.sql
\ir migrations/V001__bootstrap.sql
\ir migrations/V002__catalog.sql
\ir migrations/V003__identity_and_entities.sql
\ir migrations/V004__policy_control_plane.sql
\ir migrations/V005__occ_runtime.sql
\ir migrations/V006__audit_and_outbox.sql
\ir migrations/V007__ai_rag.sql
\ir migrations/V008__cross_schema_constraints.sql
\ir migrations/V009__runtime_privileges.sql
\ir migrations/V010__platform_security_kernel.sql
\ir migrations/V011__account_failed_attempt_window.sql
\ir migrations/V012__outbox_publisher_lifecycle.sql
\ir migrations/V013__process_task_workflow.sql
BEGIN;
\ir migrations/V014__evidence_risk_resource.sql
COMMIT;
\ir migrations/V015__cohort_api_lifecycle.sql
\ir migrations/V016__governed_ai_runtime.sql
\ir migrations/V017__risk_command_aggregates.sql
