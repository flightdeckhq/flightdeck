package processor

import (
	"context"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
)

// A client that mints its own event id sends the same id for every copy
// of one event; the worker stores it once and adds its tokens once,
// whichever session the copy names.
func TestProcess_DropsAnEventWhoseIDIsAlreadyStored(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	p := NewProcessor(pool)

	agentID := randomID(t)
	if _, err := pool.Exec(ctx, `
		INSERT INTO agents (agent_id, agent_type, client_type, agent_name, user_name, hostname)
		VALUES ($1::uuid, 'coding', 'claude_code', 'duplicate-test', 'test', 'test-host')`, agentID); err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agents WHERE agent_id = $1::uuid`, agentID) })

	start := func(sessionID string) {
		t.Helper()
		t.Cleanup(func() {
			_, _ = pool.Exec(ctx, `DELETE FROM events WHERE session_id = $1::uuid`, sessionID)
			_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE session_id = $1::uuid`, sessionID)
		})
		if err := p.Process(ctx, consumer.EventPayload{
			SessionID: sessionID, EventType: "session_start", Flavor: "duplicate-test",
			AgentID: agentID, AgentType: "coding", ClientType: "claude_code",
			AgentName: "duplicate-test", User: "test", Hostname: "test-host",
			Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		}); err != nil {
			t.Fatalf("session_start: %v", err)
		}
	}
	first, second := randomID(t), randomID(t)
	start(first)
	start(second)

	tokens := 40
	callID := randomID(t)
	occurred := time.Now().UTC().Add(-time.Second).Format(time.RFC3339Nano)
	call := func(sessionID, id string) consumer.EventPayload {
		return consumer.EventPayload{
			ID: id, SessionID: sessionID, EventType: "post_call", Flavor: "duplicate-test",
			AgentID: agentID, AgentType: "coding", ClientType: "claude_code",
			AgentName: "duplicate-test", User: "test", Hostname: "test-host",
			Model: "claude-sonnet-4-5", TokensTotal: &tokens, Timestamp: occurred,
		}
	}
	// The same call, sent first under its own session and then re-sent
	// under another (as after a reboot cleared the plugin's markers).
	if err := p.Process(ctx, call(first, callID)); err != nil {
		t.Fatalf("first copy: %v", err)
	}
	dropsBefore := metrics.Snapshot()[metrics.ReasonDuplicateEvent]
	if err := p.Process(ctx, call(second, callID)); err != nil {
		t.Fatalf("second copy: %v", err)
	}
	if got := metrics.Snapshot()[metrics.ReasonDuplicateEvent] - dropsBefore; got != 1 {
		t.Errorf("duplicate_event drops = %d, want 1", got)
	}

	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM events WHERE id = $1::uuid`, callID).Scan(&rows); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if rows != 1 {
		t.Fatalf("events with the call's id = %d, want 1", rows)
	}
	used := func(sessionID string) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, `SELECT tokens_used FROM sessions WHERE session_id = $1::uuid`, sessionID).Scan(&n); err != nil {
			t.Fatalf("read tokens_used: %v", err)
		}
		return n
	}
	if got := used(first); got != tokens {
		t.Errorf("first session tokens_used = %d, want %d", got, tokens)
	}
	if got := used(second); got != 0 {
		t.Errorf("second session tokens_used = %d, want 0 (the copy is dropped)", got)
	}

	// A different call still counts.
	if err := p.Process(ctx, call(second, randomID(t))); err != nil {
		t.Fatalf("another call: %v", err)
	}
	if got := used(second); got != tokens {
		t.Errorf("second session tokens_used after its own call = %d, want %d", got, tokens)
	}
}
