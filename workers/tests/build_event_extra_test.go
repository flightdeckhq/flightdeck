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
