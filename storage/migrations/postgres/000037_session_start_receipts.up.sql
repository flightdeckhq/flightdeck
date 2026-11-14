-- One row per session_start event id ingestion has attached. A client
-- resends a start it gave up on as the same event (one id, one
-- timestamp), and the first copy may already have been attached: the
-- receipt makes the attach idempotent per id. Attach records it in the
-- same transaction as the attach, with the answer it gave; a copy whose
-- id is here revives nothing, writes no session_attachments row and is
-- answered alike. RecordStart sets start_seq once, so a copy's later
-- stream sequence never replaces the first copy's. session_id has no
-- foreign key: a session's first start is received before the worker
-- creates its row. Attach deletes receipts older than 50 hours, past
-- which no copy passes ingestion's clock-skew check.
CREATE TABLE IF NOT EXISTS session_start_receipts (
    event_id    UUID PRIMARY KEY,
    session_id  UUID NOT NULL,
    attached    BOOLEAN NOT NULL DEFAULT FALSE,
    start_seq   BIGINT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS session_start_receipts_received_idx
    ON session_start_receipts (received_at);
