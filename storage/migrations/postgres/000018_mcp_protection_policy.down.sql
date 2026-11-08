-- Reverse 000018_mcp_protection_policy.
--
-- Drop in reverse dependency order so FKs unwind cleanly:
-- audit log → versions → entries → policies. Each table's
-- indexes are dropped implicitly with the table. ``IF EXISTS``
-- guards make the down idempotent if a partial up left things
-- half-applied.
--
-- No data migration on the way down. Any policy state captured
-- between up and down is lost (acceptable for a development
-- environment; production doesn't run downs).

DROP TABLE IF EXISTS mcp_policy_audit_log;

DROP TABLE IF EXISTS mcp_policy_versions;

DROP TABLE IF EXISTS mcp_policy_entries;

DROP TABLE IF EXISTS mcp_policies;
