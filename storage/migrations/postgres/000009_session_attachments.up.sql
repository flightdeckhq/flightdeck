-- Replace the single last_attached_at column on sessions with a
-- dedicated session_attachments table. The column only preserved the
-- most recent attachment timestamp, which threw away the full history
-- of how often an orchestrator-driven agent re-attached to the same
-- session_id. A separate row-per-attach table lets the dashboard draw
-- a run separator for every execution boundary, not just the last one.
-- See DECISIONS.md D094.

DROP INDEX IF EXISTS sessions_last_attached_idx;

ALTER TABLE sessions
    DROP COLUMN IF EXISTS last_attached_at;

CREATE TABLE IF NOT EXISTS session_attachments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    attached_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS session_attachments_session_idx
    ON session_attachments(session_id, attached_at);
