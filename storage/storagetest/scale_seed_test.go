package storagetest_test

import (
	"context"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// seedEnd is the fixed "now" of the seeded histories: nothing a test
// asserts on depends on the clock.
var seedEnd = time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)

// seedEvents keeps a seed to a few seconds under the race detector
// while the landmark runs give every tree shape and state a test looks
// for; the breadth of models and flavors is the scale check's.
const seedEvents = 800

// maxTreeEvents bounds how far a seed passes its target: one more tree.
const maxTreeEvents = 800

// determinismEvents is the size of the seeds compared row for row:
// determinism needs no breadth, and each seed costs time under the race
// detector.
const determinismEvents = 300

func seedSmall(t *testing.T, db *storage.DB) *storagetest.ScaleStats {
	t.Helper()
	return seedEventsN(t, db, seedEvents)
}

func seedEventsN(t *testing.T, db *storage.DB, events int) *storagetest.ScaleStats {
	t.Helper()
	stats, err := storagetest.SeedScale(context.Background(), db, storagetest.ScaleSpec{
		Events: events, Seed: 7, End: seedEnd,
	})
	if err != nil {
		t.Fatalf("SeedScale: %v", err)
	}
	return stats
}

func count(t *testing.T, db *storage.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := db.Reader().QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

// TestSeedScaleRows checks that the rows written are the ones reported,
// that they hold together (foreign keys, rollups, content), and that the
// history has the shape the scale check relies on.
func TestSeedScaleRows(t *testing.T) {
	for _, b := range storagetest.Backends(t) {
		t.Run(string(b), func(t *testing.T) {
			db := storagetest.OpenIsolated(t, b)
			st := seedSmall(t, db)

			for _, c := range []struct {
				table string
				want  int
			}{
				{"agents", st.Agents}, {"sessions", st.Sessions}, {"events", st.Events},
				{"event_content", st.Content}, {"session_attachments", st.Attachments}, {"directives", st.Directives},
			} {
				if got := count(t, db, "SELECT COUNT(*) FROM "+c.table); got != c.want {
					t.Errorf("%s: %d rows, stats say %d", c.table, got, c.want)
				}
			}
			// Whole trees are written: the count passes the target by at
			// most one tree, a few hundred events for a long Claude Code
			// run with its sub-agents.
			if st.Events < seedEvents || st.Events > seedEvents+maxTreeEvents {
				t.Errorf("events = %d, want %d to %d", st.Events, seedEvents, seedEvents+maxTreeEvents)
			}
			if got := count(t, db, "SELECT COUNT(*) FROM events WHERE has_content"); got != st.Content {
				t.Errorf("events with content = %d, content rows = %d", got, st.Content)
			}
			if got := count(t, db, `SELECT COUNT(*) FROM event_content c
				WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = c.event_id AND e.session_id = c.session_id AND e.has_content)`); got != 0 {
				t.Errorf("%d content rows without their event", got)
			}
			if avg := st.ContentBytes / int64(max(st.Content, 1)); avg < 1000 || avg > 12000 {
				t.Errorf("average content row = %d bytes, want a few KB", avg)
			}

			// Rollups agree with the runs.
			if got := count(t, db, `SELECT COUNT(*) FROM agents a WHERE a.total_sessions <>
				(SELECT COUNT(*) FROM sessions s WHERE s.agent_id = a.agent_id)
				OR a.total_tokens <> (SELECT COALESCE(SUM(tokens_used), 0) FROM sessions s WHERE s.agent_id = a.agent_id)`); got != 0 {
				t.Errorf("%d agents whose totals differ from their runs", got)
			}
			if got := count(t, db, `SELECT COUNT(*) FROM sessions s WHERE s.agent_id IS NOT NULL AND s.tokens_used <>
				(SELECT COALESCE(SUM(e.tokens_total), 0) FROM events e WHERE e.session_id = s.session_id
				 AND e.event_type IN ('post_call', 'embeddings'))`); got != 0 {
				t.Errorf("%d runs whose tokens_used differs from their calls", got)
			}

			// Locked vocabularies (the CHECKs hold client_type, provider
			// and billing_mode on both backends).
			if got := count(t, db, "SELECT COUNT(*) FROM agents WHERE agent_type NOT IN ('coding', 'production')"); got != 0 {
				t.Errorf("%d agents outside the agent_type vocabulary", got)
			}
			if got := count(t, db, "SELECT COUNT(DISTINCT model) FROM events"); got < 20 {
				t.Errorf("%d models, want most of the 30", got)
			}
			if got := count(t, db, "SELECT COUNT(DISTINCT flavor) FROM sessions WHERE agent_id IS NOT NULL"); got < 15 {
				t.Errorf("%d flavors, want most of the 20", got)
			}
			// The Claude Code and sensor runs at least; the Agent SDK and
			// OpenTelemetry flavors are 6% of the events and need a larger
			// seed to appear.
			if got := count(t, db, "SELECT COUNT(DISTINCT client_type) FROM sessions"); got < 2 {
				t.Errorf("%d client types, want the plugin's and the sensor's", got)
			}
			for _, et := range []string{"session_start", "session_end", "post_call", "tool_call", "mcp_tool_call",
				"llm_error", "embeddings", "policy_warn", "policy_mcp_warn"} {
				if st.EventsByType[et] == 0 {
					t.Errorf("no %s events", et)
				}
			}
			for _, state := range []string{"closed", "lost", "stale", "active"} {
				if st.SessionsByState[state] == 0 {
					t.Errorf("no %s runs", state)
				}
			}

			// Capture is on for roughly half the runs.
			on := count(t, db, "SELECT COUNT(*) FROM sessions WHERE capture_prompts")
			if frac := float64(on) / float64(st.Sessions); frac < 0.3 || frac > 0.7 {
				t.Errorf("capture on for %.0f%% of runs, want about half", frac*100)
			}

			// The history spans the year with more of it recent.
			var oldest, newest storage.Time
			if err := db.Reader().QueryRow("SELECT MIN(occurred_at), MAX(occurred_at) FROM events").Scan(&oldest, &newest); err != nil {
				t.Fatal(err)
			}
			if newest.Time.After(seedEnd) || oldest.Time.Before(seedEnd.Add(-366*24*time.Hour)) {
				t.Errorf("events from %v to %v, want within the year before %v", oldest.Time, newest.Time, seedEnd)
			}
			if oldest.Time.After(seedEnd.Add(-300 * 24 * time.Hour)) {
				t.Errorf("oldest event %v, want the history to reach most of a year back", oldest.Time)
			}
			last90 := count(t, db, "SELECT COUNT(*) FROM events WHERE occurred_at >= $1", seedEnd.Add(-90*24*time.Hour))
			if frac := float64(last90) / float64(st.Events); frac < 0.2 || frac > 0.6 {
				t.Errorf("%.0f%% of events in the last 90 days, want about a third", frac*100)
			}

			// Sub-agent trees: children, a tree three levels deep, a
			// parent stub, an old parent with a recent child.
			if st.ChildSessions == 0 {
				t.Error("no child runs")
			}
			depth := count(t, db, `WITH RECURSIVE tree AS (
				SELECT session_id, 0 AS depth FROM sessions WHERE session_id = $1
				UNION ALL
				SELECT c.session_id, t.depth + 1 FROM tree t JOIN sessions c ON c.parent_session_id = t.session_id
			) SELECT MAX(depth) FROM tree`, st.DeepRoot)
			if depth != 3 {
				t.Errorf("deep tree depth = %d, want 3", depth)
			}
			if got := count(t, db, `SELECT COUNT(*) FROM sessions WHERE session_id = $1 AND agent_id IS NULL
				AND context IS NULL AND flavor = 'unknown'`, st.ParentStub); got != 1 {
				t.Errorf("parent stub row missing")
			}
			if got := count(t, db, "SELECT COUNT(*) FROM sessions WHERE parent_session_id = $1", st.ParentStub); got != 1 {
				t.Errorf("parent stub has %d children, want 1", got)
			}
			if got := count(t, db, `SELECT COUNT(*) FROM sessions p JOIN sessions c ON c.parent_session_id = p.session_id
				WHERE p.session_id = $1 AND c.session_id = $2 AND p.state = 'closed'
				AND p.last_seen_at < $3 AND c.started_at >= $4`,
				st.OldParent, st.RecentChild, seedEnd.Add(-100*24*time.Hour), seedEnd.Add(-2*24*time.Hour)); got != 1 {
				t.Error("old parent with a recent child missing")
			}
			if got := count(t, db, `SELECT COUNT(*) FROM sessions WHERE session_id = $1 AND state = 'active'
				AND started_at < $2 AND last_seen_at > $3`,
				st.LongRunningActive, seedEnd.Add(-200*24*time.Hour), seedEnd.Add(-2*time.Minute)); got != 1 {
				t.Error("long-running active run missing")
			}
			if got := count(t, db, "SELECT COUNT(*) FROM events WHERE session_id = $1", st.LargestSession); got != st.LargestSessionEvents {
				t.Errorf("largest run has %d events, stats say %d", got, st.LargestSessionEvents)
			}
			if got := count(t, db, "SELECT COUNT(*) FROM directives WHERE session_id = $1", st.DirectiveSession); got == 0 {
				t.Error("directive run has no directives")
			}
		})
	}
}

// TestSeedScaleDeterministic checks that one spec writes the same rows
// twice, ids included, on every covered backend.
func TestSeedScaleDeterministic(t *testing.T) {
	ref := storagetest.OpenIsolated(t, storage.SQLite)
	want := seedEventsN(t, ref, determinismEvents)
	wantPrint := fingerprint(t, ref)
	for _, b := range storagetest.Backends(t) {
		t.Run(string(b), func(t *testing.T) {
			db := storagetest.OpenIsolated(t, b)
			got := seedEventsN(t, db, determinismEvents)
			if got.Digest != want.Digest || got.Events != want.Events || got.Sessions != want.Sessions ||
				got.LargestSession != want.LargestSession || got.ContentEvent != want.ContentEvent {
				t.Errorf("second seed differs: digest %x/%x events %d/%d sessions %d/%d",
					got.Digest, want.Digest, got.Events, want.Events, got.Sessions, want.Sessions)
			}
			if p := fingerprint(t, db); p != wantPrint {
				t.Errorf("database fingerprint %+v, want %+v", p, wantPrint)
			}
		})
	}
	other, err := storagetest.SeedScale(context.Background(), storagetest.OpenIsolated(t, storage.SQLite),
		storagetest.ScaleSpec{Events: 1, Seed: 8, End: seedEnd})
	if err != nil {
		t.Fatal(err)
	}
	same, err := storagetest.SeedScale(context.Background(), storagetest.OpenIsolated(t, storage.SQLite),
		storagetest.ScaleSpec{Events: 1, Seed: 7, End: seedEnd})
	if err != nil {
		t.Fatal(err)
	}
	if other.Digest == same.Digest {
		t.Error("another seed wrote the same rows")
	}
}

type dbPrint struct {
	events, tokens, content int
	minID, maxID, minSess   string
	newest                  string
}

func fingerprint(t *testing.T, db *storage.DB) dbPrint {
	t.Helper()
	var p dbPrint
	var newest storage.Time
	err := db.Reader().QueryRow(`SELECT COUNT(*), COALESCE(SUM(tokens_total), 0), MIN(CAST(id AS TEXT)), MAX(CAST(id AS TEXT)),
		MIN(CAST(session_id AS TEXT)), MAX(occurred_at) FROM events`).Scan(&p.events, &p.tokens, &p.minID, &p.maxID, &p.minSess, &newest)
	if err != nil {
		t.Fatal(err)
	}
	p.newest = storage.FormatTime(newest.Time)
	p.content = count(t, db, "SELECT COUNT(*) FROM event_content")
	return p
}

// TestSeedScaleRejects checks the spec's required fields.
func TestSeedScaleRejects(t *testing.T) {
	db := storagetest.OpenSQLite(t)
	for _, spec := range []storagetest.ScaleSpec{{End: seedEnd}, {Events: 10}} {
		if _, err := storagetest.SeedScale(context.Background(), db, spec); err == nil {
			t.Errorf("SeedScale(%+v) succeeded", spec)
		}
	}
}
