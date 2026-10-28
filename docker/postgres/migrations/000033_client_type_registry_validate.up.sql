-- Validate the client_type constraints 000032 added NOT VALID. A separate
-- file, so the scan of sessions runs under VALIDATE's SHARE UPDATE
-- EXCLUSIVE lock (reads and writes continue) rather than under the
-- exclusive lock 000032's constraint swap takes.
ALTER TABLE agents VALIDATE CONSTRAINT agents_client_type_check;
ALTER TABLE sessions VALIDATE CONSTRAINT sessions_client_type_check;
