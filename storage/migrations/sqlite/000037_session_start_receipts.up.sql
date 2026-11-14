-- SQLite translation of postgres/000037_session_start_receipts.up.sql
-- (rules in 000001_baseline.up.sql): one row per session_start event id
-- ingestion has attached, so a resent copy of the start is not attached
-- again; start_seq keeps the lowest stream sequence of the start's
-- copies. See the Postgres file for the reasons.
CREATE TABLE session_start_receipts (
    event_id    TEXT NOT NULL PRIMARY KEY CHECK (event_id = lower(event_id) AND event_id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(event_id, '-', ''))), 0) = 16),
    session_id  TEXT NOT NULL CHECK (session_id = lower(session_id) AND session_id GLOB '????????-????-????-????-????????????' AND COALESCE(length(unhex(replace(session_id, '-', ''))), 0) = 16),
    attached    BOOLEAN NOT NULL DEFAULT FALSE,
    start_seq   INTEGER,
    received_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', received_at) IS received_at)
);

CREATE INDEX session_start_receipts_received_idx ON session_start_receipts (received_at);
