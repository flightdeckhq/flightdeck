package session

import (
	"context"
	"database/sql"
	"strings"
	"sync"
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

		attached, prior, err := s.Attach(ctx, randomUUID(t), "")
		if err != nil || attached || prior != "" {
			t.Fatalf("Attach of an unknown session = %v, %q, %v; want false, \"\", nil", attached, prior, err)
		}

		seq := int64(7)
		closed := randomUUID(t)
		insertSession(t, db, closed, "closed", "", "", &seq)
		attached, prior, err = s.Attach(ctx, strings.ToUpper(closed), "")
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
		if attached, prior, err := s.Attach(ctx, lost, ""); err != nil || !attached || prior != "lost" {
			t.Fatalf("Attach of a lost session = %v, %q, %v; want true, lost, nil", attached, prior, err)
		}
		if state, _, _, _ := rowState(t, db, lost); state != "active" {
			t.Fatalf("a lost session was not revived: %s", state)
		}

		active := randomUUID(t)
		insertSession(t, db, active, "active", "", "", nil)
		for range 2 {
			if attached, prior, err := s.Attach(ctx, active, ""); err != nil || !attached || prior != "active" {
				t.Fatalf("Attach of an active session = %v, %q, %v; want true, active, nil", attached, prior, err)
			}
		}
		if attachments(t, db, active) != 2 {
			t.Fatalf("%d attachments recorded, want one per call", attachments(t, db, active))
		}
	})
}

// receipts counts the session_start receipts of id.
func receipts(t *testing.T, db *storage.DB, eventID string) int {
	t.Helper()
	var n int
	if err := db.Reader().QueryRowContext(context.Background(),
		`SELECT count(*) FROM session_start_receipts WHERE event_id = $1`, eventID).Scan(&n); err != nil {
		t.Fatalf("count receipts: %v", err)
	}
	return n
}

// A session_start that carries an id is attached once per id. A copy of
// a session's first start, resent after the worker created the row, is
// answered as the first copy was (not attached) and records no
// attachment; a copy of a re-attaching start does not revive the row
// again and records no second attachment; a new id is a new start. Many
// copies at once still attach once. Receipts past their retention are
// deleted.
func TestAttachIsIdempotentPerEventIDOnBothBackends(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		s := NewStore(db)
		forget := func(ids ...string) {
			t.Cleanup(func() {
				for _, id := range ids {
					_, _ = db.ExecContext(context.Background(), `DELETE FROM session_start_receipts WHERE event_id = $1`, id)
				}
			})
		}

		// The first start of a new session, and a copy of it after the
		// worker stored the row.
		fresh, first := randomUUID(t), randomUUID(t)
		forget(first)
		if attached, _, err := s.Attach(ctx, fresh, first); err != nil || attached {
			t.Fatalf("first copy: attached=%v err=%v, want false", attached, err)
		}
		insertSession(t, db, fresh, "active", "", "", nil)
		attached, prior, err := s.Attach(ctx, fresh, strings.ToUpper(first))
		if err != nil || attached || prior != "" {
			t.Fatalf("resent copy: %v, %q, %v; want the first copy's answer (false) and no prior state", attached, prior, err)
		}
		if n := attachments(t, db, fresh); n != 0 {
			t.Fatalf("a resent first start recorded %d attachments, want 0", n)
		}
		if n := receipts(t, db, first); n != 1 {
			t.Fatalf("%d receipts for the start, want 1", n)
		}

		// A genuine re-attach (a new id) attaches; its copy does not
		// revive the row a second time or add an attachment.
		again := randomUUID(t)
		forget(again)
		if attached, prior, err := s.Attach(ctx, fresh, again); err != nil || !attached || prior != "active" {
			t.Fatalf("re-attach with a new id: %v, %q, %v; want true, active", attached, prior, err)
		}
		closedSeq := int64(9)
		closed, reopen := randomUUID(t), randomUUID(t)
		forget(reopen)
		insertSession(t, db, closed, "closed", "", "", &closedSeq)
		if attached, prior, err := s.Attach(ctx, closed, reopen); err != nil || !attached || prior != "closed" {
			t.Fatalf("re-attach of a closed row: %v, %q, %v; want true, closed", attached, prior, err)
		}
		if _, err := db.ExecContext(ctx, `UPDATE sessions SET state = 'closed', closed_seq = 11 WHERE session_id = $1`, closed); err != nil {
			t.Fatal(err)
		}
		if attached, prior, err := s.Attach(ctx, closed, reopen); err != nil || !attached || prior != "" {
			t.Fatalf("copy of the re-attach: %v, %q, %v; want the first answer (true) and no prior state", attached, prior, err)
		}
		if state, _, _, _ := rowState(t, db, closed); state != "closed" {
			t.Fatalf("a resent re-attach revived the row again: %s", state)
		}
		if n := attachments(t, db, closed); n != 1 {
			t.Fatalf("%d attachments after a resent re-attach, want 1", n)
		}

		// Copies arriving together attach once.
		busy, burst := randomUUID(t), randomUUID(t)
		forget(burst)
		insertSession(t, db, busy, "active", "", "", nil)
		var wg sync.WaitGroup
		answers := make(chan bool, 8)
		for range 8 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				attached, _, err := s.Attach(ctx, busy, burst)
				if err != nil {
					t.Errorf("concurrent copy: %v", err)
				}
				answers <- attached
			}()
		}
		wg.Wait()
		close(answers)
		for a := range answers {
			if !a {
				t.Fatal("a concurrent copy was not given the first copy's answer (true)")
			}
		}
		if n := attachments(t, db, busy); n != 1 {
			t.Fatalf("%d attachments from concurrent copies, want 1", n)
		}

		// A receipt past its retention goes with the next attach; a
		// recent one stays.
		old, recent := randomUUID(t), randomUUID(t)
		forget(old, recent)
		for _, r := range []struct {
			id  string
			age time.Duration
		}{{old, sessionStartReceiptRetention + time.Hour}, {recent, time.Hour}} {
			if _, err := db.ExecContext(ctx,
				`INSERT INTO session_start_receipts (event_id, session_id, received_at) VALUES ($1, $2, `+
					db.Dialect.AddInterval(db.Dialect.Now(), "$3")+`)`,
				r.id, randomUUID(t), -int64(r.age/time.Second)); err != nil {
				t.Fatal(err)
			}
		}
		next := randomUUID(t)
		forget(next)
		if _, _, err := s.Attach(ctx, randomUUID(t), next); err != nil {
			t.Fatal(err)
		}
		if receipts(t, db, old) != 0 || receipts(t, db, recent) != 1 {
			t.Fatalf("after an attach: old receipt kept=%d, recent kept=%d; want 0 and 1", receipts(t, db, old), receipts(t, db, recent))
		}

		// Another session's start id is not a copy of this session's
		// start: this session gets its own answer (no row: not attached),
		// nothing is recorded under the id for it, and the other
		// session's receipt is left as it was.
		stranger := randomUUID(t)
		attached, prior, err = s.Attach(ctx, stranger, reopen)
		if err != nil || attached || prior != "" {
			t.Fatalf("a start reusing another session's id: %v, %q, %v; want this session's own answer (false)", attached, prior, err)
		}
		insertSession(t, db, stranger, "active", "", "", nil)
		for range 2 {
			if attached, prior, err := s.Attach(ctx, stranger, reopen); err != nil || !attached || prior != "active" {
				t.Fatalf("a start reusing another session's id, row present: %v, %q, %v; want attached as an id-less start", attached, prior, err)
			}
		}
		if n := attachments(t, db, stranger); n != 2 {
			t.Fatalf("%d attachments for the clashing start, want one per arrival (2)", n)
		}
		var owner string
		var ownerAttached bool
		if err := db.Reader().QueryRowContext(ctx,
			`SELECT CAST(session_id AS TEXT), attached FROM session_start_receipts WHERE event_id = $1`, reopen,
		).Scan(&owner, &ownerAttached); err != nil {
			t.Fatal(err)
		}
		if owner != closed || !ownerAttached {
			t.Fatalf("the receipt is %s attached=%v, want the first session's (%s, true) kept", owner, ownerAttached, closed)
		}

		// An id that is not a UUID is no key: every arrival attaches.
		if attached, _, err := s.Attach(ctx, busy, "not-a-uuid"); err != nil || !attached {
			t.Fatalf("a start with a non-UUID id: %v, %v; want attached", attached, err)
		}
		if attached, _, err := s.Attach(ctx, busy, "not-a-uuid"); err != nil || !attached {
			t.Fatalf("its second arrival: %v, %v; want attached", attached, err)
		}
		if n := attachments(t, db, busy); n != 3 {
			t.Fatalf("%d attachments, want 3 (one per arrival of an id-less start)", n)
		}
	})
}

// RecordStart stamps once per start event id: a copy's later sequence
// does not replace the first copy's, and a start with no receipt is
// stamped as before.
func TestRecordStartIsIdempotentPerEventIDOnBothBackends(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		s := NewStore(db)
		row, start := randomUUID(t), randomUUID(t)
		t.Cleanup(func() {
			_, _ = db.ExecContext(context.Background(), `DELETE FROM session_start_receipts WHERE event_id = $1`, start)
		})
		insertSession(t, db, row, "active", "", "", nil)
		if attached, _, err := s.Attach(ctx, row, start); err != nil || !attached {
			t.Fatalf("attach: %v, %v", attached, err)
		}
		if err := s.RecordStart(ctx, row, start, 10); err != nil {
			t.Fatal(err)
		}
		if err := s.RecordStart(ctx, row, strings.ToUpper(start), 20); err != nil {
			t.Fatal(err)
		}
		if _, _, startSeq, _ := rowState(t, db, row); startSeq.Int64 != 10 {
			t.Fatalf("start_seq = %v after a copy's stamp, want the first copy's 10", startSeq)
		}
		var receiptSeq sql.NullInt64
		if err := db.Reader().QueryRowContext(ctx,
			`SELECT start_seq FROM session_start_receipts WHERE event_id = $1`, start).Scan(&receiptSeq); err != nil {
			t.Fatal(err)
		}
		if receiptSeq.Int64 != 10 {
			t.Fatalf("receipt start_seq = %v, want 10", receiptSeq)
		}
		// The narrow race: a copy published later stamps before the
		// first copy does. The first copy's lower sequence replaces it
		// on the receipt and on the row; a still later copy changes
		// nothing.
		raced, racedStart := randomUUID(t), randomUUID(t)
		t.Cleanup(func() {
			_, _ = db.ExecContext(context.Background(), `DELETE FROM session_start_receipts WHERE event_id = $1`, racedStart)
		})
		insertSession(t, db, raced, "active", "", "", nil)
		if attached, _, err := s.Attach(ctx, raced, racedStart); err != nil || !attached {
			t.Fatalf("attach: %v, %v", attached, err)
		}
		for _, seq := range []uint64{25, 15, 35} {
			if err := s.RecordStart(ctx, raced, racedStart, seq); err != nil {
				t.Fatal(err)
			}
		}
		if _, _, startSeq, _ := rowState(t, db, raced); startSeq.Int64 != 15 {
			t.Fatalf("start_seq = %v after the copies' stamps 25, 15, 35; want the lowest, 15", startSeq)
		}
		if err := db.Reader().QueryRowContext(ctx,
			`SELECT start_seq FROM session_start_receipts WHERE event_id = $1`, racedStart).Scan(&receiptSeq); err != nil {
			t.Fatal(err)
		}
		if receiptSeq.Int64 != 15 {
			t.Fatalf("receipt start_seq = %v, want 15", receiptSeq)
		}
		// Once a later start (a new id) has stamped the row, a late first
		// copy of the earlier start lowers its receipt only.
		later := randomUUID(t)
		t.Cleanup(func() {
			_, _ = db.ExecContext(context.Background(), `DELETE FROM session_start_receipts WHERE event_id = $1`, later)
		})
		if _, _, err := s.Attach(ctx, raced, later); err != nil {
			t.Fatal(err)
		}
		if err := s.RecordStart(ctx, raced, later, 50); err != nil {
			t.Fatal(err)
		}
		if err := s.RecordStart(ctx, raced, racedStart, 12); err != nil {
			t.Fatal(err)
		}
		if _, _, startSeq, _ := rowState(t, db, raced); startSeq.Int64 != 50 {
			t.Fatalf("start_seq = %v, want the later start's 50 kept", startSeq)
		}

		// A start reusing another session's id is stamped as a start
		// without an id: the other session's receipt is not its own.
		// Session A starts with id X (receipt sequence 1); session B,
		// stamped at 2 and closed at 3, starts again reusing X,
		// published at 4: B's row takes 4, so a session_end queued at 3
		// cannot close the revived run, and A's receipt keeps 1.
		owner, reuser, shared := randomUUID(t), randomUUID(t), randomUUID(t)
		t.Cleanup(func() {
			_, _ = db.ExecContext(context.Background(), `DELETE FROM session_start_receipts WHERE event_id = $1`, shared)
		})
		insertSession(t, db, owner, "active", "", "", nil)
		if attached, _, err := s.Attach(ctx, owner, shared); err != nil || !attached {
			t.Fatalf("owner attach: %v, %v", attached, err)
		}
		if err := s.RecordStart(ctx, owner, shared, 1); err != nil {
			t.Fatal(err)
		}
		closedAt := int64(3)
		insertSession(t, db, reuser, "closed", "", "", &closedAt)
		if _, err := db.ExecContext(ctx, `UPDATE sessions SET start_seq = 2 WHERE session_id = $1`, reuser); err != nil {
			t.Fatal(err)
		}
		if attached, prior, err := s.Attach(ctx, reuser, shared); err != nil || !attached || prior != "closed" {
			t.Fatalf("reusing start: %v, %q, %v; want attached, closed", attached, prior, err)
		}
		if err := s.RecordStart(ctx, reuser, shared, 4); err != nil {
			t.Fatal(err)
		}
		if state, _, startSeq, _ := rowState(t, db, reuser); startSeq.Int64 != 4 || state != "active" {
			t.Fatalf("the reusing session: state=%s start_seq=%v, want active at 4 (stamped as an id-less start)", state, startSeq)
		}
		if err := db.Reader().QueryRowContext(ctx,
			`SELECT start_seq FROM session_start_receipts WHERE event_id = $1`, shared).Scan(&receiptSeq); err != nil {
			t.Fatal(err)
		}
		if receiptSeq.Int64 != 1 {
			t.Fatalf("the owner's receipt start_seq = %v, want its own 1 kept", receiptSeq)
		}

		// No receipt (the attach fell back): stamped as before.
		if err := s.RecordStart(ctx, row, randomUUID(t), 30); err != nil {
			t.Fatal(err)
		}
		if _, _, startSeq, _ := rowState(t, db, row); startSeq.Int64 != 30 {
			t.Fatalf("start_seq = %v after a start without a receipt, want 30", startSeq)
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
		if err := s.RecordStart(ctx, open, "", 10); err != nil {
			t.Fatal(err)
		}
		if _, _, startSeq, _ := rowState(t, db, open); !startSeq.Valid || startSeq.Int64 != 10 {
			t.Fatalf("start_seq = %v, want 10", startSeq)
		}
		// A smaller sequence never lowers the stamp.
		if err := s.RecordStart(ctx, open, "", 4); err != nil {
			t.Fatal(err)
		}
		if _, _, startSeq, _ := rowState(t, db, open); startSeq.Int64 != 10 {
			t.Fatalf("start_seq = %v after a smaller stamp, want 10 kept", startSeq)
		}

		earlier := int64(5)
		closedEarly := randomUUID(t)
		insertSession(t, db, closedEarly, "closed", "", "", &earlier)
		logs := captureLogs(t)
		if err := s.RecordStart(ctx, strings.ToUpper(closedEarly), "", 12); err != nil {
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
		if err := s.RecordStart(ctx, closedLate, "", 12); err != nil {
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
