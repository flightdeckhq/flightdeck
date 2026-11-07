package writer

import (
	"context"
	"encoding/json"
	"testing"
)

// These tests pin how a call's model and framework land on its session
// row: the framework fills a session whose session_start carried
// none (the sensor detected the framework after init()) and is appended
// to context.frameworks, and a stored framework is never replaced. Like
// the other writer DB tests they skip without TEST_POSTGRES_URL /
// FLIGHTDECK_POSTGRES_URL.

// frameworkSession inserts a session row with the given framework (""
// for NULL) and context (nil for NULL) and removes it afterwards.
func frameworkSession(t *testing.T, framework string, contextJSON []byte) (*Writer, string) {
	t.Helper()
	pool := testPool(t)
	sessionID := newUUID(t)
	trackSession(t, pool, sessionID)
	var ctxArg any
	if contextJSON != nil {
		ctxArg = string(contextJSON)
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO sessions (session_id, flavor, agent_type, framework, context)
		VALUES ($1::uuid, 'writer-test', 'coding', NULLIF($2, ''), $3::jsonb)`,
		sessionID, framework, ctxArg); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	return New(pool), sessionID
}

type frameworkRow struct {
	model, framework *string
	context          map[string]any
}

func readFrameworkRow(t *testing.T, w *Writer, sessionID string) frameworkRow {
	t.Helper()
	var r frameworkRow
	var raw []byte
	if err := w.pool.QueryRow(context.Background(),
		`SELECT model, framework, context FROM sessions WHERE session_id = $1::uuid`, sessionID,
	).Scan(&r.model, &r.framework, &raw); err != nil {
		t.Fatalf("read session %s: %v", sessionID, err)
	}
	if raw != nil {
		if err := json.Unmarshal(raw, &r.context); err != nil {
			t.Fatalf("decode context: %v", err)
		}
	}
	return r
}

func updateFromCall(t *testing.T, w *Writer, sessionID, model, framework string) {
	t.Helper()
	if err := w.UpdateSessionFromCall(context.Background(), sessionID, model, framework); err != nil {
		t.Fatalf("update session from call: %v", err)
	}
}

func frameworksOf(r frameworkRow) []any {
	list, _ := r.context["frameworks"].([]any)
	return list
}

func TestUpdateSessionFromCall_FillsALateFrameworkAndAppendsItToTheContext(t *testing.T) {
	w, sessionID := frameworkSession(t, "", []byte(`{"os":"Linux"}`))

	updateFromCall(t, w, sessionID, "gpt-4o-mini", "langchain")

	r := readFrameworkRow(t, w, sessionID)
	if r.framework == nil || *r.framework != "langchain" {
		t.Fatalf("framework = %v, want langchain", r.framework)
	}
	if r.model == nil || *r.model != "gpt-4o-mini" {
		t.Errorf("model = %v, want gpt-4o-mini", r.model)
	}
	if got := frameworksOf(r); len(got) != 1 || got[0] != "langchain" {
		t.Errorf("context.frameworks = %v, want [langchain]", got)
	}
	if r.context["os"] != "Linux" {
		t.Errorf("context lost its other keys: %v", r.context)
	}

	// The next call changes nothing: the label is not appended twice.
	updateFromCall(t, w, sessionID, "gpt-4o-mini", "langchain")
	if got := frameworksOf(readFrameworkRow(t, w, sessionID)); len(got) != 1 {
		t.Errorf("context.frameworks after a second call = %v, want one entry", got)
	}
}

func TestUpdateSessionFromCall_NeverReplacesAStoredFramework(t *testing.T) {
	w, sessionID := frameworkSession(t, "crewai", []byte(`{"frameworks":["crewai/1.15.0"]}`))

	updateFromCall(t, w, sessionID, "", "langchain")

	r := readFrameworkRow(t, w, sessionID)
	if r.framework == nil || *r.framework != "crewai" {
		t.Errorf("framework = %v, want crewai kept", r.framework)
	}
	if got := frameworksOf(r); len(got) != 1 || got[0] != "crewai/1.15.0" {
		t.Errorf("context.frameworks = %v, want [crewai/1.15.0] kept", got)
	}
}

func TestUpdateSessionFromCall_LeavesAnUnwrittenContextForItsUpgrade(t *testing.T) {
	for name, ctx := range map[string][]byte{"null": nil, "empty": []byte(`{}`)} {
		t.Run(name, func(t *testing.T) {
			w, sessionID := frameworkSession(t, "", ctx)

			updateFromCall(t, w, sessionID, "", "pydantic_ai")

			r := readFrameworkRow(t, w, sessionID)
			if r.framework == nil || *r.framework != "pydantic_ai" {
				t.Errorf("framework = %v, want pydantic_ai", r.framework)
			}
			if len(r.context) != 0 {
				t.Errorf("context = %v, want it left unwritten", r.context)
			}
		})
	}
}

func TestUpdateSessionFromCall_ModelOnlyKeepsANullFramework(t *testing.T) {
	w, sessionID := frameworkSession(t, "", []byte(`{"os":"Linux"}`))

	updateFromCall(t, w, sessionID, "claude-haiku-4-5", "")

	r := readFrameworkRow(t, w, sessionID)
	if r.framework != nil {
		t.Errorf("framework = %q, want NULL", *r.framework)
	}
	if r.model == nil || *r.model != "claude-haiku-4-5" {
		t.Errorf("model = %v, want claude-haiku-4-5", r.model)
	}
	if _, ok := r.context["frameworks"]; ok {
		t.Errorf("context gained frameworks: %v", r.context)
	}
}
