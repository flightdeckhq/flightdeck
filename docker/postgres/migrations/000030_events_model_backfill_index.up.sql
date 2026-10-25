-- The worker's model-id backfill rewrites events stored before the
-- write path canonicalised model ids: rows that name a model but have
-- no model_requested. This partial index lets each backfill batch find
-- them without scanning the events table. The write path always fills
-- model_requested, so once the backfill has run the index is empty and
-- stays so; it costs nothing to keep.
--
-- CONCURRENTLY, so building it reads the events table without blocking
-- ingestion's writes while the worker applies migrations at boot. It
-- cannot run in a transaction, so this file holds this one statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_model_backfill_idx
    ON events (occurred_at)
    WHERE model IS NOT NULL AND model_requested IS NULL;
