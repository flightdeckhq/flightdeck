package writer

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// legacySession inserts a session with the given client type and model
// and removes it with its events afterwards.
func legacySession(t *testing.T, pool *pgxpool.Pool, clientType, model string) string {
	t.Helper()
	ctx := context.Background()
	sessionID := newUUID(t)
	if _, err := pool.Exec(ctx, `
		INSERT INTO sessions (session_id, flavor, agent_type, client_type, model)
		VALUES ($1::uuid, 'backfill-test', 'coding', $2, $3)`,
		sessionID, clientType, model); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	t.Cleanup(func() {
		for _, q := range []string{
			`DELETE FROM events WHERE session_id = $1::uuid`,
			`DELETE FROM sessions WHERE session_id = $1::uuid`,
		} {
			if _, err := pool.Exec(ctx, q, sessionID); err != nil {
				t.Errorf("cleanup %q: %v", q, err)
			}
		}
	})
	return sessionID
}

// legacyEvent inserts an event the way it was stored before the write
// path canonicalised: raw model, no model_requested and no token-cost
// columns.
func legacyEvent(t *testing.T, pool *pgxpool.Pool, sessionID, eventType, model string, payload map[string]any) string {
	t.Helper()
	var raw []byte
	if payload != nil {
		var err error
		if raw, err = json.Marshal(payload); err != nil {
			t.Fatalf("encode payload: %v", err)
		}
	}
	var id string
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO events (session_id, flavor, event_type, model, payload, occurred_at)
		VALUES ($1::uuid, 'backfill-test', $2, $3, $4, NOW())
		RETURNING id::text`, sessionID, eventType, model, raw).Scan(&id); err != nil {
		t.Fatalf("insert legacy event: %v", err)
	}
	return id
}

type backfilledEvent struct {
	model, requested, provider, billing, platform, scope *string
}

func readBackfilled(t *testing.T, pool *pgxpool.Pool, id string) backfilledEvent {
	t.Helper()
	var b backfilledEvent
	if err := pool.QueryRow(context.Background(), `
		SELECT model, model_requested, provider, billing_mode, platform, payload->>'inference_scope'
		FROM events WHERE id = $1::uuid`, id).Scan(
		&b.model, &b.requested, &b.provider, &b.billing, &b.platform, &b.scope); err != nil {
		t.Fatalf("read event %s: %v", id, err)
	}
	return b
}

func str(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func TestRunModelBackfill_RewritesLegacyRows(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	w := New(pool)

	const bedrockRaw = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
	sensorSession := legacySession(t, pool, "flightdeck_sensor", bedrockRaw)
	pluginSession := legacySession(t, pool, "claude_code", "claude-opus-4.6")

	bedrockCall := legacyEvent(t, pool, sensorSession, "post_call", bedrockRaw,
		map[string]any{"provider_metadata": map[string]any{"platform": "bedrock"}})
	sensorError := legacyEvent(t, pool, sensorSession, "llm_error", "gpt-4o-mini", nil)
	pluginCall := legacyEvent(t, pool, pluginSession, "post_call", "claude-opus-4.6", nil)

	w.RunModelBackfill(ctx)

	for _, tc := range []struct {
		id   string
		want [6]string // model, requested, provider, billing, platform, scope
	}{
		{bedrockCall, [6]string{"claude-sonnet-4-5-20250929", bedrockRaw, "anthropic", "metered", "bedrock", "regional"}},
		{sensorError, [6]string{"gpt-4o-mini", "gpt-4o-mini", "openai", "<nil>", "<nil>", "<nil>"}},
		{pluginCall, [6]string{"claude-opus-4-6", "claude-opus-4.6", "anthropic", "subscription", "<nil>", "<nil>"}},
	} {
		b := readBackfilled(t, pool, tc.id)
		got := [6]string{str(b.model), str(b.requested), str(b.provider), str(b.billing), str(b.platform), str(b.scope)}
		if got != tc.want {
			t.Errorf("event %s: got %v, want %v", tc.id, got, tc.want)
		}
	}

	for session, want := range map[string]string{
		sensorSession: "claude-sonnet-4-5-20250929",
		pluginSession: "claude-opus-4-6",
	} {
		var model string
		if err := pool.QueryRow(ctx, `SELECT model FROM sessions WHERE session_id = $1::uuid`, session).Scan(&model); err != nil {
			t.Fatalf("read session: %v", err)
		}
		if model != want {
			t.Errorf("sessions.model = %q, want %q", model, want)
		}
	}

	// Nothing is left for a second run, and it changes nothing.
	n, err := w.backfillModelBatch(ctx, modelBackfillBatchSize)
	if err != nil {
		t.Fatalf("second batch: %v", err)
	}
	if n != 0 {
		t.Errorf("second run rewrote %d rows, want 0", n)
	}
}

func TestRunModelBackfill_KeepsValuesAlreadySet(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	session := legacySession(t, pool, "claude_code", "")
	id := legacyEvent(t, pool, session, "post_call", "global.anthropic.claude-opus-4-6-v1",
		map[string]any{"inference_scope": "regional", "provider_metadata": map[string]any{"platform": "vertex"}})
	if _, err := pool.Exec(ctx, `
		UPDATE events SET provider = 'other', billing_mode = 'metered', platform = 'foundry'
		WHERE id = $1::uuid`, id); err != nil {
		t.Fatalf("preset columns: %v", err)
	}

	New(pool).RunModelBackfill(ctx)

	b := readBackfilled(t, pool, id)
	got := [6]string{str(b.model), str(b.requested), str(b.provider), str(b.billing), str(b.platform), str(b.scope)}
	want := [6]string{"claude-opus-4-6", "global.anthropic.claude-opus-4-6-v1", "other", "metered", "foundry", "regional"}
	if got != want {
		t.Errorf("got %v, want %v", got, want)
	}
}
