package processor

import (
	"testing"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
)

func TestNormalizeModelFields(t *testing.T) {
	cases := []struct {
		name string
		in   consumer.EventPayload
		want consumer.EventPayload
	}{
		{
			name: "legacy model only: raw kept as requested, canonical model, defaults",
			in: consumer.EventPayload{EventType: "post_call", ClientType: "flightdeck_sensor",
				Model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0"},
			want: consumer.EventPayload{EventType: "post_call", ClientType: "flightdeck_sensor",
				Model:          "claude-sonnet-4-5-20250929",
				ModelRequested: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
				Provider:       "anthropic", BillingMode: "metered", InferenceScope: "regional"},
		},
		{
			name: "served id wins for the canonical model; requested kept",
			in: consumer.EventPayload{EventType: "post_call", ClientType: "flightdeck_sensor",
				Model: "gpt-5.1", ModelRequested: "gpt-5.1", ModelServed: "gpt-5.1-2025-11-13"},
			want: consumer.EventPayload{EventType: "post_call", ClientType: "flightdeck_sensor",
				Model: "gpt-5.1-2025-11-13", ModelRequested: "gpt-5.1", ModelServed: "gpt-5.1-2025-11-13",
				Provider: "openai", BillingMode: "metered"},
		},
		{
			name: "served id only: it is also the requested id",
			in:   consumer.EventPayload{EventType: "embeddings", ModelServed: "text-embedding-3-small"},
			want: consumer.EventPayload{EventType: "embeddings",
				Model: "text-embedding-3-small", ModelRequested: "text-embedding-3-small",
				ModelServed: "text-embedding-3-small", Provider: "openai", BillingMode: "metered"},
		},
		{
			name: "Claude Code defaults to subscription",
			in:   consumer.EventPayload{EventType: "post_call", ClientType: "claude_code", Model: "claude-opus-4-6"},
			want: consumer.EventPayload{EventType: "post_call", ClientType: "claude_code",
				Model: "claude-opus-4-6", ModelRequested: "claude-opus-4-6",
				Provider: "anthropic", BillingMode: "subscription"},
		},
		{
			name: "values the client sent are kept",
			in: consumer.EventPayload{EventType: "post_call", ClientType: "claude_code",
				Model: "global.anthropic.claude-opus-4-6-v1", Provider: "anthropic",
				BillingMode: "metered", InferenceScope: "regional"},
			want: consumer.EventPayload{EventType: "post_call", ClientType: "claude_code",
				Model: "claude-opus-4-6", ModelRequested: "global.anthropic.claude-opus-4-6-v1",
				Provider: "anthropic", BillingMode: "metered", InferenceScope: "regional"},
		},
		{
			name: "non-LLM event with a model gets no billing mode",
			in:   consumer.EventPayload{EventType: "llm_error", Model: "o3"},
			want: consumer.EventPayload{EventType: "llm_error", Model: "o3", ModelRequested: "o3", Provider: "openai"},
		},
		{
			name: "LLM call without a model still gets a billing mode",
			in:   consumer.EventPayload{EventType: "post_call", ClientType: "claude_code"},
			want: consumer.EventPayload{EventType: "post_call", ClientType: "claude_code", BillingMode: "subscription"},
		},
		{
			name: "event without a model is untouched",
			in:   consumer.EventPayload{EventType: "tool_call"},
			want: consumer.EventPayload{EventType: "tool_call"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.in
			normalizeModelFields(&got)
			for _, f := range []struct{ name, got, want string }{
				{"model", got.Model, tc.want.Model},
				{"model_requested", got.ModelRequested, tc.want.ModelRequested},
				{"model_served", got.ModelServed, tc.want.ModelServed},
				{"provider", got.Provider, tc.want.Provider},
				{"billing_mode", got.BillingMode, tc.want.BillingMode},
				{"inference_scope", got.InferenceScope, tc.want.InferenceScope},
			} {
				if f.got != f.want {
					t.Errorf("%s = %q, want %q", f.name, f.got, f.want)
				}
			}
		})
	}
}

// Normalising twice changes nothing: the write path may see an event
// that a client already canonicalised.
func TestNormalizeModelFields_Idempotent(t *testing.T) {
	e := consumer.EventPayload{EventType: "post_call", Model: "openrouter/anthropic/claude-sonnet-4.5"}
	normalizeModelFields(&e)
	once := e
	normalizeModelFields(&e)
	if e.Model != once.Model || e.ModelRequested != once.ModelRequested || e.Provider != once.Provider {
		t.Errorf("second pass changed the event: %+v then %+v", once, e)
	}
}
