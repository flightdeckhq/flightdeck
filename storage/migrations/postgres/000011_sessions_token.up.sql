-- D095: every session row is now attributed to the token that
-- authenticated its session_start event. token_id is the FK to the
-- api_tokens row; token_name is denormalized so dashboards / session
-- detail responses can render the label without a JOIN and without
-- losing the name when a token is later revoked (ON DELETE SET NULL
-- clears the FK but preserves token_name for historical sessions).

ALTER TABLE sessions
    ADD COLUMN token_id UUID
        REFERENCES api_tokens(id) ON DELETE SET NULL,
    ADD COLUMN token_name TEXT;

-- Backfill existing sessions onto the Development Token seeded by
-- migration 000010. Running systems before Phase 5 only had the
-- hardcoded tok_dev so this is the correct attribution; production
-- rollouts that created ftd_ tokens before running this migration
-- would need a targeted UPDATE, but no such rollout exists yet
-- (Phase 5 is the feature that introduces ftd_ tokens).
UPDATE sessions s
SET token_id = t.id,
    token_name = t.name
FROM api_tokens t
WHERE t.name = 'Development Token';

CREATE INDEX sessions_token_id_idx ON sessions(token_id);
