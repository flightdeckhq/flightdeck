package storage

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// optimizeTestDeadline bounds the waits for the optimizer loop, which
// the tests run every few milliseconds: an outcome that never comes
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

// fillProbe creates a table of n rows with an index, never analyzed.
func fillProbe(t *testing.T, db *DB, n int) {
	t.Helper()
	ctx := context.Background()
	for _, q := range []string{
		`CREATE TABLE probe (id INTEGER PRIMARY KEY, k TEXT NOT NULL, pad TEXT NOT NULL)`,
		`CREATE INDEX probe_k_idx ON probe (k)`,
		`CREATE INDEX probe_pad_idx ON probe (pad)`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < $1)
		INSERT INTO probe (id, k, pad) SELECT i, 'k' || (i % 10), printf('%040d', i) FROM n`, n); err != nil {
		t.Fatal(err)
	}
}

// TestSQLiteGatherStatistics_GivesTheReadPoolPlannerStatistics writes
// runs and their events, opens the database as the binary does, and
// checks that Open alone writes no statistics (so the copy a start takes
// before migrating is the file as it was), that GatherStatistics does,
// and that a read connection then plans a run's close reasons (the
// lookup the Fleet and the sessions listing make for every run they
// show) through the session index. Without statistics the planner read
// it through the event_type index: every session_end of the fleet per
// run.
func TestSQLiteGatherStatistics_GivesTheReadPoolPlannerStatistics(t *testing.T) {
	ctx := context.Background()
	url := SQLiteURL(filepath.Join(t.TempDir(), "fd.db"))
	if err := Migrate(ctx, url); err != nil {
		t.Fatal(err)
	}
	db, err := Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	const runs, perRun = 200, 20
	// Runs, and their events: the last of each a session_end.
	for _, q := range []string{
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < $1 - 1)
			INSERT INTO sessions (session_id, flavor, agent_type, state)
			SELECT printf('%08x-0000-4000-8000-%012x', i, i), 'f', 'coding', 'closed' FROM n`,
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < $1 * $2 - 1)
			INSERT INTO events (id, session_id, flavor, event_type, occurred_at, payload)
			SELECT printf('%08x-0000-4000-8000-%012x', 1000000 + i, 1000000 + i),
			       printf('%08x-0000-4000-8000-%012x', i / $2, i / $2), 'f',
			       CASE WHEN i % $2 = $2 - 1 THEN 'session_end' WHEN i % 2 = 0 THEN 'post_call' ELSE 'tool_call' END,
			       strftime('%Y-%m-%dT%H:%M:%fZ', '2026-11-01', '+' || i || ' seconds'),
			       '{"close_reason":"normal_exit"}'
			FROM n`,
	} {
		if _, err := db.ExecContext(ctx, q, runs, perRun); err != nil {
			t.Fatal(err)
		}
	}
	// An index made just before, as a migration makes one.
	if _, err := db.ExecContext(ctx, `CREATE INDEX probe_events_flavor_type_idx ON events (flavor, event_type)`); err != nil {
		t.Fatal(err)
	}
	if stat := statOf(t, db, "events_session_idx"); stat != "" {
		t.Fatalf("Open wrote statistics (%q); a start's copy before migrating would not be the file as it was", stat)
	}

	took, err := db.GatherStatistics(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if took <= 0 {
		t.Errorf("GatherStatistics took %v", took)
	}
	for _, index := range []string{"events_session_idx", "probe_events_flavor_type_idx"} {
		if stat := statOf(t, db, index); !strings.HasPrefix(stat, fmt.Sprint(runs*perRun)+" ") {
			t.Errorf("%s statistics = %q after GatherStatistics, want %d rows counted", index, stat, runs*perRun)
		}
	}
	plan := planOf(t, db, `SELECT 1 FROM events e WHERE e.session_id = $1 AND e.event_type = 'session_end'
		AND json_extract(e.payload, '$.close_reason') IS NOT NULL`, testUUID(7))
	if !strings.Contains(plan, "events_session_idx") {
		t.Errorf("a run's close reasons are planned as %q, want the session index", plan)
	}
}

// outcomes records what an optimizer's attempts did.
type outcomes struct {
	mu   sync.Mutex
	runs []outcome
}

type outcome struct {
	took        time.Duration
	interrupted bool
	err         error
}

func (o *outcomes) observe(took time.Duration, interrupted bool, err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.runs = append(o.runs, outcome{took, interrupted, err})
}

func (o *outcomes) snapshot() []outcome {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]outcome(nil), o.runs...)
}

// waitFor polls until cond holds or the deadline passes.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(optimizeTestDeadline)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("%s: not after %v", what, optimizeTestDeadline)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestSQLiteOptimizer_InterruptsALongRefreshAtItsBound gives a refresh a
// bound far shorter than the analysis of a large table needs: every
// attempt is interrupted close to the bound, a write between attempts
// does not wait for the analysis, and the attempts are retried after
// the pause.
func TestSQLiteOptimizer_InterruptsALongRefreshAtItsBound(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, SQLiteURL(filepath.Join(t.TempDir(), "fd.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	fillProbe(t, db, 40_000)
	// Eight more indexes, so an analysis counts 400,000 index entries:
	// far past the bound on any host, warm or under the race detector.
	for i := range 8 {
		if _, err := db.ExecContext(ctx, fmt.Sprintf(`CREATE INDEX probe_x%d_idx ON probe (substr(pad, %d), k)`, i, i+1)); err != nil {
			t.Fatal(err)
		}
	}

	const bound = time.Millisecond
	// slack covers the interrupt reaching the statement and a loaded
	// test host; an analysis that ran to its end takes far longer.
	const slack = 250 * time.Millisecond
	var seen outcomes
	o := startSQLiteOptimizerWith(&sqliteOptimizer{
		writer: db.DB, interval: 5 * time.Millisecond, bound: bound,
		pause: 5 * time.Millisecond, retries: 3, observe: seen.observe,
	})
	waitFor(t, "three interrupted refreshes", func() bool { return len(seen.snapshot()) >= 3 })
	start := time.Now()
	if _, err := db.ExecContext(ctx, `INSERT INTO probe (k, pad) VALUES ('between', 'attempts')`); err != nil {
		t.Fatal(err)
	}
	if waited := time.Since(start); waited > bound+slack {
		t.Errorf("a write between refreshes took %v, want it not to wait for an analysis", waited)
	}
	o.Stop()
	for i, r := range seen.snapshot() {
		if r.err != nil || !r.interrupted {
			t.Errorf("attempt %d: interrupted=%v err=%v, want it interrupted at the bound", i, r.interrupted, r.err)
		}
		if r.took > bound+slack {
			t.Errorf("attempt %d held the writer %v, past its bound %v", i, r.took, bound)
		}
	}
	if stat := statOf(t, db, "probe_k_idx"); stat != "" {
		t.Errorf("an interrupted refresh left statistics %q", stat)
	}
}

// TestSQLiteOptimizer_RefreshesAGrownTable checks that a refresh within
// its bound analyzes a table that has grown tenfold.
func TestSQLiteOptimizer_RefreshesAGrownTable(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, SQLiteURL(filepath.Join(t.TempDir(), "fd.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	fillProbe(t, db, 100)
	if _, err := db.GatherStatistics(ctx); err != nil {
		t.Fatal(err)
	}
	if stat := statOf(t, db, "probe_k_idx"); !strings.HasPrefix(stat, "100 ") {
		t.Fatalf("probe_k_idx statistics = %q, want 100 rows counted", stat)
	}
	if _, err := db.ExecContext(ctx, `WITH RECURSIVE n(i) AS (SELECT 101 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
		INSERT INTO probe (id, k, pad) SELECT i, 'k' || (i % 10), printf('%040d', i) FROM n`); err != nil {
		t.Fatal(err)
	}
	var seen outcomes
	o := startSQLiteOptimizerWith(&sqliteOptimizer{
		writer: db.DB, interval: 10 * time.Millisecond, bound: optimizeTestDeadline,
		pause: 10 * time.Millisecond, retries: 3, observe: seen.observe,
	})
	waitFor(t, "the grown table analyzed", func() bool { return strings.HasPrefix(statOf(t, db, "probe_k_idx"), "5000 ") })
	o.Stop()
	for i, r := range seen.snapshot() {
		if r.err != nil || r.interrupted {
			t.Errorf("attempt %d: interrupted=%v err=%v, want it complete", i, r.interrupted, r.err)
		}
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
	if took, err := shared.GatherStatistics(ctx); took != 0 || err != nil {
		t.Errorf("GatherStatistics on a shared handle = %v, %v; want nothing done", took, err)
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
