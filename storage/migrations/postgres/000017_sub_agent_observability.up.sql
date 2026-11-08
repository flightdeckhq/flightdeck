-- D126 sub-agent observability: paired nullable columns on
-- ``sessions`` for sub-agent attribution. Both populated only on
-- sub-agent sessions (Claude Code Task subagent, CrewAI agent
-- execution, LangGraph agent-bearing node, AutoGen 0.4 / 0.2
-- participant message handler); both null on root sessions and
-- direct-SDK sessions. The reverse (role set, parent unset) is a
-- sensor bug.
--
-- ``parent_session_id`` references ``sessions(session_id)``. The
-- FK uses the default ON DELETE NO ACTION (matching the existing
-- ``agent_id`` reference) so deleting a parent with children
-- fails rather than orphaning or cascade-deleting. Sessions are
-- write-once in normal operation; this is the conservative
-- choice.
--
-- Forward references (a child ``session_start`` arriving before
-- its parent's) are handled by the worker's parent-stub lazy-
-- create path that extends D106 — see D126 § 3 pseudocode. The
-- FK stays enforced at the schema level; the worker INSERTs a
-- placeholder parent row before writing the child so the FK
-- check passes, then ``UpsertSession ON CONFLICT`` upgrades the
-- stub's ``"unknown"`` sentinels when the real parent's
-- ``session_start`` arrives later.
--
-- ``agent_role`` is the framework-supplied role string (CrewAI
-- ``Agent.role``, LangGraph node name, AutoGen ``participant.name``,
-- Claude Code Task hook ``agent_type``). Joins the ``agent_id``
-- derivation as a conditional 6th input — when set, two
-- sub-agents with the same 5-tuple but different roles land
-- under distinct ``agent_id``s. Indexed via the partial index
-- below for the analytics ``group_by=agent_role`` path.
--
-- The partial index on ``parent_session_id WHERE NOT NULL``
-- excludes the null-majority root sessions so the index stays
-- small while supporting fast lookups for the
-- ``?has_sub_agents`` / ``?is_sub_agent`` /
-- ``?parent_session_id`` API filters and the recursive CTE
-- traversal that drives ``parent_token_sum`` /
-- ``child_token_sum`` / ``child_count`` /
-- ``parent_to_first_child_latency_ms`` analytics metrics.

ALTER TABLE sessions
    ADD COLUMN parent_session_id UUID NULL REFERENCES sessions(session_id);

ALTER TABLE sessions
    ADD COLUMN agent_role TEXT NULL;

CREATE INDEX sessions_parent_session_id_idx
    ON sessions (parent_session_id)
    WHERE parent_session_id IS NOT NULL;
