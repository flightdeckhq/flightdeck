-- 000014: one-time normalization of legacy agent_type values.
--
-- D114 locked the agent_type vocabulary to {'coding', 'production'}.
-- A migration that performed this normalization landed on
-- feat/agent-type-vocab-lock but was discarded with the rest of that
-- branch (see DECISIONS.md on the KI21/KI22/KI23 scrub batch and the
-- subsequent branch reset). Sessions created between v0.3.0 and the
-- scrub carry the legacy 'developer' / 'autonomous' strings; agents
-- rows inherited those too.
--
-- This migration restores the D114 invariant on the live dev DB
-- without re-introducing the machinery from the discarded branch.
-- It touches two tables (sessions, agents) with the same mapping:
--
--   'developer'  -> 'coding'     (former plugin default)
--   'autonomous' -> 'production' (former sensor default)
--
-- Rows whose agent_type is already 'coding', 'production', NULL, or
-- the D106 'unknown' sentinel are left untouched. The WHERE clauses
-- are explicit so an accidental re-run only UPDATEs rows that still
-- match the legacy pattern -- idempotent-enough for the one-shot
-- launch cleanup this migration is.

BEGIN;

UPDATE sessions
   SET agent_type = 'coding'
 WHERE agent_type = 'developer';

UPDATE sessions
   SET agent_type = 'production'
 WHERE agent_type = 'autonomous';

UPDATE agents
   SET agent_type = 'coding'
 WHERE agent_type = 'developer';

UPDATE agents
   SET agent_type = 'production'
 WHERE agent_type = 'autonomous';

COMMIT;
