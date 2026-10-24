-- Inverse of 000030: drop the model-id backfill index, without blocking
-- writes to events. One statement: CONCURRENTLY cannot run in a
-- transaction.
DROP INDEX CONCURRENTLY IF EXISTS events_model_backfill_idx;
