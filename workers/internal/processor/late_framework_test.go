package processor

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
)

// A sensor that detects its framework after init() sends a session_start
// with no framework and calls that carry one: the first such call fills
// the session's framework and context.frameworks, and later calls change
// neither.
func TestHandlePostCall_FillsTheFrameworkASessionStartDidNotCarry(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		sp := newTestSessionProcessor(db)
		sessionID := randomID(t)
		if _, err := db.ExecContext(ctx, `
			INSERT INTO sessions (session_id, flavor, agent_type, state, context)
			VALUES ($1, 'processor-test', 'coding', 'active', '{"os":"Linux"}')`, sessionID); err != nil {
			t.Fatalf("seed session: %v", err)
		}
		cleanupSession(t, db, sessionID)

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
		if err := db.Reader().QueryRowContext(ctx,
			`SELECT framework, model, context FROM sessions WHERE session_id = $1`, sessionID,
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
	})
}
