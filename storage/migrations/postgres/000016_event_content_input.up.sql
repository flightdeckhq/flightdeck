-- Phase 4 polish: add ``input`` column to event_content for the
-- embedding-shaped capture path. The chat path stays in ``messages``;
-- embedding events leave ``messages`` empty and put the request's
-- ``input`` parameter (string or list of strings) into this new
-- column instead. Dashboard branches on event_type to render via
-- EmbeddingsContentViewer.
--
-- ``messages`` was previously NOT NULL. Loosening that constraint so
-- embedding events can leave it null/empty without violating the
-- check. Existing chat rows still write a non-null array; nothing
-- backfilled.

ALTER TABLE event_content
    ALTER COLUMN messages DROP NOT NULL;

ALTER TABLE event_content
    ADD COLUMN input JSONB;
