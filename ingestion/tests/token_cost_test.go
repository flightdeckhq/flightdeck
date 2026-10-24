package handlers_test

import (
	"net/http"
	"strings"
	"testing"
)

// postCallWithTokenCost is a post_call carrying every token, model and
// cost field of the event payload contract, set to valid values.
func postCallWithTokenCost() map[string]any {
	return map[string]any{
		"session_id":               "22222222-2222-4222-8222-222222222222",
		"agent_id":                 "11111111-1111-4111-8111-111111111111",
		"agent_type":               "production",
		"client_type":              "flightdeck_sensor",
		"event_type":               "post_call",
		"model":                    "claude-sonnet-4-5",
		"model_requested":          "claude-sonnet-4-5",
		"model_served":             "claude-sonnet-4-5-20250929",
		"provider":                 "anthropic",
		"billing_mode":             "metered",
		"tokens_input":             1200,
		"tokens_output":            400,
		"tokens_total":             1600,
		"tokens_cache_read":        800,
		"tokens_cache_creation":    300,
		"tokens_cache_creation_1h": 100,
		"tokens_reasoning":         150,
		"cost_reported":            0.0123,
		"cost_source":              "agent",
		"service_tier":             "standard",
		"speed":                    "standard",
		"inference_geo":            "us",
		"inference_scope":          "regional",
		"server_tool_use":          map[string]any{"web_search_requests": 2},
		"stop_reason":              "end_turn",
		"provider_metadata":        map[string]any{"platform": "bedrock", "request_id": "req_1"},
	}
}

func TestEventsHandler_TokenCostFields_AcceptsTheFullContract(t *testing.T) {
	for _, eventType := range []string{"post_call", "embeddings"} {
		payload := postCallWithTokenCost()
		payload["event_type"] = eventType
		if code, body := runEventValidationTest(t, payload); code != http.StatusOK {
			t.Errorf("%s: expected 200, got %d body=%s", eventType, code, body)
		}
	}
}

func TestEventsHandler_TokenCostFields_NullsCountAsAbsent(t *testing.T) {
	payload := postCallWithTokenCost()
	for _, key := range []string{
		"model_requested", "model_served", "provider", "billing_mode",
		"tokens_cache_creation_1h", "tokens_reasoning", "cost_reported",
		"cost_source", "service_tier", "speed", "inference_geo",
		"inference_scope", "server_tool_use", "stop_reason",
	} {
		payload[key] = nil
	}
	if code, body := runEventValidationTest(t, payload); code != http.StatusOK {
		t.Errorf("expected 200, got %d body=%s", code, body)
	}
}

func TestEventsHandler_TokenCostFields_Rejections(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]any)
		want   string
	}{
		{"negative reasoning", func(p map[string]any) { p["tokens_reasoning"] = -1 }, "tokens_reasoning"},
		{"fractional reasoning", func(p map[string]any) { p["tokens_reasoning"] = 1.5 }, "tokens_reasoning"},
		{"string reasoning", func(p map[string]any) { p["tokens_reasoning"] = "5" }, "tokens_reasoning"},
		{"negative 1h cache", func(p map[string]any) { p["tokens_cache_creation_1h"] = -3 }, "tokens_cache_creation_1h"},
		{"reasoning above output", func(p map[string]any) { p["tokens_reasoning"] = 401 }, "must not exceed tokens_output"},
		{"1h above cache creation", func(p map[string]any) { p["tokens_cache_creation_1h"] = 301 }, "must not exceed tokens_cache_creation"},
		{"cost without source", func(p map[string]any) { delete(p, "cost_source") }, "sent together"},
		{"source without cost", func(p map[string]any) { delete(p, "cost_reported") }, "sent together"},
		{"negative cost", func(p map[string]any) { p["cost_reported"] = -0.01 }, "cost_reported"},
		{"string cost", func(p map[string]any) { p["cost_reported"] = "0.01" }, "cost_reported"},
		{"unknown cost source", func(p map[string]any) { p["cost_source"] = "guess" }, "cost_source"},
		{"unknown billing mode", func(p map[string]any) { p["billing_mode"] = "free" }, "billing_mode"},
		{"non-string billing mode", func(p map[string]any) { p["billing_mode"] = 1 }, "billing_mode"},
		{"unknown provider", func(p map[string]any) { p["provider"] = "litellm" }, "provider"},
		{"unknown inference scope", func(p map[string]any) { p["inference_scope"] = "local" }, "inference_scope"},
		{"oversize model_requested", func(p map[string]any) { p["model_requested"] = strings.Repeat("m", 257) }, "model_requested"},
		{"non-string model_served", func(p map[string]any) { p["model_served"] = 42 }, "model_served"},
		{"oversize stop_reason", func(p map[string]any) { p["stop_reason"] = strings.Repeat("s", 257) }, "stop_reason"},
		{"server_tool_use not an object", func(p map[string]any) { p["server_tool_use"] = []any{1} }, "server_tool_use"},
		{"negative server tool counter", func(p map[string]any) {
			p["server_tool_use"] = map[string]any{"web_search_requests": -1}
		}, "server_tool_use.web_search_requests"},
		{"oversize platform", func(p map[string]any) {
			p["provider_metadata"] = map[string]any{"platform": strings.Repeat("h", 254)}
		}, "provider_metadata.platform"},
		{"non-string platform", func(p map[string]any) {
			p["provider_metadata"] = map[string]any{"platform": 7}
		}, "provider_metadata.platform"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload := postCallWithTokenCost()
			tc.mutate(payload)
			code, body := runEventValidationTest(t, payload)
			if code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d body=%s", code, body)
			}
			if !strings.Contains(body, tc.want) {
				t.Errorf("expected %q in error body, got %s", tc.want, body)
			}
		})
	}
}

func TestEventsHandler_TokenCostFields_SubsetCheckNeedsBothFields(t *testing.T) {
	// A share without its total cannot be compared and is accepted.
	payload := postCallWithTokenCost()
	delete(payload, "tokens_output")
	payload["tokens_reasoning"] = 10_000
	if code, body := runEventValidationTest(t, payload); code != http.StatusOK {
		t.Errorf("expected 200, got %d body=%s", code, body)
	}
}
