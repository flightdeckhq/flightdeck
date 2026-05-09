-- D150 down: exact inverse of 000021 up (Rule 34). Drop the two
-- columns added by the up migration. ``DROP COLUMN IF EXISTS``
-- guards against re-application against an environment that has
-- already had the rollback run.

ALTER TABLE event_content
    DROP COLUMN IF EXISTS tool_output,
    DROP COLUMN IF EXISTS tool_input;
