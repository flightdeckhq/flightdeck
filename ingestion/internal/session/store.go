// Package session provides synchronous session-attachment checks for the
// ingestion handler. The worker pipeline still owns the authoritative
// session row (UpsertSession on the session_start event), but the
// ingestion API has to tell the sensor -- in the POST /v1/events
// response envelope -- whether it was attached to a prior session or
// whether this is a fresh one. That answer must be known before the
// response is written, so it cannot wait on the NATS → worker hop.
//
// Store reads and (for closed/lost revivals) mutates the sessions row
// directly through the storage boundary, mirroring the directive.Store
// pattern already used for synchronous directive lookup, and so runs
// on SQLite and Postgres alike. See ARCHITECTURE.md (session attachment
// flow).
package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// Store performs synchronous session attachment against the database.
type Store struct {
	db *storage.DB
	// otlpSessionQuery and otlpEndsQuery are the backend's query set,
	// chosen once at construction.
	otlpSessionQuery string
	otlpEndsQuery    string
}

// NewStore creates a session Store.
func NewStore(db *storage.DB) *Store {
	s := &Store{db: db}
	switch db.Backend {
	case storage.Postgres:
		s.otlpSessionQuery = queryOTLPSessionPostgres
	default:
		s.otlpSessionQuery = fmt.Sprintf(queryOTLPSessionSQLite,
			db.Dialect.JSONText("context", "claude_code_session_id"),
			db.Dialect.JSONText("context", "telemetry"))
	}
	s.otlpEndsQuery = fmt.Sprintf(queryOTLPSessionEnds, db.Dialect.InUUIDArray("e.session_id", "$1"),
		db.Dialect.InUUIDArray("s.session_id", "$1"))
	return s
}

// canonical returns a session id as the stores compare it: lower case,
// the canonical form the SQLite CHECK enforces and Postgres' uuid type
// normalises to. The handlers accept hex digits of either case.
func canonical(sessionID string) string {
	return strings.ToLower(sessionID)
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
// eventID is the session_start's own id. A start that carries one is
// attached once per id: the id is recorded in session_start_receipts
// in the same transaction as the attach, with the answer, and a copy
// of the start sent again (a client that gave up on a slow answer, an
// exporter retrying a batch) finds it there, changes nothing and gets
// that answer back, with an empty priorState. A start without an id,
// with one that is not a UUID, or with the id of another session's
// start (a client bug; that session's answer is not handed out) is
// attached on every arrival and recorded nowhere.
//
// On any other database error, the function returns (false, "", err)
// and the caller MUST fall back to attached=false rather than block
// the ingestion path -- the attached flag is informational, not
// load-bearing.
func (s *Store) Attach(ctx context.Context, sessionID, eventID string) (bool, string, error) {
	sessionID = canonical(sessionID)
	eventID = canonicalEventID(eventID)
	if eventID == "" {
		return attachIn(ctx, s.db.Reader(), s.db, sessionID)
	}
	// One transaction for the receipt and the attach: a copy that
	// arrives meanwhile waits for it (Postgres holds the receipt's key
	// until commit, SQLite has one writer) and then finds the receipt
	// with its answer, and an attach that fails takes its receipt with
	// it, so the client's next copy is attached afresh.
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, "", fmt.Errorf("attach %s: begin: %w", sessionID, err)
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx, `
		INSERT INTO session_start_receipts (event_id, session_id)
		VALUES ($1, $2)
		ON CONFLICT (event_id) DO NOTHING
	`, eventID, sessionID)
	if err != nil {
		return false, "", fmt.Errorf("record session_start %s of %s: %w", eventID, sessionID, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, "", fmt.Errorf("record session_start %s of %s: %w", eventID, sessionID, err)
	}
	recorded := n > 0
	if !recorded {
		var attached bool
		var owner string
		if err := tx.QueryRowContext(ctx,
			`SELECT attached, CAST(session_id AS TEXT) FROM session_start_receipts WHERE event_id = $1`, eventID,
		).Scan(&attached, &owner); err != nil {
			return false, "", fmt.Errorf("read session_start %s of %s: %w", eventID, sessionID, err)
		}
		if canonical(owner) == sessionID {
			// A copy of a start already attached: its answer, nothing else.
			return attached, "", tx.Commit()
		}
		// The id is another session's start: not a copy of this one.
		// It is attached as a start without an id is, on this arrival,
		// and no receipt is recorded for it (the id's is the other
		// session's), so the other session's answer is never handed out.
	}
	attached, priorState, err := attachIn(ctx, tx, tx, sessionID)
	if err != nil {
		return false, priorState, err
	}
	if !recorded {
		if err := tx.Commit(); err != nil {
			return false, priorState, fmt.Errorf("attach %s: commit: %w", sessionID, err)
		}
		return attached, priorState, nil
	}
	if attached {
		if _, err := tx.ExecContext(ctx,
			`UPDATE session_start_receipts SET attached = TRUE WHERE event_id = $1`, eventID,
		); err != nil {
			return false, priorState, fmt.Errorf("record session_start %s of %s: %w", eventID, sessionID, err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM session_start_receipts WHERE received_at < `+s.db.Dialect.AddInterval(s.db.Dialect.Now(), "$1"),
		-int64(sessionStartReceiptRetention/time.Second),
	); err != nil {
		return false, priorState, fmt.Errorf("prune session_start receipts: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, priorState, fmt.Errorf("attach %s: commit: %w", sessionID, err)
	}
	return attached, priorState, nil
}

// sessionStartReceiptRetention is how long a session_start receipt is
// kept. Ingestion refuses an event dated more than 48 hours in the past
// or 5 minutes in the future, so no copy of a start first received
// longer ago than that passes validation again; the rest is margin.
const sessionStartReceiptRetention = 50 * time.Hour

// canonicalEventID returns an event id in the form the receipts key
// takes (lower-case 8-4-4-4-12 hex), or "" when id is not a UUID in
// that layout.
func canonicalEventID(id string) string {
	if !canonicalUUID.MatchString(id) {
		return ""
	}
	return strings.ToLower(id)
}

// querier is what the attach runs its statements on: the database, or
// a transaction.
type querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// attachIn is the attach itself (see Attach), reading the row through
// reader and writing through writer: the read pool and the database
// outside a transaction, the transaction for both inside one (a read
// that must see the transaction's own writes runs on it).
func attachIn(ctx context.Context, reader, writer querier, sessionID string) (bool, string, error) {
	var priorState string
	err := reader.QueryRowContext(ctx,
		`SELECT state FROM sessions WHERE session_id = $1`,
		sessionID,
	).Scan(&priorState)
	if errors.Is(err, sql.ErrNoRows) {
		return false, "", nil
	}
	if err != nil {
		return false, "", fmt.Errorf("lookup session %s: %w", sessionID, err)
	}

	// Revive closed/lost → active. started_at stays at the run's first
	// start (session_attachments records each re-attachment); ended_at
	// and closed_seq are cleared below.
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
		if _, err := writer.ExecContext(ctx, `
			UPDATE sessions
			SET state = 'active',
			    ended_at = NULL,
			    closed_seq = NULL
			WHERE session_id = $1
		`, sessionID); err != nil {
			return false, priorState, fmt.Errorf("revive session %s: %w", sessionID, err)
		}
	}

	// Record this attachment. One row per session_start arrival, so
	// the API can return the full history of when an orchestrator-
	// driven agent re-attached. Migration 000009 replaced the earlier
	// single-column last_attached_at design with this table because
	// the column only preserved the most recent timestamp.
	if _, err := writer.ExecContext(ctx, `
		INSERT INTO session_attachments (session_id)
		VALUES ($1)
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
	// AgentRole is the row's agent_role (a sub-agent's role), or "" when
	// there is no row or no role.
	AgentRole string
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

// The OTLP session lookup, per backend. On Postgres the plugin's rows
// are found by a containment query on sessions.context, which the
// sessions_context_gin index serves; the third argument is the JSON
// document to contain. On SQLite the same key is read with
// json_extract (the two %s are the dialect's JSON reads of
// context.claude_code_session_id and context.telemetry) and the third
// argument is the Claude Code session id itself; the whole table is
// scanned, which the single-process database can afford. Both compare
// uuid columns with the ids bound as text; a NULL fourth argument (the
// Claude Code id is not a UUID) matches no row on either.
const (
	queryOTLPSessionPostgres = `
		SELECT
		  COALESCE(own.state, ''),
		  COALESCE(own.agent_role, ''),
		  EXISTS (SELECT 1 FROM sessions WHERE session_id = $2),
		  EXISTS (
		    SELECT 1 FROM sessions
		    WHERE context @> CAST($3 AS jsonb)
		      AND client_type IN ('claude_code', 'claude_agent_sdk')
		      AND NOT context @> '{"telemetry": "otlp"}'::jsonb
		  )
		  OR EXISTS (
		    SELECT 1 FROM sessions
		    WHERE session_id = $4 AND client_type = 'claude_agent_sdk'
		  )
		FROM (SELECT 1) AS one
		LEFT JOIN sessions AS own ON own.session_id = $1`
	queryOTLPSessionSQLite = `
		SELECT
		  COALESCE(own.state, ''),
		  COALESCE(own.agent_role, ''),
		  EXISTS (SELECT 1 FROM sessions WHERE session_id = $2),
		  EXISTS (
		    SELECT 1 FROM sessions
		    WHERE %s = $3
		      AND client_type IN ('claude_code', 'claude_agent_sdk')
		      AND %s IS NOT 'otlp'
		  )
		  OR EXISTS (
		    SELECT 1 FROM sessions
		    WHERE session_id = $4 AND client_type = 'claude_agent_sdk'
		  )
		FROM (SELECT 1) AS one
		LEFT JOIN sessions AS own ON own.session_id = $1`
)

// LookupOTLPSession reads, in one round trip, the state and agent_role
// of the session row sessionID, whether the run's root session
// rootSessionID is stored, and whether another client reports the
// Claude Code session claudeCodeSessionID (see the queries above). The
// Agent SDK's row is looked up by primary key, and only when the Claude
// Code id is a canonical UUID (Claude Code's always are).
func (s *Store) LookupOTLPSession(ctx context.Context, sessionID, rootSessionID, claudeCodeSessionID string) (OTLPSession, error) {
	var sdkSessionID *string
	if canonicalUUID.MatchString(claudeCodeSessionID) {
		id := canonical(claudeCodeSessionID)
		sdkSessionID = &id
	}
	var contained any = claudeCodeSessionID
	if s.db.Backend == storage.Postgres {
		doc, err := json.Marshal(map[string]string{"claude_code_session_id": claudeCodeSessionID})
		if err != nil {
			return OTLPSession{}, fmt.Errorf("encode claude_code_session_id: %w", err)
		}
		contained = string(doc)
	}
	var out OTLPSession
	err := s.db.Reader().QueryRowContext(ctx, s.otlpSessionQuery,
		canonical(sessionID), canonical(rootSessionID), contained, sdkSessionID,
	).Scan(&out.State, &out.AgentRole, &out.RootStored, &out.ReportedElsewhere)
	if err != nil {
		return OTLPSession{}, fmt.Errorf("look up OTLP session %s: %w", sessionID, err)
	}
	return out, nil
}

// queryOTLPSessionEnds reads the closed sessions among the ids and
// their ends (see OTLPSessionEnds). The two %s are the dialect's
// membership test of a uuid column in the bound id array. The latest
// start and end of each session's events come from one aggregate pass
// over its events (events_session_idx leads with session_id), left
// joined so a session without events still answers with its ended_at;
// the CASE form of the conditional maximum is common to both backends.
const queryOTLPSessionEnds = `
	SELECT CAST(s.session_id AS TEXT),
	       CASE WHEN ev.last_start IS NULL OR ev.last_end >= ev.last_start
	            THEN COALESCE(ev.last_end, s.ended_at)
	            ELSE s.ended_at END
	FROM sessions AS s
	LEFT JOIN (
	  SELECT e.session_id,
	         max(CASE WHEN e.event_type = 'session_end' THEN e.occurred_at END) AS last_end,
	         max(CASE WHEN e.event_type = 'session_start' THEN e.occurred_at END) AS last_start
	  FROM events AS e
	  WHERE %s
	    AND e.event_type IN ('session_start', 'session_end')
	  GROUP BY e.session_id
	) AS ev ON ev.session_id = s.session_id
	WHERE %s AND s.state = 'closed'`

// OTLPSessionEnds reads, in one round trip, which of the sessions
// sessionIDs are closed, and when each ended as its client dated the
// end: the date of its latest stored session_end (an OTLP sub-agent's
// subagent_completed, on Claude Code's clock, or the end the reaper
// stores when it closes a session), provided no session_start is stored
// after it, else its ended_at. The OTLP receiver compares a closed
// sub-agent's records with it to tell a resumed run from a late record.
// A session that is open or has no row is absent from the result; a
// closed one whose end is unknown maps to the zero time. sessionIDs must
// be canonical UUIDs.
//
// The worker closes a row before it stores the closing session_end's
// event, so for that moment the latest stored end is the previous run's
// (or there is none): a start stored after it, the current run's, says
// so, and the row's ended_at, which the close just set, stands in. That
// is on the worker's clock, later than the end, so a late record still
// reads as late.
func (s *Store) OTLPSessionEnds(ctx context.Context, sessionIDs []string) (map[string]time.Time, error) {
	ids := make([]string, len(sessionIDs))
	for i, id := range sessionIDs {
		ids[i] = canonical(id)
	}
	rows, err := s.db.Reader().QueryContext(ctx, s.otlpEndsQuery, s.db.Dialect.ArrayArg(ids))
	if err != nil {
		return nil, fmt.Errorf("read OTLP session ends: %w", err)
	}
	defer func() { _ = rows.Close() }()
	ends := make(map[string]time.Time, len(sessionIDs))
	for rows.Next() {
		var id string
		// The end is an aggregate on SQLite, read back as text.
		var ended storage.Time
		if err := rows.Scan(&id, &ended); err != nil {
			return nil, fmt.Errorf("read OTLP session ends: %w", err)
		}
		ends[id] = time.Time{}
		if ended.Valid {
			ends[id] = ended.Time
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read OTLP session ends: %w", err)
	}
	return ends, nil
}

// canonicalUUID matches the canonical 8-4-4-4-12 hex form, which the
// uuid columns accept.
var canonicalUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// RecordStart stamps the stream sequence of a re-attaching session_start
// on its session row (sessions.start_seq), keeping the greater of the
// stored and the new value. The worker compares a session_end's sequence
// against it: an end published before the start belongs to the previous
// run and must not close the re-attached session. eventID is the
// start's own id: a start that has one is stamped at the lowest
// sequence any copy of it was published at (claimStartStamp), however
// often it is resent and in whatever order the copies' stamps run.
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
// whole ingestion path. On Postgres a row another writer holds is
// therefore skipped (FOR NO KEY UPDATE SKIP LOCKED: the stamp writes no
// key column, so it conflicts only with other row updates, not with the
// KEY SHARE locks the worker's event inserts take through the sessions
// foreign key) and tried again after each pause in
// recordStartRetryDelays, which together cover the chain of row updates
// the worker may be applying (the previous run's end, this start, the
// first call) at several milliseconds of commit latency each. A row
// still held after that is logged and left to the worker's own ordering
// rules, which remain the backstop; calls of the new run that the worker
// handles before the start's own revive are then stored without rolling
// their tokens up. On SQLite writers never hold a row against each
// other (one writer connection, transactions begin IMMEDIATE), so the
// stamp applies on its first attempt whenever the row exists.
func (s *Store) RecordStart(ctx context.Context, sessionID, eventID string, seq uint64) error {
	// Zero means unknown; a sequence beyond the bigint range (which no
	// stream reaches) is treated the same rather than wrapped.
	if seq == 0 || seq > math.MaxInt64 {
		return nil
	}
	sessionID = canonical(sessionID)
	if eventID = canonicalEventID(eventID); eventID != "" {
		stamp, replaced, err := s.claimStartStamp(ctx, eventID, int64(seq))
		if err != nil || !stamp {
			return err
		}
		if replaced > 0 {
			// A copy published later stamped the row first: put the
			// first copy's sequence back where the copy's still stands.
			// Not where a later start has stamped the row since.
			if _, err := s.db.ExecContext(ctx,
				`UPDATE sessions SET start_seq = $2 WHERE session_id = $1 AND start_seq = $3`,
				sessionID, int64(seq), replaced,
			); err != nil {
				return fmt.Errorf("lower session_start %s sequence on %s: %w", eventID, sessionID, err)
			}
			return nil
		}
	}
	return stampWithRetry(ctx, sessionID, int64(seq), recordStartRetryDelays, s.recordStart, stampGiveUps)
}

// claimStartStamp records seq as the stamp of start eventID on its
// receipt when it is the lowest sequence a copy of the start was
// published at so far, and reports what to do with the row: stamp is
// true for such a sequence and false for a later copy's (the first
// copy's stamp stands: a later sequence would make the worker take a
// session_end published between the two for an earlier run's), and
// replaced is the receipt's previous sequence when a copy published
// later had stamped first (the narrow race of two copies' stamps), 0
// otherwise. A start with no receipt (Attach failed and the caller fell
// back) is stamped as before. The read and the write run in one
// transaction, the receipt's row locked on Postgres, so two copies'
// stamps are taken in turn.
func (s *Store) claimStartStamp(ctx context.Context, eventID string, seq int64) (stamp bool, replaced int64, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, 0, fmt.Errorf("record session_start %s sequence: begin: %w", eventID, err)
	}
	defer func() { _ = tx.Rollback() }()
	lock := ""
	if s.db.Backend == storage.Postgres {
		lock = " FOR UPDATE"
	}
	var current sql.NullInt64
	err = tx.QueryRowContext(ctx,
		`SELECT start_seq FROM session_start_receipts WHERE event_id = $1`+lock, eventID,
	).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		return true, 0, nil
	}
	if err != nil {
		return false, 0, fmt.Errorf("read session_start %s sequence: %w", eventID, err)
	}
	if current.Valid && current.Int64 <= seq {
		return false, 0, nil
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE session_start_receipts SET start_seq = $2 WHERE event_id = $1`, eventID, seq,
	); err != nil {
		return false, 0, fmt.Errorf("record session_start %s sequence: %w", eventID, err)
	}
	if err := tx.Commit(); err != nil {
		return false, 0, fmt.Errorf("record session_start %s sequence: commit: %w", eventID, err)
	}
	if current.Valid {
		return true, current.Int64, nil
	}
	return true, 0, nil
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

// queryRecordStartPostgres is the stamp as one statement: the CTE takes
// the row's lock or skips it, the UPDATE stamps the sequence and
// revives a row closed by an earlier end, and RETURNING reports the
// revival from the row's state before the update. No row is returned
// when the row is held or gone.
const queryRecordStartPostgres = `
	WITH before AS (
		SELECT session_id, state, closed_seq
		FROM sessions
		WHERE session_id = $1
		FOR NO KEY UPDATE SKIP LOCKED
	)
	UPDATE sessions AS s
	SET start_seq = GREATEST(s.start_seq, CAST($2 AS bigint)),
	    state = CASE WHEN before.state = 'closed'
	                  AND (before.closed_seq IS NULL OR before.closed_seq < $2)
	                 THEN 'active' ELSE s.state END,
	    ended_at = CASE WHEN before.state = 'closed'
	                     AND (before.closed_seq IS NULL OR before.closed_seq < $2)
	                    THEN NULL ELSE s.ended_at END,
	    closed_seq = CASE WHEN before.state = 'closed'
	                       AND (before.closed_seq IS NULL OR before.closed_seq < $2)
	                      THEN NULL ELSE s.closed_seq END
	FROM before
	WHERE s.session_id = before.session_id
	RETURNING before.state = 'closed'
	          AND (before.closed_seq IS NULL OR before.closed_seq < $2)`

// recordStart runs the stamp once; startSeq is already range-checked by
// RecordStart.
func (s *Store) recordStart(ctx context.Context, sessionID string, startSeq int64) (revived, applied bool, err error) {
	if s.db.Backend == storage.Postgres {
		return s.recordStartPostgres(ctx, sessionID, startSeq)
	}
	return s.recordStartSQLite(ctx, sessionID, startSeq)
}

func (s *Store) recordStartPostgres(ctx context.Context, sessionID string, startSeq int64) (revived, applied bool, err error) {
	err = s.db.QueryRowContext(ctx, queryRecordStartPostgres, sessionID, startSeq).Scan(&revived)
	if errors.Is(err, sql.ErrNoRows) {
		// The row is held by another transaction (skipped) or gone.
		return false, false, nil
	}
	if err != nil {
		return false, false, fmt.Errorf("record start sequence for %s: %w", sessionID, err)
	}
	return revived, true, nil
}

// recordStartSQLite is the stamp on SQLite: a read and a write in one
// transaction, which begins IMMEDIATE and so holds the database's one
// write lock from the read on; no other writer can change the row in
// between, and none is skipped. SQLite's RETURNING cannot read the
// row's state before the update, so the revival is decided in Go from
// the read.
func (s *Store) recordStartSQLite(ctx context.Context, sessionID string, startSeq int64) (revived, applied bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, false, fmt.Errorf("record start sequence for %s: %w", sessionID, err)
	}
	defer func() { _ = tx.Rollback() }()
	var (
		state     string
		closedSeq sql.NullInt64
	)
	err = tx.QueryRowContext(ctx,
		`SELECT state, closed_seq FROM sessions WHERE session_id = $1`, sessionID).Scan(&state, &closedSeq)
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, fmt.Errorf("record start sequence for %s: %w", sessionID, err)
	}
	revived = state == "closed" && (!closedSeq.Valid || closedSeq.Int64 < startSeq)
	if _, err := tx.ExecContext(ctx, `
		UPDATE sessions
		SET start_seq = CASE WHEN start_seq IS NULL OR start_seq < $2 THEN $2 ELSE start_seq END,
		    state = CASE WHEN $3 THEN 'active' ELSE state END,
		    ended_at = CASE WHEN $3 THEN NULL ELSE ended_at END,
		    closed_seq = CASE WHEN $3 THEN NULL ELSE closed_seq END
		WHERE session_id = $1`, sessionID, startSeq, revived); err != nil {
		return false, false, fmt.Errorf("record start sequence for %s: %w", sessionID, err)
	}
	if err := tx.Commit(); err != nil {
		return false, false, fmt.Errorf("record start sequence for %s: %w", sessionID, err)
	}
	return revived, true, nil
}
