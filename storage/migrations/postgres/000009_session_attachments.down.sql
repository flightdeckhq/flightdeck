DROP INDEX IF EXISTS session_attachments_session_idx;

DROP TABLE IF EXISTS session_attachments;

ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS last_attached_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS sessions_last_attached_idx
    ON sessions(last_attached_at)
    WHERE last_attached_at IS NOT NULL;
