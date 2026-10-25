package store

import (
	"context"
	"encoding/json"
	"math"
	"slices"
	"testing"
	"time"
)

// costScenario seeds one agent with a session holding three LLM calls
// in the last hour: a priced metered call, an unpriced metered call and
// a priced subscription call.
type costScenario struct {
	agentID, flavor, priced, unpriced string
	wantCost                          float64
}

func seedCostScenario(t *testing.T, s *Store, now time.Time) costScenario {
	t.Helper()
	ctx := context.Background()
	sc := costScenario{agentID: randomUUID(t), flavor: "test-cost-scenario-" + randomUUID(t)[:8]}
	sc.priced, sc.unpriced = sc.flavor+"-priced", sc.flavor+"-unpriced"
	seedAgent(t, s, sc.agentID, now.Add(-2*time.Hour), now, 1, 0)
	sessionID := randomUUID(t)
	seedSessionRow(t, s, sessionID, sc.agentID, sc.flavor, nil, nil,
		`{"frameworks": ["langchain"]}`, now.Add(-time.Hour), 0)
	seedPrice(t, s, sc.priced, 3, 15)
	for _, ev := range []struct {
		model, billing string
		in, out        int
	}{
		{sc.priced, "metered", 1000, 100},
		{sc.unpriced, "metered", 500, 50},
		{sc.priced, "subscription", 2000, 200},
	} {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO events (session_id, flavor, event_type, model, tokens_input, tokens_output,
				tokens_total, billing_mode, provider, occurred_at)
			VALUES ($1::uuid, $2, 'post_call', $3, $4::int, $5::int, $4::int + $5::int, $6, 'other', $7)`,
			sessionID, sc.flavor, ev.model, ev.in, ev.out, ev.billing, now.Add(-30*time.Minute)); err != nil {
			t.Fatalf("seed event: %v", err)
		}
	}
	sc.wantCost = (1000*3 + 100*15) / 1e6
	return sc
}

func TestQueryAnalytics_EstimatedCostAcrossShapes(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	sc := seedCostScenario(t, s, now)

	for _, tc := range []struct {
		name   string
		params AnalyticsParams
	}{
		{"by model", AnalyticsParams{GroupBy: "model"}},
		{"by framework (unnest)", AnalyticsParams{GroupBy: "framework"}},
		{"by provider", AnalyticsParams{GroupBy: "provider", FilterProvider: "other"}},
		{"two dimensions", AnalyticsParams{GroupBy: "flavor", GroupBySecondary: "model"}},
		{"agent_type filter", AnalyticsParams{GroupBy: "model", FilterAgentType: "production"}},
		{"agent filter", AnalyticsParams{GroupBy: "host", FilterAgentID: sc.agentID}},
	} {
		p := tc.params
		p.Metric, p.Range, p.Granularity = "estimated_cost", "custom", "day"
		p.From, p.To, p.FilterFlavor = now.Add(-time.Hour), now, sc.flavor
		resp, err := s.QueryAnalytics(ctx, p)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if math.Abs(resp.Totals.GrandTotal-sc.wantCost) > 1e-9 {
			t.Errorf("%s: cost = %v, want %v (the subscription call must not count)", tc.name, resp.Totals.GrandTotal, sc.wantCost)
		}
		if !resp.PartialEstimate || !slices.Contains(resp.ModelsUnpriced, sc.unpriced) {
			t.Errorf("%s: %s should be reported unpriced: partial=%v unpriced=%v",
				tc.name, sc.unpriced, resp.PartialEstimate, resp.ModelsUnpriced)
		}
		if !slices.Contains(resp.BillingModes, "metered") || !slices.Contains(resp.BillingModes, "subscription") {
			t.Errorf("%s: billing modes = %v, want metered and subscription", tc.name, resp.BillingModes)
		}
	}

	// A sub-agent filter that matches nothing still yields a valid query.
	if _, err := s.QueryAnalytics(ctx, AnalyticsParams{
		Metric: "estimated_cost", GroupBy: "model", Range: "custom", Granularity: "day",
		From: now.Add(-time.Hour), To: now, FilterFlavor: sc.flavor, FilterIsSubAgent: true,
	}); err != nil {
		t.Fatalf("sub-agent filter: %v", err)
	}
}

func TestAgentSummary_CostAndCoverage(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	sc := seedCostScenario(t, s, now)

	resp, err := s.AgentSummary(ctx, AgentSummaryParams{AgentID: sc.agentID, Period: "24h", Bucket: "hour"})
	if err != nil {
		t.Fatalf("summary: %v", err)
	}
	if math.Abs(resp.Totals.CostUSD-sc.wantCost) > 1e-9 {
		t.Errorf("cost = %v, want %v", resp.Totals.CostUSD, sc.wantCost)
	}
	if !resp.Totals.PartialEstimate || !slices.Equal(resp.Totals.ModelsUnpriced, []string{sc.unpriced}) {
		t.Errorf("unpriced = %v (partial %v), want [%s]", resp.Totals.ModelsUnpriced, resp.Totals.PartialEstimate, sc.unpriced)
	}
	if !slices.Equal(resp.Totals.BillingModes, []string{"metered", "subscription"}) {
		t.Errorf("billing modes = %v", resp.Totals.BillingModes)
	}
	var seriesCost float64
	for _, p := range resp.Series {
		seriesCost += p.CostUSD
	}
	if math.Abs(seriesCost-sc.wantCost) > 1e-9 {
		t.Errorf("series cost = %v, want %v", seriesCost, sc.wantCost)
	}
}

func TestAgentSummary_EmptyCoverageIsAnEmptyList(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	agentID := randomUUID(t)
	now := time.Now().UTC()
	seedAgent(t, s, agentID, now.Add(-time.Hour), now, 0, 0)

	resp, err := s.AgentSummary(context.Background(), AgentSummaryParams{AgentID: agentID, Period: "24h", Bucket: "hour"})
	if err != nil {
		t.Fatalf("summary: %v", err)
	}
	encoded, _ := json.Marshal(resp.Totals)
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(encoded, &fields)
	for _, key := range []string{"models_unpriced", "billing_modes"} {
		if string(fields[key]) != "[]" {
			t.Errorf("%s = %s, want []", key, fields[key])
		}
	}
}
