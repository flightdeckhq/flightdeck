package tests

import (
	"encoding/json"
	"testing"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/processor"
)

// D126 § 7 — sub-agent observability fields project inline into
// events.payload via BuildEventExtra. Small bodies route here; the
// 8 KiB → event_content overflow path is deferred (D126 v1).
//
// has_content stays false on sub-agent events: setting has_content=true
// without the LLM PromptContent shape (provider / model / messages /
// tools / response / input) would route to event_content with NULL
// columns and trip the dashboard's GET /v1/events/{id}/content with a
// 404 (Rule 37). The wire shape these tests pin keeps the cross-agent
// message body inline and dashboard-readable without a content-fetch
// round-trip.

func TestBuildEventExtra_SubagentSessionStart_ProjectsParentAndRole(t *testing.T) {
	e := consumer.EventPayload{
		SessionID:       "child-uuid",
		EventType:       "session_start",
		ParentSessionID: "parent-uuid",
		AgentRole:       "Researcher",
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("expected non-empty extra when sub-agent fields present")
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse extra: %v", err)
	}
	if parsed["parent_session_id"] != "parent-uuid" {
		t.Errorf("parent_session_id: want parent-uuid, got %v",
			parsed["parent_session_id"])
	}
	if parsed["agent_role"] != "Researcher" {
		t.Errorf("agent_role: want Researcher, got %v", parsed["agent_role"])
	}
}

func TestBuildEventExtra_SubagentSessionStart_ProjectsIncomingMessage(t *testing.T) {
	e := consumer.EventPayload{
		SessionID:       "child-uuid",
		EventType:       "session_start",
		ParentSessionID: "parent-uuid",
		AgentRole:       "Researcher",
		IncomingMessage: &consumer.SubagentMessage{
			Body:       json.RawMessage(`"find files matching X"`),
			CapturedAt: "2026-05-02T19:00:00Z",
		},
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse extra: %v", err)
	}
	inner, ok := parsed["incoming_message"].(map[string]interface{})
	if !ok {
		t.Fatalf("incoming_message should be a map, got %T", parsed["incoming_message"])
	}
	if inner["body"] != "find files matching X" {
		t.Errorf("incoming_message.body: want %q, got %v",
			"find files matching X", inner["body"])
	}
	if inner["captured_at"] != "2026-05-02T19:00:00Z" {
		t.Errorf("incoming_message.captured_at: want timestamp, got %v",
			inner["captured_at"])
	}
}

func TestBuildEventExtra_SubagentSessionEnd_ProjectsOutgoingAndState(t *testing.T) {
	e := consumer.EventPayload{
		SessionID:       "child-uuid",
		EventType:       "session_end",
		ParentSessionID: "parent-uuid",
		AgentRole:       "Researcher",
		OutgoingMessage: &consumer.SubagentMessage{
			Body:       json.RawMessage(`"found 7 matches"`),
			CapturedAt: "2026-05-02T19:00:01Z",
		},
		State: "error",
		Error: json.RawMessage(
			`{"type":"RuntimeError","message":"LLM downtime"}`,
		),
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse extra: %v", err)
	}
	if parsed["state"] != "error" {
		t.Errorf("state: want error, got %v", parsed["state"])
	}
	outErr, ok := parsed["error"].(map[string]interface{})
	if !ok {
		t.Fatalf("error block: want map, got %T", parsed["error"])
	}
	if outErr["type"] != "RuntimeError" {
		t.Errorf("error.type: want RuntimeError, got %v", outErr["type"])
	}
	out2, ok := parsed["outgoing_message"].(map[string]interface{})
	if !ok {
		t.Fatalf("outgoing_message: want map, got %T", parsed["outgoing_message"])
	}
	if out2["body"] != "found 7 matches" {
		t.Errorf("outgoing_message.body: want %q, got %v",
			"found 7 matches", out2["body"])
	}
}

func TestBuildEventExtra_RootSession_OmitsSubagentFields(t *testing.T) {
	// A regular session_start with no sub-agent fields must not
	// project any of the D126 keys into events.payload — every
	// existing root session would otherwise carry a NULL
	// parent_session_id / agent_role pair into the JSONB and bloat
	// the column without value.
	e := consumer.EventPayload{
		SessionID: "root-uuid",
		EventType: "session_start",
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	if len(out) != 0 {
		t.Fatalf("expected empty extra for root session_start; got %s", out)
	}
}

func TestBuildEventExtra_PreservesBodyShape(t *testing.T) {
	// The D126 § 7 body-preservation invariant: framework-supplied
	// objects (CrewAI Task description string vs LangGraph state
	// dict) round-trip through events.payload unchanged. The
	// dashboard's MESSAGES sub-section reads them verbatim.
	cases := []struct {
		name string
		body string
	}{
		{"string body (CrewAI task)", `"a CrewAI task description"`},
		{"dict body (LangGraph state)", `{"text":"node input","step":2}`},
		{"list body", `["a","b","c"]`},
		{"int body", `42`},
		{"null body", `null`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := consumer.EventPayload{
				SessionID:       "child-uuid",
				EventType:       "session_start",
				ParentSessionID: "parent-uuid",
				AgentRole:       "Researcher",
				IncomingMessage: &consumer.SubagentMessage{
					Body:       json.RawMessage(tc.body),
					CapturedAt: "2026-05-02T19:00:00Z",
				},
			}
			out, err := processor.BuildEventExtra(e)
			if err != nil {
				t.Fatalf("BuildEventExtra: %v", err)
			}
			var parsed map[string]interface{}
			if err := json.Unmarshal(out, &parsed); err != nil {
				t.Fatalf("parse extra: %v", err)
			}
			inner, ok := parsed["incoming_message"].(map[string]interface{})
			if !ok {
				t.Fatalf("incoming_message: want map, got %T", parsed["incoming_message"])
			}
			// Compare unmarshalled values (Go map iteration order is
			// random so a byte-string compare on dicts would flake).
			var wantV interface{}
			if err := json.Unmarshal([]byte(tc.body), &wantV); err != nil {
				t.Fatalf("parse want: %v", err)
			}
			gotV := inner["body"]
			gotJSON, _ := json.Marshal(gotV)
			wantJSON, _ := json.Marshal(wantV)
			// Re-marshal both sides through the same json.Marshal so
			// any normalisation it does (e.g. number formatting) is
			// applied to both. Compare the resulting bytes.
			if string(gotJSON) != string(wantJSON) {
				t.Errorf("body round-trip: want %s, got %s", wantJSON, gotJSON)
			}
		})
	}
}
