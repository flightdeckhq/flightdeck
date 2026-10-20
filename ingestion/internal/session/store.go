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
// used for synchronous directive lookup. See ARCHITECTURE.md and
// DECISIONS.md D094.
package session

import (
	"context"
	"errors"
	"fmt"

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
//     active, sets last_attached_at = NOW(), leaves started_at /
//     ended_at untouched (see D094), returns (true, priorState, nil).
//     The caller logs INFO.
//   - Session row exists with state in {active, idle, stale} → touches
//     last_attached_at only, returns (true, priorState, nil). The
//     caller does not log (the sensor is simply resuming).
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

	// Revive closed/lost → active. started_at and ended_at stay as they
	// were on the original close; the dashboard's run separator draws
	// off session_attachments, so we don't need to clear ended_at to
	// distinguish runs. See DECISIONS.md D094.
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
func (s *Store) RecordStart(ctx context.Context, sessionID string, seq uint64) error {
	if seq == 0 {
		return nil
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE sessions
		SET start_seq = GREATEST(start_seq, $2::bigint),
		    state = CASE WHEN state = 'closed'
		                  AND (closed_seq IS NULL OR closed_seq < $2::bigint)
		                 THEN 'active' ELSE state END,
		    ended_at = CASE WHEN state = 'closed'
		                     AND (closed_seq IS NULL OR closed_seq < $2::bigint)
		                    THEN NULL ELSE ended_at END,
		    closed_seq = CASE WHEN state = 'closed'
		                       AND (closed_seq IS NULL OR closed_seq < $2::bigint)
		                      THEN NULL ELSE closed_seq END
		WHERE session_id = $1::uuid
	`, sessionID, int64(seq)); err != nil {
		return fmt.Errorf("record start sequence for %s: %w", sessionID, err)
	}
	return nil
}
