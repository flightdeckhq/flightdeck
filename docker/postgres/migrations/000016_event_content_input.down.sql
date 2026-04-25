-- Reverse 000016_event_content_input.
--
-- Restoring NOT NULL on messages requires every row to have a value.
-- Backfill any currently-null messages (embedding rows) to an empty
-- JSONB array before re-applying the constraint. Then drop the
-- input column.

UPDATE event_content
   SET messages = '[]'::jsonb
 WHERE messages IS NULL;

ALTER TABLE event_content
    ALTER COLUMN messages SET NOT NULL;

ALTER TABLE event_content
    DROP COLUMN input;
