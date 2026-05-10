-- Inverse of 000020_drop_mcp_policy_versions.up.sql. Recreates the
-- schema state that existed pre-D142 — version column on
-- ``mcp_policies`` plus the ``mcp_policy_versions`` table — so a
-- ``migrate down`` from 20 → 19 leaves the schema as 000018
-- originally created it.
--
-- Snapshot data that existed before the up-migration is gone;
-- this rollback recreates the empty schema only. Operators who
-- need historical snapshot data restore from backup.

ALTER TABLE mcp_policies ADD COLUMN version INT NOT NULL DEFAULT 1;

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
