package processor

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
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

func newStubFamily(t *testing.T, db *storage.DB) stubFamily {
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
			{`DELETE FROM events WHERE session_id = $1`, f.childSID},
			{`DELETE FROM events WHERE session_id = $1`, f.parentSID},
			{`DELETE FROM sessions WHERE session_id = $1`, f.childSID},
			{`DELETE FROM sessions WHERE session_id = $1`, f.parentSID},
			{`DELETE FROM agents WHERE agent_id = $1`, f.childAgent},
			{`DELETE FROM agents WHERE agent_id = $1`, f.parentAgent},
		} {
			if _, err := db.ExecContext(ctx, q.sql, q.id); err != nil {
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

func agentSessions(t *testing.T, db *storage.DB, agentID string) int {
	t.Helper()
	var n int
	if err := db.Reader().QueryRowContext(context.Background(),
		`SELECT total_sessions FROM agents WHERE agent_id = $1`, agentID).Scan(&n); err != nil {
		t.Fatalf("read total_sessions of %s: %v", agentID, err)
	}
	return n
}

// sessionOwner is the session's agent_id, "" while it has none.
func sessionOwner(t *testing.T, db *storage.DB, sessionID string) string {
	t.Helper()
	var owner string
	if err := db.Reader().QueryRowContext(context.Background(),
		`SELECT COALESCE(CAST(agent_id AS TEXT), '') FROM sessions WHERE session_id = $1`, sessionID).Scan(&owner); err != nil {
		t.Fatalf("read session %s: %v", sessionID, err)
	}
	return owner
}

func TestHandleSessionStart_ChildBeforeParentCountsTheParentOnce(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		sp := newTestSessionProcessor(db)
		f := newStubFamily(t, db)

		if err := sp.HandleSessionStart(ctx, f.childStart()); err != nil {
			t.Fatalf("child session_start: %v", err)
		}
		if owner := sessionOwner(t, db, f.parentSID); owner != "" {
			t.Fatalf("the child's start must leave the parent as an ownerless stub, owner = %s", owner)
		}
		if got := agentSessions(t, db, f.childAgent); got != 1 {
			t.Errorf("child agent total_sessions = %d, want 1", got)
		}

		// The parent's start, then a redelivery of it.
		for i := range 2 {
			if err := sp.HandleSessionStart(ctx, f.parentEvent("session_start")); err != nil {
				t.Fatalf("parent session_start %d: %v", i, err)
			}
		}
		if got := agentSessions(t, db, f.parentAgent); got != 1 {
			t.Errorf("parent agent total_sessions = %d, want 1", got)
		}
		if owner := sessionOwner(t, db, f.parentSID); owner != f.parentAgent {
			t.Errorf("parent session agent_id = %q, want %s", owner, f.parentAgent)
		}
		if got := agentSessions(t, db, f.childAgent); got != 1 {
			t.Errorf("child agent total_sessions = %d after the parent's start, want 1", got)
		}
	})
}

// sessionState is the session's stored state.
func sessionState(t *testing.T, db *storage.DB, sessionID string) string {
	t.Helper()
	var state string
	if err := db.Reader().QueryRowContext(context.Background(),
		`SELECT state FROM sessions WHERE session_id = $1`, sessionID).Scan(&state); err != nil {
		t.Fatalf("read state of %s: %v", sessionID, err)
	}
	return state
}

// The parent's session_start never reaches the worker (a root start the
// client gave up on) and neither does any other event of it but its
// session_end: the end closes the stub and claims it for the parent's
// agent, and a duplicate end does not count it again.
func TestHandleSessionEnd_ClaimsAParentStubWhoseStartNeverArrived(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		sp := newTestSessionProcessor(db)
		f := newStubFamily(t, db)

		if err := sp.HandleSessionStart(ctx, f.childStart()); err != nil {
			t.Fatalf("child session_start: %v", err)
		}
		end := f.parentEvent("session_end")
		end.StreamSeq = 50
		closed, err := sp.HandleSessionEnd(ctx, end)
		if err != nil || !closed {
			t.Fatalf("parent session_end: closed = %v, err = %v; want true, nil", closed, err)
		}
		if owner := sessionOwner(t, db, f.parentSID); owner != f.parentAgent {
			t.Fatalf("parent session agent_id = %q after its end, want %s", owner, f.parentAgent)
		}
		if state := sessionState(t, db, f.parentSID); state != "closed" {
			t.Errorf("parent session state = %s, want closed", state)
		}
		if got := agentSessions(t, db, f.parentAgent); got != 1 {
			t.Errorf("parent agent total_sessions = %d, want 1", got)
		}

		if _, err := sp.HandleSessionEnd(ctx, end); err != nil {
			t.Fatalf("duplicate parent session_end: %v", err)
		}
		if got := agentSessions(t, db, f.parentAgent); got != 1 {
			t.Errorf("parent agent total_sessions = %d after a duplicate end, want 1", got)
		}
		if state := sessionState(t, db, f.parentSID); state != "closed" {
			t.Errorf("parent session state = %s after a duplicate end, want closed", state)
		}
	})
}

// The claim on session_end never creates anything: an end for a session
// the worker has not stored asks for redelivery and leaves no session
// row and no agent row behind.
func TestHandleSessionEnd_ForAMissingRowCreatesNothing(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		sp := newTestSessionProcessor(db)
		f := newStubFamily(t, db)

		_, err := sp.HandleSessionEnd(ctx, f.parentEvent("session_end"))
		if !errors.Is(err, consumer.ErrRetryLater) {
			t.Fatalf("session_end for a missing row: err = %v, want ErrRetryLater", err)
		}
		var sessions, agents int
		if err := db.Reader().QueryRowContext(ctx, `
			SELECT (SELECT count(*) FROM sessions WHERE session_id = $1),
			       (SELECT count(*) FROM agents WHERE agent_id = $2)`,
			f.parentSID, f.parentAgent).Scan(&sessions, &agents); err != nil {
			t.Fatalf("count rows: %v", err)
		}
		if sessions != 0 || agents != 0 {
			t.Errorf("an end for a missing row left %d session and %d agent rows, want none", sessions, agents)
		}
	})
}

// POST /v1/heartbeat forwards its body without validating the identity
// in it, so a heartbeat never claims a parent stub; the parent's next
// event, whose identity ingestion validated, does.
func TestHandleHeartbeat_DoesNotClaimAParentStub(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		sp := newTestSessionProcessor(db)
		f := newStubFamily(t, db)

		if err := sp.HandleSessionStart(ctx, f.childStart()); err != nil {
			t.Fatalf("child session_start: %v", err)
		}
		if err := sp.HandleHeartbeat(ctx, f.parentEvent("heartbeat")); err != nil {
			t.Fatalf("parent heartbeat: %v", err)
		}
		if owner := sessionOwner(t, db, f.parentSID); owner != "" {
			t.Fatalf("a heartbeat claimed the parent stub for %s", owner)
		}

		tokens := 5
		call := f.parentEvent("post_call")
		call.TokensTotal = &tokens
		if err := sp.HandlePostCall(ctx, call); err != nil {
			t.Fatalf("parent post_call: %v", err)
		}
		if owner := sessionOwner(t, db, f.parentSID); owner != f.parentAgent {
			t.Fatalf("parent session agent_id = %q after its post_call, want %s", owner, f.parentAgent)
		}
		if got := agentSessions(t, db, f.parentAgent); got != 1 {
			t.Errorf("parent agent total_sessions = %d, want 1", got)
		}
	})
}

// The parent's session_start is never processed (a client failed to
// send it), but its other events arrive: the first one claims the stub
// for the parent's agent, and a late start does not count it again.
func TestHandlePostCall_ClaimsAParentStubWhoseStartHasNotArrived(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		sp := newTestSessionProcessor(db)
		f := newStubFamily(t, db)

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
		if owner := sessionOwner(t, db, f.parentSID); owner != f.parentAgent {
			t.Fatalf("parent session agent_id = %q after its post_call, want %s", owner, f.parentAgent)
		}
		if got := agentSessions(t, db, f.parentAgent); got != 1 {
			t.Errorf("parent agent total_sessions = %d, want 1", got)
		}

		if err := sp.HandleSessionStart(ctx, f.parentEvent("session_start")); err != nil {
			t.Fatalf("late parent session_start: %v", err)
		}
		if got := agentSessions(t, db, f.parentAgent); got != 1 {
			t.Errorf("parent agent total_sessions = %d after a late start, want 1", got)
		}
	})
}
