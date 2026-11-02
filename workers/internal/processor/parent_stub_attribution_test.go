package processor

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
)

// A sub-agent's session_start can reach the worker before its parent's:
// an OTLP export carries both, a plugin retries a failed root start, a
// framework spawns the child at once. The child's start writes the parent
// row as a stub that belongs to no agent; these tests pin that the
// parent's agent still counts the session exactly once.

// stubFamily is a parent session, a child session pointing at it, and
// the two agents that own them, removed when the test ends.
type stubFamily struct {
	parentAgent, childAgent string
	parentSID, childSID     string
}

func newStubFamily(t *testing.T, pool *pgxpool.Pool) stubFamily {
	t.Helper()
	f := stubFamily{
		parentAgent: randomID(t), childAgent: randomID(t),
		parentSID: randomID(t), childSID: randomID(t),
	}
	ctx := context.Background()
	t.Cleanup(func() {
		// The child references the parent session; both reference
		// their agents.
		for _, q := range []struct{ sql, id string }{
			{`DELETE FROM events WHERE session_id = $1::uuid`, f.childSID},
			{`DELETE FROM events WHERE session_id = $1::uuid`, f.parentSID},
			{`DELETE FROM sessions WHERE session_id = $1::uuid`, f.childSID},
			{`DELETE FROM sessions WHERE session_id = $1::uuid`, f.parentSID},
			{`DELETE FROM agents WHERE agent_id = $1::uuid`, f.childAgent},
			{`DELETE FROM agents WHERE agent_id = $1::uuid`, f.parentAgent},
		} {
			if _, err := pool.Exec(ctx, q.sql, q.id); err != nil {
				t.Errorf("cleanup %q %s: %v", q.sql, q.id, err)
			}
		}
	})
	return f
}

func (f stubFamily) parentEvent(eventType string) consumer.EventPayload {
	return consumer.EventPayload{
		SessionID: f.parentSID, EventType: eventType,
		Flavor: "processor-test-parent", AgentType: "coding",
		AgentID: f.parentAgent, ClientType: "flightdeck_sensor",
		AgentName: "processor-test-parent", User: "test", Hostname: "test-host",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
}

func (f stubFamily) childStart() consumer.EventPayload {
	return consumer.EventPayload{
		SessionID: f.childSID, EventType: "session_start",
		Flavor: "processor-test-child", AgentType: "coding",
		AgentID: f.childAgent, ClientType: "flightdeck_sensor",
		AgentName: "processor-test-child", User: "test", Hostname: "test-host",
		ParentSessionID: f.parentSID, AgentRole: "worker",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
}

func agentSessions(t *testing.T, pool *pgxpool.Pool, agentID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT total_sessions FROM agents WHERE agent_id = $1::uuid`, agentID).Scan(&n); err != nil {
		t.Fatalf("read total_sessions of %s: %v", agentID, err)
	}
	return n
}

// sessionOwner is the session's agent_id, "" while it has none.
func sessionOwner(t *testing.T, pool *pgxpool.Pool, sessionID string) string {
	t.Helper()
	var owner string
	if err := pool.QueryRow(context.Background(),
		`SELECT COALESCE(agent_id::text, '') FROM sessions WHERE session_id = $1::uuid`, sessionID).Scan(&owner); err != nil {
		t.Fatalf("read session %s: %v", sessionID, err)
	}
	return owner
}

func TestHandleSessionStart_ChildBeforeParentCountsTheParentOnce(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	sp := NewSessionProcessor(writer.New(pool), pool)
	f := newStubFamily(t, pool)

	if err := sp.HandleSessionStart(ctx, f.childStart()); err != nil {
		t.Fatalf("child session_start: %v", err)
	}
	if owner := sessionOwner(t, pool, f.parentSID); owner != "" {
		t.Fatalf("the child's start must leave the parent as an ownerless stub, owner = %s", owner)
	}
	if got := agentSessions(t, pool, f.childAgent); got != 1 {
		t.Errorf("child agent total_sessions = %d, want 1", got)
	}

	// The parent's start, then a redelivery of it.
	for i := range 2 {
		if err := sp.HandleSessionStart(ctx, f.parentEvent("session_start")); err != nil {
			t.Fatalf("parent session_start %d: %v", i, err)
		}
	}
	if got := agentSessions(t, pool, f.parentAgent); got != 1 {
		t.Errorf("parent agent total_sessions = %d, want 1", got)
	}
	if owner := sessionOwner(t, pool, f.parentSID); owner != f.parentAgent {
		t.Errorf("parent session agent_id = %q, want %s", owner, f.parentAgent)
	}
	if got := agentSessions(t, pool, f.childAgent); got != 1 {
		t.Errorf("child agent total_sessions = %d after the parent's start, want 1", got)
	}
}

// The parent's session_start is never processed (a client failed to
// send it), but its other events arrive: the first one claims the stub
// for the parent's agent, and a late start does not count it again.
func TestHandlePostCall_ClaimsAParentStubWhoseStartHasNotArrived(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	sp := NewSessionProcessor(writer.New(pool), pool)
	f := newStubFamily(t, pool)

	if err := sp.HandleSessionStart(ctx, f.childStart()); err != nil {
		t.Fatalf("child session_start: %v", err)
	}
	tokens := 40
	call := f.parentEvent("post_call")
	call.TokensTotal = &tokens
	for i := range 2 {
		if err := sp.HandlePostCall(ctx, call); err != nil {
			t.Fatalf("parent post_call %d: %v", i, err)
		}
	}
	if owner := sessionOwner(t, pool, f.parentSID); owner != f.parentAgent {
		t.Fatalf("parent session agent_id = %q after its post_call, want %s", owner, f.parentAgent)
	}
	if got := agentSessions(t, pool, f.parentAgent); got != 1 {
		t.Errorf("parent agent total_sessions = %d, want 1", got)
	}

	if err := sp.HandleSessionStart(ctx, f.parentEvent("session_start")); err != nil {
		t.Fatalf("late parent session_start: %v", err)
	}
	if got := agentSessions(t, pool, f.parentAgent); got != 1 {
		t.Errorf("parent agent total_sessions = %d after a late start, want 1", got)
	}
}
