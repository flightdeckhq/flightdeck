package store

import (
	"context"
	"testing"
	"time"
)

// clockLead is how far ahead of the test's clock the seeded rows are
// dated. It stands in for the gap between the clock that stamped a row
// (Postgres for started_at, the emitting client for occurred_at) and
// the API's clock when that clock reads behind: a WSL2 dev box steps
// its clock back by about two seconds every few minutes. A minute is
// well past any such step and far inside the from bound.
const clockLead = time.Minute

// seedLeadingSession stores a session whose started_at, and one event
// whose occurred_at, are clockLead ahead of now. Both are removed when
// the test ends.
func seedLeadingSession(t *testing.T, s *Store) (sessionID, flavor string, now time.Time) {
	t.Helper()
	ctx := context.Background()
	now = time.Now().UTC().Truncate(time.Millisecond)
	sessionID = randomUUID(t)
	flavor = "test-open-ended-" + sessionID[:8]
	ahead := now.Add(clockLead)
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO sessions (session_id, flavor, agent_type, client_type, state, started_at, last_seen_at)
		VALUES ($1, $2, 'coding', 'flightdeck_sensor', 'active', $3, $3)`,
		sessionID, flavor, ahead); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		if _, err := s.db.ExecContext(ctx, `DELETE FROM events WHERE session_id = $1`, sessionID); err != nil {
			t.Errorf("cleanup events: %v", err)
		}
		if _, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE session_id = $1`, sessionID); err != nil {
			t.Errorf("cleanup session: %v", err)
		}
	})
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO events (session_id, flavor, event_type, occurred_at)
		VALUES ($1, $2, 'session_start', $3)`,
		sessionID, flavor, ahead); err != nil {
		t.Fatalf("seed event: %v", err)
	}
	return sessionID, flavor, now
}

// A zero To leaves the session listing without an upper bound, so a
// session stamped ahead of the caller's clock is listed; an explicit To
// still bounds started_at.
func TestGetSessions_ZeroToIsOpenEnded(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		sessionID, flavor, now := seedLeadingSession(t, s)

		open, err := s.GetSessions(ctx, SessionsParams{
			From: now.Add(-time.Hour), Flavors: []string{flavor}, Limit: 10,
		})
		if err != nil {
			t.Fatalf("GetSessions without To: %v", err)
		}
		if open.Total != 1 || len(open.Sessions) != 1 || open.Sessions[0].SessionID != sessionID {
			t.Fatalf("without To: want the one seeded session, got total=%d rows=%v", open.Total, open.Sessions)
		}

		bounded, err := s.GetSessions(ctx, SessionsParams{
			From: now.Add(-time.Hour), To: now, Flavors: []string{flavor}, Limit: 10,
		})
		if err != nil {
			t.Fatalf("GetSessions with To: %v", err)
		}
		if bounded.Total != 0 || len(bounded.Sessions) != 0 {
			t.Fatalf("with To before started_at: want no rows, got total=%d", bounded.Total)
		}
	})
}

// A zero To leaves the events listing without an upper bound, so an
// event dated ahead of the caller's clock is listed; an explicit To
// still bounds occurred_at.
func TestGetEvents_ZeroToIsOpenEnded(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		sessionID, _, now := seedLeadingSession(t, s)

		open, err := s.GetEvents(ctx, EventsParams{
			From: now.Add(-time.Hour), SessionID: sessionID, Limit: 10,
		})
		if err != nil {
			t.Fatalf("GetEvents without To: %v", err)
		}
		if open.Total != 1 || len(open.Events) != 1 {
			t.Fatalf("without To: want the one seeded event, got total=%d", open.Total)
		}

		bounded, err := s.GetEvents(ctx, EventsParams{
			From: now.Add(-time.Hour), To: now, SessionID: sessionID, Limit: 10,
		})
		if err != nil {
			t.Fatalf("GetEvents with To: %v", err)
		}
		if bounded.Total != 0 || len(bounded.Events) != 0 {
			t.Fatalf("with To before occurred_at: want no events, got total=%d", bounded.Total)
		}
	})
}
