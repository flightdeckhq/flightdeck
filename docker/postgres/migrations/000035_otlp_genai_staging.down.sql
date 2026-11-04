-- Inverse of 000035: drop the OTLP GenAI staging tables, last created
-- first (each table's indexes go with it). Staged records that were not
-- yet assembled are lost, so roll back only together with the ingestion
-- code that writes them.
DROP TABLE IF EXISTS otlp_span_content;
DROP TABLE IF EXISTS otlp_spans;
DROP TABLE IF EXISTS otlp_traces;
