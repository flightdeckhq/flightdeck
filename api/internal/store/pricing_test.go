// Cost SQL tests (pricing.go). The formula, the price lookup and the
// provider rule are SQL, so the meaningful tests run them against
// Postgres (TEST_POSTGRES_URL / FLIGHTDECK_POSTGRES_URL; skipped
// otherwise) with price rows the test owns. The catalogue and the
// loader are tested in pricing_catalogue_test.go and
// pricing_loader_test.go.
package store

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"strings"
	"testing"
	"time"
)

// costRates are the rates of a test price row, USD per million tokens.
type costRates struct {
	input, output, cacheRead, cacheWrite5m, cacheWrite1h float64
	reasoning                                            *float64
	tierThreshold                                        *int64
	tierInput, tierOutput                                *float64
	priority, fast                                       *float64
}

// costEvent is one event the cost expression prices.
type costEvent struct {
	model, platform, billing string
	in, out, cacheRead       int64
	cacheWrite, cacheWrite1h int64
	reasoning                *int64
	costReported             *float64
	payload                  map[string]any
}

type costFixture struct {
	t        *testing.T
	s        *Store
	session  string
	prefix   string
	settings PricingSettings
}

func newCostFixture(t *testing.T, clientType string) *costFixture {
	t.Helper()
	s, cleanup := newTestStore(t)
	t.Cleanup(cleanup)
	ctx := context.Background()
	f := &costFixture{
		t: t, s: s, session: randomUUID(t),
		prefix:   "test-cost-" + randomUUID(t)[:8],
		settings: defaultPricingSettings(),
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (session_id, flavor, agent_type, client_type, state, started_at, last_seen_at)
		VALUES ($1::uuid, 'cost-test', 'production', $2, 'closed', NOW(), NOW())`,
		f.session, clientType); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	t.Cleanup(func() {
		for _, q := range []string{
			`DELETE FROM events WHERE session_id = $1::uuid`,
			`DELETE FROM sessions WHERE session_id = $1::uuid`,
		} {
			if _, err := s.pool.Exec(ctx, q, f.session); err != nil {
				t.Errorf("cleanup: %v", err)
			}
		}
		if _, err := s.pool.Exec(ctx, `DELETE FROM model_pricing WHERE model_id LIKE $1`, f.prefix+"%"); err != nil {
			t.Errorf("cleanup prices: %v", err)
		}
	})
	return f
}

// price inserts a model_pricing row for model (prefixed) on platform.
func (f *costFixture) price(model, platform string, r costRates) {
	f.t.Helper()
	if _, err := f.s.pool.Exec(context.Background(), `
		INSERT INTO model_pricing (model_id, platform, provider, input, output, cache_read,
			cache_write_5m, cache_write_1h, reasoning, tier_threshold_tokens, tier_input,
			tier_output, priority_multiplier, fast_multiplier, source)
		VALUES ($1, $2, 'other', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'override')`,
		f.prefix+model, platform, r.input, r.output, r.cacheRead, r.cacheWrite5m, r.cacheWrite1h,
		r.reasoning, r.tierThreshold, r.tierInput, r.tierOutput, r.priority, r.fast); err != nil {
		f.t.Fatalf("insert price: %v", err)
	}
}

// cost inserts an event and returns the cost expression's value for it
// (nil when the expression is NULL: an unpriced call).
func (f *costFixture) cost(ev costEvent) *float64 {
	f.t.Helper()
	ctx := context.Background()
	payload := map[string]any{}
	for k, v := range ev.payload {
		payload[k] = v
	}
	if ev.cacheWrite1h > 0 {
		payload["tokens_cache_creation_1h"] = ev.cacheWrite1h
	}
	encoded, _ := json.Marshal(payload)
	nullable := func(s string) *string {
		if s == "" {
			return nil
		}
		return &s
	}
	var costSource *string
	if ev.costReported != nil {
		costSource = nullable("agent")
	}
	var id string
	if err := f.s.pool.QueryRow(ctx, `
		INSERT INTO events (session_id, flavor, event_type, model, tokens_input, tokens_output,
			tokens_total, tokens_cache_read, tokens_cache_creation, tokens_reasoning, billing_mode,
			platform, cost_reported, cost_source, payload, occurred_at)
		VALUES ($1::uuid, 'cost-test', 'post_call', $2, $3::int, $4::int, $3::int + $4::int, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
		RETURNING id::text`,
		f.session, f.prefix+ev.model, ev.in, ev.out, ev.cacheRead, ev.cacheWrite, ev.reasoning,
		nullable(ev.billing), nullable(ev.platform), ev.costReported, costSource, encoded).Scan(&id); err != nil {
		f.t.Fatalf("insert event: %v", err)
	}
	var got *float64
	if err := f.s.pool.QueryRow(ctx,
		`SELECT (`+costRowSQL(f.settings)+`)::float8 FROM events e `+CostPriceJoinSQL()+` WHERE e.id = $1::uuid`,
		id).Scan(&got); err != nil {
		f.t.Fatalf("cost query: %v", err)
	}
	return got
}

func float(v float64) *float64 { return &v }
func count(v int64) *int64     { return &v }

func assertCost(t *testing.T, name string, got *float64, want float64) {
	t.Helper()
	if got == nil {
		t.Errorf("%s: cost is NULL, want %.10f", name, want)
		return
	}
	if math.Abs(*got-want) > 1e-9 {
		t.Errorf("%s: cost = %.10f, want %.10f", name, *got, want)
	}
}

var sonnetRates = costRates{input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6}

func TestCostRow_Formula(t *testing.T) {
	f := newCostFixture(t, "flightdeck_sensor")
	f.price("m", "direct", sonnetRates)
	// 1,000 input = 500 uncached + 200 read + 300 written (100 for 1h);
	// 500 output of which 100 reasoning (output rate, no reasoning rate).
	got := f.cost(costEvent{
		model: "m", billing: "metered", in: 1000, out: 500, cacheRead: 200,
		cacheWrite: 300, cacheWrite1h: 100, reasoning: count(100),
	})
	want := (500*3 + 200*0.3 + 200*3.75 + 100*6 + 400*15 + 100*15) / 1e6
	assertCost(t, "formula", got, want)
}

func TestCostRow_ReasoningRateAndTier(t *testing.T) {
	f := newCostFixture(t, "flightdeck_sensor")
	r := sonnetRates
	r.reasoning = float(20)
	r.tierThreshold = count(800)
	r.tierInput, r.tierOutput = float(6), float(22.5)
	f.price("m", "direct", r)
	below := f.cost(costEvent{model: "m", billing: "metered", in: 800, out: 100, reasoning: count(40)})
	assertCost(t, "below the tier", below, (800*3+60*15+40*20)/1e6)
	above := f.cost(costEvent{model: "m", billing: "metered", in: 1000, out: 100})
	assertCost(t, "above the tier", above, (1000*6+100*22.5)/1e6)
}

func TestCostRow_Multipliers(t *testing.T) {
	f := newCostFixture(t, "flightdeck_sensor")
	r := sonnetRates
	r.priority, r.fast = float(1.75), float(2)
	f.price("m", "direct", r)
	base := 1000*3/1e6 + 100*15/1e6
	for _, tc := range []struct {
		name    string
		payload map[string]any
		factor  float64
	}{
		{"batch", map[string]any{"service_tier": "batch"}, 0.5},
		{"priority from the row", map[string]any{"service_tier": "priority"}, 1.75},
		{"fast from the row", map[string]any{"speed": "fast"}, 2},
		{"US-only inference", map[string]any{"inference_geo": "us"}, 1.1},
		{"regional endpoint", map[string]any{"inference_scope": "regional"}, 1.1},
		{"combined", map[string]any{"service_tier": "batch", "inference_geo": "us"}, 0.55},
		{"unknown value", map[string]any{"service_tier": "scale"}, 1},
	} {
		got := f.cost(costEvent{model: "m", billing: "metered", in: 1000, out: 100, payload: tc.payload})
		assertCost(t, tc.name, got, base*tc.factor)
	}
}

func TestCostRow_FeesReportedCostAndBilling(t *testing.T) {
	f := newCostFixture(t, "flightdeck_sensor")
	f.price("m", "direct", sonnetRates)
	base := 1000*3/1e6 + 100*15/1e6
	assertCost(t, "web search fee",
		f.cost(costEvent{model: "m", billing: "metered", in: 1000, out: 100,
			payload: map[string]any{"server_tool_use": map[string]any{"web_search_requests": 2}}}),
		base+0.02)
	assertCost(t, "reported cost wins",
		f.cost(costEvent{model: "m", billing: "metered", in: 1000, out: 100, costReported: float(0.5)}), 0.5)
	assertCost(t, "subscription is not spend",
		f.cost(costEvent{model: "m", billing: "subscription", in: 1000, out: 100}), 0)
	assertCost(t, "local is free",
		f.cost(costEvent{model: "m", billing: "local", in: 1000, out: 100}), 0)
	assertCost(t, "no billing mode on a sensor session is metered",
		f.cost(costEvent{model: "m", in: 1000, out: 100}), base)
	if got := f.cost(costEvent{model: "unknown", billing: "metered", in: 1000, out: 100}); got != nil {
		t.Errorf("an unpriced call should be NULL, got %v", *got)
	}
}

func TestCostRow_NoBillingModeOnClaudeCodeIsSubscription(t *testing.T) {
	f := newCostFixture(t, "claude_code")
	f.price("m", "direct", sonnetRates)
	assertCost(t, "claude code default", f.cost(costEvent{model: "m", in: 1000, out: 100}), 0)
}

func TestCostRow_PriceLookupFallbacks(t *testing.T) {
	f := newCostFixture(t, "flightdeck_sensor")
	f.price("m", "direct", sonnetRates)
	r := sonnetRates
	r.input = 4
	f.price("m", "bedrock", r)
	direct := 1000 * 3 / 1e6
	bedrock := 1000 * 4 / 1e6
	assertCost(t, "bedrock row", f.cost(costEvent{model: "m", platform: "bedrock", billing: "metered", in: 1000}), bedrock)
	assertCost(t, "bedrock-mantle is bedrock", f.cost(costEvent{model: "m", platform: "bedrock-mantle", billing: "metered", in: 1000}), bedrock)
	assertCost(t, "vertex falls back to direct", f.cost(costEvent{model: "m", platform: "vertex", billing: "metered", in: 1000}), direct)
	assertCost(t, "a gateway host prices direct", f.cost(costEvent{model: "m", platform: "gw.example.com", billing: "metered", in: 1000}), direct)
	assertCost(t, "an undated id prices a dated snapshot", f.cost(costEvent{model: "m-20260115", billing: "metered", in: 1000}), direct)
	assertCost(t, "an OpenAI-style date too", f.cost(costEvent{model: "m-2026-01-15", billing: "metered", in: 1000}), direct)
}

func TestCostAggregate_SumsOnlyLLMEvents(t *testing.T) {
	agg := BuildCostAggregateSQL()
	if !strings.Contains(agg, "FILTER (WHERE "+costEventFilter+")") {
		t.Errorf("the aggregate must be limited to LLM events: %s", agg)
	}
}

func TestCostRow_IsValidWithoutSettings(t *testing.T) {
	f := newCostFixture(t, "flightdeck_sensor")
	f.settings = PricingSettings{}
	f.price("m", "direct", sonnetRates)
	assertCost(t, "no settings", f.cost(costEvent{model: "m", billing: "metered", in: 1000}), 1000*3/1e6)
}

// The SQL provider rule agrees with the worker's Go rule on every shared
// test vector (workers/internal/modelid/testdata/vectors.json).
func TestProviderCaseSQL_MatchesTheGoRule(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	raw, err := os.ReadFile("../../../workers/internal/modelid/testdata/vectors.json")
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var vectors struct {
		Provider map[string]string `json:"provider"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for model, want := range vectors.Provider {
		var got string
		if err := s.pool.QueryRow(ctx,
			`SELECT `+providerCase("t.model")+` FROM (SELECT $1::text AS model) t`, model).Scan(&got); err != nil {
			t.Fatalf("provider SQL for %q: %v", model, err)
		}
		if got != want {
			t.Errorf("SQL provider(%q) = %q, Go rule says %q", model, got, want)
		}
	}
}
