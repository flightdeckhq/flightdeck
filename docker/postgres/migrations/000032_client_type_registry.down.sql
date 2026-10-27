-- Inverse of 000032: restore the two-value client_type constraints.
-- Fails while any agents or sessions row holds a value outside
-- claude_code / flightdeck_sensor; delete or relabel those rows first.
ALTER TABLE sessions DROP CONSTRAINT sessions_client_type_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_client_type_check
    CHECK (client_type IN ('claude_code', 'flightdeck_sensor'));
ALTER TABLE agents DROP CONSTRAINT agents_client_type_check;
ALTER TABLE agents ADD CONSTRAINT agents_client_type_check
    CHECK (client_type IN ('claude_code', 'flightdeck_sensor'));
