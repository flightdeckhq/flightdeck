package writer

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// sentinelWait bounds how long a test waits for its own sentinel
// notification. A notification reaches a listener on the same database
// within milliseconds; the bound only turns a broken run into a failure
// instead of a hang.
const sentinelWait = 10 * time.Second

// isolatedPool returns a pool whose unqualified tables resolve to a
// scratch schema holding empty copies of sessions and events. The
// reconciler's and the reaper's UPDATEs act on every eligible row, so
// against the shared database they would move sessions the test does
// not own; in the scratch schema they see only the test's rows. The
// notifications still go out on the database's flightdeck_fleet
// channel, where a running API hub reads them, finds no such session
// in public.sessions and broadcasts nothing.
func isolatedPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	admin := testPool(t) // skips when no database is configured
	ctx := context.Background()
	schema := "writer_test_" + strings.ReplaceAll(newUUID(t), "-", "")[:12]
	for _, q := range []string{
		`CREATE SCHEMA ` + schema,
		`CREATE TABLE ` + schema + `.sessions (LIKE public.sessions INCLUDING ALL)`,
		`CREATE TABLE ` + schema + `.events (LIKE public.events INCLUDING ALL)`,
	} {
		if _, err := admin.Exec(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`); err != nil {
			t.Errorf("drop schema %s: %v", schema, err)
		}
	})

	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		dsn = os.Getenv("FLIGHTDECK_POSTGRES_URL")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("open isolated pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// insertSession adds a session in the given state whose last signal was
// silentFor ago, and returns its id.
func insertSession(t *testing.T, pool *pgxpool.Pool, state string, silentFor time.Duration) string {
	t.Helper()
	id := newUUID(t)
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO sessions (session_id, flavor, agent_type, state, started_at, last_seen_at)
		VALUES ($1::uuid, 'transition-notify-test', 'coding', $2,
		        NOW() - make_interval(secs => $3) - INTERVAL '1 minute',
		        NOW() - make_interval(secs => $3))`,
		id, state, silentFor.Seconds()); err != nil {
		t.Fatalf("insert %s session: %v", state, err)
	}
	return id
}

func sessionState(t *testing.T, pool *pgxpool.Pool, id string) string {
	t.Helper()
	var state string
	if err := pool.QueryRow(context.Background(),
		`SELECT state FROM sessions WHERE session_id = $1::uuid`, id).Scan(&state); err != nil {
		t.Fatalf("read state of %s: %v", id, err)
	}
	return state
}

// fleetListener holds a connection subscribed to flightdeck_fleet.
type fleetListener struct {
	pool *pgxpool.Pool
	conn *pgxpool.Conn
}

func listenFleet(t *testing.T, pool *pgxpool.Pool) *fleetListener {
	t.Helper()
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire listen conn: %v", err)
	}
	if _, err := conn.Exec(ctx, "LISTEN "+notifyChannel); err != nil {
		conn.Release()
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() {
		_, _ = conn.Exec(context.Background(), "UNLISTEN *")
		conn.Release()
	})
	return &fleetListener{pool: pool, conn: conn}
}

// received returns, in arrival order, the notifications naming one of
// ids that arrived before a sentinel the call sends now. Postgres
// delivers notifications in commit order, so once the sentinel arrives
// every notification committed before this call has too: the result is
// complete without sleeping. Other sessions' notifications (a running
// worker shares the channel) are ignored.
func (l *fleetListener) received(t *testing.T, ids ...string) []fleetNotifyPayload {
	t.Helper()
	want := make(map[string]bool, len(ids))
	for _, id := range ids {
		want[id] = true
	}
	ctx, cancel := context.WithTimeout(context.Background(), sentinelWait)
	defer cancel()
	sentinel := newUUID(t)
	if err := notifyFleet(ctx, l.pool, []fleetNotifyPayload{{SessionID: sentinel}}); err != nil {
		t.Fatalf("send sentinel: %v", err)
	}
	var got []fleetNotifyPayload
	for {
		n, err := l.conn.Conn().WaitForNotification(ctx)
		if err != nil {
			t.Fatalf("wait for the sentinel notification: %v", err)
		}
		var p fleetNotifyPayload
		if json.Unmarshal([]byte(n.Payload), &p) != nil {
			continue
		}
		if p.SessionID == sentinel {
			return got
		}
		if want[p.SessionID] {
			got = append(got, p)
		}
	}
}

func sessionIDsOf(payloads []fleetNotifyPayload) []string {
	ids := make([]string, len(payloads))
	for i, p := range payloads {
		ids[i] = p.SessionID
	}
	sort.Strings(ids)
	return ids
}

func sorted(ids ...string) []string {
	out := append([]string(nil), ids...)
	sort.Strings(out)
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// The reconciler announces each session it moves, once, with a
// state-only payload, and nothing for the sessions it leaves alone.
func TestReconcileStaleSessions_AnnouncesEachSessionItMoves(t *testing.T) {
	pool := isolatedPool(t)
	w := New(pool)
	listener := listenFleet(t, pool)

	goingStale := insertSession(t, pool, "active", 3*time.Minute)
	idleGoingStale := insertSession(t, pool, "idle", 3*time.Minute)
	goingLost := insertSession(t, pool, "stale", 31*time.Minute)
	// Silent past both thresholds: marked stale, then lost, in one pass.
	straightToLost := insertSession(t, pool, "active", 31*time.Minute)
	fresh := insertSession(t, pool, "active", 10*time.Second)
	alreadyLost := insertSession(t, pool, "lost", 31*time.Minute)
	closed := insertSession(t, pool, "closed", 31*time.Minute)

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
		if state := sessionState(t, pool, id); state != want {
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
}

// The reaper announces each close as a session_end naming the
// synthetic event it wrote, so the hub broadcasts it like any close.
func TestReapOrphanedLostSessions_AnnouncesTheCloseWithItsSessionEnd(t *testing.T) {
	pool := isolatedPool(t)
	w := New(pool)
	listener := listenFleet(t, pool)

	expired := insertSession(t, pool, "lost", 25*time.Hour)
	recentLost := insertSession(t, pool, "lost", time.Hour)
	oldStale := insertSession(t, pool, "stale", 25*time.Hour)

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
	if err := pool.QueryRow(context.Background(), `
		SELECT id::text, payload->>'close_reason' FROM events
		WHERE session_id = $1::uuid AND event_type = 'session_end'`, expired).Scan(&endID, &reason); err != nil {
		t.Fatalf("read the synthetic session_end: %v", err)
	}
	if got[0].EventID != endID {
		t.Errorf("event_id = %q, want the synthetic session_end %q", got[0].EventID, endID)
	}
	if reason != "orphan_timeout" {
		t.Errorf("close_reason = %q, want orphan_timeout", reason)
	}
	if state := sessionState(t, pool, expired); state != "closed" {
		t.Errorf("reaped session state = %q, want closed", state)
	}
	for _, id := range []string{recentLost, oldStale} {
		var n int
		if err := pool.QueryRow(context.Background(),
			`SELECT COUNT(*) FROM events WHERE session_id = $1::uuid`, id).Scan(&n); err != nil {
			t.Fatalf("count events of %s: %v", id, err)
		}
		if n != 0 {
			t.Errorf("session %s outside the reap got %d events, want none", id, n)
		}
	}
}

// A child's event that revives its stale or lost parent announces the
// parent once; bumping an active or closed parent announces nothing.
func TestBumpParentLastSeen_AnnouncesARevival(t *testing.T) {
	pool := isolatedPool(t)
	w := New(pool)
	listener := listenFleet(t, pool)

	staleParent := insertSession(t, pool, "stale", 5*time.Minute)
	lostParent := insertSession(t, pool, "lost", 40*time.Minute)
	activeParent := insertSession(t, pool, "active", 10*time.Second)
	closedParent := insertSession(t, pool, "closed", 5*time.Minute)

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
	} {
		revived, err := w.BumpParentLastSeen(ctx, tc.parent)
		if err != nil {
			t.Fatalf("BumpParentLastSeen(%s): %v", tc.parent, err)
		}
		if revived != tc.wantRevived {
			t.Errorf("BumpParentLastSeen(%s) revived = %v, want %v", tc.parent, revived, tc.wantRevived)
		}
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

// refusingQuerier fails the test if anything is sent through it.
type refusingQuerier struct{ t *testing.T }

func (r refusingQuerier) QueryRow(context.Context, string, ...any) pgx.Row {
	r.t.Fatal("unexpected QueryRow")
	return nil
}

func (r refusingQuerier) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	r.t.Fatal("unexpected Exec")
	return pgconn.CommandTag{}, errors.New("unexpected Exec")
}

// Nothing moved, nothing sent: an empty batch makes no round trip.
func TestNotifyFleet_EmptyBatchSendsNothing(t *testing.T) {
	if err := notifyFleet(context.Background(), refusingQuerier{t}, nil); err != nil {
		t.Fatalf("notifyFleet(nil) = %v", err)
	}
}
