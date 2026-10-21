package tests

import (
	"encoding/json"
	"testing"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/processor"
)

// Phase 4: BuildEventExtra used to short-circuit for every event type
// except directive_result. That behaviour masked the Phase 4 LLM_ERROR
// and streaming sub-objects because neither is a directive event. The
// gate is now lifted; the tests below pin the intended behaviour so a
// future refactor cannot regress it silently.

func TestBuildEventExtra_LLMError_SerializesStructuredError(t *testing.T) {
	e := consumer.EventPayload{
		SessionID: "x",
		EventType: "llm_error",
		Error: json.RawMessage(
			`{"error_type":"rate_limit","provider":"anthropic","http_status":429,"is_retryable":true}`,
		),
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("expected non-empty extra for llm_error event")
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse extra: %v", err)
	}
	inner, ok := parsed["error"].(map[string]interface{})
	if !ok {
		t.Fatalf("extra.error should be a map, got %T: %v", parsed["error"], parsed)
	}
	if inner["error_type"] != "rate_limit" {
		t.Errorf("error_type: want rate_limit, got %v", inner["error_type"])
	}
	if inner["is_retryable"] != true {
		t.Errorf("is_retryable: want true, got %v", inner["is_retryable"])
	}
}

func TestBuildEventExtra_Streaming_SerializesSubObject(t *testing.T) {
	e := consumer.EventPayload{
		SessionID: "x",
		EventType: "post_call",
		Streaming: json.RawMessage(
			`{"ttft_ms":320,"chunk_count":42,"final_outcome":"completed"}`,
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
	inner, ok := parsed["streaming"].(map[string]interface{})
	if !ok {
		t.Fatalf("extra.streaming should be a map, got %T: %v", parsed["streaming"], parsed)
	}
	if int(inner["chunk_count"].(float64)) != 42 {
		t.Errorf("chunk_count: want 42, got %v", inner["chunk_count"])
	}
}

func TestBuildEventExtra_DirectiveResultStillWorks(t *testing.T) {
	// Regression guard: the directive_result path must keep emitting
	// its legacy extras when the gate is lifted.
	e := consumer.EventPayload{
		SessionID:       "x",
		EventType:       "directive_result",
		DirectiveName:   "warn",
		DirectiveAction: "warn",
		DirectiveStatus: "ok",
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse extra: %v", err)
	}
	if parsed["directive_name"] != "warn" {
		t.Errorf("directive_name: want 'warn', got %v", parsed["directive_name"])
	}
}

func TestBuildEventExtra_NoExtras_ReturnsNil(t *testing.T) {
	// Most event types (session_start, post_call without streaming,
	// tool_call, pre_call, heartbeat) carry no Phase 4 extras. For
	// those the function must still short-circuit to nil so the
	// payload column stays NULL -- matching pre-Phase-4 behaviour.
	e := consumer.EventPayload{
		SessionID: "x",
		EventType: "post_call",
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	if out != nil {
		t.Errorf("expected nil extras for bare post_call, got %q", string(out))
	}
}

// The Claude Code plugin sends tool_use_id, mcp_server and end_reason.
// Each must land in events.payload when present and be absent
// otherwise, so a reader can tell "not sent" from "sent empty".

func TestBuildEventExtra_ToolUseID_ProjectsWhenPresent(t *testing.T) {
	e := consumer.EventPayload{
		SessionID: "x",
		EventType: "tool_call",
		ToolUseID: "toolu_01Xg9Qe5dbennMRZ7YuUVr4m",
	}
	parsed := buildExtra(t, e)
	if parsed["tool_use_id"] != "toolu_01Xg9Qe5dbennMRZ7YuUVr4m" {
		t.Errorf("tool_use_id: want toolu_01Xg9Qe5dbennMRZ7YuUVr4m, got %v", parsed["tool_use_id"])
	}
}

func TestBuildEventExtra_MCPServer_ReattachedAsOneDocument(t *testing.T) {
	e := consumer.EventPayload{
		SessionID:  "x",
		EventType:  "mcp_tool_call",
		ServerName: "plugin:claude-mem:mcp-search",
		MCPServer:  json.RawMessage(`{"name":"plugin:claude-mem:mcp-search","source":"plugin"}`),
	}
	parsed := buildExtra(t, e)
	inner, ok := parsed["mcp_server"].(map[string]interface{})
	if !ok {
		t.Fatalf("extra.mcp_server should be a map, got %T: %v", parsed["mcp_server"], parsed)
	}
	if inner["name"] != "plugin:claude-mem:mcp-search" {
		t.Errorf("mcp_server.name: got %v", inner["name"])
	}
	if inner["source"] != "plugin" {
		t.Errorf("mcp_server.source: got %v", inner["source"])
	}
}

func TestBuildEventExtra_EndReason_ProjectsBesideCloseReason(t *testing.T) {
	e := consumer.EventPayload{
		SessionID:   "x",
		EventType:   "session_end",
		CloseReason: "normal_exit",
		EndReason:   "prompt_input_exit",
	}
	parsed := buildExtra(t, e)
	if parsed["close_reason"] != "normal_exit" {
		t.Errorf("close_reason: want normal_exit, got %v", parsed["close_reason"])
	}
	if parsed["end_reason"] != "prompt_input_exit" {
		t.Errorf("end_reason: want prompt_input_exit, got %v", parsed["end_reason"])
	}
}

func TestBuildEventExtra_PluginFieldsAbsentWhenNotSent(t *testing.T) {
	// A sensor tool_call / mcp_tool_call / session_end never carries
	// the plugin's fields; the stored payload must not grow empty keys.
	cases := []consumer.EventPayload{
		{SessionID: "x", EventType: "tool_call"},
		{SessionID: "x", EventType: "mcp_tool_call", ServerName: "filesystem"},
		{SessionID: "x", EventType: "session_end", CloseReason: "normal_exit"},
	}
	for _, e := range cases {
		parsed := buildExtra(t, e)
		for _, key := range []string{"tool_use_id", "mcp_server", "end_reason"} {
			if v, present := parsed[key]; present {
				t.Errorf("%s: %s must be absent when not sent, got %v", e.EventType, key, v)
			}
		}
	}
	// A malformed mcp_server document is dropped rather than failing
	// the event; the rest of the payload still lands.
	bad := consumer.EventPayload{
		SessionID:  "x",
		EventType:  "mcp_tool_call",
		ServerName: "filesystem",
		MCPServer:  json.RawMessage(`{not json`),
	}
	parsed := buildExtra(t, bad)
	if _, present := parsed["mcp_server"]; present {
		t.Errorf("malformed mcp_server must be dropped, got %v", parsed["mcp_server"])
	}
	if parsed["server_name"] != "filesystem" {
		t.Errorf("server_name must survive a dropped mcp_server, got %v", parsed["server_name"])
	}
}

// buildExtra runs BuildEventExtra and decodes the result; an event with
// nothing to project decodes to an empty map.
func buildExtra(t *testing.T, e consumer.EventPayload) map[string]interface{} {
	t.Helper()
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	parsed := map[string]interface{}{}
	if len(out) == 0 {
		return parsed
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("parse extra: %v", err)
	}
	return parsed
}
