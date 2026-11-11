package processor

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
)

// freshFileTimeout bounds the end-to-end run on a new database file;
// the migration and a handful of events take well under a second.
const freshFileTimeout = 30 * time.Second

// The worker's start-up path on a new SQLite file, as main runs it:
// storage.Migrate creates the schema from the embedded baseline, the
// database opens, and a session's events flow through Process onto it,
// with the fleet notifications on the in-process bus and the policy
// evaluator reading the (empty) token_policies table. Unlike the other
// tests this one opens the file itself rather than through storagetest,
// so it also proves the runner on an empty file.
func TestWorker_MigratesAnEmptySQLiteFileAndProcessesEvents(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), freshFileTimeout)
	defer cancel()
	url := "sqlite://" + filepath.Join(t.TempDir(), "fresh.db")

	version, dirty, err := storage.SchemaVersion(ctx, url)
	if err != nil || version != 0 || dirty {
		t.Fatalf("a new file reports version %d dirty %v err %v, want 0 false nil", version, dirty, err)
	}
	if err := storage.Migrate(ctx, url); err != nil {
		t.Fatalf("migrate an empty file: %v", err)
	}
	// A second run is a no-op.
	if err := storage.Migrate(ctx, url); err != nil {
		t.Fatalf("migrate again: %v", err)
	}
	version, dirty, err = storage.SchemaVersion(ctx, url)
	if err != nil || version == 0 || dirty {
		t.Fatalf("after migrating: version %d dirty %v err %v", version, dirty, err)
	}

	db, err := storage.Open(ctx, url)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	bus := storage.NewInProcessBus()
	fleet, err := bus.Subscribe(ctx, storage.ChannelFleet)
	if err != nil {
		t.Fatal(err)
	}
	p := NewProcessor(db, bus)

	agentID, sessionID := randomID(t), randomID(t)
	base := consumer.EventPayload{
		SessionID: sessionID, Flavor: "fresh-file-test",
		AgentID: agentID, AgentType: "coding", ClientType: "flightdeck_sensor",
		AgentName: "fresh-file-test", User: "test", Hostname: "test-host",
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
	}
	start := base
	start.EventType, start.CapturePrompts, start.StreamSeq = "session_start", true, 1
	start.Context = map[string]interface{}{"os": "Linux"}
	call := base
	tokens := 21
	call.EventType, call.Model, call.TokensTotal, call.StreamSeq = "post_call", "gpt-4o-mini", &tokens, 2
	call.Framework = "langchain"
	call.HasContent = true
	call.Content = json.RawMessage(`{"provider":"openai","model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"response":{"choices":[]}}`)
	end := base
	end.EventType, end.StreamSeq = "session_end", 3
	for _, e := range []consumer.EventPayload{start, call, end} {
		if err := p.Process(ctx, e); err != nil {
			t.Fatalf("process %s: %v", e.EventType, err)
		}
	}

	var state, framework string
	var used, events, content, agents int
	var frameworks string
	if err := db.Reader().QueryRowContext(ctx, `
		SELECT state, framework, tokens_used, json_extract(context, '$.frameworks'),
		       (SELECT count(*) FROM events WHERE session_id = sessions.session_id),
		       (SELECT count(*) FROM event_content WHERE session_id = sessions.session_id),
		       (SELECT total_sessions FROM agents WHERE agent_id = sessions.agent_id)
		FROM sessions WHERE session_id = $1`, sessionID).Scan(&state, &framework, &used, &frameworks, &events, &content, &agents); err != nil {
		t.Fatalf("read the session: %v", err)
	}
	if state != "closed" || framework != "langchain" || used != 21 || frameworks != `["langchain"]` || events != 3 || content != 1 || agents != 1 {
		t.Errorf("session after the run: state=%s framework=%s tokens=%d frameworks=%s events=%d content=%d agent sessions=%d",
			state, framework, used, frameworks, events, content, agents)
	}

	// One fleet notification per stored event, carrying its type.
	var types []string
	for range 3 {
		select {
		case raw := <-fleet:
			var n struct {
				SessionID string `json:"session_id"`
				EventType string `json:"event_type"`
				EventID   string `json:"event_id"`
			}
			if err := json.Unmarshal([]byte(raw), &n); err != nil || n.SessionID != sessionID || n.EventID == "" {
				t.Fatalf("notification %q: %v", raw, err)
			}
			types = append(types, n.EventType)
		case <-ctx.Done():
			t.Fatalf("received %v, want three fleet notifications", types)
		}
	}
	if len(types) != 3 || types[0] != "session_start" || types[1] != "post_call" || types[2] != "session_end" {
		t.Errorf("fleet notifications = %v, want the three events in order", types)
	}
}
