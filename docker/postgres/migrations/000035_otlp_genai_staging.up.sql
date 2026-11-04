-- OTLP GenAI staging. OpenTelemetry GenAI frameworks export a span when
-- it ends, so an agent's span arrives after its model calls and tools,
-- and one run's spans can reach different ingestion replicas in several
-- requests. Ingestion writes each span (and each Google ADK content log
-- record) here, keyed by the sending token, trace, span and kind, and an
-- assembler in every ingestion process maps a whole trace once it is
-- due. Ingestion owns these tables; no other service reads them.
--
-- otlp_span_content is the one table outside event_content that holds
-- captured content, and only transiently: a row is written only when the
-- exporter declares capture, and is deleted when its trace is assembled,
-- or by the backstop sweep once it is more than 24 hours and 30 seconds
-- old.

CREATE TABLE otlp_traces (
    token_key         TEXT NOT NULL,                 -- the sending access token's id; a trace belongs to its token
    trace_id          BYTEA NOT NULL CHECK (octet_length(trace_id) = 16),
    source            TEXT NOT NULL,                 -- framework label of the first record: pydantic_ai / strands / openai_agents / google_adk
    source_version    TEXT NOT NULL DEFAULT '',
    token_name        TEXT NOT NULL DEFAULT '',
    resource          JSONB NOT NULL,                -- allowlisted resource attributes only: service.name / service.version, host.name,
                                                     -- user.id / user.name, flightdeck.{flavor, agent_type, billing_mode, capture_prompts};
                                                     -- of the resource that created the row, never updated
    capture           BOOLEAN NOT NULL,              -- AND over every contributing resource: off wins
    first_received_at TIMESTAMPTZ NOT NULL,
    last_received_at  TIMESTAMPTZ NOT NULL,
    root_seen_at      TIMESTAMPTZ,
    resolve_at        TIMESTAMPTZ NOT NULL,          -- when the trace is next due
    pending           BOOLEAN NOT NULL DEFAULT TRUE, -- has (or may have) records not yet assembled
    gen               BIGINT NOT NULL DEFAULT 0,     -- bumped by every write that staged a new record
    lease_owner       TEXT,
    lease_expires     TIMESTAMPTZ,
    assembled_at      TIMESTAMPTZ,
    assembly_count    INTEGER NOT NULL DEFAULT 0,
    assembly_reason   TEXT,                          -- complete / adk_log_timeout / quiet / max_hold
    span_count        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (token_key, trace_id)
);

-- The assembler's due-trace claim reads pending traces by resolve_at;
-- the retention sweep reads finished ones by assembled_at.
CREATE INDEX otlp_traces_due_idx       ON otlp_traces (resolve_at)   WHERE pending;
CREATE INDEX otlp_traces_retention_idx ON otlp_traces (assembled_at) WHERE NOT pending;

CREATE TABLE otlp_spans (                            -- spans (kind 1) and ADK log records (kind 2)
    token_key      TEXT NOT NULL,
    trace_id       BYTEA NOT NULL,
    span_id        BYTEA NOT NULL,
    kind           SMALLINT NOT NULL CHECK (kind IN (1, 2)),
    parent_span_id BYTEA,
    remote_parent  BOOLEAN NOT NULL DEFAULT FALSE,
    scope_name     TEXT NOT NULL,
    scope_version  TEXT NOT NULL DEFAULT '',
    name           TEXT NOT NULL,
    op             TEXT NOT NULL DEFAULT '',         -- gen_ai.operation.name
    agent_name     TEXT NOT NULL DEFAULT '',
    start_ns       BIGINT NOT NULL,
    end_ns         BIGINT NOT NULL,
    status         SMALLINT NOT NULL,
    meta           JSONB NOT NULL,                   -- the content-free allowlisted attributes
    assembled      BOOLEAN NOT NULL DEFAULT FALSE,
    received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (token_key, trace_id, span_id, kind),
    FOREIGN KEY (token_key, trace_id) REFERENCES otlp_traces ON DELETE CASCADE
);

-- The records of a trace not yet assembled.
CREATE INDEX otlp_spans_unassembled_idx ON otlp_spans (token_key, trace_id) WHERE NOT assembled;

CREATE TABLE otlp_span_content (                     -- written only when capture is declared
    token_key TEXT NOT NULL,
    trace_id  BYTEA NOT NULL,
    span_id   BYTEA NOT NULL,
    kind      SMALLINT NOT NULL,
    content   JSONB NOT NULL,
    staged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),    -- the backstop sweep's age is measured from it
    PRIMARY KEY (token_key, trace_id, span_id, kind),
    FOREIGN KEY (token_key, trace_id, span_id, kind) REFERENCES otlp_spans ON DELETE CASCADE
);

-- The content backstop sweep reads staged content by age.
CREATE INDEX otlp_span_content_staged_idx ON otlp_span_content (staged_at);
