package tests

import (
	"encoding/json"
	"testing"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/processor"
)

// The token and cost fields that have no events column travel in
// events.payload under their wire names; the column fields stay out of
// the payload.
func TestBuildEventExtra_TokenCostPayloadFields(t *testing.T) {
	var e consumer.EventPayload
	if err := json.Unmarshal([]byte(`{
		"session_id": "x", "event_type": "post_call",
		"tokens_cache_creation_1h": 100,
		"service_tier": "batch", "speed": "fast",
		"inference_geo": "us", "inference_scope": "regional",
		"server_tool_use": {"web_search_requests": 3},
		"stop_reason": "end_turn", "effort": "xhigh",
		"tokens_reasoning": 7, "provider": "anthropic", "billing_mode": "metered",
		"model_requested": "claude-sonnet-4-5", "model_served": "claude-sonnet-4-5-20250929",
		"cost_reported": 0.5, "cost_source": "agent"
	}`), &e); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	out, err := processor.BuildEventExtra(e)
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("parse extra: %v", err)
	}
	want := map[string]any{
		"tokens_cache_creation_1h": float64(100),
		"service_tier":             "batch",
		"speed":                    "fast",
		"inference_geo":            "us",
		"inference_scope":          "regional",
		"stop_reason":              "end_turn",
		"effort":                   "xhigh",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("payload[%q] = %v, want %v", k, got[k], v)
		}
	}
	tools, ok := got["server_tool_use"].(map[string]any)
	if !ok || tools["web_search_requests"] != float64(3) {
		t.Errorf("payload.server_tool_use = %v, want web_search_requests 3", got["server_tool_use"])
	}
	for _, column := range []string{
		"tokens_reasoning", "provider", "billing_mode", "model_requested",
		"model_served", "cost_reported", "cost_source",
	} {
		if _, present := got[column]; present {
			t.Errorf("column field %q must not be copied into the payload", column)
		}
	}
}

// An LLM event that carries none of the fields keeps its payload as it
// was: no empty keys appear.
func TestBuildEventExtra_TokenCostFieldsAbsent(t *testing.T) {
	out, err := processor.BuildEventExtra(consumer.EventPayload{SessionID: "x", EventType: "post_call"})
	if err != nil {
		t.Fatalf("BuildEventExtra: %v", err)
	}
	if len(out) != 0 {
		t.Errorf("expected no payload, got %s", out)
	}
}
