-- Reverse 000017_sub_agent_observability.
--
-- Drop in opposite order from up: index first (depends on
-- parent_session_id), then both columns. ``IF EXISTS`` guards
-- make the down idempotent if a partial up left things half-
-- applied.
--
-- No data backfill needed on the way down: nullable columns
-- with no NOT NULL constraint, no defaults that depend on them.
-- Any sub-agent-relationship data captured between up and down
-- is lost (acceptable for a development environment; production
-- doesn't run downs).

DROP INDEX IF EXISTS sessions_parent_session_id_idx;

ALTER TABLE sessions
    DROP COLUMN IF EXISTS agent_role;

ALTER TABLE sessions
    DROP COLUMN IF EXISTS parent_session_id;
