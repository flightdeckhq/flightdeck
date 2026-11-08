DROP INDEX IF EXISTS sessions_last_attached_idx;

ALTER TABLE sessions
    DROP COLUMN IF EXISTS last_attached_at;
