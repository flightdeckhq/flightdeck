-- The client type registry (contracts/client_types.json) widens the
-- client_type vocabulary from the plugin and the sensor to every client
-- Flightdeck integrates with, including those not shipped yet, so a new
-- integration needs no schema change. Both CHECK constraints are swapped
-- for the registry's list.
--
-- NOT VALID: adding the constraints does not scan the existing rows
-- while this file's transaction holds the tables' exclusive lock; every
-- existing row already satisfies the wider list, and 000033 validates
-- the constraints in a separate step. The four statements run as one
-- transaction, so there is no moment without a constraint.
ALTER TABLE agents DROP CONSTRAINT agents_client_type_check;
ALTER TABLE agents ADD CONSTRAINT agents_client_type_check
    CHECK (client_type IN ('claude_code', 'flightdeck_sensor', 'claude_agent_sdk', 'codex', 'copilot', 'opencode', 'gemini_cli', 'cursor', 'otlp')) NOT VALID;
ALTER TABLE sessions DROP CONSTRAINT sessions_client_type_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_client_type_check
    CHECK (client_type IN ('claude_code', 'flightdeck_sensor', 'claude_agent_sdk', 'codex', 'copilot', 'opencode', 'gemini_cli', 'cursor', 'otlp')) NOT VALID;
