package store

import (
	"context"
	"math"
	"slices"
	"testing"
	"time"
)

// failedStreamScenario seeds one agent's session in the last hour with a
// completed call, an embeddings call, a failed stream whose llm_error
// carries the tokens the provider billed (as the worker stores them: in
// the token columns) and an llm_error without tokens on a model no price
// covers. The session's counter holds the same three billed amounts.
type failedStreamScenario struct {
	agentID, flavor, model, noTokensModel     string
	callTokens, embeddingTokens, failedTokens int
	wantCost                                  float64
}

// billedTokens is what every server total counts for the scenario.
func (sc failedStreamScenario) billedTokens() int {
	return sc.callTokens + sc.embeddingTokens + sc.failedTokens
}

func seedFailedStreamScenario(t *testing.T, s *Store, now time.Time) failedStreamScenario {
	t.Helper()
	ctx := context.Background()
	sc := failedStreamScenario{
		agentID: randomUUID(t), flavor: "test-failed-stream-" + randomUUID(t)[:8],
		callTokens: 1100, embeddingTokens: 200, failedTokens: 1740,
	}
	sc.model, sc.noTokensModel = sc.flavor+"-model", sc.flavor+"-unpriced"
	seedAgent(t, s, sc.agentID, now.Add(-2*time.Hour), now, 1, 0)
	sessionID := randomUUID(t)
	seedSessionRow(t, s, sessionID, sc.agentID, sc.flavor, nil, nil,
		`{"frameworks": ["langchain"]}`, now.Add(-time.Hour), sc.billedTokens())
	seedPrice(t, s, sc.model, 3, 15)
	insert := func(eventType, model string, in, out *int, billing *string) {
		t.Helper()
		if _, err := s.db.ExecContext(ctx, `
			INSERT INTO events (session_id, flavor, event_type, model, tokens_input, tokens_output,
				tokens_total, billing_mode, provider, occurred_at)
			VALUES ($1, $2, $3, $4, CAST($5 AS INTEGER), CAST($6 AS INTEGER), CAST($5 AS INTEGER) + CAST($6 AS INTEGER), $7, 'other', $8)`,
			sessionID, sc.flavor, eventType, model, in, out, billing, now.Add(-30*time.Minute)); err != nil {
			t.Fatalf("seed %s: %v", eventType, err)
		}
	}
	metered := "metered"
	in, out := 1000, 100
	insert("post_call", sc.model, &in, &out, &metered)
	ein, eout := 200, 0
	insert("embeddings", sc.model, &ein, &eout, &metered)
	pin, pout := 1500, 240
	insert("llm_error", sc.model, &pin, &pout, &metered)
	// An llm_error with no tokens (a refused request) on an unpriced
	// model: it counts nowhere and must not be reported unpriced.
	insert("llm_error", sc.noTokensModel, nil, nil, nil)
	sc.wantCost = float64(1000*3+100*15+200*3+1500*3+240*15) / 1e6
	return sc
}

func (sc failedStreamScenario) params(metric string, now time.Time, p AnalyticsParams) AnalyticsParams {
	p.Metric, p.Range, p.Granularity = metric, "custom", "day"
	p.From, p.To, p.FilterFlavor = now.Add(-time.Hour), now, sc.flavor
	return p
}

// groupBys covers a dimension on events, one joined from sessions, the
// unnested framework, provider, a two-dimension rollup and an agent
// filter, so every group-by path counts the failed stream.
var failedStreamGroupBys = []struct {
	name   string
	params AnalyticsParams
}{
	{"by model", AnalyticsParams{GroupBy: "model"}},
	{"by host (sessions join)", AnalyticsParams{GroupBy: "host"}},
	{"by framework (unnest)", AnalyticsParams{GroupBy: "framework"}},
	{"by provider", AnalyticsParams{GroupBy: "provider", FilterProvider: "other"}},
	{"two dimensions", AnalyticsParams{GroupBy: "flavor", GroupBySecondary: "model"}},
	{"agent filter", AnalyticsParams{GroupBy: "agent_type", FilterAgentID: ""}},
}

func TestQueryAnalytics_TokensCountFailedStreams(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		now := time.Now().UTC().Truncate(time.Millisecond)
		sc := seedFailedStreamScenario(t, s, now)

		// The metric counts what the session's counter holds.
		want := float64(sc.billedTokens())
		for _, tc := range failedStreamGroupBys {
			p := tc.params
			if tc.name == "agent filter" {
				p.FilterAgentID = sc.agentID
			}
			resp, err := s.QueryAnalytics(ctx, sc.params("tokens", now, p))
			if err != nil {
				t.Fatalf("%s: %v", tc.name, err)
			}
			if resp.Totals.GrandTotal != want {
				t.Errorf("%s: tokens = %v, want %v (the call, the embeddings and the failed stream)", tc.name, resp.Totals.GrandTotal, want)
			}
			for _, series := range resp.Series {
				if series.Dimension == sc.noTokensModel {
					t.Errorf("%s: the llm_error without tokens made a series of its own", tc.name)
				}
			}
		}
	})
}

func TestQueryAnalytics_EstimatedCostPricesFailedStreams(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		now := time.Now().UTC().Truncate(time.Millisecond)
		sc := seedFailedStreamScenario(t, s, now)

		for _, tc := range failedStreamGroupBys {
			p := tc.params
			if tc.name == "agent filter" {
				p.FilterAgentID = sc.agentID
			}
			resp, err := s.QueryAnalytics(ctx, sc.params("estimated_cost", now, p))
			if err != nil {
				t.Fatalf("%s: %v", tc.name, err)
			}
			if math.Abs(resp.Totals.GrandTotal-sc.wantCost) > 1e-9 {
				t.Errorf("%s: cost = %v, want %v (the failed stream priced like the call)", tc.name, resp.Totals.GrandTotal, sc.wantCost)
			}
			if slices.Contains(resp.ModelsUnpriced, sc.noTokensModel) {
				t.Errorf("%s: an llm_error without tokens was reported unpriced: %v", tc.name, resp.ModelsUnpriced)
			}
		}
	})
}

// The sub-agent token metrics read the session counter, which the worker
// raises by a failed stream's tokens.
func TestQueryAnalytics_SubagentTokenSumsFollowTheSessionCounter(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		now := time.Now().UTC().Truncate(time.Millisecond)
		flavor := "test-failed-stream-tree-" + randomUUID(t)[:8]
		agentID := randomUUID(t)
		seedAgent(t, s, agentID, now.Add(-2*time.Hour), now, 2, 0)
		parentID, childID := randomUUID(t), randomUUID(t)
		role := "researcher"
		// The child's counter holds a 300-token call and a 1,740-token
		// failed stream.
		seedSessionRow(t, s, parentID, agentID, flavor, nil, nil, `{}`, now.Add(-time.Hour), 500)
		seedSessionRow(t, s, childID, agentID, flavor, &parentID, &role, `{}`, now.Add(-50*time.Minute), 300+1740)

		for metric, want := range map[string]float64{"parent_token_sum": 500 + 300 + 1740, "child_token_sum": 300 + 1740} {
			resp, err := s.QueryAnalytics(ctx, AnalyticsParams{
				Metric: metric, GroupBy: "agent_role", Range: "custom", Granularity: "day",
				From: now.Add(-2 * time.Hour), To: now, FilterFlavor: flavor,
			})
			if err != nil {
				t.Fatalf("%s: %v", metric, err)
			}
			var root float64
			for _, series := range resp.Series {
				if series.Dimension == "(root)" {
					root = series.Total
				}
			}
			if root != want {
				t.Errorf("%s for the parent = %v, want %v", metric, root, want)
			}
		}
	})
}

func TestAgentSummary_CountsFailedStreams(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		now := time.Now().UTC().Truncate(time.Millisecond)
		sc := seedFailedStreamScenario(t, s, now)

		resp, err := s.AgentSummary(ctx, AgentSummaryParams{AgentID: sc.agentID, Period: "24h", Bucket: "hour"})
		if err != nil {
			t.Fatalf("summary: %v", err)
		}
		want := int64(sc.billedTokens())
		if resp.Totals.Tokens != want {
			t.Errorf("totals.tokens = %d, want %d", resp.Totals.Tokens, want)
		}
		if resp.Totals.Errors != 2 {
			t.Errorf("totals.errors = %d, want 2 (both llm_error events)", resp.Totals.Errors)
		}
		if math.Abs(resp.Totals.CostUSD-sc.wantCost) > 1e-9 {
			t.Errorf("totals.cost_usd = %v, want %v", resp.Totals.CostUSD, sc.wantCost)
		}
		if resp.Totals.PartialEstimate {
			t.Errorf("an llm_error without tokens made the estimate partial: %v", resp.Totals.ModelsUnpriced)
		}
		var seriesTokens int64
		for _, p := range resp.Series {
			seriesTokens += p.Tokens
		}
		if seriesTokens != want {
			t.Errorf("series tokens = %d, want %d", seriesTokens, want)
		}
	})
}

// A failed stream the sensor stamped local (or subscription) counts in
// the token totals and costs nothing, though its model has a price.
func TestQueryAnalytics_FailedStreamBilledLocallyCostsNothing(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		now := time.Now().UTC().Truncate(time.Millisecond)
		flavor := "test-failed-stream-local-" + randomUUID(t)[:8]
		agentID := randomUUID(t)
		seedAgent(t, s, agentID, now.Add(-2*time.Hour), now, 1, 0)
		sessionID := randomUUID(t)
		seedSessionRow(t, s, sessionID, agentID, flavor, nil, nil, `{}`, now.Add(-time.Hour), 500)
		model := flavor + "-model"
		seedPrice(t, s, model, 3, 15)
		for _, mode := range []string{"local", "subscription"} {
			if _, err := s.db.ExecContext(ctx, `
				INSERT INTO events (session_id, flavor, event_type, model, tokens_input, tokens_output,
					tokens_total, billing_mode, provider, occurred_at)
				VALUES ($1, $2, 'llm_error', $3, 200, 50, 250, $4, 'other', $5)`,
				sessionID, flavor, model, mode, now.Add(-30*time.Minute)); err != nil {
				t.Fatalf("seed %s llm_error: %v", mode, err)
			}
		}
		p := AnalyticsParams{
			GroupBy: "model", Range: "custom", Granularity: "day",
			From: now.Add(-time.Hour), To: now, FilterFlavor: flavor,
		}
		p.Metric = "tokens"
		tokens, err := s.QueryAnalytics(ctx, p)
		if err != nil {
			t.Fatalf("tokens: %v", err)
		}
		if tokens.Totals.GrandTotal != 500 {
			t.Errorf("tokens = %v, want 500", tokens.Totals.GrandTotal)
		}
		p.Metric = "estimated_cost"
		cost, err := s.QueryAnalytics(ctx, p)
		if err != nil {
			t.Fatalf("cost: %v", err)
		}
		if cost.Totals.GrandTotal != 0 {
			t.Errorf("cost = %v, want 0 (local and subscription are not metered)", cost.Totals.GrandTotal)
		}
	})
}
