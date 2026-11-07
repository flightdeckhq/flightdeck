ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS context JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS sessions_context_gin
    ON sessions
    USING GIN (context);
