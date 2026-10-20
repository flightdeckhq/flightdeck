-- The worker pool processes a session's events concurrently, so the
-- order in which two events of one session reach the database is not
-- the order the sensor sent them. The NATS stream sequence of each
-- event is that order: ingestion publishes events as it accepts them.
-- Recording the sequence of the event that opened the current run and
-- of the session_end that closed it lets the worker tell "this
-- session_end belongs to an earlier run" and "this session_start was
-- overtaken by its own session_end" apart from a genuine re-attachment,
-- without holding events back.
--
-- Nullable on purpose: rows written by earlier releases, by the
-- reconciler's synthetic close and by the e2e seed carry no sequence,
-- and the worker falls back to the plain state rules for them.
ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS start_seq  BIGINT,
    ADD COLUMN IF NOT EXISTS closed_seq BIGINT;

COMMENT ON COLUMN sessions.start_seq IS
    'NATS stream sequence of the event that opened the current run: the '
    'latest session_start, or the first event that lazily created the '
    'row. A session_end published before it belongs to an earlier run '
    'and does not close the session.';
COMMENT ON COLUMN sessions.closed_seq IS
    'NATS stream sequence of the session_end that closed the session. A '
    'session_start published before it was overtaken by its own '
    'session_end and leaves the row closed; one published after it is a '
    're-attachment and revives the row. NULL when the reconciler closed '
    'the session.';
