-- Add cache-token columns to events so per-call cache economics survive into
-- analytics. The sensor's Anthropic provider continues to fold cache reads and
-- cache-creation tokens into tokens_input for policy/budget compatibility; the
-- new columns surface the breakdown verbatim from the provider usage object.
-- Claude Code plugin's post_call events populate these from the JSONL
-- transcript. See DECISIONS.md D100.

ALTER TABLE events
    ADD COLUMN tokens_cache_read BIGINT NOT NULL DEFAULT 0;

ALTER TABLE events
    ADD COLUMN tokens_cache_creation BIGINT NOT NULL DEFAULT 0;
