package handlers

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/session"
	"github.com/jackc/pgx/v5/pgxpool"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
)

// dbPool connects to the dev database, skipping when none is set (CI's
// unit jobs run without one).
func dbPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		dsn = os.Getenv("FLIGHTDECK_POSTGRES_URL")
	}
	if dsn == "" {
		t.Skip("no TEST_POSTGRES_URL or FLIGHTDECK_POSTGRES_URL set; skipping DB test")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Skipf("postgres unavailable, skipping DB test: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Skipf("postgres unavailable, skipping DB test: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func newClaudeCodeSessionID(t *testing.T) string {
	t.Helper()
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// seedClosedChild stores an open root and its sub-agent, closed at
// endedAt, with the sub-agent's session_start and session_end events at
// the given dates, as the worker leaves them in the moment between
// closing the row and storing the end's event. The rows go when the test
// ends.
func seedClosedChild(t *testing.T, pool *pgxpool.Pool, rootID, childID string, endedAt time.Time, starts, ends []time.Time) {
	t.Helper()
	ctx := context.Background()
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM events WHERE session_id = ANY($1::uuid[])`, []string{rootID, childID})
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE session_id = $1::uuid`, childID)
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE session_id = $1::uuid`, rootID)
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO sessions (session_id, flavor, agent_type, client_type, state)
		VALUES ($1::uuid, 'otlp-resume-db-test', 'coding', 'claude_code', 'active')`, rootID); err != nil {
		t.Fatalf("seed root: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sessions (session_id, flavor, agent_type, client_type, state, ended_at, parent_session_id, agent_role)
		VALUES ($1::uuid, 'otlp-resume-db-test', 'coding', 'claude_code', 'closed', $2, $3::uuid, 'general-purpose')`,
		childID, endedAt, rootID); err != nil {
		t.Fatalf("seed child: %v", err)
	}
	for eventType, dates := range map[string][]time.Time{"session_start": starts, "session_end": ends} {
		for _, at := range dates {
			if _, err := pool.Exec(ctx, `
				INSERT INTO events (session_id, flavor, event_type, occurred_at)
				VALUES ($1::uuid, 'otlp-resume-db-test', $2, $3)`, childID, eventType, at); err != nil {
				t.Fatalf("seed %s: %v", eventType, err)
			}
		}
	}
}

// Against the database, through session.Store: a sub-agent read after
// the worker closed its run but before it stored the run's end event.
// Run 1's end and run 2's start are stored (a resumed run), or only run
// 1's start (a first run); the row's ended_at is the worker's close, on
// its own clock. A late record of the run starts nothing; a record dated
// past ended_at and the tolerance resumes the sub-agent.
func TestClaudeCodeEndBeingStoredAgainstTheDatabase(t *testing.T) {
	pool := dbPool(t)
	firstRunEnd := firstEnd(t).Truncate(time.Microsecond)
	runStart := firstRunEnd.Add(4500 * time.Millisecond)
	runEnd := runStart.Add(2 * time.Second)
	endedAt := runEnd.Add(800 * time.Millisecond)
	for _, c := range []struct {
		name   string
		starts []time.Time
		ends   []time.Time
	}{
		{"a resumed run", []time.Time{firstRunEnd.Add(-4 * time.Second), runStart}, []time.Time{firstRunEnd}},
		{"a first run", []time.Time{runStart}, nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			for _, rec := range []struct {
				name  string
				at    time.Time
				start bool
			}{
				{"late", runStart.Add(1500 * time.Millisecond), false},
				{"at the tolerance", endedAt.Add(otlpResumeTolerance), false},
				{"resumed", endedAt.Add(otlpResumeTolerance + time.Millisecond), true},
			} {
				claudeCodeSession := newClaudeCodeSessionID(t)
				rootID := ccSessionUUID(claudeCodeSession, "")
				childID := ccSessionUUID(claudeCodeSession, ccResumeAgentID)
				seedClosedChild(t, pool, rootID, childID, endedAt, c.starts, c.ends)

				record := childCallAt(t, rec.at, ccResumeAgentID)
				setAttr(record, "session.id", strVal(claudeCodeSession))
				d := newResumeTestDialect(session.NewStore(pool))
				events, _, _ := mapAll(t, d, []*collogs.ExportLogsServiceRequest{exportOf(t, record)})
				want := []string{"post_call"}
				if rec.start {
					want = []string{"session_start", "post_call"}
				}
				if got := sessionEvents(events, childID); !reflect.DeepEqual(got, want) {
					t.Errorf("%s record: child published %v, want %v", rec.name, got, want)
				}
				if got := sessionEvents(events, rootID); len(got) != 0 {
					t.Errorf("the open root published %v", got)
				}
			}
		})
	}
}
