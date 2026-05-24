-- Exact inverse of 000023_events_facet_indexes.up.sql — drop the
-- event-grain /events facet indexes.

DROP INDEX IF EXISTS events_payload_terminal_idx;
DROP INDEX IF EXISTS events_payload_server_name_idx;
DROP INDEX IF EXISTS events_payload_orig_call_ctx_idx;
DROP INDEX IF EXISTS events_payload_matched_entry_idx;
DROP INDEX IF EXISTS events_payload_estimated_via_idx;
DROP INDEX IF EXISTS events_payload_close_reason_idx;
DROP INDEX IF EXISTS events_payload_error_type_idx;
DROP INDEX IF EXISTS events_model_idx;
