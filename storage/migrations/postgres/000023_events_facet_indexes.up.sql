-- Event-grain /events facet support (D157 Phase 4).
--
-- The /events event-grain page filters and counts facets on the
-- `model` column and on text extracted from the `events.payload`
-- JSONB. A `->>`-equality predicate (`payload->>'close_reason' = ANY
-- (...)`) is NOT served by a GIN index, so each payload facet needs a
-- partial expression index keyed on the extracted text.
--
-- The partial predicate `(<expr>) IS NOT NULL` keeps each index tiny:
-- the vast majority of events carry none of these payload fields, so
-- only the relevant minority is indexed. The facet filters apply
-- `(<expr>) = ANY(...)`, a strict predicate the planner can prove
-- implies `(<expr>) IS NOT NULL`, so the partial index stays usable
-- for both the row query and the facet-count GROUP BYs.

CREATE INDEX IF NOT EXISTS events_model_idx
    ON events (model)
    WHERE model IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_payload_error_type_idx
    ON events ((payload->'error'->>'error_type'))
    WHERE (payload->'error'->>'error_type') IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_payload_close_reason_idx
    ON events ((payload->>'close_reason'))
    WHERE (payload->>'close_reason') IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_payload_estimated_via_idx
    ON events ((payload->>'estimated_via'))
    WHERE (payload->>'estimated_via') IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_payload_matched_entry_idx
    ON events ((payload->'policy_decision'->>'matched_entry_id'))
    WHERE (payload->'policy_decision'->>'matched_entry_id') IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_payload_orig_call_ctx_idx
    ON events ((payload->>'originating_call_context'))
    WHERE (payload->>'originating_call_context') IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_payload_server_name_idx
    ON events ((payload->>'server_name'))
    WHERE (payload->>'server_name') IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_payload_terminal_idx
    ON events ((payload->>'terminal'))
    WHERE (payload->>'terminal') IS NOT NULL;
