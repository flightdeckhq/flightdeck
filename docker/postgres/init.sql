-- Flightdeck database schema
-- Applied once on first container start via Postgres docker-entrypoint-initdb.d

-- API tokens for sensor authentication
CREATE TABLE api_tokens (
    token_hash  TEXT PRIMARY KEY,
    label       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed dev token: tok_dev
-- SHA-256 of 'tok_dev' precomputed for deterministic init
INSERT INTO api_tokens (token_hash, label)
VALUES (encode(sha256('tok_dev'::bytea), 'hex'), 'development');

-- Agent flavors (persistent identity)
CREATE TABLE agents (
    flavor          TEXT PRIMARY KEY,
    agent_type      TEXT NOT NULL DEFAULT 'autonomous',
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_count   INTEGER NOT NULL DEFAULT 0,
    policy_id       UUID
);

-- Token policies (Phase 2: token enforcement)
-- scope values: 'org', 'flavor', 'session'
-- scope_value: '' for org, flavor name for flavor, session_id for session
CREATE TABLE IF NOT EXISTS token_policies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope           TEXT NOT NULL,
    scope_value     TEXT NOT NULL DEFAULT '',
    token_limit     BIGINT,
    warn_at_pct     INT,
    degrade_at_pct  INT,
    degrade_to      TEXT,
    block_at_pct    INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (scope, scope_value)
);

CREATE INDEX IF NOT EXISTS idx_token_policies_scope
    ON token_policies (scope, scope_value);

-- Add foreign key on agents now that token_policies table exists
ALTER TABLE agents
    ADD CONSTRAINT agents_policy_id_fk FOREIGN KEY (policy_id) REFERENCES token_policies(id);

-- Sessions (ephemeral identity)
CREATE TABLE sessions (
    session_id      UUID PRIMARY KEY,
    flavor          TEXT NOT NULL REFERENCES agents(flavor),
    agent_type      TEXT NOT NULL,
    host            TEXT,
    framework       TEXT,
    model           TEXT,
    state           TEXT NOT NULL DEFAULT 'active',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    tokens_used     INTEGER NOT NULL DEFAULT 0,
    token_limit     INTEGER,
    metadata        JSONB
);

CREATE INDEX sessions_flavor_idx    ON sessions(flavor);
CREATE INDEX sessions_state_idx     ON sessions(state);
CREATE INDEX sessions_last_seen_idx ON sessions(last_seen_at);
CREATE INDEX sessions_started_idx   ON sessions(started_at);

-- Events (metadata only -- no prompt content inline)
CREATE TABLE events (
    id              UUID DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES sessions(session_id),
    flavor          TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    model           TEXT,
    tokens_input    INTEGER,
    tokens_output   INTEGER,
    tokens_total    INTEGER,
    latency_ms      INTEGER,
    tool_name       TEXT,
    has_content     BOOLEAN NOT NULL DEFAULT FALSE,
    source          TEXT,               -- Phase 1 revision: "local" or "server" on policy_warn events, NULL otherwise
    payload         JSONB,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, occurred_at)
);

CREATE INDEX events_session_idx ON events(session_id, occurred_at);
CREATE INDEX events_flavor_idx  ON events(flavor, occurred_at);
CREATE INDEX events_type_idx    ON events(event_type, occurred_at);

-- Event content (prompt storage -- separate table, fetched on demand)
CREATE TABLE event_content (
    event_id        UUID NOT NULL,
    session_id      UUID NOT NULL REFERENCES sessions(session_id),
    provider        TEXT NOT NULL,
    model           TEXT NOT NULL,
    system_prompt   TEXT,
    messages        JSONB NOT NULL,
    tools           JSONB,
    response        JSONB NOT NULL,
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id)
);

CREATE INDEX event_content_session_idx ON event_content(session_id);

-- Directives (Phase 3 uses, but table exists for schema completeness)
CREATE TABLE directives (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID,
    flavor          TEXT,
    action          TEXT NOT NULL,
    reason          TEXT,
    degrade_to      TEXT,
    grace_period_ms INTEGER NOT NULL DEFAULT 5000,
    issued_by       TEXT NOT NULL DEFAULT 'platform',
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at    TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ
);

CREATE INDEX directives_session_pending_idx
    ON directives(session_id) WHERE delivered_at IS NULL;
CREATE INDEX directives_flavor_pending_idx
    ON directives(flavor) WHERE delivered_at IS NULL;
