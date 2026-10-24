package processor

import (
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
)

func TestEventRow_MapsTokenCostColumns(t *testing.T) {
	reasoning := int64(12)
	cost := 0.25
	e := consumer.EventPayload{
		ID: "evt", SessionID: "sess", Flavor: "f", EventType: "post_call",
		Model:           "claude-sonnet-4-5",
		TokensReasoning: &reasoning,
		ModelRequested:  "claude-sonnet-4-5",
		ModelServed:     "claude-sonnet-4-5-20250929",
		Provider:        "anthropic",
		BillingMode:     "metered",
		CostReported:    &cost,
		CostSource:      "provider",
		ProviderMetadata: map[string]interface{}{
			"platform": "bedrock", "request_id": "req_1",
		},
	}
	ts := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	row := eventRow(e, ts, []byte(`{}`))

	if row.TokensReasoning != &reasoning || row.CostReported != &cost {
		t.Error("pointer fields must be passed through")
	}
	for name, pair := range map[string][2]string{
		"model_requested": {row.ModelRequested, "claude-sonnet-4-5"},
		"model_served":    {row.ModelServed, "claude-sonnet-4-5-20250929"},
		"provider":        {row.Provider, "anthropic"},
		"billing_mode":    {row.BillingMode, "metered"},
		"platform":        {row.Platform, "bedrock"},
		"cost_source":     {row.CostSource, "provider"},
	} {
		if pair[0] != pair[1] {
			t.Errorf("%s = %q, want %q", name, pair[0], pair[1])
		}
	}
	if !row.OccurredAt.Equal(ts) || string(row.Payload) != `{}` {
		t.Errorf("occurred_at / payload not carried: %v %s", row.OccurredAt, row.Payload)
	}
}

func TestPlatformOf_IgnoresAbsentOrNonStringPlatform(t *testing.T) {
	cases := []map[string]interface{}{
		nil,
		{"request_id": "req_1"},
		{"platform": 7},
	}
	for _, meta := range cases {
		if got := platformOf(consumer.EventPayload{ProviderMetadata: meta}); got != "" {
			t.Errorf("platformOf(%v) = %q, want empty", meta, got)
		}
	}
}
