-- SQLite baseline: the schema Postgres reaches after its migration
-- 000036, translated once. From here on every schema change lands as a
-- pair with the same version number under migrations/postgres and
-- migrations/sqlite; scripts/check-migration-pairs.sh enforces it and
-- the storage module's parity test asserts both backends expose the
-- same tables, columns, nullability and indexes.
--
-- Translation rules (ARCHITECTURE.md, Storage):
--   uuid         -> TEXT, canonical lower-case hyphenated form, with a
--                   CHECK (Postgres accepted upper case and other
--                   spellings; a store normalises before writing); the
--                   default builds a random version-4 UUID from
--                   randomblob()
--   timestamptz  -> TIMESTAMP, text in RFC 3339 UTC with milliseconds
--                   ("2026-11-07T12:34:56.789Z"); declared TIMESTAMP so
--                   the driver scans it as time.Time; a CHECK that the
--                   value round-trips through strftime in that layout
--                   ("IS", so NULL passes and '' or garbage does not)
--   jsonb        -> TEXT with a json_valid() CHECK; read with json_extract
--   boolean      -> BOOLEAN (0 / 1)
--   integer, bigint, smallint -> INTEGER
--   numeric      -> NUMERIC;  bytea -> BLOB;  date -> DATE
--   GIN index    -> none; the per-key expression indexes cover the facets
--   plpgsql trigger (token revocation NOTIFY) -> none; the store
--                   publishes on the storage Bus after commit
--   NOT VALID constraints -> ordinary constraints (an empty database has
--                   nothing to validate)
-- Every primary-key column is declared NOT NULL explicitly: SQLite lets
-- a non-INTEGER PRIMARY KEY hold NULL unless told otherwise, and the
-- Postgres schema never does.

CREATE TABLE token_policies (
    id              TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (id = lower(id) AND id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(id, '-', ''))), 0) = 16),
    scope           TEXT NOT NULL,
    scope_value     TEXT NOT NULL DEFAULT '',
    token_limit     INTEGER,
    warn_at_pct     INTEGER,
    degrade_at_pct  INTEGER,
    degrade_to      TEXT,
    block_at_pct    INTEGER,
    created_at      TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
    updated_at      TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
    CONSTRAINT token_policies_scope_scope_value_key UNIQUE (scope, scope_value)
);

CREATE INDEX idx_token_policies_scope ON token_policies (scope, scope_value);

CREATE TABLE access_tokens (
    id           TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (id = lower(id) AND id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(id, '-', ''))), 0) = 16),
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL,
    salt         TEXT NOT NULL,
    prefix       TEXT NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
    last_used_at TIMESTAMP CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', last_used_at) IS last_used_at),
    CONSTRAINT access_tokens_token_hash_key UNIQUE (token_hash)
);

CREATE INDEX access_tokens_prefix_idx ON access_tokens (prefix);

-- The development token, with the same derivation as the Postgres seed
-- in migration 000010:
--   salt       = 'd0d0cafed00dfaceb00bba5eba11f001'
--   raw_token  = 'tok_dev'
--   token_hash = SHA256(salt || raw_token)
--   prefix     = 'tok_dev_' (the validator short-circuits on the raw
--                token before any prefix lookup)
-- The validator accepts it only when ENVIRONMENT=dev.
INSERT INTO access_tokens (name, token_hash, salt, prefix)
VALUES (
    'Development Token',
    '0c805243ecd4f6f59bec56235a1901d97ad8cf0771020f2d44da428827f1145e',
    'd0d0cafed00dfaceb00bba5eba11f001',
    'tok_dev_'
);

CREATE TABLE agents (
    agent_id        TEXT NOT NULL PRIMARY KEY CHECK (agent_id = lower(agent_id) AND agent_id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(agent_id, '-', ''))), 0) = 16),
    agent_type      TEXT NOT NULL,
    client_type     TEXT NOT NULL,
    agent_name      TEXT NOT NULL,
    user_name       TEXT NOT NULL,
    hostname        TEXT NOT NULL,
    policy_id       TEXT REFERENCES token_policies(id) CHECK (policy_id IS NULL OR (policy_id = lower(policy_id) AND policy_id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(policy_id, '-', ''))), 0) = 16)),
    first_seen_at   TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', first_seen_at) IS first_seen_at),
    last_seen_at    TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at) IS last_seen_at),
    total_sessions  INTEGER NOT NULL DEFAULT 0,
    total_tokens    INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT agents_agent_type_check CHECK (agent_type IN ('coding', 'production')),
    CONSTRAINT agents_client_type_check CHECK (client_type IN ('claude_code', 'flightdeck_sensor', 'claude_agent_sdk', 'codex', 'copilot', 'opencode', 'gemini_cli', 'cursor', 'otlp'))
);

CREATE INDEX idx_agents_last_seen_at ON agents (last_seen_at DESC);
CREATE INDEX idx_agents_client_type ON agents (client_type);
CREATE INDEX idx_agents_agent_type ON agents (agent_type);

CREATE TABLE sessions (
    session_id        TEXT NOT NULL PRIMARY KEY CHECK (session_id = lower(session_id) AND session_id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(session_id, '-', ''))), 0) = 16),
    flavor            TEXT NOT NULL,
    agent_type        TEXT NOT NULL,
    host              TEXT,
    framework         TEXT,
    model             TEXT,
    state             TEXT NOT NULL DEFAULT 'active',
    started_at        TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS started_at),
    last_seen_at      TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at) IS last_seen_at),
    ended_at          TIMESTAMP CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', ended_at) IS ended_at),
    tokens_used       INTEGER NOT NULL DEFAULT 0,
    token_limit       INTEGER,
    metadata          TEXT,
    context           TEXT DEFAULT '{}',
    token_id          TEXT REFERENCES access_tokens(id) ON DELETE SET NULL CHECK (token_id IS NULL OR (token_id = lower(token_id) AND token_id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(token_id, '-', ''))), 0) = 16)),
    token_name        TEXT,
    agent_id          TEXT REFERENCES agents(agent_id) CHECK (agent_id IS NULL OR (agent_id = lower(agent_id) AND agent_id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(agent_id, '-', ''))), 0) = 16)),
    client_type       TEXT,
    agent_name        TEXT,
    parent_session_id TEXT REFERENCES sessions(session_id) CHECK (parent_session_id IS NULL OR (parent_session_id = lower(parent_session_id) AND parent_session_id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(parent_session_id, '-', ''))), 0) = 16)),
    agent_role        TEXT,
    capture_prompts   BOOLEAN,
    start_seq         INTEGER,
    closed_seq        INTEGER,
    CONSTRAINT sessions_client_type_check CHECK (client_type IN ('claude_code', 'flightdeck_sensor', 'claude_agent_sdk', 'codex', 'copilot', 'opencode', 'gemini_cli', 'cursor', 'otlp')),
    CONSTRAINT sessions_metadata_json_check CHECK (json_valid(metadata)),
    CONSTRAINT sessions_context_json_check CHECK (json_valid(context))
);

CREATE INDEX idx_sessions_agent_id ON sessions (agent_id);
CREATE INDEX sessions_agent_id_started_at_desc_idx ON sessions (agent_id, started_at DESC);
CREATE INDEX sessions_active_by_agent_idx ON sessions (agent_id) WHERE state = 'active';
CREATE INDEX sessions_state_idx ON sessions (state);
CREATE INDEX sessions_last_seen_idx ON sessions (last_seen_at);
CREATE INDEX sessions_flavor_idx ON sessions (flavor);
CREATE INDEX sessions_started_idx ON sessions (started_at);
CREATE INDEX sessions_token_id_idx ON sessions (token_id);
CREATE INDEX sessions_parent_session_id_idx ON sessions (parent_session_id) WHERE parent_session_id IS NOT NULL;
CREATE INDEX sessions_context_os_idx ON sessions (json_extract(context, '$.os')) WHERE json_extract(context, '$.os') IS NOT NULL;
CREATE INDEX sessions_context_arch_idx ON sessions (json_extract(context, '$.arch')) WHERE json_extract(context, '$.arch') IS NOT NULL;
CREATE INDEX sessions_context_hostname_idx ON sessions (json_extract(context, '$.hostname')) WHERE json_extract(context, '$.hostname') IS NOT NULL;
CREATE INDEX sessions_context_user_idx ON sessions (json_extract(context, '$.user')) WHERE json_extract(context, '$.user') IS NOT NULL;
CREATE INDEX sessions_context_git_branch_idx ON sessions (json_extract(context, '$.git_branch')) WHERE json_extract(context, '$.git_branch') IS NOT NULL;
CREATE INDEX sessions_context_git_repo_idx ON sessions (json_extract(context, '$.git_repo')) WHERE json_extract(context, '$.git_repo') IS NOT NULL;
CREATE INDEX sessions_context_orchestration_idx ON sessions (json_extract(context, '$.orchestration')) WHERE json_extract(context, '$.orchestration') IS NOT NULL;
CREATE INDEX sessions_context_python_version_idx ON sessions (json_extract(context, '$.python_version')) WHERE json_extract(context, '$.python_version') IS NOT NULL;
CREATE INDEX sessions_context_process_name_idx ON sessions (json_extract(context, '$.process_name')) WHERE json_extract(context, '$.process_name') IS NOT NULL;

CREATE TABLE events (
    id                    TEXT NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (id = lower(id) AND id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(id, '-', ''))), 0) = 16),
    session_id            TEXT NOT NULL REFERENCES sessions(session_id) CHECK (session_id = lower(session_id) AND session_id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(session_id, '-', ''))), 0) = 16),
    flavor                TEXT NOT NULL,
    event_type            TEXT NOT NULL,
    model                 TEXT,
    tokens_input          INTEGER,
    tokens_output         INTEGER,
    tokens_total          INTEGER,
    latency_ms            INTEGER,
    tool_name             TEXT,
    has_content           BOOLEAN NOT NULL DEFAULT FALSE,
    payload               TEXT,
    occurred_at           TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
    source                TEXT,
    tokens_cache_read     INTEGER NOT NULL DEFAULT 0,
    tokens_cache_creation INTEGER NOT NULL DEFAULT 0,
    tokens_reasoning      INTEGER,
    provider              TEXT,
    billing_mode          TEXT,
    platform              TEXT,
    cost_reported         NUMERIC,
    cost_source           TEXT,
    model_requested       TEXT,
    model_served          TEXT,
    PRIMARY KEY (id, occurred_at),
    CONSTRAINT events_payload_json_check CHECK (json_valid(payload)),
    CONSTRAINT events_billing_mode_check CHECK (billing_mode IN ('metered', 'subscription', 'local')),
    CONSTRAINT events_provider_check CHECK (provider IN ('anthropic', 'openai', 'google', 'xai', 'mistral', 'meta', 'deepseek', 'other')),
    CONSTRAINT events_cost_source_check CHECK (cost_source IN ('provider', 'agent')),
    CONSTRAINT events_cost_reported_pair_check CHECK ((cost_reported IS NULL) = (cost_source IS NULL)),
    CONSTRAINT events_tokens_reasoning_check CHECK (tokens_reasoning >= 0)
);

CREATE INDEX events_session_idx ON events (session_id, occurred_at);
CREATE INDEX events_flavor_idx ON events (flavor, occurred_at);
CREATE INDEX events_type_idx ON events (event_type, occurred_at);
CREATE INDEX events_model_idx ON events (model) WHERE model IS NOT NULL;
CREATE INDEX events_model_backfill_idx ON events (occurred_at) WHERE model IS NOT NULL AND model_requested IS NULL;
CREATE INDEX events_payload_error_type_idx ON events (json_extract(payload, '$.error.error_type')) WHERE json_extract(payload, '$.error.error_type') IS NOT NULL;
CREATE INDEX events_payload_close_reason_idx ON events (json_extract(payload, '$.close_reason')) WHERE json_extract(payload, '$.close_reason') IS NOT NULL;
CREATE INDEX events_payload_estimated_via_idx ON events (json_extract(payload, '$.estimated_via')) WHERE json_extract(payload, '$.estimated_via') IS NOT NULL;
CREATE INDEX events_payload_matched_entry_idx ON events (json_extract(payload, '$.policy_decision.matched_entry_id')) WHERE json_extract(payload, '$.policy_decision.matched_entry_id') IS NOT NULL;
CREATE INDEX events_payload_orig_call_ctx_idx ON events (json_extract(payload, '$.originating_call_context')) WHERE json_extract(payload, '$.originating_call_context') IS NOT NULL;
CREATE INDEX events_payload_server_name_idx ON events (json_extract(payload, '$.server_name')) WHERE json_extract(payload, '$.server_name') IS NOT NULL;
CREATE INDEX events_payload_terminal_idx ON events (json_extract(payload, '$.terminal')) WHERE json_extract(payload, '$.terminal') IS NOT NULL;

CREATE TABLE event_content (
    event_id         TEXT NOT NULL PRIMARY KEY CHECK (event_id = lower(event_id) AND event_id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(event_id, '-', ''))), 0) = 16),
    session_id       TEXT NOT NULL REFERENCES sessions(session_id) CHECK (session_id = lower(session_id) AND session_id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(session_id, '-', ''))), 0) = 16),
    provider         TEXT NOT NULL,
    model            TEXT NOT NULL,
    system_prompt    TEXT,
    messages         TEXT,
    tools            TEXT,
    response         TEXT NOT NULL,
    captured_at      TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', captured_at) IS captured_at),
    input            TEXT,
    tool_input       TEXT,
    tool_output      TEXT,
    embedding_output TEXT,
    CONSTRAINT event_content_messages_json_check CHECK (json_valid(messages)),
    CONSTRAINT event_content_tools_json_check CHECK (json_valid(tools)),
    CONSTRAINT event_content_response_json_check CHECK (json_valid(response)),
    CONSTRAINT event_content_input_json_check CHECK (json_valid(input)),
    CONSTRAINT event_content_tool_input_json_check CHECK (json_valid(tool_input)),
    CONSTRAINT event_content_tool_output_json_check CHECK (json_valid(tool_output)),
    CONSTRAINT event_content_embedding_output_json_check CHECK (json_valid(embedding_output))
);

CREATE INDEX event_content_session_idx ON event_content (session_id);

CREATE TABLE directives (
    id              TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (id = lower(id) AND id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(id, '-', ''))), 0) = 16),
    session_id      TEXT CHECK (session_id IS NULL OR (session_id = lower(session_id) AND session_id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(session_id, '-', ''))), 0) = 16)),
    flavor          TEXT,
    action          TEXT NOT NULL,
    reason          TEXT,
    grace_period_ms INTEGER NOT NULL DEFAULT 5000,
    issued_by       TEXT NOT NULL DEFAULT 'platform',
    issued_at       TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) IS issued_at),
    delivered_at    TIMESTAMP CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', delivered_at) IS delivered_at),
    acknowledged_at TIMESTAMP CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', acknowledged_at) IS acknowledged_at),
    degrade_to      TEXT,
    payload         TEXT,
    CONSTRAINT directives_payload_json_check CHECK (json_valid(payload))
);

CREATE INDEX directives_session_pending_idx ON directives (session_id) WHERE delivered_at IS NULL;
CREATE INDEX directives_flavor_pending_idx ON directives (flavor) WHERE delivered_at IS NULL;

CREATE TABLE custom_directives (
    id            TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (id = lower(id) AND id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(id, '-', ''))), 0) = 16),
    fingerprint   TEXT NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT,
    flavor        TEXT NOT NULL,
    parameters    TEXT,
    registered_at TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', registered_at) IS registered_at),
    last_seen_at  TIMESTAMP DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at) IS last_seen_at),
    CONSTRAINT custom_directives_fingerprint_flavor_key UNIQUE (fingerprint, flavor),
    CONSTRAINT custom_directives_parameters_json_check CHECK (json_valid(parameters))
);

CREATE INDEX custom_directives_flavor_idx ON custom_directives (flavor);
CREATE INDEX custom_directives_fp_idx ON custom_directives (fingerprint);

CREATE TABLE session_attachments (
    id          TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (id = lower(id) AND id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(id, '-', ''))), 0) = 16),
    session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE CHECK (session_id = lower(session_id) AND session_id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(session_id, '-', ''))), 0) = 16),
    attached_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', attached_at) IS attached_at)
);

CREATE INDEX session_attachments_session_idx ON session_attachments (session_id, attached_at);

CREATE TABLE mcp_policies (
    id                   TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (id = lower(id) AND id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(id, '-', ''))), 0) = 16),
    scope                TEXT NOT NULL,
    scope_value          TEXT,
    mode                 TEXT,
    block_on_uncertainty BOOLEAN NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
    updated_at           TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
    CONSTRAINT mcp_policies_scope_check CHECK (scope IN ('global', 'flavor')),
    CONSTRAINT mcp_policies_mode_check CHECK (mode IN ('allowlist', 'blocklist')),
    CONSTRAINT mcp_policies_check CHECK ((scope = 'global' AND scope_value IS NULL AND mode IS NOT NULL)
        OR (scope = 'flavor' AND scope_value IS NOT NULL AND mode IS NULL))
);

CREATE UNIQUE INDEX mcp_policies_scope_idx ON mcp_policies (scope, COALESCE(scope_value, ''));

-- The global policy row every lookup assumes: blocklist mode, nothing
-- listed, as the Postgres seed in migration 000019.
INSERT INTO mcp_policies (scope, scope_value, mode, block_on_uncertainty)
VALUES ('global', NULL, 'blocklist', FALSE);

CREATE TABLE mcp_policy_entries (
    id                   TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (id = lower(id) AND id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(id, '-', ''))), 0) = 16),
    policy_id            TEXT NOT NULL REFERENCES mcp_policies(id) ON DELETE CASCADE CHECK (policy_id = lower(policy_id) AND policy_id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(policy_id, '-', ''))), 0) = 16),
    server_url_canonical TEXT NOT NULL,
    server_name          TEXT NOT NULL,
    fingerprint          TEXT NOT NULL,
    entry_kind           TEXT NOT NULL,
    enforcement          TEXT,
    created_at           TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
    CONSTRAINT mcp_policy_entries_entry_kind_check CHECK (entry_kind IN ('allow', 'deny')),
    CONSTRAINT mcp_policy_entries_enforcement_check CHECK (enforcement IN ('warn', 'block', 'interactive'))
);

CREATE UNIQUE INDEX mcp_policy_entries_policy_fp_idx ON mcp_policy_entries (policy_id, fingerprint);
CREATE INDEX mcp_policy_entries_url_idx ON mcp_policy_entries (server_url_canonical);

CREATE TABLE mcp_policy_audit_log (
    id          TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (id = lower(id) AND id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(id, '-', ''))), 0) = 16),
    policy_id   TEXT REFERENCES mcp_policies(id) ON DELETE SET NULL CHECK (policy_id IS NULL OR (policy_id = lower(policy_id) AND policy_id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(policy_id, '-', ''))), 0) = 16)),
    event_type  TEXT NOT NULL,
    actor       TEXT REFERENCES access_tokens(id) ON DELETE SET NULL CHECK (actor IS NULL OR (actor = lower(actor) AND actor GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(actor, '-', ''))), 0) = 16)),
    payload     TEXT NOT NULL DEFAULT '{}',
    occurred_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
    CONSTRAINT mcp_policy_audit_log_event_type_check CHECK (event_type IN (
        'policy_created', 'policy_updated', 'policy_deleted',
        'mode_changed', 'entry_added', 'entry_removed',
        'block_on_uncertainty_changed'
    )),
    CONSTRAINT mcp_policy_audit_log_payload_json_check CHECK (json_valid(payload))
);

CREATE INDEX mcp_policy_audit_log_policy_idx ON mcp_policy_audit_log (policy_id, occurred_at DESC);

CREATE TABLE model_pricing (
    model_id              TEXT NOT NULL,
    platform              TEXT NOT NULL,
    provider              TEXT NOT NULL,
    input                 NUMERIC NOT NULL,
    output                NUMERIC NOT NULL,
    cache_read            NUMERIC NOT NULL,
    cache_write_5m        NUMERIC NOT NULL,
    cache_write_1h        NUMERIC NOT NULL,
    reasoning             NUMERIC,
    tier_threshold_tokens INTEGER,
    tier_input            NUMERIC,
    tier_output           NUMERIC,
    tier_cache_read       NUMERIC,
    tier_cache_write_5m   NUMERIC,
    tier_cache_write_1h   NUMERIC,
    priority_multiplier   NUMERIC,
    source                TEXT NOT NULL,
    deprecated_on         DATE,
    fast_multiplier       NUMERIC,
    PRIMARY KEY (model_id, platform),
    CONSTRAINT model_pricing_source_check CHECK (source IN ('catalogue', 'override', 'alias'))
);

CREATE TABLE model_pricing_meta (
    id           BOOLEAN NOT NULL PRIMARY KEY DEFAULT TRUE,
    content_hash TEXT NOT NULL,
    loaded_at    TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', loaded_at) IS loaded_at),
    CONSTRAINT model_pricing_meta_id_check CHECK (id)
);

CREATE TABLE otlp_traces (
    token_key         TEXT NOT NULL,
    trace_id          BLOB NOT NULL,
    source            TEXT NOT NULL,
    source_version    TEXT NOT NULL DEFAULT '',
    token_name        TEXT NOT NULL DEFAULT '',
    resource          TEXT NOT NULL,
    capture           BOOLEAN NOT NULL,
    first_received_at TIMESTAMP NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', first_received_at) IS first_received_at),
    last_received_at  TIMESTAMP NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', last_received_at) IS last_received_at),
    root_seen_at      TIMESTAMP CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', root_seen_at) IS root_seen_at),
    resolve_at        TIMESTAMP NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', resolve_at) IS resolve_at),
    pending           BOOLEAN NOT NULL DEFAULT TRUE,
    gen               INTEGER NOT NULL DEFAULT 0,
    lease_owner       TEXT,
    lease_expires     TIMESTAMP CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires) IS lease_expires),
    assembled_at      TIMESTAMP CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', assembled_at) IS assembled_at),
    assembly_count    INTEGER NOT NULL DEFAULT 0,
    assembly_reason   TEXT,
    span_count        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (token_key, trace_id),
    CONSTRAINT otlp_traces_trace_id_check CHECK (length(trace_id) = 16),
    CONSTRAINT otlp_traces_resource_json_check CHECK (json_valid(resource))
);

CREATE INDEX otlp_traces_due_idx ON otlp_traces (resolve_at) WHERE pending;
CREATE INDEX otlp_traces_retention_idx ON otlp_traces (assembled_at) WHERE NOT pending;

CREATE TABLE otlp_spans (
    token_key      TEXT NOT NULL,
    trace_id       BLOB NOT NULL,
    span_id        BLOB NOT NULL,
    kind           INTEGER NOT NULL,
    parent_span_id BLOB,
    remote_parent  BOOLEAN NOT NULL DEFAULT FALSE,
    scope_name     TEXT NOT NULL,
    scope_version  TEXT NOT NULL DEFAULT '',
    name           TEXT NOT NULL,
    op             TEXT NOT NULL DEFAULT '',
    agent_name     TEXT NOT NULL DEFAULT '',
    start_ns       INTEGER NOT NULL,
    end_ns         INTEGER NOT NULL,
    status         INTEGER NOT NULL,
    meta           TEXT NOT NULL,
    assembled      BOOLEAN NOT NULL DEFAULT FALSE,
    received_at    TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', received_at) IS received_at),
    assembled_in   INTEGER,
    PRIMARY KEY (token_key, trace_id, span_id, kind),
    FOREIGN KEY (token_key, trace_id) REFERENCES otlp_traces (token_key, trace_id) ON DELETE CASCADE,
    CONSTRAINT otlp_spans_kind_check CHECK (kind IN (1, 2)),
    CONSTRAINT otlp_spans_meta_json_check CHECK (json_valid(meta)),
    CONSTRAINT otlp_spans_assembled_in_check CHECK (assembled = (assembled_in IS NOT NULL) AND (assembled_in IS NULL OR assembled_in >= 1))
);

CREATE INDEX otlp_spans_unassembled_idx ON otlp_spans (token_key, trace_id) WHERE NOT assembled;

CREATE TABLE otlp_span_content (
    token_key TEXT NOT NULL,
    trace_id  BLOB NOT NULL,
    span_id   BLOB NOT NULL,
    kind      INTEGER NOT NULL,
    content   TEXT NOT NULL,
    staged_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', staged_at) IS staged_at),
    PRIMARY KEY (token_key, trace_id, span_id, kind),
    FOREIGN KEY (token_key, trace_id, span_id, kind) REFERENCES otlp_spans (token_key, trace_id, span_id, kind) ON DELETE CASCADE,
    CONSTRAINT otlp_span_content_content_json_check CHECK (json_valid(content))
);

CREATE INDEX otlp_span_content_staged_idx ON otlp_span_content (staged_at);
