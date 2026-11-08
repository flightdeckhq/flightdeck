-- D128 MCP Protection Policy storage schema. Four tables:
--
-- ``mcp_policies``        : live state. One global row + zero or
--                           more per-flavor rows. Mode lives on
--                           global only (D134); the CHECK below
--                           enforces the scope-mode invariant at
--                           the storage layer so a misbehaving
--                           API caller cannot persist a flavor
--                           row with mode set.
-- ``mcp_policy_entries``  : live entries linked to a policy.
--                           server_url_canonical is the D127
--                           canonical form; fingerprint is the
--                           16-char display hash. The (policy_id,
--                           fingerprint) UNIQUE index is the per-
--                           policy resolution key.
-- ``mcp_policy_versions`` : append-only per-PUT snapshots for
--                           diff / rollback. Every PUT to an
--                           ``mcp_policies`` row bumps version
--                           and writes the resulting snapshot.
-- ``mcp_policy_audit_log``: operator-initiated mutations only —
--                           actor + diff. Sensor-observed system
--                           state (decision events, name drift)
--                           ships through the standard event
--                           pipeline as typed event rows, NOT
--                           audit-log entries (D131). The audit
--                           log answers "who changed this and
--                           when?"; the events query answers
--                           "what did the agent do and when?".
--
-- The schema in ARCHITECTURE.md "MCP Protection Policy" →
-- "Storage schema" is the binding contract; this migration
-- implements it byte-for-byte. Any deviation requires a new
-- DECISIONS.md entry per Rule 42 BEFORE the migration is
-- written.
--
-- No seed data here — Rule 34 requires init.sql to be seed-only
-- and migrations to be schema-only. The empty-blocklist global
-- policy auto-create on install lands in the API-layer step.
--
-- Soft-delete is intentionally NOT implemented (D128). A deleted
-- flavor policy means the global takes over; the live row is
-- gone. The audit log preserves the deletion event.

CREATE TABLE mcp_policies (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope                 TEXT NOT NULL CHECK (scope IN ('global', 'flavor')),
    scope_value           TEXT,
    mode                  TEXT CHECK (mode IN ('allowlist', 'blocklist')),
    block_on_uncertainty  BOOLEAN NOT NULL DEFAULT FALSE,
    version               INT NOT NULL DEFAULT 1,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((scope = 'global' AND scope_value IS NULL AND mode IS NOT NULL)
        OR (scope = 'flavor' AND scope_value IS NOT NULL AND mode IS NULL))
);

-- One global row + at most one row per flavor. COALESCE on
-- scope_value collapses the global's NULL into '' for the
-- uniqueness check so the (scope, scope_value) pair is always
-- comparable.
CREATE UNIQUE INDEX mcp_policies_scope_idx
    ON mcp_policies (scope, COALESCE(scope_value, ''));

CREATE TABLE mcp_policy_entries (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id             UUID NOT NULL REFERENCES mcp_policies(id) ON DELETE CASCADE,
    server_url_canonical  TEXT NOT NULL,
    server_name           TEXT NOT NULL,
    fingerprint           TEXT NOT NULL,
    entry_kind            TEXT NOT NULL CHECK (entry_kind IN ('allow', 'deny')),
    enforcement           TEXT CHECK (enforcement IN ('warn', 'block', 'interactive')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-policy uniqueness on fingerprint is the resolve-query key.
-- A given (URL, name) pair has at most one entry per policy; if
-- an operator wants to change an entry's decision they UPDATE,
-- they don't accumulate duplicate rows.
CREATE UNIQUE INDEX mcp_policy_entries_policy_fp_idx
    ON mcp_policy_entries (policy_id, fingerprint);

-- Secondary index on the canonical URL supports cross-policy
-- search ("which flavors have a rule for this server?") and the
-- mcp_server_name_changed event's URL-based lookup.
CREATE INDEX mcp_policy_entries_url_idx
    ON mcp_policy_entries (server_url_canonical);

CREATE TABLE mcp_policy_versions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id   UUID NOT NULL REFERENCES mcp_policies(id) ON DELETE CASCADE,
    version     INT NOT NULL,
    snapshot    JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by  UUID REFERENCES access_tokens(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX mcp_policy_versions_policy_version_idx
    ON mcp_policy_versions (policy_id, version);

CREATE TABLE mcp_policy_audit_log (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id    UUID REFERENCES mcp_policies(id) ON DELETE SET NULL,
    event_type   TEXT NOT NULL CHECK (event_type IN (
        'policy_created', 'policy_updated', 'policy_deleted',
        'mode_changed', 'entry_added', 'entry_removed',
        'block_on_uncertainty_changed'
    )),
    actor        UUID REFERENCES access_tokens(id) ON DELETE SET NULL,
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ON DELETE SET NULL on policy_id (not CASCADE) so the audit log
-- survives policy deletion. The deletion event itself is one of
-- the rows the operator wants to keep.
CREATE INDEX mcp_policy_audit_log_policy_idx
    ON mcp_policy_audit_log (policy_id, occurred_at DESC);
