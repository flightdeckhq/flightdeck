-- Inverse of 000025: drop the composite index. The pre-existing
-- single-column index on sessions(agent_id) (migration 000015)
-- remains and continues to back per-agent lookups.
DROP INDEX IF EXISTS sessions_agent_id_started_at_desc_idx;
