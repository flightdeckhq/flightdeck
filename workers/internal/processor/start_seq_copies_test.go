package processor

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
)

// Two copies of one session_start in flight at once, neither stored yet,
// both reach HandleSessionStart (Process drops a copy whose id is
// already stored before any side effect). The session row keeps the
// lowest stream sequence of the copies, whichever the worker handles
// first, as ingestion's re-attachment stamp does; a start without a
// receipt keeps the greater sequence of the starts, as before.
func TestHandleSessionStart_KeepsTheLowestSequenceOfOneStartsCopies(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		sp := newTestSessionProcessor(db)
		agentID := randomID(t)
		t.Cleanup(func() { _, _ = db.ExecContext(ctx, `DELETE FROM agents WHERE agent_id = $1`, agentID) })

		start := func(sessionID, eventID string, seq uint64) consumer.EventPayload {
			return consumer.EventPayload{
				ID: eventID, SessionID: sessionID, EventType: "session_start",
				Flavor: "processor-test-copies", AgentType: "coding",
				AgentID: agentID, ClientType: "flightdeck_sensor",
				AgentName: "processor-test-copies", User: "test", Hostname: "test-host",
				Timestamp: time.Now().UTC().Format(time.RFC3339), StreamSeq: seq,
			}
		}
		// receipt writes the start's receipt, as ingestion's attach does.
		receipt := func(sessionID, eventID string) {
			if _, err := db.ExecContext(ctx,
				`INSERT INTO session_start_receipts (event_id, session_id) VALUES ($1, $2)`, eventID, sessionID); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				_, _ = db.ExecContext(ctx, `DELETE FROM session_start_receipts WHERE event_id = $1`, eventID)
			})
		}
		startSeq := func(sessionID string) int64 {
			var seq sql.NullInt64
			if err := db.Reader().QueryRowContext(ctx,
				`SELECT start_seq FROM sessions WHERE session_id = $1`, sessionID).Scan(&seq); err != nil {
				t.Fatal(err)
			}
			return seq.Int64
		}

		for _, tc := range []struct {
			name  string
			order []uint64
		}{
			{"the first copy is handled first", []uint64{10, 20}},
			{"the later copy is handled first", []uint64{20, 10}},
		} {
			sid, eid := randomID(t), randomID(t)
			cleanupSession(t, db, sid)
			receipt(sid, eid)
			for _, seq := range tc.order {
				if err := sp.HandleSessionStart(ctx, start(sid, eid, seq)); err != nil {
					t.Fatalf("%s: seq %d: %v", tc.name, seq, err)
				}
			}
			if got := startSeq(sid); got != 10 {
				t.Errorf("%s: start_seq = %d, want the lowest copy's 10", tc.name, got)
			}
		}

		// A later start of the session (a new id) stamped the row since:
		// a late lower copy of the earlier start leaves it alone.
		sid, early, later := randomID(t), randomID(t), randomID(t)
		cleanupSession(t, db, sid)
		receipt(sid, early)
		receipt(sid, later)
		for _, ev := range []consumer.EventPayload{start(sid, early, 20), start(sid, later, 50), start(sid, early, 10)} {
			if err := sp.HandleSessionStart(ctx, ev); err != nil {
				t.Fatal(err)
			}
		}
		if got := startSeq(sid); got != 50 {
			t.Errorf("start_seq = %d after a later start, want its 50 kept", got)
		}

		// A start reusing another session's id: the other session's
		// receipt is not its own, so it upserts with its own sequence, as
		// a start without a receipt does, and the receipt is left alone.
		owner, reuser, shared := randomID(t), randomID(t), randomID(t)
		cleanupSession(t, db, owner)
		cleanupSession(t, db, reuser)
		receipt(owner, shared)
		if err := sp.HandleSessionStart(ctx, start(owner, shared, 1)); err != nil {
			t.Fatal(err)
		}
		if err := sp.HandleSessionStart(ctx, start(reuser, randomID(t), 2)); err != nil {
			t.Fatal(err)
		}
		if err := sp.HandleSessionStart(ctx, start(reuser, shared, 4)); err != nil {
			t.Fatal(err)
		}
		if got := startSeq(reuser); got != 4 {
			t.Errorf("start_seq = %d for a start reusing another session's id, want its own 4", got)
		}
		var ownerReceipt sql.NullInt64
		if err := db.Reader().QueryRowContext(ctx,
			`SELECT start_seq FROM session_start_receipts WHERE event_id = $1`, shared).Scan(&ownerReceipt); err != nil {
			t.Fatal(err)
		}
		if ownerReceipt.Int64 != 1 {
			t.Errorf("the owner's receipt start_seq = %v, want its own 1", ownerReceipt)
		}

		// No receipt: the greater sequence of the starts, as before.
		plain := randomID(t)
		cleanupSession(t, db, plain)
		for _, seq := range []uint64{10, 20} {
			if err := sp.HandleSessionStart(ctx, start(plain, randomID(t), seq)); err != nil {
				t.Fatal(err)
			}
		}
		if got := startSeq(plain); got != 20 {
			t.Errorf("start_seq = %d for starts without receipts, want the greater, 20", got)
		}
	})
}
