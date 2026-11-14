package writer

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/flightdeckhq/flightdeck/storage"
)

// ClaimStartSeq takes the stream sequence a session_start's upsert uses
// from the start's receipt (session_start_receipts, written by
// ingestion's attach): a session row keeps the lowest sequence any copy
// of one start was published at, as ingestion's re-attachment stamp
// does. The worker drops a copy whose id is already stored before any
// side effect (Processor.Process), so this matters only for two copies
// in flight at once, neither stored yet: the copy with the higher
// sequence upserts with the lower one when that is on the receipt, and
// when the higher was recorded first, the lower one replaces it and
// replaced reports the higher, for LowerStartSeq. useSeq is seq itself
// when the start has no receipt of sessionID's (no id, ingestion's
// attach did not record one, or the id is another session's start,
// which ingestion attaches as a start without an id), when the id is
// not a UUID, or for an unknown (zero) sequence.
func (w *Writer) ClaimStartSeq(ctx context.Context, sessionID, eventID string, seq uint64) (useSeq, replaced uint64, err error) {
	if seq == 0 || seqParam(seq) == 0 || !eventIDPattern.MatchString(eventID) {
		return seq, 0, nil
	}
	eventID = strings.ToLower(eventID)
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("claim session_start %s sequence: begin: %w", eventID, err)
	}
	defer func() { _ = tx.Rollback() }()
	lock := ""
	if w.db.Backend == storage.Postgres {
		lock = " FOR UPDATE"
	}
	var current sql.NullInt64
	err = tx.QueryRowContext(ctx,
		`SELECT start_seq FROM session_start_receipts WHERE event_id = $1 AND session_id = $2`+lock,
		eventID, canonicalUUID(sessionID),
	).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		return seq, 0, nil
	}
	if err != nil {
		return 0, 0, fmt.Errorf("claim session_start %s sequence: %w", eventID, err)
	}
	if current.Valid && current.Int64 > 0 && uint64(current.Int64) <= seq {
		return uint64(current.Int64), 0, nil
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE session_start_receipts SET start_seq = $2 WHERE event_id = $1 AND session_id = $3`,
		eventID, seqParam(seq), canonicalUUID(sessionID),
	); err != nil {
		return 0, 0, fmt.Errorf("claim session_start %s sequence: %w", eventID, err)
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, fmt.Errorf("claim session_start %s sequence: commit: %w", eventID, err)
	}
	if current.Valid && current.Int64 > 0 {
		return seq, uint64(current.Int64), nil
	}
	return seq, 0, nil
}

// LowerStartSeq puts sessionID's start_seq back from a copy's higher
// sequence to its start's lower one (ClaimStartSeq's replaced), where
// the higher still stands: not where a later start has stamped the row
// since.
func (w *Writer) LowerStartSeq(ctx context.Context, sessionID string, from, to uint64) error {
	if _, err := w.db.ExecContext(ctx,
		`UPDATE sessions SET start_seq = $2 WHERE session_id = $1 AND start_seq = $3`,
		canonicalUUID(sessionID), seqParam(to), seqParam(from),
	); err != nil {
		return fmt.Errorf("lower session %s start_seq: %w", sessionID, err)
	}
	return nil
}
