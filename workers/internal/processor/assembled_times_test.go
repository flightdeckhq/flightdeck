package processor

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
)

// These tests run a session's events through Process and pin the dates
// the worker gives its row: an assembled OpenTelemetry session (its
// session_start context carries otel_trace_id) takes started_at and
// ended_at from its own start and end, while every other session takes
// the worker's clock. They run against the dev database and skip
// without TEST_POSTGRES_URL / FLIGHTDECK_POSTGRES_URL.

// otelContext is an assembled session's start context.
func otelContext() map[string]interface{} {
	return map[string]interface{}{
		"telemetry":     "otlp",
		"otel_trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
		"otel_span_id":  "00f067aa0ba902b7",
	}
}

// timesRun is one or two sessions (a root and, optionally, its child)
// and the agent that owns them, removed when the test ends.
type timesRun struct {
	agentID, sessionID, childID string
}

func newTimesRun(t *testing.T, pool *pgxpool.Pool) timesRun {
	t.Helper()
	r := timesRun{agentID: randomID(t), sessionID: randomID(t), childID: randomID(t)}
	t.Cleanup(func() {
		ctx := context.Background()
		for _, q := range []struct{ sql, id string }{
			{`DELETE FROM events WHERE session_id = $1::uuid`, r.childID},
			{`DELETE FROM events WHERE session_id = $1::uuid`, r.sessionID},
			{`DELETE FROM sessions WHERE session_id = $1::uuid`, r.childID},
			{`DELETE FROM sessions WHERE session_id = $1::uuid`, r.sessionID},
			{`DELETE FROM agents WHERE agent_id = $1::uuid`, r.agentID},
		} {
			if _, err := pool.Exec(ctx, q.sql, q.id); err != nil {
				t.Errorf("cleanup %q %s: %v", q.sql, q.id, err)
			}
		}
	})
	return r
}

// event is one of the run's events, dated ts and stamped with the
// stream sequence seq. An assembled run's start carries otel_trace_id.
func (r timesRun) event(sessionID, eventType string, ts time.Time, seq uint64, assembled bool) consumer.EventPayload {
	e := consumer.EventPayload{
		SessionID: sessionID, EventType: eventType, Flavor: "times-test",
		AgentID: r.agentID, AgentType: "production", ClientType: "otlp",
		AgentName: "times-test/agent", User: "test", Hostname: "test-host",
		Timestamp: ts.Format(time.RFC3339Nano),
		StreamSeq: seq,
	}
	if !assembled {
		e.ClientType, e.AgentType = "flightdeck_sensor", "coding"
	}
	if eventType == "session_start" && assembled {
		e.Context = otelContext()
	}
	if eventType == "post_call" {
		tokens := 7
		e.TokensTotal = &tokens
		e.Model = "claude-sonnet-4-6"
	}
	return e
}

func (r timesRun) child(eventType string, ts time.Time, seq uint64, assembled bool) consumer.EventPayload {
	e := r.event(r.childID, eventType, ts, seq, assembled)
	e.ParentSessionID, e.AgentRole = r.sessionID, "researcher"
	return e
}

func process(t *testing.T, p *Processor, e consumer.EventPayload) {
	t.Helper()
	if err := p.Process(context.Background(), e); err != nil {
		t.Fatalf("process %s: %v", e.EventType, err)
	}
}

// endSession runs a session_end through the session handler and reports
// whether it closed the row, which Process uses to release the
// session's policy state.
func endSession(t *testing.T, p *Processor, e consumer.EventPayload) bool {
	t.Helper()
	closed, err := p.session.HandleSessionEnd(context.Background(), e)
	if err != nil {
		t.Fatalf("session end: %v", err)
	}
	return closed
}

type storedTimes struct {
	state      string
	startedAt  time.Time
	endedAt    *time.Time
	lastSeenAt time.Time
	tokens     int
}

func readStoredTimes(t *testing.T, pool *pgxpool.Pool, sessionID string) storedTimes {
	t.Helper()
	var s storedTimes
	if err := pool.QueryRow(context.Background(), `
		SELECT state, started_at, ended_at, last_seen_at, tokens_used
		FROM sessions WHERE session_id = $1::uuid`, sessionID,
	).Scan(&s.state, &s.startedAt, &s.endedAt, &s.lastSeenAt, &s.tokens); err != nil {
		t.Fatalf("read session %s: %v", sessionID, err)
	}
	return s
}

func databaseNow(t *testing.T, pool *pgxpool.Pool) time.Time {
	t.Helper()
	var now time.Time
	if err := pool.QueryRow(context.Background(), `SELECT clock_timestamp()`).Scan(&now); err != nil {
		t.Fatalf("read the database clock: %v", err)
	}
	return now
}

// minutesAgo is a time n minutes before now at microsecond precision,
// the database's, so a stored value compares equal to it.
func minutesAgo(n int) time.Time {
	return time.Now().UTC().Add(-time.Duration(n) * time.Minute).Truncate(time.Microsecond)
}

func wantTime(t *testing.T, what string, got, want time.Time) {
	t.Helper()
	if !got.Equal(want) {
		t.Errorf("%s = %s, want %s", what, got, want)
	}
}

func wantClock(t *testing.T, what string, got, lo, hi time.Time) {
	t.Helper()
	if got.Before(lo) || got.After(hi) {
		t.Errorf("%s = %s, want the worker's clock, between %s and %s", what, got, lo, hi)
	}
}

// An assembled run reaches the worker after it ended; its row carries
// the run's own start and end, and the end still reports the close.
func TestProcess_AssembledSessionTakesItsOwnStartAndEnd(t *testing.T) {
	pool := dbPool(t)
	p := NewProcessor(pool)
	r := newTimesRun(t, pool)
	start, end := minutesAgo(12), minutesAgo(10)

	process(t, p, r.event(r.sessionID, "session_start", start, 1, true))
	process(t, p, r.event(r.sessionID, "post_call", minutesAgo(11), 2, true))
	before := databaseNow(t, pool)
	if !endSession(t, p, r.event(r.sessionID, "session_end", end, 3, true)) {
		t.Fatal("the assembled session's end must report that it closed the row")
	}
	after := databaseNow(t, pool)

	s := readStoredTimes(t, pool, r.sessionID)
	if s.state != "closed" || s.tokens != 7 {
		t.Fatalf("state = %s, tokens = %d; want closed and 7", s.state, s.tokens)
	}
	wantTime(t, "started_at", s.startedAt, start)
	if s.endedAt == nil {
		t.Fatal("ended_at is NULL")
	}
	wantTime(t, "ended_at", *s.endedAt, end)
	wantClock(t, "last_seen_at", s.lastSeenAt, before, after)
}

// A child's start written before its parent's (two replicas) leaves a
// parent stub dated at the child's start; the parent's own start then
// dates the row.
func TestProcess_AssembledParentReplacesItsStubsStart(t *testing.T) {
	pool := dbPool(t)
	p := NewProcessor(pool)
	r := newTimesRun(t, pool)
	parentStart, childStart := minutesAgo(12), minutesAgo(11)

	process(t, p, r.child("session_start", childStart, 2, true))
	wantTime(t, "stub started_at", readStoredTimes(t, pool, r.sessionID).startedAt, childStart)
	process(t, p, r.event(r.sessionID, "session_start", parentStart, 1, true))

	wantTime(t, "parent started_at", readStoredTimes(t, pool, r.sessionID).startedAt, parentStart)
	wantTime(t, "child started_at", readStoredTimes(t, pool, r.childID).startedAt, childStart)
}

// A call processed before its session's start lazily creates the row,
// dated at the call; the start then dates it.
func TestProcess_AssembledStartReplacesALazyRowsStart(t *testing.T) {
	pool := dbPool(t)
	p := NewProcessor(pool)
	r := newTimesRun(t, pool)
	start, call := minutesAgo(12), minutesAgo(11)

	process(t, p, r.event(r.sessionID, "post_call", call, 2, true))
	wantTime(t, "lazy started_at", readStoredTimes(t, pool, r.sessionID).startedAt, call)
	process(t, p, r.event(r.sessionID, "session_start", start, 1, true))

	s := readStoredTimes(t, pool, r.sessionID)
	wantTime(t, "started_at", s.startedAt, start)
	if s.tokens != 7 {
		t.Errorf("tokens = %d, want 7", s.tokens)
	}
}

// Late records of an ended session are wrapped in a re-attaching start
// dated just before them and an end dated at the original end (or just
// after them, when the original end is outside the validation window).
// The row keeps the run's start, counts the late tokens and ends where
// the re-attaching end says.
func TestProcess_ReattachedAssembledSessionKeepsItsStart(t *testing.T) {
	for _, tc := range []struct {
		name string
		end  func(originalEnd, late time.Time) time.Time
	}{
		{"end at the original end", func(originalEnd, _ time.Time) time.Time { return originalEnd }},
		{"end after the latest late event", func(_, late time.Time) time.Time { return late.Add(time.Microsecond) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := dbPool(t)
			p := NewProcessor(pool)
			r := newTimesRun(t, pool)
			start, originalEnd, late := minutesAgo(30), minutesAgo(20), minutesAgo(2)

			process(t, p, r.event(r.sessionID, "session_start", start, 1, true))
			process(t, p, r.event(r.sessionID, "post_call", minutesAgo(25), 2, true))
			if !endSession(t, p, r.event(r.sessionID, "session_end", originalEnd, 3, true)) {
				t.Fatal("first end must close the row")
			}
			// The ingestion API's Attach reopens the row before it
			// publishes the re-attaching start.
			if _, err := pool.Exec(context.Background(), `
				UPDATE sessions SET state = 'active', ended_at = NULL, closed_seq = NULL
				WHERE session_id = $1::uuid`, r.sessionID); err != nil {
				t.Fatalf("attach: %v", err)
			}
			process(t, p, r.event(r.sessionID, "session_start", late.Add(-time.Microsecond), 10, true))
			process(t, p, r.event(r.sessionID, "post_call", late, 11, true))
			endedAt := tc.end(originalEnd, late)
			if !endSession(t, p, r.event(r.sessionID, "session_end", endedAt, 12, true)) {
				t.Fatal("the re-attaching end must report that it closed the row")
			}

			s := readStoredTimes(t, pool, r.sessionID)
			if s.state != "closed" || s.tokens != 14 {
				t.Fatalf("state = %s, tokens = %d; want closed and 14", s.state, s.tokens)
			}
			wantTime(t, "started_at", s.startedAt, start)
			if s.endedAt == nil {
				t.Fatal("ended_at is NULL")
			}
			wantTime(t, "ended_at", *s.endedAt, endedAt)
		})
	}
}

// Sessions without otel_trace_id are dated by the worker's clock, as
// before, however their events are dated; a parent stub keeps the
// child's start as its placeholder.
func TestProcess_OtherSessionsKeepTheWorkersClock(t *testing.T) {
	pool := dbPool(t)
	p := NewProcessor(pool)
	r := newTimesRun(t, pool)
	childStart := minutesAgo(11)

	process(t, p, r.child("session_start", childStart, 2, false))
	process(t, p, r.event(r.sessionID, "session_start", minutesAgo(12), 1, false))
	wantTime(t, "claimed stub started_at", readStoredTimes(t, pool, r.sessionID).startedAt, childStart)

	other := randomID(t)
	cleanupSession(t, pool, other)
	before := databaseNow(t, pool)
	process(t, p, r.event(other, "session_start", minutesAgo(12), 3, false))
	after := databaseNow(t, pool)
	wantClock(t, "started_at", readStoredTimes(t, pool, other).startedAt, before, after)

	before = databaseNow(t, pool)
	if !endSession(t, p, r.event(other, "session_end", minutesAgo(10), 4, false)) {
		t.Fatal("the end must report that it closed the row")
	}
	after = databaseNow(t, pool)
	s := readStoredTimes(t, pool, other)
	if s.endedAt == nil {
		t.Fatal("ended_at is NULL")
	}
	wantClock(t, "ended_at", *s.endedAt, before, after)
	if endSession(t, p, r.event(other, "session_end", minutesAgo(10), 5, false)) {
		t.Fatal("a second end must not report a close")
	}
}
