-- Inverse of 000019_mcp_protection_policy_seed_global.up.sql.
-- Removes the seeded global policy row. ON DELETE CASCADE on
-- mcp_policy_entries / mcp_policy_versions clears any rows that
-- were attached to it; mcp_policy_audit_log uses ON DELETE SET
-- NULL so audit trail survives.

DELETE FROM mcp_policies WHERE scope = 'global';
