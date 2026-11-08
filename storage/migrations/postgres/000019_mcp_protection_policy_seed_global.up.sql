-- D133: seed the empty-blocklist global MCP policy at install time.
--
-- Migration 000018's header note deferred this row to "the API-layer
-- step" (the boot-time EnsureGlobalMCPPolicy hook). On a cold
-- ``make dev-reset`` postgres, api, and workers come up in parallel:
-- api runs EnsureGlobalMCPPolicy before workers has finished
-- applying 000018, the call fails with ``relation mcp_policies does
-- not exist``, and every subsequent ``GET /v1/mcp-policies/global``
-- 500s with ``global policy missing; restart API to auto-create``.
--
-- Seeding the row here closes the race: the migrator is the single
-- writer that owns schema state, and by the time api can SELECT the
-- table the row is guaranteed present. The boot-time
-- EnsureGlobalMCPPolicy stays as a defensive idempotent noop — same
-- D133 contract, belt-and-suspenders for any future install path
-- that runs migrations and api separately.
--
-- The INSERT mirrors EnsureGlobalMCPPolicy byte-for-byte (mode =
-- 'blocklist', block_on_uncertainty = false, no entries). The
-- ``WHERE NOT EXISTS`` predicate makes this safe to apply against an
-- environment that already has a global policy from the boot hook
-- on a prior install.

INSERT INTO mcp_policies (scope, scope_value, mode, block_on_uncertainty)
SELECT 'global', NULL, 'blocklist', false
 WHERE NOT EXISTS (SELECT 1 FROM mcp_policies WHERE scope = 'global');
