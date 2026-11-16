-- A system prompt given as a list of content blocks: an Anthropic
-- `system` in the form prompt caching uses (text blocks, a block
-- carrying `cache_control`), or an OpenTelemetry GenAI framework's
-- system instructions (a list of parts). It is stored as the list the
-- provider received; a system prompt given as text stays in
-- system_prompt, so a text prompt that happens to read as JSON stays
-- text. The JSON type the producer sent picks the column, and a row
-- holds at most one of the two.
ALTER TABLE event_content ADD COLUMN system_blocks JSONB;

ALTER TABLE event_content ADD CONSTRAINT event_content_system_blocks_check
    CHECK (
        (system_blocks IS NULL OR jsonb_typeof(system_blocks) = 'array')
        AND (system_prompt IS NULL OR system_blocks IS NULL)
    );
