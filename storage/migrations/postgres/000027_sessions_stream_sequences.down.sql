-- Inverse of 000027: drop the stream-sequence columns. Roll back only
-- together with the worker code that writes and compares them.
ALTER TABLE sessions
    DROP COLUMN IF EXISTS start_seq,
    DROP COLUMN IF EXISTS closed_seq;
