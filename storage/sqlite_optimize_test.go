package storage

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// optimizeTestDeadline bounds the wait for the optimizer loop, which
// the test runs every few milliseconds: a refresh that never comes
// fails rather than hangs.
const optimizeTestDeadline = 30 * time.Second

// planOf is the query plan of query on the read pool, its details
// joined.
func planOf(t *testing.T, db *DB, query string, args ...any) string {
	t.Helper()
	rows, err := db.Reader().QueryContext(context.Background(), "EXPLAIN QUERY PLAN "+query, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var parts []string
	for rows.Next() {
		var id, parent, notused int
		var detail string
		if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
			t.Fatal(err)
		}
		parts = append(parts, detail)
	}
	return strings.Join(parts, "; ")
}

// statOf is the sqlite_stat1 row of an index, "" when it has none.
func statOf(t *testing.T, db *DB, index string) string {
	t.Helper()
	var stat string
	err := db.Reader().QueryRowContext(context.Background(),
		`SELECT stat FROM sqlite_stat1 WHERE idx = $1`, index).Scan(&stat)
	if err != nil {
		return ""
	}
	return stat
}

func testUUID(i int) string { return fmt.Sprintf("%08x-0000-4000-8000-%012x", i, i) }

// TestSQLiteOpen_GivesTheReadPoolPlannerStatistics writes runs and
// their events, reopens the database as a service does, and checks
// that a read connection plans a run's close reasons (the lookup the
// Fleet and the sessions listing make for every run they show) through
// the session index. Without statistics the planner read it through
// the event_type index: every session_end of the fleet per run.
func TestSQLiteOpen_GivesTheReadPoolPlannerStatistics(t *testing.T) {
	ctx := context.Background()
	url := SQLiteURL(filepath.Join(t.TempDir(), "fd.db"))
	if err := Migrate(ctx, url); err != nil {
		t.Fatal(err)
	}
	db, err := Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	const runs, perRun = 200, 20
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	for r := range runs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO sessions (session_id, flavor, agent_type, state) VALUES ($1, 'f', 'coding', 'closed')`, testUUID(r)); err != nil {
			t.Fatal(err)
		}
		for e := range perRun {
			eventType := []string{"post_call", "tool_call", "tool_call", "post_call"}[e%4]
			if e == perRun-1 {
				eventType = "session_end"
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO events (id, session_id, flavor, event_type, occurred_at, payload) VALUES ($1, $2, 'f', $3, $4, '{"close_reason":"normal_exit"}')`,
				testUUID(1_000_000+r*perRun+e), testUUID(r), eventType, at.Add(time.Duration(r*perRun+e)*time.Second)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db, err = Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if stat := statOf(t, db, "events_session_idx"); !strings.HasPrefix(stat, fmt.Sprint(runs*perRun)+" ") {
		t.Fatalf("events_session_idx statistics = %q after Open, want %d rows counted", stat, runs*perRun)
	}
	plan := planOf(t, db, `SELECT 1 FROM events e WHERE e.session_id = $1 AND e.event_type = 'session_end'
		AND json_extract(e.payload, '$.close_reason') IS NOT NULL`, testUUID(7))
	if !strings.Contains(plan, "events_session_idx") {
		t.Errorf("a run's close reasons are planned as %q, want the session index", plan)
	}
}

// TestSQLiteOptimizer_RefreshesAGrownTable checks that the periodic run
// analyzes a table again once it has grown tenfold.
func TestSQLiteOptimizer_RefreshesAGrownTable(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, SQLiteURL(filepath.Join(t.TempDir(), "fd.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `CREATE TABLE probe (id INTEGER PRIMARY KEY, k TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `CREATE INDEX probe_k_idx ON probe (k)`); err != nil {
		t.Fatal(err)
	}
	fill := func(from, to int) {
		t.Helper()
		if _, err := db.ExecContext(ctx, `WITH RECURSIVE n(i) AS (SELECT $1 UNION ALL SELECT i + 1 FROM n WHERE i < $2)
			INSERT INTO probe (id, k) SELECT i, 'k' || (i % 10) FROM n`, from, to); err != nil {
			t.Fatal(err)
		}
	}
	fill(1, 100)
	if err := optimizeSQLite(ctx, db.DB); err != nil {
		t.Fatal(err)
	}
	if stat := statOf(t, db, "probe_k_idx"); !strings.HasPrefix(stat, "100 ") {
		t.Fatalf("probe_k_idx statistics = %q, want 100 rows counted", stat)
	}
	fill(101, 5000)

	o := startSQLiteOptimizer(db.DB, 10*time.Millisecond)
	deadline := time.Now().Add(optimizeTestDeadline)
	for !strings.HasPrefix(statOf(t, db, "probe_k_idx"), "5000 ") {
		if time.Now().After(deadline) {
			t.Fatalf("probe_k_idx statistics still %q after %v, want the grown table counted", statOf(t, db, "probe_k_idx"), optimizeTestDeadline)
		}
		time.Sleep(10 * time.Millisecond)
	}
	o.Stop()
	select {
	case <-o.done:
	default:
		t.Fatal("the optimizer loop runs on after Stop")
	}
}

// TestSQLiteClose_StopsTheOptimizer checks that Close ends the loop and
// that a shared handle runs none of its own.
func TestSQLiteClose_StopsTheOptimizer(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, SQLiteURL(filepath.Join(t.TempDir(), "fd.db")))
	if err != nil {
		t.Fatal(err)
	}
	shared, err := db.Share(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if shared.optimizer != nil {
		t.Error("a shared handle runs an optimizer of its own")
	}
	o := db.optimizer
	if o == nil {
		t.Fatal("Open started no optimizer")
	}
	_ = shared.Close()
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-o.done:
	default:
		t.Fatal("the optimizer loop runs on after Close")
	}
}
