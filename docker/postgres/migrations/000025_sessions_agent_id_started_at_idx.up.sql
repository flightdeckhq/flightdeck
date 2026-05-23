-- D161: composite index on sessions(agent_id, started_at DESC) so
-- the AgentSummary latest-session context LATERAL JOIN
-- (ORDER BY started_at DESC LIMIT 1) is a single index lookup
-- per agent. The pre-existing idx_sessions_agent_id (migration
-- 000015) only indexes agent_id, forcing the planner to fetch
-- every matching row from the heap and sort — fine at one
-- session per agent, but the AgentSummary projection runs the
-- latest-session lookup for every row of the fleet page, so the
-- composite is the right shape.
--
-- Same DESC ordering as the implicit sort the state-rollup
-- subquery already does today, so this index simultaneously
-- speeds the existing state rollup AND the new D161 context
-- projection. No new column data — only an index.
CREATE INDEX IF NOT EXISTS sessions_agent_id_started_at_desc_idx
    ON sessions (agent_id, started_at DESC);
