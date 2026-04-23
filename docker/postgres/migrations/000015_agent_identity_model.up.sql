-- v0.4.0 Phase 1: agent identity model foundation (D115).
--
-- Replaces the legacy flavor-keyed ``agents`` table with an agent_id-
-- keyed table that encodes the full identity grammar:
--
--   agent_id = uuid5(NAMESPACE_FLIGHTDECK,
--       "flightdeck://{agent_type}/{user}@{hostname}/{client_type}/{agent_name}")
--
-- Columns carry the components so the backend can filter / group
-- without re-parsing the UUID.
--
-- DESTRUCTIVE. Drops the existing agents table and truncates sessions.
-- The repository has no published users and the dev DB is transient;
-- a one-shot wipe is cheaper than a bespoke backfill that would need
-- to invent agent identities for rows that predate the model. See the
-- Phase 1 brief's Flag 2 resolution and D115.
--
-- CHECK constraints enforce the D114 vocabulary at the schema layer
-- so a misbehaving third-party emitter cannot write rows the dashboard
-- would then have to filter or defend against.

BEGIN;

-- Sessions reference agents(flavor) today; drop the FK before the
-- cascading agents table drop so the error path is explicit.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_flavor_fkey;

-- Legacy agents table: flavor TEXT PK, agent_type, first_seen, last_seen,
-- session_count, policy_id. Gone. The policy_id linkage moves to the new
-- agents table (carried forward in the column list below).
DROP TABLE IF EXISTS agents CASCADE;

CREATE TABLE agents (
    agent_id        UUID PRIMARY KEY,
    agent_type      TEXT NOT NULL
        CHECK (agent_type IN ('coding', 'production')),
    client_type     TEXT NOT NULL
        CHECK (client_type IN ('claude_code', 'flightdeck_sensor')),
    agent_name      TEXT NOT NULL,
    user_name       TEXT NOT NULL,
    hostname        TEXT NOT NULL,
    policy_id       UUID REFERENCES token_policies(id),
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total_sessions  INTEGER NOT NULL DEFAULT 0,
    total_tokens    BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_agents_last_seen_at ON agents(last_seen_at DESC);
CREATE INDEX idx_agents_client_type ON agents(client_type);
CREATE INDEX idx_agents_agent_type ON agents(agent_type);

-- Sessions need to pick up the new foreign key plus the denormalized
-- client_type / agent_name columns the dashboard reads without a
-- join. TRUNCATE first so the NOT NULL invariants don't trip on
-- pre-existing rows. CASCADE because events / event_content /
-- session_attachments have FKs onto sessions(session_id).
TRUNCATE sessions CASCADE;

ALTER TABLE sessions
    ADD COLUMN agent_id    UUID REFERENCES agents(agent_id),
    ADD COLUMN client_type TEXT
        CHECK (client_type IN ('claude_code', 'flightdeck_sensor')),
    ADD COLUMN agent_name  TEXT;

CREATE INDEX idx_sessions_agent_id ON sessions(agent_id);

COMMIT;
