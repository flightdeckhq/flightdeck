-- D142: drop the per-PUT version snapshot table and the version
-- column on ``mcp_policies``. v0.6 step 6.8 cleanup retires the
-- version-history feature; the audit log is the durable
-- modification trail. No code reads either after the cleanup, so
-- leaving them in the schema would be cruft (no-compat-tax memory).
--
-- Order matters: drop the table first because nothing references
-- it; then drop the column. ``DROP TABLE IF EXISTS`` and
-- ``DROP COLUMN IF EXISTS`` make this safe to apply against any
-- environment that has already had the prior schema state.
--
-- Reintroduction (if user demand surfaces, see README Roadmap)
-- ships as a new numbered migration that re-adds both, plus the
-- API handlers / dashboard panels that read them.

DROP TABLE IF EXISTS mcp_policy_versions;

ALTER TABLE mcp_policies DROP COLUMN IF EXISTS version;
