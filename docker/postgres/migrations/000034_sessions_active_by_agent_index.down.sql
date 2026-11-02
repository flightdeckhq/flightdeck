-- Inverse of 000034: drop the active-runs-by-agent index, without
-- blocking writes to sessions. One statement: CONCURRENTLY cannot run in
-- a transaction.
DROP INDEX CONCURRENTLY IF EXISTS sessions_active_by_agent_idx;
