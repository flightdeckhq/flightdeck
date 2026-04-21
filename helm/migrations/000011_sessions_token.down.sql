-- Exact inverse of 000011_sessions_token.up.sql.

DROP INDEX IF EXISTS sessions_token_id_idx;

ALTER TABLE sessions
    DROP COLUMN IF EXISTS token_id,
    DROP COLUMN IF EXISTS token_name;
