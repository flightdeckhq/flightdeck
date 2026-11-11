package session

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// insertSession stores a session row in state with the given columns
// (clientType and context may be empty; parent may be empty), and
// removes it when the test ends.
func insertSession(t *testing.T, db *storage.DB, id, state, clientType, contextJSON string, closedSeq *int64) {
	t.Helper()
	ctx := context.Background()
	var client *string
	if clientType != "" {
		client = &clientType
	}
	if contextJSON == "" {
		contextJSON = "{}"
	}
	var ended *time.Time
	if state == "closed" || state == "lost" {
		at := time.Now().UTC().Truncate(time.Millisecond)
		ended = &at
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO sessions (session_id, flavor, agent_type, state, client_type, context, ended_at, closed_seq)
		VALUES ($1, 'session-store-test', 'coding', $2, $3, $4, $5, $6)`,
		id, state, client, contextJSON, ended, closedSeq); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), `DELETE FROM session_attachments WHERE session_id = $1`, id)
		_, _ = db.ExecContext(context.Background(), `DELETE FROM sessions WHERE session_id = $1`, id)
	})
}

// rowState reads a session row's state, ended_at, start_seq and
// closed_seq.
func rowState(t *testing.T, db *storage.DB, id string) (state string, ended sql.NullTime, startSeq, closedSeq sql.NullInt64) {
	t.Helper()
	var endedAt storage.Time
	if err := db.Reader().QueryRowContext(context.Background(),
		`SELECT state, ended_at, start_seq, closed_seq FROM sessions WHERE session_id = $1`, id).
		Scan(&state, &endedAt, &startSeq, &closedSeq); err != nil {
		t.Fatalf("read session: %v", err)
	}
	return state, sql.NullTime{Time: endedAt.Time, Valid: endedAt.Valid}, startSeq, closedSeq
}

func attachments(t *testing.T, db *storage.DB, id string) int {
	t.Helper()
	var n int
	if err := db.Reader().QueryRowContext(context.Background(),
		`SELECT count(*) FROM session_attachments WHERE session_id = $1`, id).Scan(&n); err != nil {
		t.Fatalf("count attachments: %v", err)
	}
	return n
}

// Attach answers "no row" for an unknown session, revives a closed or
// lost one (clearing ended_at and closed_seq) and leaves an open one as
// it is, recording one attachment per call; an id in upper case names
// the same row.
func TestAttachOnBothBackends(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		s := NewStore(db)

		attached, prior, err := s.Attach(ctx, randomUUID(t))
		if err != nil || attached || prior != "" {
			t.Fatalf("Attach of an unknown session = %v, %q, %v; want false, \"\", nil", attached, prior, err)
		}

		seq := int64(7)
		closed := randomUUID(t)
		insertSession(t, db, closed, "closed", "", "", &seq)
		attached, prior, err = s.Attach(ctx, strings.ToUpper(closed))
		if err != nil || !attached || prior != "closed" {
			t.Fatalf("Attach of a closed session = %v, %q, %v; want true, closed, nil", attached, prior, err)
		}
		state, ended, _, closedSeq := rowState(t, db, closed)
		if state != "active" || ended.Valid || closedSeq.Valid {
			t.Fatalf("after the revive state=%s ended=%v closed_seq=%v, want active with both cleared", state, ended, closedSeq)
		}
		if attachments(t, db, closed) != 1 {
			t.Fatalf("%d attachments recorded, want 1", attachments(t, db, closed))
		}

		lost := randomUUID(t)
		insertSession(t, db, lost, "lost", "", "", nil)
		if attached, prior, err := s.Attach(ctx, lost); err != nil || !attached || prior != "lost" {
			t.Fatalf("Attach of a lost session = %v, %q, %v; want true, lost, nil", attached, prior, err)
		}
		if state, _, _, _ := rowState(t, db, lost); state != "active" {
			t.Fatalf("a lost session was not revived: %s", state)
		}

		active := randomUUID(t)
		insertSession(t, db, active, "active", "", "", nil)
		for range 2 {
			if attached, prior, err := s.Attach(ctx, active); err != nil || !attached || prior != "active" {
				t.Fatalf("Attach of an active session = %v, %q, %v; want true, active, nil", attached, prior, err)
			}
		}
		if attachments(t, db, active) != 2 {
			t.Fatalf("%d attachments recorded, want one per call", attachments(t, db, active))
		}
	})
}

// RecordStart stamps the greater sequence, revives a row closed by an
// earlier end (closed_seq below the start's sequence, or unknown) and
// leaves a row closed by a later end closed; a missing row applies
// nothing and is logged once the retries run out.
func TestRecordStartOnBothBackends(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		s := NewStore(db)

		open := randomUUID(t)
		insertSession(t, db, open, "active", "", "", nil)
		if err := s.RecordStart(ctx, open, 10); err != nil {
			t.Fatal(err)
		}
		if _, _, startSeq, _ := rowState(t, db, open); !startSeq.Valid || startSeq.Int64 != 10 {
			t.Fatalf("start_seq = %v, want 10", startSeq)
		}
		// A smaller sequence never lowers the stamp.
		if err := s.RecordStart(ctx, open, 4); err != nil {
			t.Fatal(err)
		}
		if _, _, startSeq, _ := rowState(t, db, open); startSeq.Int64 != 10 {
			t.Fatalf("start_seq = %v after a smaller stamp, want 10 kept", startSeq)
		}

		earlier := int64(5)
		closedEarly := randomUUID(t)
		insertSession(t, db, closedEarly, "closed", "", "", &earlier)
		logs := captureLogs(t)
		if err := s.RecordStart(ctx, strings.ToUpper(closedEarly), 12); err != nil {
			t.Fatal(err)
		}
		state, ended, startSeq, closedSeq := rowState(t, db, closedEarly)
		if state != "active" || ended.Valid || closedSeq.Valid || startSeq.Int64 != 12 {
			t.Fatalf("a row closed by an earlier end: state=%s ended=%v start_seq=%v closed_seq=%v, want revived with start_seq 12",
				state, ended, startSeq, closedSeq)
		}
		if !strings.Contains(logs.String(), "session revived") {
			t.Fatalf("the revival was not logged: %s", logs.String())
		}

		later := int64(20)
		closedLate := randomUUID(t)
		insertSession(t, db, closedLate, "closed", "", "", &later)
		if err := s.RecordStart(ctx, closedLate, 12); err != nil {
			t.Fatal(err)
		}
		state, ended, startSeq, closedSeq = rowState(t, db, closedLate)
		if state != "closed" || !ended.Valid || closedSeq.Int64 != 20 || startSeq.Int64 != 12 {
			t.Fatalf("a row closed by a later end: state=%s ended=%v start_seq=%v closed_seq=%v, want still closed with start_seq 12",
				state, ended, startSeq, closedSeq)
		}

		logs = captureLogs(t)
		if err := stampWithRetry(ctx, randomUUID(t), 3, quickDelays, s.recordStart, newGiveUpSampler(time.Now)); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(logs.String(), "re-attachment stamp not applied") {
			t.Fatalf("a missing row's give-up was not logged: %s", logs.String())
		}
	})
}

// LookupOTLPSession reads the session's own state and role, whether
// its root is stored, and whether the plugin or the Agent SDK already
// reports the Claude Code session, on both backends; a plugin row that
// is itself an OTLP session does not count.
func TestLookupOTLPSessionOnBothBackends(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		s := NewStore(db)
		claudeCode := randomUUID(t)

		got, err := s.LookupOTLPSession(ctx, randomUUID(t), randomUUID(t), claudeCode)
		if err != nil || got != (OTLPSession{}) {
			t.Fatalf("lookup with nothing stored = %+v, %v; want the zero answer", got, err)
		}

		root, child := randomUUID(t), randomUUID(t)
		insertSession(t, db, root, "active", "claude_code", `{"telemetry":"otlp"}`, nil)
		if _, err := db.ExecContext(ctx, `
			INSERT INTO sessions (session_id, flavor, agent_type, state, client_type, parent_session_id, agent_role, context)
			VALUES ($1, 'session-store-test', 'coding', 'closed', 'claude_code', $2, 'general-purpose', '{"telemetry":"otlp"}')`,
			child, root); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = db.ExecContext(context.Background(), `DELETE FROM sessions WHERE session_id = $1`, child)
		})

		got, err = s.LookupOTLPSession(ctx, strings.ToUpper(child), root, claudeCode)
		if err != nil || got != (OTLPSession{State: "closed", AgentRole: "general-purpose", RootStored: true}) {
			t.Fatalf("lookup of the stored child = %+v, %v", got, err)
		}
		got, err = s.LookupOTLPSession(ctx, randomUUID(t), root, claudeCode)
		if err != nil || got != (OTLPSession{RootStored: true}) {
			t.Fatalf("lookup of a new child under a stored root = %+v, %v", got, err)
		}

		// The plugin reports the Claude Code session: a claude_code row
		// (not an OTLP one) whose context carries the id.
		plugin := randomUUID(t)
		insertSession(t, db, plugin, "active", "claude_code", `{"claude_code_session_id":"`+claudeCode+`","os":"linux"}`, nil)
		got, err = s.LookupOTLPSession(ctx, child, root, claudeCode)
		if err != nil || !got.ReportedElsewhere {
			t.Fatalf("lookup with a plugin row = %+v, %v; want reported elsewhere", got, err)
		}
		if got, err := s.LookupOTLPSession(ctx, child, root, randomUUID(t)); err != nil || got.ReportedElsewhere {
			t.Fatalf("lookup of another Claude Code session = %+v, %v; want not reported elsewhere", got, err)
		}

		// The Agent SDK reports it: a claude_agent_sdk row under the
		// Claude Code id itself.
		sdkSession := randomUUID(t)
		insertSession(t, db, sdkSession, "active", "claude_agent_sdk", "", nil)
		if got, err := s.LookupOTLPSession(ctx, child, root, strings.ToUpper(sdkSession)); err != nil || !got.ReportedElsewhere {
			t.Fatalf("lookup with an Agent SDK row = %+v, %v; want reported elsewhere", got, err)
		}
		// A Claude Code id that is not a UUID is looked up by context only.
		if got, err := s.LookupOTLPSession(ctx, child, root, "not-a-uuid"); err != nil || got.ReportedElsewhere {
			t.Fatalf("lookup with a non-UUID Claude Code id = %+v, %v", got, err)
		}
	})
}
