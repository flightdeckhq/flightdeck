package writer

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// The writer's database tests run on both backends through
// storagetest.Each: SQLite on a fresh file per test, Postgres on the
// database TEST_POSTGRES_URL names (scripts/go-db-tests.sh gives the
// package one of its own). Postgres tests share that database, so each
// keeps to the rows it creates and removes them.

// newUUID returns a random version-4 UUID string.
func newUUID(t *testing.T) string {
	t.Helper()
	return NewUUID()
}

// newTestWriter returns a writer on db and the bus it announces on.
func newTestWriter(db *storage.DB) (*Writer, storage.Bus) {
	bus := storage.NewBus(db)
	return New(db, bus), bus
}

// dbNow reads the database's clock, which the statements' current time
// is. SQLite keeps milliseconds, so a stored value compares against it
// at that precision on both backends.
func dbNow(t *testing.T, db *storage.DB) time.Time {
	t.Helper()
	var now storage.Time
	if err := db.Reader().QueryRowContext(context.Background(), "SELECT "+db.Dialect.Now()).Scan(&now); err != nil {
		t.Fatalf("read the database clock: %v", err)
	}
	return now.Time.Truncate(time.Millisecond)
}

// ago is a time d before now at millisecond precision, the coarser of
// the two backends' (Postgres keeps microseconds, SQLite
// milliseconds), so a stored value compares equal to it on both.
func ago(d time.Duration) time.Time {
	return time.Now().UTC().Add(-d).Truncate(time.Millisecond)
}

// within fails the test unless got lies in [lo, hi].
func within(t *testing.T, what string, got, lo, hi time.Time) {
	t.Helper()
	got = got.Truncate(time.Millisecond)
	if got.Before(lo) || got.After(hi) {
		t.Errorf("%s = %s, want the database's clock, between %s and %s", what, got, lo, hi)
	}
}

func equalTime(t *testing.T, what string, got, want time.Time) {
	t.Helper()
	if !got.Truncate(time.Millisecond).Equal(want.Truncate(time.Millisecond)) {
		t.Errorf("%s = %s, want %s", what, got, want)
	}
}

// isolatedDB returns a database whose unqualified tables resolve to
// empty copies of sessions and events. The reconciler's and the
// reaper's UPDATEs act on every eligible row, so against the shared
// Postgres database they would move sessions the test does not own; in
// a scratch schema they see only the test's rows. The notifications
// still go out on the database's flightdeck_fleet channel, where a
// running API hub reads them, finds no such session in public.sessions
// and broadcasts nothing. On SQLite every test already has a database
// of its own, so db is returned as is.
func isolatedDB(t *testing.T, db *storage.DB) *storage.DB {
	t.Helper()
	if db.Backend != storage.Postgres {
		return db
	}
	ctx := context.Background()
	schema := "writer_test_" + strings.ReplaceAll(newUUID(t), "-", "")[:12]
	for _, q := range []string{
		`CREATE SCHEMA ` + schema,
		`CREATE TABLE ` + schema + `.sessions (LIKE public.sessions INCLUDING ALL)`,
		`CREATE TABLE ` + schema + `.events (LIKE public.events INCLUDING ALL)`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	t.Cleanup(func() {
		if _, err := db.ExecContext(ctx, `DROP SCHEMA `+schema+` CASCADE`); err != nil {
			t.Errorf("drop schema %s: %v", schema, err)
		}
	})
	// pgx passes a URL query key it does not know to the server as a
	// runtime parameter, so every connection of this pool resolves
	// unqualified names in the scratch schema.
	sep := "?"
	if strings.Contains(db.URL(), "?") {
		sep = "&"
	}
	isolated, err := storage.Open(ctx, db.URL()+sep+"search_path="+schema)
	if err != nil {
		t.Fatalf("open isolated database: %v", err)
	}
	t.Cleanup(func() { _ = isolated.Close() })
	return isolated
}

// fleetListener is a subscription to flightdeck_fleet.
type fleetListener struct {
	bus storage.Bus
	ch  <-chan string
}

// listenFleet subscribes to the fleet channel of bus for the rest of
// the test.
func listenFleet(t *testing.T, bus storage.Bus) *fleetListener {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	ch, err := bus.Subscribe(ctx, notifyChannel)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	return &fleetListener{bus: bus, ch: ch}
}

// sentinelWait bounds how long a test waits for its own sentinel
// notification. A notification reaches a subscriber on the same bus
// within milliseconds; the bound only turns a broken run into a failure
// instead of a hang.
const sentinelWait = 10 * time.Second

// received returns, in arrival order, the notifications naming one of
// ids that arrived before a sentinel the call sends now. Both buses
// deliver in publication order (Postgres in commit order), so once the
// sentinel arrives every notification published before this call has
// too: the result is complete without sleeping. Other sessions'
// notifications (a running worker shares the Postgres channel) are
// ignored.
func (l *fleetListener) received(t *testing.T, ids ...string) []fleetNotifyPayload {
	t.Helper()
	want := make(map[string]bool, len(ids))
	for _, id := range ids {
		want[id] = true
	}
	ctx, cancel := context.WithTimeout(context.Background(), sentinelWait)
	defer cancel()
	sentinel := newUUID(t)
	if err := notifyFleet(ctx, l.bus, []fleetNotifyPayload{{SessionID: sentinel}}); err != nil {
		t.Fatalf("send sentinel: %v", err)
	}
	var got []fleetNotifyPayload
	for {
		var raw string
		select {
		case raw = <-l.ch:
		case <-ctx.Done():
			t.Fatalf("the sentinel notification did not arrive within %s", sentinelWait)
		}
		var p fleetNotifyPayload
		if json.Unmarshal([]byte(raw), &p) != nil {
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

// each runs fn on every covered backend.
func each(t *testing.T, fn func(t *testing.T, db *storage.DB)) {
	t.Helper()
	storagetest.Each(t, fn)
}
