package writer

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// These tests pin how a call's model and framework land on its session
// row: the framework fills a session whose session_start carried
// none (the sensor detected the framework after init()) and is appended
// to context.frameworks, and a stored framework is never replaced. The
// append is the one JSON mutation both backends must perform
// identically (jsonb_set on Postgres, json_set / json_insert on
// SQLite), so every case runs on both.

// frameworkSession inserts a session row with the given framework (""
// for NULL) and context (nil for NULL) and removes it afterwards.
func frameworkSession(t *testing.T, db *storage.DB, framework string, contextJSON []byte) (*Writer, string) {
	t.Helper()
	sessionID := newUUID(t)
	trackSession(t, db, sessionID)
	if _, err := db.ExecContext(context.Background(), `
		INSERT INTO sessions (session_id, flavor, agent_type, framework, context)
		VALUES ($1, 'writer-test', 'coding', NULLIF($2, ''), $3)`,
		sessionID, framework, jsonArg(contextJSON)); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	w, _ := newTestWriter(db)
	return w, sessionID
}

type frameworkRow struct {
	model, framework *string
	context          map[string]any
}

func readFrameworkRow(t *testing.T, w *Writer, sessionID string) frameworkRow {
	t.Helper()
	var r frameworkRow
	var raw []byte
	if err := w.db.Reader().QueryRowContext(context.Background(),
		`SELECT model, framework, context FROM sessions WHERE session_id = $1`, sessionID,
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
	each(t, func(t *testing.T, db *storage.DB) {
		w, sessionID := frameworkSession(t, db, "", []byte(`{"os":"Linux"}`))

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
	})
}

func TestUpdateSessionFromCall_NeverReplacesAStoredFramework(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, sessionID := frameworkSession(t, db, "crewai", []byte(`{"frameworks":["crewai/1.15.0"]}`))

		updateFromCall(t, w, sessionID, "", "langchain")

		r := readFrameworkRow(t, w, sessionID)
		if r.framework == nil || *r.framework != "crewai" {
			t.Errorf("framework = %v, want crewai kept", r.framework)
		}
		if got := frameworksOf(r); len(got) != 1 || got[0] != "crewai/1.15.0" {
			t.Errorf("context.frameworks = %v, want [crewai/1.15.0] kept", got)
		}
	})
}

func TestUpdateSessionFromCall_LeavesAnUnwrittenContextForItsUpgrade(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		// The empty object in two spellings: a call must leave both for
		// the session_start, whatever whitespace the client sent.
		for name, ctx := range map[string][]byte{"null": nil, "empty": []byte(`{}`), "spaced": []byte(`{ }`)} {
			t.Run(name, func(t *testing.T) {
				w, sessionID := frameworkSession(t, db, "", ctx)

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
	})
}

// A call can reach the worker before its session_start: the row is
// lazily created with the call's framework and a NULL context, so that
// call cannot append to context.frameworks; the session_start then
// writes the init-time context, which has no framework, and keeps the
// column. The next call appends the label, once.
func TestUpdateSessionFromCall_AppendsTheLabelAfterALateSessionStart(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		ctx := context.Background()
		id := testAgent(t, w, db, "framework-test")
		sessionID := newUUID(t)
		trackSession(t, db, sessionID)

		if _, err := w.ReviveOrCreateSession(ctx, sessionID, "writer-test", id.AgentType,
			"writer-test-host", "langchain", "gpt-4o-mini", id, time.Now().UTC(), "", ""); err != nil {
			t.Fatalf("lazy create: %v", err)
		}
		updateFromCall(t, w, sessionID, "gpt-4o-mini", "langchain")
		if r := readFrameworkRow(t, w, sessionID); r.context != nil {
			t.Fatalf("a call wrote the lazy row's NULL context: %v", r.context)
		}

		if _, err := w.UpsertSession(ctx, sessionID, "writer-test", id.AgentType,
			"writer-test-host", "", "", "active",
			id.AgentID, id.ClientType, id.AgentName,
			[]byte(`{"os":"Linux","hostname":"writer-test-host"}`), "", "", "", "", true, 0, time.Time{},
		); err != nil {
			t.Fatalf("session_start: %v", err)
		}
		updateFromCall(t, w, sessionID, "gpt-4o-mini", "langchain")
		updateFromCall(t, w, sessionID, "gpt-4o-mini", "langchain")

		r := readFrameworkRow(t, w, sessionID)
		if r.framework == nil || *r.framework != "langchain" {
			t.Fatalf("framework = %v, want langchain", r.framework)
		}
		if got := frameworksOf(r); len(got) != 1 || got[0] != "langchain" {
			t.Errorf("context.frameworks = %v, want [langchain] exactly once", got)
		}
		if r.context["os"] != "Linux" {
			t.Errorf("the session_start's context was not kept: %v", r.context)
		}
	})
}

// A run with one call whose post_call is processed before its
// session_start: no later call reaches UpdateSessionFromCall (the
// session_end does not), so the session_start that writes the context
// adds the label the call put on the row. Other clients' starts write
// their context as sent.
func TestUpsertSession_AddsTheFrameworkALateCallSetOnALazyRow(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		for name, tc := range map[string]struct {
			clientType, framework, context string
			want                           []any // nil: no frameworks key
		}{
			"sensor, one call": {"flightdeck_sensor", "langchain", `{"os":"Linux"}`, []any{"langchain"}},
			"sensor, already listed": {"flightdeck_sensor", "langchain",
				`{"os":"Linux","frameworks":["langchain/1.6.10"]}`, []any{"langchain/1.6.10"}},
			"claude code plugin": {"claude_code", "claude-code",
				`{"frameworks":["claude-code/2.1.316"]}`, []any{"claude-code/2.1.316"}},
			"agent sdk": {"claude_agent_sdk", "claude_agent_sdk",
				`{"frameworks":["claude_agent_sdk/0.2.168"]}`, []any{"claude_agent_sdk/0.2.168"}},
			"otlp claude code": {"claude_code", "claude-code",
				`{"telemetry":"otlp","claude_code_version":"2.1.319"}`, nil},
		} {
			t.Run(name, func(t *testing.T) {
				w, _ := newTestWriter(db)
				ctx := context.Background()
				id := testAgent(t, w, db, "framework-test")
				id.ClientType = tc.clientType
				sessionID := newUUID(t)
				trackSession(t, db, sessionID)

				if _, err := w.ReviveOrCreateSession(ctx, sessionID, "writer-test", id.AgentType,
					"writer-test-host", tc.framework, "some-model", id, time.Now().UTC(), "", ""); err != nil {
					t.Fatalf("lazy create: %v", err)
				}
				updateFromCall(t, w, sessionID, "some-model", tc.framework)
				if _, err := w.UpsertSession(ctx, sessionID, "writer-test", id.AgentType,
					"writer-test-host", "", "", "active",
					id.AgentID, id.ClientType, id.AgentName,
					[]byte(tc.context), "", "", "", "", true, 0, time.Time{},
				); err != nil {
					t.Fatalf("session_start: %v", err)
				}

				r := readFrameworkRow(t, w, sessionID)
				if r.framework == nil || *r.framework != tc.framework {
					t.Errorf("framework = %v, want %q", r.framework, tc.framework)
				}
				got, has := r.context["frameworks"]
				switch {
				case tc.want == nil && has:
					t.Errorf("context gained frameworks: %v", r.context)
				case tc.want != nil && fmt.Sprint(got) != fmt.Sprint(tc.want):
					t.Errorf("context.frameworks = %v, want %v", got, tc.want)
				}
			})
		}
	})
}

// A session whose array already lists its own label, versioned or bare,
// is unchanged by its calls: the plugin's sessions, the Agent SDK's and
// those whose framework the sensor found at init().
func TestUpdateSessionFromCall_LeavesASessionThatListsItsLabel(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		for name, tc := range map[string]struct {
			framework, context string
		}{
			"claude code plugin": {"claude-code", `{"frameworks": ["claude-code/2.1.316"]}`},
			"agent sdk":          {"claude_agent_sdk", `{"frameworks": ["claude_agent_sdk/0.2.168", "langchain/1.4.4"]}`},
			"detected at init":   {"langchain", `{"frameworks": ["langchain/1.6.10"]}`},
			"bare entry":         {"agno", `{"frameworks": ["agno"]}`},
		} {
			t.Run(name, func(t *testing.T) {
				w, sessionID := frameworkSession(t, db, tc.framework, []byte(tc.context))
				before := readFrameworkRow(t, w, sessionID)

				updateFromCall(t, w, sessionID, "some-model", tc.framework)

				after := readFrameworkRow(t, w, sessionID)
				if after.framework == nil || *after.framework != tc.framework {
					t.Errorf("framework = %v, want %q", after.framework, tc.framework)
				}
				if fmt.Sprint(frameworksOf(after)) != fmt.Sprint(frameworksOf(before)) {
					t.Errorf("context.frameworks = %v, want %v unchanged", frameworksOf(after), frameworksOf(before))
				}
			})
		}
	})
}

// An OpenTelemetry Claude Code session carries framework=claude-code and
// its version as context.claude_code_version, with no frameworks entry;
// only a sensor session gets its own label appended, so its context is
// unchanged.
func TestUpdateSessionFromCall_LeavesAnotherClientsContext(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, sessionID := frameworkSession(t, db, "claude-code",
			[]byte(`{"telemetry":"otlp","claude_code_version":"2.1.319"}`))
		if _, err := w.db.ExecContext(context.Background(),
			`UPDATE sessions SET client_type = 'claude_code' WHERE session_id = $1`, sessionID); err != nil {
			t.Fatalf("set client_type: %v", err)
		}

		updateFromCall(t, w, sessionID, "claude-opus-5-5", "claude-code")

		r := readFrameworkRow(t, w, sessionID)
		if _, ok := r.context["frameworks"]; ok {
			t.Errorf("an OpenTelemetry Claude Code session gained frameworks: %v", r.context)
		}
	})
}

func TestUpdateSessionFromCall_ModelOnlyKeepsANullFramework(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, sessionID := frameworkSession(t, db, "", []byte(`{"os":"Linux"}`))

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
	})
}

// The other JSON mutations behave the same on both backends: the
// context upgrade fills only the two sentinels, and an MCP server is
// appended once per (name, server_url) with the stored document's other
// keys kept.
func TestJSONMutations_UpgradeContextAndAppendMCPServer(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		for name, initial := range map[string][]byte{"null": nil, "empty": []byte(`{}`), "spaced": []byte(` { } `)} {
			w, sessionID := frameworkSession(t, db, "", initial)
			if err := w.UpgradeSessionContext(ctx, sessionID, []byte(`{"os":"Linux"}`)); err != nil {
				t.Fatalf("%s: upgrade: %v", name, err)
			}
			if r := readFrameworkRow(t, w, sessionID); r.context["os"] != "Linux" {
				t.Errorf("%s: context after the upgrade = %v, want the new document", name, r.context)
			}
			if err := w.UpgradeSessionContext(ctx, sessionID, []byte(`{"os":"Windows"}`)); err != nil {
				t.Fatalf("%s: second upgrade: %v", name, err)
			}
			if r := readFrameworkRow(t, w, sessionID); r.context["os"] != "Linux" {
				t.Errorf("%s: a real context was overwritten: %v", name, r.context)
			}
		}

		w, sessionID := frameworkSession(t, db, "", []byte(`{"os":"Linux"}`))
		dict := func(name, url string) []byte {
			return []byte(fmt.Sprintf(`{"name":%q,"transport":"stdio","server_url":%q}`, name, url))
		}
		for _, d := range [][2]string{{"fs", "stdio://fs"}, {"fs", "stdio://fs"}, {"git", "stdio://git"}, {"fs", "stdio://other"}} {
			if err := w.AppendMCPServerToContext(ctx, sessionID, d[0], d[1], dict(d[0], d[1])); err != nil {
				t.Fatalf("append %v: %v", d, err)
			}
		}
		r := readFrameworkRow(t, w, sessionID)
		servers, _ := r.context["mcp_servers"].([]any)
		if len(servers) != 3 {
			t.Fatalf("mcp_servers = %v, want three distinct (name, server_url) entries", servers)
		}
		if first, _ := servers[0].(map[string]any); first["name"] != "fs" || first["transport"] != "stdio" {
			t.Errorf("first entry = %v, want the stored dict", servers[0])
		}
		if r.context["os"] != "Linux" {
			t.Errorf("context lost its other keys: %v", r.context)
		}
	})
}
