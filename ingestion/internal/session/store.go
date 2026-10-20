// Package session provides synchronous session-attachment checks for the
// ingestion handler. The worker pipeline still owns the authoritative
// session row (UpsertSession on the session_start event), but the
// ingestion API has to tell the sensor -- in the POST /v1/events
// response envelope -- whether it was attached to a prior session or
// whether this is a fresh one. That answer must be known before the
// response is written, so it cannot wait on the NATS → worker hop.
//
// Store reads and (for closed/lost revivals) mutates the sessions row
// directly in Postgres, mirroring the directive.Store pattern already
// used for synchronous directive lookup. See ARCHITECTURE.md (session
// attachment flow).
package session

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store performs synchronous session attachment against Postgres.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore creates a session Store.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// Attach implements the ingestion-side session-attachment protocol.
//
// Contract:
//   - Session row does not exist → returns (false, "", nil). The worker
//     will later create it via UpsertSession.
//   - Session row exists with state in {closed, lost} → flips state to
//     active, clears ended_at and closed_seq, leaves started_at
//     untouched, records a session_attachments row and returns
//     (true, priorState, nil). The caller logs INFO.
//   - Session row exists with state in {active, idle, stale} → leaves
//     the row as it is, records a session_attachments row and returns
//     (true, priorState, nil). The caller does not log (the sensor is
//     simply resuming).
//
// On any other Postgres error, the function returns (false, "", err)
// and the caller MUST fall back to attached=false rather than block
// the ingestion path -- the attached flag is informational, not
// load-bearing.
func (s *Store) Attach(ctx context.Context, sessionID string) (bool, string, error) {
	var priorState string
	err := s.pool.QueryRow(
		ctx,
		`SELECT state FROM sessions WHERE session_id = $1::uuid`,
		sessionID,
	).Scan(&priorState)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, "", nil
	}
	if err != nil {
		return false, "", fmt.Errorf("lookup session %s: %w", sessionID, err)
	}

	// Revive closed/lost → active. started_at stays as it was on the
	// original close (the dashboard's run separator draws off
	// session_attachments); ended_at and closed_seq are cleared below.
	if priorState == "closed" || priorState == "lost" {
		// Clear ended_at on revive so the session no longer looks
		// "finished at time X" while state=active. Without this, the
		// session carries a contradictory (state=active, ended_at is
		// set) pair, and downstream consumers that key off ended_at
		// (e.g. "has this session finished?") see stale values from
		// the previous run. started_at is still preserved so the
		// original lifetime remains discoverable via
		// session_attachments.
		// closed_seq goes with ended_at: the row is no longer closed by
		// any session_end, so the worker's ordering rules start afresh.
		if _, err := s.pool.Exec(ctx, `
			UPDATE sessions
			SET state = 'active',
			    ended_at = NULL,
			    closed_seq = NULL
			WHERE session_id = $1::uuid
		`, sessionID); err != nil {
			return false, priorState, fmt.Errorf("revive session %s: %w", sessionID, err)
		}
	}

	// Record this attachment. One row per session_start arrival, so
	// the API can return the full history of when an orchestrator-
	// driven agent re-attached. Migration 000009 replaced the earlier
	// single-column last_attached_at design with this table because
	// the column only preserved the most recent timestamp.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO session_attachments (session_id)
		VALUES ($1::uuid)
	`, sessionID); err != nil {
		return false, priorState, fmt.Errorf("record attachment for %s: %w", sessionID, err)
	}
	return true, priorState, nil
}

// RecordStart stamps the stream sequence of a re-attaching session_start
// on its session row (sessions.start_seq), keeping the greater of the
// stored and the new value. The worker compares a session_end's sequence
// against it: an end published before the start belongs to the previous
// run and must not close the re-attached session.
//
// The previous run's session_end can be processed by the worker between
// Attach's read and this write, closing the row that Attach found
// active. Such a row (closed by an end published before this start, or
// by the reconciler) is revived here, as Attach would have revived it a
// moment earlier, so the new run's first events do not land on a closed
// session. A row closed by a later end (the new run's own, which can
// only be published after this start) stays closed. A zero sequence
// (the publish was given up on) records nothing.
//
// The stamp is best effort and must not queue behind other writers of
// the row: many clients re-attaching one session id at once would
// otherwise serialise every request on that row's lock and slow the
// whole ingestion path. A row another writer holds is therefore skipped
// (FOR NO KEY UPDATE SKIP LOCKED: the stamp writes no key column, so it
// conflicts only with other row updates, not with the KEY SHARE locks
// the worker's event inserts take through the sessions foreign key)
// and tried once more after recordStartRetryDelay, which outlasts the
// single-statement close the worker may be applying to the row at that
// instant. A row still held after that is logged and left to the
// worker's own ordering rules, which remain the backstop; calls of the
// new run that the worker handles before the start's own revive are
// then stored without rolling their tokens up.
func (s *Store) RecordStart(ctx context.Context, sessionID string, seq uint64) error {
	// Zero means unknown; a sequence beyond the bigint range (which no
	// stream reaches) is treated the same rather than wrapped.
	if seq == 0 || seq > math.MaxInt64 {
		return nil
	}
	startSeq := int64(seq)
	for attempt := 0; ; attempt++ {
		revived, applied, err := s.recordStart(ctx, sessionID, startSeq)
		if err != nil {
			return err
		}
		if applied {
			if revived {
				slog.Info("session revived by its re-attaching session_start",
					"session_id", sessionID,
					"start_seq", seq,
				)
			}
			return nil
		}
		if attempt > 0 {
			// Routine under a hammer on one session id, where nearly
			// every request finds the row held; no operator action
			// follows, so this is an Info line, not a warning.
			slog.Info("re-attachment stamp not applied; row held by another writer or gone",
				"session_id", sessionID,
				"start_seq", seq,
			)
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(recordStartRetryDelay):
		}
	}
}

// recordStartRetryDelay is the pause before the stamp's second attempt
// on a row another transaction held. The worker's statements on a
// session row are single UPDATEs whose lock lasts for the statement and
// its commit, usually a millisecond or less and a few at most on a slow
// disk, so five milliseconds cover the common case without adding
// noticeable latency to the ingestion response; a row still held after
// that is under contention the stamp must not wait for.
const recordStartRetryDelay = 5 * time.Millisecond

// recordStart runs the stamp once; startSeq is already range-checked by
// RecordStart.
func (s *Store) recordStart(ctx context.Context, sessionID string, startSeq int64) (revived, applied bool, err error) {
	err = s.pool.QueryRow(ctx, `
		WITH before AS (
			SELECT session_id, state, closed_seq
			FROM sessions
			WHERE session_id = $1::uuid
			FOR NO KEY UPDATE SKIP LOCKED
		)
		UPDATE sessions AS s
		SET start_seq = GREATEST(s.start_seq, $2::bigint),
		    state = CASE WHEN before.state = 'closed'
		                  AND (before.closed_seq IS NULL OR before.closed_seq < $2::bigint)
		                 THEN 'active' ELSE s.state END,
		    ended_at = CASE WHEN before.state = 'closed'
		                     AND (before.closed_seq IS NULL OR before.closed_seq < $2::bigint)
		                    THEN NULL ELSE s.ended_at END,
		    closed_seq = CASE WHEN before.state = 'closed'
		                       AND (before.closed_seq IS NULL OR before.closed_seq < $2::bigint)
		                      THEN NULL ELSE s.closed_seq END
		FROM before
		WHERE s.session_id = before.session_id
		RETURNING before.state = 'closed'
		          AND (before.closed_seq IS NULL OR before.closed_seq < $2::bigint)
	`, sessionID, startSeq).Scan(&revived)
	if errors.Is(err, pgx.ErrNoRows) {
		// The row is held by another transaction (skipped) or gone.
		return false, false, nil
	}
	if err != nil {
		return false, false, fmt.Errorf("record start sequence for %s: %w", sessionID, err)
	}
	return revived, true, nil
}
