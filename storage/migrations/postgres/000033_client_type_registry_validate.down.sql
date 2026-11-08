-- Inverse of 000033: return both client_type constraints to the NOT VALID
-- state 000032 left them in. A constraint cannot be marked NOT VALID in
-- place, so each is dropped and re-added with the same list, NOT VALID
-- (no scan; a brief exclusive lock). 000032's down then restores the
-- previous list.
ALTER TABLE agents DROP CONSTRAINT agents_client_type_check;
ALTER TABLE agents ADD CONSTRAINT agents_client_type_check
    CHECK (client_type IN ('claude_code', 'flightdeck_sensor', 'claude_agent_sdk', 'codex', 'copilot', 'opencode', 'gemini_cli', 'cursor', 'otlp')) NOT VALID;
ALTER TABLE sessions DROP CONSTRAINT sessions_client_type_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_client_type_check
    CHECK (client_type IN ('claude_code', 'flightdeck_sensor', 'claude_agent_sdk', 'codex', 'copilot', 'opencode', 'gemini_cli', 'cursor', 'otlp')) NOT VALID;
