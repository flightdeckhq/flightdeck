-- Exact inverse of 000010_api_tokens.up.sql: drop the salted token
-- table and restore the minimal pre-D095 schema seeded by init.sql
-- (unsalted SHA256 of 'tok_dev').

DROP TABLE IF EXISTS api_tokens CASCADE;

CREATE TABLE api_tokens (
    token_hash  TEXT PRIMARY KEY,
    label       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO api_tokens (token_hash, label)
VALUES (encode(sha256('tok_dev'::bytea), 'hex'), 'development')
ON CONFLICT (token_hash) DO NOTHING;
