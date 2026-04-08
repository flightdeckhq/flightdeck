-- Seed data only. Schema is managed by golang-migrate in migrations/.
-- This file runs on first container start via Postgres docker-entrypoint-initdb.d.
-- It runs BEFORE workers apply migrations, so api_tokens must be created here
-- for the seed INSERT to succeed. Migration 000001 uses IF NOT EXISTS for this table.

CREATE TABLE IF NOT EXISTS api_tokens (
    token_hash  TEXT PRIMARY KEY,
    label       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed dev token: tok_dev
-- SHA-256 of 'tok_dev' precomputed for deterministic init.
INSERT INTO api_tokens (token_hash, label)
VALUES (encode(sha256('tok_dev'::bytea), 'hex'), 'development')
ON CONFLICT (token_hash) DO NOTHING;
