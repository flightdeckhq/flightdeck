-- Inverse of the baseline: every table, dependants first. Indexes and
-- the seed rows go with their tables.
DROP TABLE IF EXISTS otlp_span_content;
DROP TABLE IF EXISTS otlp_spans;
DROP TABLE IF EXISTS otlp_traces;
DROP TABLE IF EXISTS model_pricing_meta;
DROP TABLE IF EXISTS model_pricing;
DROP TABLE IF EXISTS mcp_policy_audit_log;
DROP TABLE IF EXISTS mcp_policy_entries;
DROP TABLE IF EXISTS mcp_policies;
DROP TABLE IF EXISTS session_attachments;
DROP TABLE IF EXISTS custom_directives;
DROP TABLE IF EXISTS directives;
DROP TABLE IF EXISTS event_content;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS access_tokens;
DROP TABLE IF EXISTS token_policies;
