-- Inverse of 000036: drop otlp_spans.assembled_in, and its check with it.
ALTER TABLE otlp_spans DROP CONSTRAINT IF EXISTS otlp_spans_assembled_in_check;
ALTER TABLE otlp_spans DROP COLUMN IF EXISTS assembled_in;
