-- The assembly that marked each staged OTLP GenAI record: the trace's
-- assembly_count after that assembly, from 1. The mapping reads it to
-- tell an ancestor assembled with an agent from one that arrived in a
-- later assembly, so a late ancestor never re-parents an agent already
-- published. NULL exactly while the record is not assembled.
ALTER TABLE otlp_spans ADD COLUMN assembled_in INTEGER;

-- A record marked before this column existed was marked by one of its
-- trace's assemblies so far; the latest is the only one known.
UPDATE otlp_spans s
SET assembled_in = t.assembly_count
FROM otlp_traces t
WHERE s.assembled
  AND t.token_key = s.token_key AND t.trace_id = s.trace_id;

ALTER TABLE otlp_spans ADD CONSTRAINT otlp_spans_assembled_in_check
    CHECK (assembled = (assembled_in IS NOT NULL) AND (assembled_in IS NULL OR assembled_in >= 1));
