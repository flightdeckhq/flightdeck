-- Down for 000015: reverse the agent identity model.
--
-- LOSSY by design. The UP migration drops the legacy flavor-keyed
-- agents table and truncates sessions; this DOWN restores the legacy
-- schema shape but not the data. A rollback is only sensible in a
-- disaster-recovery scenario where the whole v0.4.0 Phase 1 foundation
-- is being reverted.
--
-- Restores:
--   - The flavor-keyed agents table (schema per migration 000001).
--   - The sessions_flavor_fkey FK.
--   - Drops the new columns and indexes added on sessions.
--
-- Does NOT restore:
--   - Any rows that were in the legacy agents table.
--   - Any sessions rows (truncated on UP).
--   - The session_count / policy_id values that rode on legacy agents.

BEGIN;

DROP INDEX IF EXISTS idx_sessions_agent_id;

ALTER TABLE sessions
    DROP COLUMN IF EXISTS agent_id,
    DROP COLUMN IF EXISTS client_type,
    DROP COLUMN IF EXISTS agent_name;

DROP INDEX IF EXISTS idx_agents_last_seen_at;
DROP INDEX IF EXISTS idx_agents_client_type;
DROP INDEX IF EXISTS idx_agents_agent_type;
DROP TABLE IF EXISTS agents CASCADE;

-- Recreate the legacy agents table (verbatim from migration 000001).
CREATE TABLE agents (
    flavor          TEXT PRIMARY KEY,
    agent_type      TEXT NOT NULL DEFAULT 'autonomous',
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_count   INTEGER NOT NULL DEFAULT 0,
    policy_id       UUID REFERENCES token_policies(id)
);

ALTER TABLE sessions
    ADD CONSTRAINT sessions_flavor_fkey
    FOREIGN KEY (flavor) REFERENCES agents(flavor);

COMMIT;
