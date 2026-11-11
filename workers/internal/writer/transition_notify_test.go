package writer

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// insertSession adds a session in the given state whose last signal was
// silentFor ago, and returns its id.
func insertSession(t *testing.T, db *storage.DB, state string, silentFor time.Duration) string {
	t.Helper()
	id := newUUID(t)
	lastSeen := time.Now().UTC().Add(-silentFor)
	if _, err := db.ExecContext(context.Background(), `
		INSERT INTO sessions (session_id, flavor, agent_type, state, started_at, last_seen_at)
		VALUES ($1, 'transition-notify-test', 'coding', $2, $3, $4)`,
		id, state, lastSeen.Add(-time.Minute), lastSeen); err != nil {
		t.Fatalf("insert %s session: %v", state, err)
	}
	return id
}

func sessionState(t *testing.T, db *storage.DB, id string) string {
	t.Helper()
	var state string
	if err := db.Reader().QueryRowContext(context.Background(),
		`SELECT state FROM sessions WHERE session_id = $1`, id).Scan(&state); err != nil {
		t.Fatalf("read state of %s: %v", id, err)
	}
	return state
}

// The reconciler announces each session it moves, once, with a
// state-only payload, and nothing for the sessions it leaves alone.
func TestReconcileStaleSessions_AnnouncesEachSessionItMoves(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		db = isolatedDB(t, db)
		w, bus := newTestWriter(db)
		listener := listenFleet(t, bus)

		goingStale := insertSession(t, db, "active", 3*time.Minute)
		idleGoingStale := insertSession(t, db, "idle", 3*time.Minute)
		goingLost := insertSession(t, db, "stale", 31*time.Minute)
		// Silent past both thresholds: marked stale, then lost, in one pass.
		straightToLost := insertSession(t, db, "active", 31*time.Minute)
		fresh := insertSession(t, db, "active", 10*time.Second)
		alreadyLost := insertSession(t, db, "lost", 31*time.Minute)
		closed := insertSession(t, db, "closed", 31*time.Minute)

		if err := w.ReconcileStaleSessions(context.Background()); err != nil {
			t.Fatalf("ReconcileStaleSessions: %v", err)
		}

		got := listener.received(t, goingStale, idleGoingStale, goingLost, straightToLost,
			fresh, alreadyLost, closed)
		wantIDs := sorted(goingStale, idleGoingStale, goingLost, straightToLost)
		if ids := sessionIDsOf(got); !equalStrings(ids, wantIDs) {
			t.Fatalf("announced sessions = %v, want each of %v exactly once", ids, wantIDs)
		}
		for _, p := range got {
			if p.EventType != "" || p.EventID != "" {
				t.Errorf("state-only change for %s carried event_type=%q event_id=%q, want both empty",
					p.SessionID, p.EventType, p.EventID)
			}
		}

		for id, want := range map[string]string{
			goingStale: "stale", idleGoingStale: "stale", goingLost: "lost",
			straightToLost: "lost", fresh: "active", alreadyLost: "lost", closed: "closed",
		} {
			if state := sessionState(t, db, id); state != want {
				t.Errorf("session %s state = %q, want %q", id, state, want)
			}
		}

		// A second pass moves nothing and announces nothing.
		if err := w.ReconcileStaleSessions(context.Background()); err != nil {
			t.Fatalf("second ReconcileStaleSessions: %v", err)
		}
		if again := listener.received(t, goingStale, idleGoingStale, goingLost, straightToLost); len(again) != 0 {
			t.Errorf("second pass announced %v, want nothing", sessionIDsOf(again))
		}
	})
}

// The reaper announces each close as a session_end naming the
// synthetic event it wrote, so the hub broadcasts it like any close.
func TestReapOrphanedLostSessions_AnnouncesTheCloseWithItsSessionEnd(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		db = isolatedDB(t, db)
		w, bus := newTestWriter(db)
		listener := listenFleet(t, bus)

		expired := insertSession(t, db, "lost", 25*time.Hour)
		recentLost := insertSession(t, db, "lost", time.Hour)
		oldStale := insertSession(t, db, "stale", 25*time.Hour)

		reaped, err := w.ReapOrphanedLostSessions(context.Background(), 24*time.Hour)
		if err != nil {
			t.Fatalf("ReapOrphanedLostSessions: %v", err)
		}
		if reaped != 1 {
			t.Fatalf("reaped = %d, want 1", reaped)
		}

		got := listener.received(t, expired, recentLost, oldStale)
		if len(got) != 1 || got[0].SessionID != expired {
			t.Fatalf("announced %+v, want one notification for %s", got, expired)
		}
		if got[0].EventType != "session_end" {
			t.Errorf("event_type = %q, want session_end", got[0].EventType)
		}

		var endID, reason string
		if err := db.Reader().QueryRowContext(context.Background(), `
			SELECT CAST(id AS TEXT), `+db.Dialect.JSONText("payload", "close_reason")+` FROM events
			WHERE session_id = $1 AND event_type = 'session_end'`, expired).Scan(&endID, &reason); err != nil {
			t.Fatalf("read the synthetic session_end: %v", err)
		}
		if got[0].EventID != endID {
			t.Errorf("event_id = %q, want the synthetic session_end %q", got[0].EventID, endID)
		}
		if endID != canonicalUUID(endID) || !eventIDPattern.MatchString(endID) {
			t.Errorf("synthetic session_end id %q is not a canonical uuid", endID)
		}
		if reason != "orphan_timeout" {
			t.Errorf("close_reason = %q, want orphan_timeout", reason)
		}
		if state := sessionState(t, db, expired); state != "closed" {
			t.Errorf("reaped session state = %q, want closed", state)
		}
		for _, id := range []string{recentLost, oldStale} {
			var n int
			if err := db.Reader().QueryRowContext(context.Background(),
				`SELECT COUNT(*) FROM events WHERE session_id = $1`, id).Scan(&n); err != nil {
				t.Fatalf("count events of %s: %v", id, err)
			}
			if n != 0 {
				t.Errorf("session %s outside the reap got %d events, want none", id, n)
			}
		}
		// A second pass reaps nothing.
		if reaped, err := w.ReapOrphanedLostSessions(context.Background(), 24*time.Hour); err != nil || reaped != 0 {
			t.Errorf("second reap: %d, %v; want 0, nil", reaped, err)
		}
	})
}

// A child's event that revives its stale or lost parent announces the
// parent once; bumping an active or closed parent announces nothing.
func TestBumpParentLastSeen_AnnouncesARevival(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		db = isolatedDB(t, db)
		w, bus := newTestWriter(db)
		listener := listenFleet(t, bus)

		staleParent := insertSession(t, db, "stale", 5*time.Minute)
		lostParent := insertSession(t, db, "lost", 40*time.Minute)
		activeParent := insertSession(t, db, "active", 10*time.Second)
		closedParent := insertSession(t, db, "closed", 5*time.Minute)

		ctx := context.Background()
		for _, tc := range []struct {
			parent      string
			wantRevived bool
		}{
			{staleParent, true},
			{lostParent, true},
			{activeParent, false},
			{closedParent, false},
			// The revived parent is active now: a second child event bumps
			// it without another announcement.
			{staleParent, false},
			// A missing parent is a no-op, not an error.
			{newUUID(t), false},
		} {
			revived, err := w.BumpParentLastSeen(ctx, tc.parent)
			if err != nil {
				t.Fatalf("BumpParentLastSeen(%s): %v", tc.parent, err)
			}
			if revived != tc.wantRevived {
				t.Errorf("BumpParentLastSeen(%s) revived = %v, want %v", tc.parent, revived, tc.wantRevived)
			}
		}
		if state := sessionState(t, db, closedParent); state != "closed" {
			t.Errorf("closed parent state = %q, want closed", state)
		}

		got := listener.received(t, staleParent, lostParent, activeParent, closedParent)
		wantIDs := sorted(staleParent, lostParent)
		if ids := sessionIDsOf(got); !equalStrings(ids, wantIDs) {
			t.Fatalf("announced %v, want one notification each for %v", ids, wantIDs)
		}
		for _, p := range got {
			if p.EventType != "" || p.EventID != "" {
				t.Errorf("revival of %s carried event_type=%q event_id=%q, want a state-only change",
					p.SessionID, p.EventType, p.EventID)
			}
		}
	})
}

// A state-only payload decodes, field for field, into the shape the
// hub reads, with empty event_type and event_id, and stays far under
// Postgres's 8000-byte payload limit.
func TestStateChanges_PayloadShapeAndDedup(t *testing.T) {
	a, b := "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
	got := stateChanges([]string{a, b}, []string{b}, nil, []string{a})
	if len(got) != 2 || got[0].SessionID != a || got[1].SessionID != b {
		t.Fatalf("stateChanges = %+v, want %s then %s once each", got, a, b)
	}
	data, err := json.Marshal(got[0])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var hubSide struct {
		SessionID string `json:"session_id"`
		EventType string `json:"event_type"`
		EventID   string `json:"event_id"`
	}
	if err := json.Unmarshal(data, &hubSide); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if hubSide.SessionID != a || hubSide.EventType != "" || hubSide.EventID != "" {
		t.Errorf("decoded %+v, want session %s with empty event fields", hubSide, a)
	}
	full, err := json.Marshal(fleetNotifyPayload{SessionID: a, EventType: "session_end", EventID: b})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(full) > 200 {
		t.Errorf("payload is %d bytes, want a small fixed size far under 8000", len(full))
	}
}

// refusingBus fails the test if anything is published through it.
type refusingBus struct{ t *testing.T }

func (r refusingBus) Publish(context.Context, string, string) error {
	r.t.Fatal("unexpected Publish")
	return nil
}

func (r refusingBus) Subscribe(context.Context, string) (<-chan string, error) {
	r.t.Fatal("unexpected Subscribe")
	return nil, nil
}

// Nothing moved, nothing sent: an empty batch publishes nothing.
func TestNotifyFleet_EmptyBatchSendsNothing(t *testing.T) {
	if err := notifyFleet(context.Background(), refusingBus{t}, nil); err != nil {
		t.Fatalf("notifyFleet(nil) = %v", err)
	}
}

// Every notification of a committed change is published on the fleet
// channel with the payload the hub reads, event announcements and
// state-only changes alike.
func TestNotifyFleetChange_PublishesThePayloadTheHubReads(t *testing.T) {
	bus := storage.NewInProcessBus()
	listener := listenFleet(t, bus)
	ctx := context.Background()
	if err := NotifyFleetChange(ctx, bus, "11111111-1111-4111-8111-111111111111", "post_call", "22222222-2222-4222-8222-222222222222"); err != nil {
		t.Fatal(err)
	}
	got := listener.received(t, "11111111-1111-4111-8111-111111111111")
	if len(got) != 1 || got[0].EventType != "post_call" || got[0].EventID != "22222222-2222-4222-8222-222222222222" {
		t.Fatalf("received %+v, want one post_call notification with its event id", got)
	}
}
