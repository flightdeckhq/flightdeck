package store

import (
	"context"
	"testing"
	"time"
)

// seedRun inserts one of an agent's runs in the given state, started
// startedAgo ago. seedAgent's cleanup removes it with the agent.
func seedRun(t *testing.T, s *Store, agentID, state string, startedAgo time.Duration) {
	t.Helper()
	started := time.Now().Add(-startedAgo)
	if _, err := s.db.ExecContext(context.Background(), `
		INSERT INTO sessions (session_id, agent_id, flavor, state, started_at, last_seen_at,
		                      agent_type, client_type)
		VALUES ($1, $2, 'test-agent-state', $3, $4, $4, 'production', 'flightdeck_sensor')`,
		randomUUID(t), agentID, state, started); err != nil {
		t.Fatalf("seed %s run: %v", state, err)
	}
}

// GetAgentState answers what the agent endpoints answer: active while
// any run is active, however many newer runs have ended, else the
// newest run's state; "" for an agent it does not know.
func TestGetAgentState(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		now := time.Now()

		// One long run, started two days ago and still active, then five
		// newer short runs that have all ended: a page that holds only the
		// newest runs would roll this agent up as closed.
		longRunner := randomUUID(t)
		seedAgent(t, s, longRunner, now.Add(-72*time.Hour), now, 6, 0)
		seedRun(t, s, longRunner, "active", 48*time.Hour)
		for i := range 5 {
			seedRun(t, s, longRunner, "closed", time.Duration(5-i)*time.Hour)
		}

		// No active run: the newest run's state wins.
		quiet := randomUUID(t)
		seedAgent(t, s, quiet, now.Add(-72*time.Hour), now, 2, 0)
		seedRun(t, s, quiet, "closed", 3*time.Hour)
		seedRun(t, s, quiet, "stale", 10*time.Minute)

		for _, tc := range []struct {
			name, agentID, want string
		}{
			{"active long run behind five ended ones", longRunner, "active"},
			{"newest run without an active one", quiet, "stale"},
			{"unknown agent", randomUUID(t), ""},
		} {
			got, err := s.GetAgentState(ctx, tc.agentID)
			if err != nil {
				t.Fatalf("%s: GetAgentState: %v", tc.name, err)
			}
			if got != tc.want {
				t.Errorf("%s: GetAgentState = %q, want %q", tc.name, got, tc.want)
			}
		}
	})
}
