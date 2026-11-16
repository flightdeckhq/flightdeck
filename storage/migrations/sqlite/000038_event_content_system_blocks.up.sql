-- SQLite translation of postgres/000038_event_content_system_blocks.up.sql
-- (rules in 000001_baseline.up.sql): a system prompt given as a list of
-- content blocks, stored as the list, beside system_prompt for one given
-- as text; a row holds at most one of the two. See the Postgres file for
-- the reasons. The checks are the column's own, so the down file's DROP
-- COLUMN takes them with it.
ALTER TABLE event_content ADD COLUMN system_blocks TEXT
    CONSTRAINT event_content_system_blocks_json_check
        CHECK (json_valid(system_blocks) AND json_type(system_blocks) = 'array')
    CONSTRAINT event_content_system_blocks_check
        CHECK (system_prompt IS NULL OR system_blocks IS NULL);
