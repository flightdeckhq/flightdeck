package writer

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/flightdeckhq/flightdeck/storage"
)

// legacySession inserts a session with the given client type and model
// and removes it with its events afterwards.
func legacySession(t *testing.T, db *storage.DB, clientType, model string) string {
	t.Helper()
	ctx := context.Background()
	sessionID := newUUID(t)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO sessions (session_id, flavor, agent_type, client_type, model)
		VALUES ($1, 'backfill-test', 'coding', $2, $3)`,
		sessionID, clientType, model); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	t.Cleanup(func() {
		for _, q := range []string{
			`DELETE FROM events WHERE session_id = $1`,
			`DELETE FROM sessions WHERE session_id = $1`,
		} {
			if _, err := db.ExecContext(ctx, q, sessionID); err != nil {
				t.Errorf("cleanup %q: %v", q, err)
			}
		}
	})
	return sessionID
}

// legacyEvent inserts an event the way it was stored before the write
// path canonicalised: raw model, no model_requested and no token-cost
// columns.
func legacyEvent(t *testing.T, db *storage.DB, sessionID, eventType, model string, payload map[string]any) string {
	t.Helper()
	var raw []byte
	if payload != nil {
		var err error
		if raw, err = json.Marshal(payload); err != nil {
			t.Fatalf("encode payload: %v", err)
		}
	}
	var id string
	if err := db.QueryRowContext(context.Background(), `
		INSERT INTO events (session_id, flavor, event_type, model, payload, occurred_at)
		VALUES ($1, 'backfill-test', $2, $3, $4, `+db.Dialect.Now()+`)
		RETURNING CAST(id AS TEXT)`, sessionID, eventType, model, jsonArg(raw)).Scan(&id); err != nil {
		t.Fatalf("insert legacy event: %v", err)
	}
	return id
}

type backfilledEvent struct {
	model, requested, provider, billing, platform, scope *string
}

func readBackfilled(t *testing.T, db *storage.DB, id string) backfilledEvent {
	t.Helper()
	var b backfilledEvent
	if err := db.Reader().QueryRowContext(context.Background(), `
		SELECT model, model_requested, provider, billing_mode, platform, `+db.Dialect.JSONText("payload", "inference_scope")+`
		FROM events WHERE id = $1`, id).Scan(
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
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		w, _ := newTestWriter(db)

		const bedrockRaw = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
		sensorSession := legacySession(t, db, "flightdeck_sensor", bedrockRaw)
		pluginSession := legacySession(t, db, "claude_code", "claude-opus-4.6")

		bedrockCall := legacyEvent(t, db, sensorSession, "post_call", bedrockRaw,
			map[string]any{"provider_metadata": map[string]any{"platform": "bedrock"}})
		sensorError := legacyEvent(t, db, sensorSession, "llm_error", "gpt-4o-mini", nil)
		pluginCall := legacyEvent(t, db, pluginSession, "post_call", "claude-opus-4.6", nil)

		w.RunModelBackfill(ctx)

		for _, tc := range []struct {
			id   string
			want [6]string // model, requested, provider, billing, platform, scope
		}{
			{bedrockCall, [6]string{"claude-sonnet-4-5-20250929", bedrockRaw, "anthropic", "metered", "bedrock", "regional"}},
			{sensorError, [6]string{"gpt-4o-mini", "gpt-4o-mini", "openai", "<nil>", "<nil>", "<nil>"}},
			{pluginCall, [6]string{"claude-opus-4-6", "claude-opus-4.6", "anthropic", "subscription", "<nil>", "<nil>"}},
		} {
			b := readBackfilled(t, db, tc.id)
			got := [6]string{str(b.model), str(b.requested), str(b.provider), str(b.billing), str(b.platform), str(b.scope)}
			if got != tc.want {
				t.Errorf("event %s: got %v, want %v", tc.id, got, tc.want)
			}
		}
		// The rewritten payload keeps its other keys next to the scope.
		var platform string
		if err := db.Reader().QueryRowContext(ctx, `SELECT `+db.Dialect.JSONText("payload", "provider_metadata", "platform")+` FROM events WHERE id = $1`, bedrockCall).Scan(&platform); err != nil || platform != "bedrock" {
			t.Errorf("payload.provider_metadata.platform after the rewrite = %q, %v; want bedrock", platform, err)
		}

		for session, want := range map[string]string{
			sensorSession: "claude-sonnet-4-5-20250929",
			pluginSession: "claude-opus-4-6",
		} {
			var model string
			if err := db.Reader().QueryRowContext(ctx, `SELECT model FROM sessions WHERE session_id = $1`, session).Scan(&model); err != nil {
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
	})
}

func TestRunModelBackfill_KeepsValuesAlreadySet(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		session := legacySession(t, db, "claude_code", "")
		id := legacyEvent(t, db, session, "post_call", "global.anthropic.claude-opus-4-6-v1",
			map[string]any{"inference_scope": "regional", "provider_metadata": map[string]any{"platform": "vertex"}})
		if _, err := db.ExecContext(ctx, `
			UPDATE events SET provider = 'other', billing_mode = 'metered', platform = 'foundry'
			WHERE id = $1`, id); err != nil {
			t.Fatalf("preset columns: %v", err)
		}

		w, _ := newTestWriter(db)
		w.RunModelBackfill(ctx)

		b := readBackfilled(t, db, id)
		got := [6]string{str(b.model), str(b.requested), str(b.provider), str(b.billing), str(b.platform), str(b.scope)}
		want := [6]string{"claude-opus-4-6", "global.anthropic.claude-opus-4-6-v1", "other", "metered", "foundry", "regional"}
		if got != want {
			t.Errorf("got %v, want %v", got, want)
		}
	})
}

// Small batches cover a backlog over several transactions, and a row
// whose model canonicalises to nothing still leaves the work set, so
// the run terminates.
func TestBackfillModelBatch_SeveralBatchesAndBlankModel(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		w, _ := newTestWriter(db)
		session := legacySession(t, db, "flightdeck_sensor", "")
		ids := []string{
			legacyEvent(t, db, session, "post_call", "gpt-4o-mini", nil),
			legacyEvent(t, db, session, "post_call", "openai/gpt-4o", nil),
			legacyEvent(t, db, session, "post_call", "   ", nil),
		}

		// Drain with batches of one; the live worker may claim some rows of
		// this test's session itself, which is fine: every row must end up
		// rewritten either way.
		for i := 0; i < 1000; i++ {
			n, err := w.backfillModelBatch(ctx, 1)
			if err != nil {
				t.Fatalf("batch %d: %v", i, err)
			}
			if n == 0 {
				break
			}
		}

		want := map[string][2]string{ // id -> model, model_requested
			ids[0]: {"gpt-4o-mini", "gpt-4o-mini"},
			ids[1]: {"gpt-4o", "openai/gpt-4o"},
			ids[2]: {"<nil>", "   "},
		}
		for id, w := range want {
			b := readBackfilled(t, db, id)
			if got := [2]string{str(b.model), str(b.requested)}; got != w {
				t.Errorf("event %s: got %v, want %v", id, got, w)
			}
		}
	})
}

// The sessions update is a compare-and-set: a session whose model moved
// on to a newer id after the raw one was stored keeps the newer id.
func TestRunModelBackfill_DoesNotOverwriteANewerSessionModel(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		session := legacySession(t, db, "flightdeck_sensor", "claude-opus-4-6")
		legacyEvent(t, db, session, "post_call", "claude-opus-4.5", nil)

		w, _ := newTestWriter(db)
		w.RunModelBackfill(ctx)

		var model string
		if err := db.Reader().QueryRowContext(ctx, `SELECT model FROM sessions WHERE session_id = $1`, session).Scan(&model); err != nil {
			t.Fatalf("read session: %v", err)
		}
		if model != "claude-opus-4-6" {
			t.Errorf("sessions.model = %q, want the newer claude-opus-4-6 kept", model)
		}
	})
}

// Two workers backfilling at once share the rows without failing: on
// Postgres SKIP LOCKED splits the events and the ordered session locks
// keep shared sessions from deadlocking; on SQLite the batches queue on
// the single writer.
func TestRunModelBackfill_ConcurrentRunsShareTheWork(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		sessions := []string{
			legacySession(t, db, "flightdeck_sensor", "gpt-4o-mini"),
			legacySession(t, db, "claude_code", "claude-sonnet-4.5"),
		}
		var ids []string
		for i := 0; i < 50; i++ {
			ids = append(ids,
				legacyEvent(t, db, sessions[0], "post_call", "gpt-4o-mini", nil),
				legacyEvent(t, db, sessions[1], "post_call", "claude-sonnet-4.5", nil),
			)
		}

		errs := make(chan error, 2)
		for i := 0; i < 2; i++ {
			go func() {
				w, _ := newTestWriter(db)
				for {
					n, err := w.backfillModelBatch(ctx, 7)
					if err != nil || n == 0 {
						errs <- err
						return
					}
				}
			}()
		}
		for i := 0; i < 2; i++ {
			if err := <-errs; err != nil {
				t.Fatalf("concurrent backfill: %v", err)
			}
		}

		var left int
		if err := db.Reader().QueryRowContext(ctx, `
			SELECT count(*) FROM events
			WHERE `+db.Dialect.InUUIDArray("id", "$1")+` AND model_requested IS NULL`, db.Dialect.ArrayArg(ids)).Scan(&left); err != nil {
			t.Fatalf("count remaining: %v", err)
		}
		if left != 0 {
			t.Errorf("%d rows left unrewritten", left)
		}
	})
}
