-- Down for 000014: reverse the legacy-vocab normalization.
--
-- LOSSY. After the UP migration ran, every row that was once
-- 'developer' or 'autonomous' now carries 'coding' or 'production' --
-- indistinguishable from rows that were created with the new
-- vocabulary directly. The down mapping restores the two primary
-- values to their pre-D114 defaults so the pre-D114 code paths still
-- function against the schema, but it cannot reconstruct which rows
-- were legacy vs. native-new:
--
--   'coding'     -> 'developer'   (former plugin default)
--   'production' -> 'autonomous'  (former sensor default)
--
-- Rolling back this migration is only sensible in a disaster-recovery
-- scenario where the whole D114 vocabulary lock is being reverted.
-- A normal migration rollback sequence would otherwise round-trip
-- through wrong data. Matches the lossy-down contract documented on
-- the discarded feat/agent-type-vocab-lock branch.

BEGIN;

UPDATE sessions
   SET agent_type = 'developer'
 WHERE agent_type = 'coding';

UPDATE sessions
   SET agent_type = 'autonomous'
 WHERE agent_type = 'production';

UPDATE agents
   SET agent_type = 'developer'
 WHERE agent_type = 'coding';

UPDATE agents
   SET agent_type = 'autonomous'
 WHERE agent_type = 'production';

COMMIT;
