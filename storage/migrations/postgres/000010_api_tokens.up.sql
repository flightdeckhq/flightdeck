-- D095: replace the minimal (token_hash, label, created_at) api_tokens
-- table seeded by init.sql with a full token-management schema:
--   id           primary key used as sessions.token_id FK target
--   name         human label shown in the Settings UI
--   token_hash   SHA256(salt || raw_token) -- hex
--   salt         per-token 16-byte random hex string
--   prefix       first 8 chars of the raw token, used to narrow the
--                lookup before the salted-hash comparison. 'tok_dev_'
--                for the dev seed row, 'ftd_xxxx' for real tokens.
--   created_at   row creation timestamp
--   last_used_at stamped by the auth middleware on every valid lookup
--
-- The previous schema only had (token_hash, label) and stored an
-- unsalted SHA256 of the raw token. See KI10 / DECISIONS.md D046.

DROP TABLE IF EXISTS api_tokens CASCADE;

CREATE TABLE api_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    salt         TEXT NOT NULL,
    prefix       TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

CREATE INDEX api_tokens_prefix_idx ON api_tokens (prefix);

-- Seed the dev token. Derivation (see DECISIONS.md D095):
--   salt       = 'd0d0cafed00dfaceb00bba5eba11f001'
--   raw_token  = 'tok_dev'
--   token_hash = SHA256(salt || raw_token)
--              = SHA256('d0d0cafed00dfaceb00bba5eba11f001tok_dev')
--              = 0c805243ecd4f6f59bec56235a1901d97ad8cf0771020f2d44da428827f1145e
--   prefix     = 'tok_dev_' (literal 8-char fallback; the middleware
--                short-circuits on raw_token=="tok_dev" before the
--                prefix lookup, so the stored prefix only needs to be
--                stable and unique within the table)
--
-- Production deployments must create real ftd_ tokens via the Settings
-- UI; the auth middleware rejects raw_token=="tok_dev" unless the
-- ingestion/API service was started with ENVIRONMENT=dev.
INSERT INTO api_tokens (name, token_hash, salt, prefix)
VALUES (
    'Development Token',
    '0c805243ecd4f6f59bec56235a1901d97ad8cf0771020f2d44da428827f1145e',
    'd0d0cafed00dfaceb00bba5eba11f001',
    'tok_dev_'
);
