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
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"regexp"
	"sync"
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

// OTLPSession is what the OTLP receiver needs to know about a Claude
// Code session before it publishes the session's events.
type OTLPSession struct {
	// State is the session row's state, or "" when there is no row.
	State string
	// RootStored reports that the row of the run's root session (the
	// session itself, for a root) exists, so the run is already reported
	// over OTLP.
	RootStored bool
	// ReportedElsewhere reports that another Flightdeck client reports
	// the same Claude Code session: a claude_code or claude_agent_sdk row
	// that is not an OTLP session and carries the Claude Code session id
	// in context.claude_code_session_id (the plugin), or a
	// claude_agent_sdk row whose session_id is the Claude Code session id
	// (the Agent SDK interceptor reports a run under that id).
	ReportedElsewhere bool
}

// LookupOTLPSession reads, in one round trip, the state of the session
// row sessionID, whether the run's root session rootSessionID is stored,
// and whether another client reports the Claude Code session
// claudeCodeSessionID. The plugin's rows are found by a containment
// query on sessions.context, which the sessions_context_gin index
// serves; the Agent SDK's by primary key, and only when the Claude Code
// id is a canonical UUID (Claude Code's always are).
func (s *Store) LookupOTLPSession(ctx context.Context, sessionID, rootSessionID, claudeCodeSessionID string) (OTLPSession, error) {
	doc, err := json.Marshal(map[string]string{"claude_code_session_id": claudeCodeSessionID})
	if err != nil {
		return OTLPSession{}, fmt.Errorf("encode claude_code_session_id: %w", err)
	}
	var sdkSessionID *string
	if canonicalUUID.MatchString(claudeCodeSessionID) {
		sdkSessionID = &claudeCodeSessionID
	}
	var out OTLPSession
	err = s.pool.QueryRow(ctx, `
		SELECT
		  COALESCE((SELECT state FROM sessions WHERE session_id = $1::uuid), ''),
		  EXISTS (SELECT 1 FROM sessions WHERE session_id = $2::uuid),
		  EXISTS (
		    SELECT 1 FROM sessions
		    WHERE context @> $3::jsonb
		      AND client_type IN ('claude_code', 'claude_agent_sdk')
		      AND NOT context @> '{"telemetry": "otlp"}'::jsonb
		  )
		  OR EXISTS (
		    SELECT 1 FROM sessions
		    WHERE session_id = $4::uuid AND client_type = 'claude_agent_sdk'
		  )
	`, sessionID, rootSessionID, string(doc), sdkSessionID).Scan(&out.State, &out.RootStored, &out.ReportedElsewhere)
	if err != nil {
		return OTLPSession{}, fmt.Errorf("look up OTLP session %s: %w", sessionID, err)
	}
	return out, nil
}

// canonicalUUID matches the canonical 8-4-4-4-12 hex form, which the
// ::uuid cast accepts.
var canonicalUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

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
// and tried again after each pause in recordStartRetryDelays, which
// together cover the chain of row updates the worker may be applying
// (the previous run's end, this start, the first call) at several
// milliseconds of commit latency each. A row still held after that is
// logged and left to the worker's own ordering rules, which remain the
// backstop; calls of the new run that the worker handles before the
// start's own revive are then stored without rolling their tokens up.
func (s *Store) RecordStart(ctx context.Context, sessionID string, seq uint64) error {
	// Zero means unknown; a sequence beyond the bigint range (which no
	// stream reaches) is treated the same rather than wrapped.
	if seq == 0 || seq > math.MaxInt64 {
		return nil
	}
	return stampWithRetry(ctx, sessionID, int64(seq), recordStartRetryDelays, s.recordStart, stampGiveUps)
}

// stampFunc is one attempt of the re-attachment stamp. applied is false
// when the row was held by another writer or does not exist; revived
// reports that the attempt reopened a closed row.
type stampFunc func(ctx context.Context, sessionID string, startSeq int64) (revived, applied bool, err error)

// stampWithRetry runs stamp until it applies, pausing between attempts
// for each duration in delays in turn. A stamp still not applied after
// the last pause is noted through giveUps and abandoned; a context that
// ends during a pause abandons it silently, since the request it
// belonged to is over.
func stampWithRetry(ctx context.Context, sessionID string, startSeq int64, delays []time.Duration, stamp stampFunc, giveUps *giveUpSampler) error {
	for attempt := 0; ; attempt++ {
		revived, applied, err := stamp(ctx, sessionID, startSeq)
		if err != nil {
			return err
		}
		if applied {
			if revived {
				slog.Info("session revived by its re-attaching session_start",
					"session_id", sessionID,
					"start_seq", startSeq,
				)
			}
			return nil
		}
		if attempt >= len(delays) {
			giveUps.note(sessionID, startSeq)
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delays[attempt]):
		}
	}
}

// recordStartRetryDelays are the pauses between the stamp's attempts on
// a row another transaction holds. The worker's statements on a session
// row are single UPDATEs whose lock lasts for the statement and its
// commit, a millisecond or less on fast storage and several on a slow
// disk, and the previous run's end, this start and the first call can
// each hold it in turn; the schedule covers that chain (75 ms of pauses
// in all, holding no database connection) while bounding what a
// request under real contention adds to its response time.
var recordStartRetryDelays = []time.Duration{
	5 * time.Millisecond,
	10 * time.Millisecond,
	20 * time.Millisecond,
	40 * time.Millisecond,
}

// stampGiveUps rate-limits the log line for a stamp that found its row
// held through every attempt: routine under a hammer on one session id
// (nearly every request), where one line per request would let a token
// holder drive log volume. One line per stampLogInterval carries the
// count suppressed since the previous one, so give-ups in the last
// interval of a burst are reported by the next line, not on their own;
// the line stays, since it is the operator's only signal that a run's
// first calls may have missed their roll-up.
var stampGiveUps = newGiveUpSampler(time.Now)

// stampLogInterval bounds the give-up log to one line per interval per
// process; a second keeps a hammer to at most sixty lines a minute and
// still reports a real event promptly.
const stampLogInterval = time.Second

type giveUpSampler struct {
	now        func() time.Time
	mu         sync.Mutex
	lastLogged time.Time
	suppressed int
}

func newGiveUpSampler(now func() time.Time) *giveUpSampler {
	return &giveUpSampler{now: now}
}

func (g *giveUpSampler) note(sessionID string, startSeq int64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	if now.Sub(g.lastLogged) < stampLogInterval {
		g.suppressed++
		return
	}
	suppressed := g.suppressed
	g.suppressed = 0
	g.lastLogged = now
	slog.Info("re-attachment stamp not applied; row held by another writer or gone",
		"session_id", sessionID,
		"start_seq", startSeq,
		"suppressed_since_last", suppressed,
	)
}

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
