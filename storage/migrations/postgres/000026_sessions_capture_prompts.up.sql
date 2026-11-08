-- Security fix (capture-posture server-side enforcement): persist the
-- session's declared capture posture authoritatively on the sessions
-- row so the worker gates prompt-content storage on a trusted,
-- server-held value rather than on each event's self-reported
-- has_content flag. Previously capture_prompts existed only as a
-- sensor-side kwarg, so a forged event on the message bus could store
-- content for a capture-off session. See SECURITY.md (capture posture).
--
-- Nullable on purpose: NULL means "no authoritative session_start has
-- declared posture yet" (e.g. a lazily-created stub row). The worker
-- treats NULL as capture-off (content is dropped). The first
-- authoritative session_start writes the real value write-once via
-- COALESCE(sessions.capture_prompts, EXCLUDED.capture_prompts).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS capture_prompts BOOLEAN;

COMMENT ON COLUMN sessions.capture_prompts IS
    'Server-authoritative capture posture, set write-once from the '
    'session_start event. NULL/false => prompt content is never stored '
    'for this session; TRUE => content storage is permitted.';
