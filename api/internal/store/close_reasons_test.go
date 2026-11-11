package store

import (
	"context"
	"reflect"
	"testing"
	"time"
)

// A run the orphan-timeout reaper closed is usually older than the
// Fleet's 24 h sessions page, so the dashboard learns it was reaped
// from the agent's recent_sessions rollup or from the session row the
// live stream re-reads (GetSession). Both carry close_reasons: the
// distinct close_reason values of the run's session_end events, sorted,
// and an empty array (never null) for a run without one.
func seedCloseReasonRuns(t *testing.T, s *Store) (agentID, reaped, open string) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)
	agentID = randomUUID(t)
	seedAgent(t, s, agentID, now.Add(-30*time.Hour), now.Add(-time.Minute), 2, 0)

	reaped = randomUUID(t)
	open = randomUUID(t)
	flavor := "test-close-reasons-" + agentID[:8]
	for _, run := range []struct {
		id, state string
		started   time.Time
	}{
		{reaped, "closed", now.Add(-30 * time.Hour)},
		{open, "active", now.Add(-10 * time.Minute)},
	} {
		if _, err := s.db.ExecContext(ctx, `
			INSERT INTO sessions (
				session_id, agent_id, flavor, state,
				started_at, last_seen_at, tokens_used,
				agent_type, client_type
			) VALUES ($1, $2, $3, $4, $5, $5, 0, 'coding', 'flightdeck_sensor')
		`, run.id, agentID, flavor, run.state, run.started); err != nil {
			t.Fatalf("seed session: %v", err)
		}
	}
	// Two closes of the reaped run (a resume closed normally, then the
	// reaper), and a session_end without a reason, which adds nothing.
	for _, payload := range []string{
		`{"close_reason": "orphan_timeout"}`,
		`{"close_reason": "normal_exit"}`,
		`{"close_reason": "orphan_timeout"}`,
		`{}`,
	} {
		if _, err := s.db.ExecContext(ctx, `
			INSERT INTO events (session_id, flavor, event_type, payload, occurred_at)
			VALUES ($1, $2, 'session_end', $3, $4)
		`, reaped, flavor, payload, now.Add(-time.Minute)); err != nil {
			t.Fatalf("seed event: %v", err)
		}
	}
	// Registered after seedAgent's cleanup, so it runs first: the
	// events go before the sessions they reference.
	t.Cleanup(func() {
		_, _ = s.db.ExecContext(ctx, `DELETE FROM events WHERE `+s.d.InUUIDArray("session_id", "$1"),
			s.d.ArrayArg([]string{reaped, open}))
	})
	return agentID, reaped, open
}

func TestGetSession_CloseReasons(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		_, reaped, open := seedCloseReasonRuns(t, s)
		ctx := context.Background()

		got, err := s.GetSession(ctx, reaped)
		if err != nil || got == nil {
			t.Fatalf("GetSession(reaped): %v, %v", got, err)
		}
		if want := []string{"normal_exit", "orphan_timeout"}; !reflect.DeepEqual(got.CloseReasons, want) {
			t.Errorf("reaped close_reasons = %v, want %v", got.CloseReasons, want)
		}

		got, err = s.GetSession(ctx, open)
		if err != nil || got == nil {
			t.Fatalf("GetSession(open): %v, %v", got, err)
		}
		if got.CloseReasons == nil || len(got.CloseReasons) != 0 {
			t.Errorf("open close_reasons = %#v, want an empty array", got.CloseReasons)
		}
	})
}

func TestGetRecentSessionsByAgentIDs_CloseReasons(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		agentID, reaped, open := seedCloseReasonRuns(t, s)

		byAgent, err := s.GetRecentSessionsByAgentIDs(context.Background(), []string{agentID}, RecentSessionsPerAgent)
		if err != nil {
			t.Fatalf("GetRecentSessionsByAgentIDs: %v", err)
		}
		got := map[string][]string{}
		for _, r := range byAgent[agentID] {
			got[r.SessionID] = r.CloseReasons
		}
		if want := []string{"normal_exit", "orphan_timeout"}; !reflect.DeepEqual(got[reaped], want) {
			t.Errorf("reaped close_reasons = %v, want %v", got[reaped], want)
		}
		if reasons, ok := got[open]; !ok || reasons == nil || len(reasons) != 0 {
			t.Errorf("open close_reasons = %#v (present %v), want an empty array", reasons, ok)
		}
	})
}
