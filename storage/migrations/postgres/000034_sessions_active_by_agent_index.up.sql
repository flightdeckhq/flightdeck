-- The WebSocket hub reads the rolled-up state of each broadcast's agent
-- (the agents' "active when any of its runs is active" rollup). Without
-- this index the active-run check intersects every run of the agent with
-- every active run of the fleet, so its cost grows with the agent's run
-- count on every broadcast. This partial index holds only active runs,
-- keyed by agent, so the check is one small index probe; it stays small
-- because few runs are active at once.
--
-- CONCURRENTLY, so building it reads the sessions table without blocking
-- the worker's writes while it applies migrations at boot. It cannot run
-- in a transaction, so this file holds this one statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_active_by_agent_idx
    ON sessions (agent_id)
    WHERE state = 'active';
