package session

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// testPool connects to the dev database, skipping when none is set (CI's
// unit jobs run without one).
func testPool(t *testing.T) *pgxpool.Pool {
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

func randomUUID(t *testing.T) string {
	t.Helper()
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// seedSession inserts a session row in state, ended at endedAt when it is
// not zero, with session_start and session_end events at the given
// dates, and removes them when the test ends.
func seedSession(t *testing.T, pool *pgxpool.Pool, state string, endedAt time.Time, starts, ends []time.Time) string {
	t.Helper()
	ctx := context.Background()
	id := randomUUID(t)
	var ended *time.Time
	if !endedAt.IsZero() {
		ended = &endedAt
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sessions (session_id, flavor, agent_type, state, started_at, last_seen_at, ended_at)
		VALUES ($1::uuid, 'otlp-ends-test', 'coding', $2, NOW(), NOW(), $3)`, id, state, ended); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM events WHERE session_id = $1::uuid`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM sessions WHERE session_id = $1::uuid`, id)
	})
	for eventType, dates := range map[string][]time.Time{"session_start": starts, "session_end": ends} {
		for _, at := range dates {
			if _, err := pool.Exec(ctx, `
				INSERT INTO events (session_id, flavor, event_type, occurred_at)
				VALUES ($1::uuid, 'otlp-ends-test', $2, $3)`, id, eventType, at); err != nil {
				t.Fatalf("seed %s: %v", eventType, err)
			}
		}
	}
	return id
}

// The end of a closed session is its latest stored session_end, unless a
// session_start is stored after it: the worker closes a row before it
// stores the end's event, and in that moment the latest end is the
// previous run's (or none), so the row's ended_at answers instead. The
// dates are the live resumed child's of the review: run 1 ended at
// 10:10:27.898, run 2 started at 10:10:32.144 and ended at 10:10:33.355.
func TestOTLPSessionEndsReadsTheEndOfTheLatestRun(t *testing.T) {
	pool := testPool(t)
	at := func(clock string) time.Time {
		v, err := time.Parse("15:04:05.000", clock)
		if err != nil {
			t.Fatal(err)
		}
		return time.Date(2026, 11, 2, v.Hour(), v.Minute(), v.Second(), v.Nanosecond(), time.UTC)
	}
	run1Start, run1End := at("10:10:23.500"), at("10:10:27.898")
	run2Start, run2End := at("10:10:32.144"), at("10:10:33.355")
	endedAt := at("10:10:33.900") // the worker's close of run 2
	reaped := at("10:40:33.900")

	cases := []struct {
		name   string
		state  string
		starts []time.Time
		ends   []time.Time
		want   time.Time
		closed bool
	}{
		{"the resumed run's end is stored", "closed", []time.Time{run1Start, run2Start}, []time.Time{run1End, run2End}, run2End, true},
		{"the resumed run is closed, its end not yet stored", "closed", []time.Time{run1Start, run2Start}, []time.Time{run1End}, endedAt, true},
		{"the first run is closed, its end not yet stored", "closed", []time.Time{run1Start}, nil, endedAt, true},
		{"the first run's end is stored", "closed", []time.Time{run1Start}, []time.Time{run1End}, run1End, true},
		{"the reaper's end after a resumed run", "closed", []time.Time{run1Start, run2Start}, []time.Time{run1End, reaped}, reaped, true},
		{"no events", "closed", nil, nil, endedAt, true},
		{"an open row", "active", []time.Time{run1Start}, nil, time.Time{}, false},
	}
	ids := make([]string, len(cases))
	for i, c := range cases {
		ended := endedAt
		if !c.closed {
			ended = time.Time{}
		}
		ids[i] = seedSession(t, pool, c.state, ended, c.starts, c.ends)
	}
	missing := randomUUID(t)

	ends, err := NewStore(pool).OTLPSessionEnds(context.Background(), append(append([]string(nil), ids...), missing))
	if err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		got, closed := ends[ids[i]]
		if closed != c.closed || !got.Equal(c.want) {
			t.Errorf("%s: end %v (closed %v), want %v (closed %v)", c.name, got, closed, c.want, c.closed)
		}
	}
	if _, ok := ends[missing]; ok || len(ends) != len(cases)-1 {
		t.Errorf("answered %d sessions, the missing one %v", len(ends), ok)
	}
}
