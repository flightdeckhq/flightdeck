package processor

import (
	"context"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
)

// A client that mints its own event id sends the same id for every copy
// of one event; the worker stores it once and adds its tokens once,
// whichever session the copy names.
func TestProcess_DropsAnEventWhoseIDIsAlreadyStored(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		p := newTestProcessor(db)
		agentID := seedAgent(t, db, "coding", "claude_code", "duplicate-test")

		start := func(sessionID string) {
			t.Helper()
			cleanupSession(t, db, sessionID)
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
		if err := db.Reader().QueryRowContext(ctx, `SELECT count(*) FROM events WHERE id = $1`, callID).Scan(&rows); err != nil {
			t.Fatalf("count events: %v", err)
		}
		if rows != 1 {
			t.Fatalf("events with the call's id = %d, want 1", rows)
		}
		if got := tokensUsed(t, db, first); got != tokens {
			t.Errorf("first session tokens_used = %d, want %d", got, tokens)
		}
		if got := tokensUsed(t, db, second); got != 0 {
			t.Errorf("second session tokens_used = %d, want 0 (the copy is dropped)", got)
		}

		// A different call still counts.
		if err := p.Process(ctx, call(second, randomID(t))); err != nil {
			t.Fatalf("another call: %v", err)
		}
		if got := tokensUsed(t, db, second); got != tokens {
			t.Errorf("second session tokens_used after its own call = %d, want %d", got, tokens)
		}
	})
}
