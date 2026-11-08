-- Inverse of 000026: drop the server-authoritative capture posture
-- column. Reverting re-exposes the wire-trust capture gate, so only
-- roll back in tandem with the worker code that reads this column.
ALTER TABLE sessions DROP COLUMN IF EXISTS capture_prompts;
