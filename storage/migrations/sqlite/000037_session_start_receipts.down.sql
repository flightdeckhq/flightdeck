-- Inverse of 000037: drop session_start_receipts, its index with it.
DROP INDEX IF EXISTS session_start_receipts_received_idx;
DROP TABLE IF EXISTS session_start_receipts;
