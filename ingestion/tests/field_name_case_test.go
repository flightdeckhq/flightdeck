package handlers_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// subagentStart is a sub-agent's session_start carrying the parent's
// message to it.
func subagentStart() map[string]any {
	return map[string]any{
		"session_id":        "22222222-2222-4222-8222-222222222222",
		"agent_id":          "11111111-1111-4111-8111-111111111111",
		"agent_type":        "production",
		"client_type":       "flightdeck_sensor",
		"event_type":        "session_start",
		"sensor_version":    "0.8.0",
		"parent_session_id": "33333333-3333-4333-8333-333333333333",
		"agent_role":        "researcher",
		"incoming_message":  map[string]any{"body": "find the bug", "captured_at": "2026-11-02T12:00:00Z"},
	}
}

// The worker matches field names ignoring case, so a key that is a case
// variant of a field name is refused at every level the worker decodes
// into a struct or ingestion checks, and nothing reaches the bus.
func TestFieldNameCase_VariantsAreRefusedAtEveryLevel(t *testing.T) {
	cases := []struct {
		name  string
		event func() map[string]any
		edit  func(map[string]any)
		want  string
	}{
		{"top level: Streaming holding a string", streamedPostCall, func(p map[string]any) {
			delete(p, "streaming")
			p["Streaming"] = "garbage"
		}, `\"Streaming\" is not a field name`},
		{"top level: TOKENS_INPUT holding a negative count", streamedPostCall, func(p map[string]any) {
			p["TOKENS_INPUT"] = -5
		}, `\"TOKENS_INPUT\" is not a field name`},
		{"top level: next to the exact field", streamedPostCall, func(p map[string]any) {
			p["Tokens_Total"] = -1
		}, `the field is \"tokens_total\"`},
		{"top level: long s folds to s", streamedPostCall, func(p map[string]any) {
			p["tokenſ_input"] = -5
		}, `the field is \"tokens_input\"`},
		{"streaming", streamedPostCall, func(p map[string]any) {
			p["streaming"].(map[string]any)["Chunk_Count"] = -1
		}, `\"streaming.Chunk_Count\" is not a field name`},
		{"streaming.inter_chunk_ms", streamedPostCall, func(p map[string]any) {
			p["streaming"].(map[string]any)["inter_chunk_ms"].(map[string]any)["MAX"] = -1
		}, `\"streaming.inter_chunk_ms.MAX\" is not a field name`},
		{"llm_error error", failedStreamError, func(p map[string]any) {
			p["error"].(map[string]any)["Partial_Chunks"] = -3
		}, `\"error.Partial_Chunks\" is not a field name`},
		{"llm_error error: type", failedStreamError, func(p map[string]any) {
			p["error"].(map[string]any)["ERROR_TYPE"] = 429
		}, `the field is \"error.error_type\"`},
		{"incoming_message", subagentStart, func(p map[string]any) {
			p["incoming_message"].(map[string]any)["Captured_At"] = "later"
		}, `\"incoming_message.Captured_At\" is not a field name`},
		{"outgoing_message", subagentStart, func(p map[string]any) {
			p["event_type"] = "session_end"
			p["outgoing_message"] = map[string]any{"body": "done", "captured_at": "2026-11-02T12:01:00Z", "Has_Content": true}
		}, `\"outgoing_message.Has_Content\" is not a field name`},
	}
	for _, tc := range cases {
		payload := tc.event()
		tc.edit(payload)
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("%s: encode: %v", tc.name, err)
		}
		code, resp, published := postCapturing(t, body)
		if code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400 (body %s)", tc.name, code, resp)
		}
		if !strings.Contains(resp, tc.want) {
			t.Errorf("%s: response %s lacks %s", tc.name, resp, tc.want)
		}
		if published != nil {
			t.Errorf("%s: published %s", tc.name, published)
		}
	}
}

// Exact names pass, and so does a key that folds to no field name, which
// keeps its current handling: published as sent. An MCP event's error and
// a context map are not checked.
func TestFieldNameCase_ExactAndUnknownKeysPublishedAsSent(t *testing.T) {
	for name, payload := range map[string]map[string]any{
		"post_call with unknown keys": func() map[string]any {
			p := streamedPostCall()
			p["tool_input"] = "x"
			p["Os"] = "linux"
			p["streaming"].(map[string]any)["Chunks"] = 3
			p["context"] = map[string]any{"Session_ID": "a context key", "OS": "linux"}
			return p
		}(),
		"llm_error with every error field": failedStreamError(),
		"sub-agent start":                  subagentStart(),
		"MCP error object": {
			"session_id":  "22222222-2222-4222-8222-222222222222",
			"agent_id":    "11111111-1111-4111-8111-111111111111",
			"agent_type":  "production",
			"client_type": "flightdeck_sensor",
			"event_type":  "mcp_tool_call",
			"server_name": "fs",
			"transport":   "stdio",
			"tool_name":   "read",
			"error":       map[string]any{"Error_Type": "invalid_params", "message": "bad"},
		},
	} {
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("%s: encode: %v", name, err)
		}
		code, resp, published := postCapturing(t, body)
		if code != http.StatusOK {
			t.Errorf("%s: status %d, want 200 (body %s)", name, code, resp)
			continue
		}
		if payload["event_type"] != "session_start" && !bytes.Equal(published, body) {
			t.Errorf("%s was changed on the way to the bus:\n got %s\nwant %s", name, published, body)
		}
	}
}
