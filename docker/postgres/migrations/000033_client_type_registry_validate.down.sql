-- Inverse of 000033. Postgres has no statement that marks a validated
-- constraint NOT VALID again, and a validated constraint enforces
-- exactly what the NOT VALID one did for new rows, so there is nothing
-- to undo; 000032's down replaces the constraints themselves.
SELECT 1;
