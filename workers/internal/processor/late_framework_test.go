package processor

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
)

// A sensor that detects its framework after init() sends a session_start
// with no framework and calls that carry one: the first such call fills
// the session's framework and context.frameworks, and later calls change
// neither. Skips without TEST_POSTGRES_URL / FLIGHTDECK_POSTGRES_URL.
func TestHandlePostCall_FillsTheFrameworkASessionStartDidNotCarry(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	sp := NewSessionProcessor(writer.New(pool), pool)
	sessionID := randomID(t)
	if _, err := pool.Exec(ctx, `
		INSERT INTO sessions (session_id, flavor, agent_type, state, context)
		VALUES ($1::uuid, 'processor-test', 'coding', 'active', '{"os":"Linux"}'::jsonb)`, sessionID); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM events WHERE session_id = $1::uuid`, sessionID)
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE session_id = $1::uuid`, sessionID)
	})

	for _, framework := range []string{"agno", "agno", "langchain"} {
		if err := sp.HandlePostCall(ctx, consumer.EventPayload{
			SessionID: sessionID, EventType: "post_call", Flavor: "processor-test",
			Model: "gpt-4o-mini", Framework: framework,
		}); err != nil {
			t.Fatalf("post_call: %v", err)
		}
	}

	var framework, model string
	var raw []byte
	if err := pool.QueryRow(ctx,
		`SELECT framework, model, context FROM sessions WHERE session_id = $1::uuid`, sessionID,
	).Scan(&framework, &model, &raw); err != nil {
		t.Fatalf("read session: %v", err)
	}
	if framework != "agno" || model != "gpt-4o-mini" {
		t.Errorf("framework, model = %q, %q; want agno (the first label kept), gpt-4o-mini", framework, model)
	}
	var sessionContext struct {
		OS         string   `json:"os"`
		Frameworks []string `json:"frameworks"`
	}
	if err := json.Unmarshal(raw, &sessionContext); err != nil {
		t.Fatalf("decode context: %v", err)
	}
	if len(sessionContext.Frameworks) != 1 || sessionContext.Frameworks[0] != "agno" || sessionContext.OS != "Linux" {
		t.Errorf("context = %s, want the os kept and frameworks [agno]", raw)
	}
}
