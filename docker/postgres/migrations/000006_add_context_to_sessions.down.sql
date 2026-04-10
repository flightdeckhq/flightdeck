DROP INDEX IF EXISTS sessions_context_gin;

ALTER TABLE sessions
    DROP COLUMN IF EXISTS context;
