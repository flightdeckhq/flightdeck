-- event_content gains an embedding_output jsonb column for the raw
-- vectors returned by embeddings.create() / litellm.embedding().
-- Gated by capture_prompts (the same gate that protects prompts and
-- responses). Populated by the sensor's embeddings path when capture
-- is on; the dashboard's EmbeddingsContentViewer fetches via the
-- existing GET /v1/events/:id/content endpoint and renders a
-- collapsible vector matrix preview.
--
-- Inline shape: [[<float>, <float>, ...], [<float>, ...], ...]
-- Outer length = response vector count; inner length = model
-- dimension. The companion always-included `output_dimensions`
-- field on events.payload carries the {count, dimension} summary so
-- the dashboard renders the shape chip without fetching this body.

ALTER TABLE event_content
    ADD COLUMN embedding_output jsonb;

COMMENT ON COLUMN event_content.embedding_output IS
    'Raw embedding vectors from embeddings.create() responses. '
    'Shape: [[<float>...], [<float>...], ...]. Outer length = vector '
    'count; inner length = model dimension. Populated only when '
    'capture_prompts=True AND event_type=embeddings. NULL otherwise.';
