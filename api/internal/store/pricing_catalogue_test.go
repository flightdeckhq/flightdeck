package store

import (
	"testing"
)

// sampleCatalogue is a small catalogue in the shape pricing_refresh.py
// writes, covering each mapping rule.
const sampleCatalogue = `{
 "source": "test",
 "refreshed": "2026-10-25",
 "models": {
  "claude-sonnet-4-5": {
   "litellm_provider": "anthropic", "mode": "chat",
   "input_cost_per_token": 3e-06, "output_cost_per_token": 1.5e-05,
   "cache_read_input_token_cost": 3e-07,
   "cache_creation_input_token_cost": 3.75e-06,
   "cache_creation_input_token_cost_above_1hr": 6e-06,
   "input_cost_per_token_above_200k_tokens": 6e-06,
   "output_cost_per_token_above_200k_tokens": 2.25e-05,
   "cache_creation_input_token_cost_above_1hr_above_200k_tokens": 1.2e-05,
   "provider_specific_entry": {"fast": 2}
  },
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
   "litellm_provider": "bedrock_converse", "mode": "chat",
   "input_cost_per_token": 3.3e-06, "output_cost_per_token": 1.65e-05
  },
  "anthropic.claude-sonnet-4-5-20250929-v1:0": {
   "litellm_provider": "bedrock", "mode": "chat",
   "input_cost_per_token": 3e-06, "output_cost_per_token": 1.5e-05
  },
  "vertex_ai/claude-sonnet-4-5@20250929": {
   "litellm_provider": "vertex_ai-anthropic_models", "mode": "chat",
   "input_cost_per_token": 3e-06, "output_cost_per_token": 1.5e-05,
   "deprecation_date": "2026-09-29"
  },
  "azure/gpt-4o": {
   "litellm_provider": "azure", "mode": "chat",
   "input_cost_per_token": 2.5e-06, "output_cost_per_token": 1e-05
  },
  "gpt-5.1": {
   "litellm_provider": "openai", "mode": "chat",
   "input_cost_per_token": 1.25e-06, "output_cost_per_token": 1e-05,
   "input_cost_per_token_priority": 2.5e-06,
   "output_cost_per_reasoning_token": 1e-05
  },
  "xai/grok-4": {
   "litellm_provider": "xai", "mode": "chat",
   "input_cost_per_token": 3e-06, "output_cost_per_token": 1.5e-05
  },
  "text-embedding-3-small": {
   "litellm_provider": "openai", "mode": "embedding",
   "input_cost_per_token": 2e-08
  },
  "some-other-host/model": {
   "litellm_provider": "together_ai", "mode": "chat",
   "input_cost_per_token": 1e-06, "output_cost_per_token": 1e-06
  },
  "no-input-rate": {"litellm_provider": "openai", "mode": "chat"}
 }
}`

func rowsByKey(t *testing.T, rows []PriceRow) map[rowKey]PriceRow {
	t.Helper()
	out := make(map[rowKey]PriceRow, len(rows))
	for _, r := range rows {
		k := rowKey{r.ModelID, r.Platform}
		if _, dup := out[k]; dup {
			t.Fatalf("duplicate row %v", k)
		}
		out[k] = r
	}
	return out
}

func approx(a, b float64) bool {
	d := a - b
	return d < 1e-9 && d > -1e-9
}

func TestParseCatalogue_MapsEachRule(t *testing.T) {
	rows, err := parseCatalogue([]byte(sampleCatalogue))
	if err != nil {
		t.Fatalf("parseCatalogue: %v", err)
	}
	got := rowsByKey(t, rows)

	sonnet, ok := got[rowKey{"claude-sonnet-4-5", platformDirect}]
	if !ok {
		t.Fatal("direct claude-sonnet-4-5 row missing")
	}
	if !approx(sonnet.Input, 3) || !approx(sonnet.Output, 15) || !approx(sonnet.CacheRead, 0.3) ||
		!approx(sonnet.CacheWrite5m, 3.75) || !approx(sonnet.CacheWrite1h, 6) {
		t.Errorf("sonnet base rates wrong: %+v", sonnet)
	}
	if sonnet.Provider != "anthropic" || sonnet.Source != sourceCatalogue {
		t.Errorf("sonnet provider/source wrong: %+v", sonnet)
	}
	if sonnet.TierThreshold == nil || *sonnet.TierThreshold != 200_000 ||
		!approx(*sonnet.TierInput, 6) || !approx(*sonnet.TierOutput, 22.5) ||
		!approx(*sonnet.TierCacheWrite1h, 12) || !approx(*sonnet.TierCacheRead, 0.3) {
		t.Errorf("sonnet tier wrong: %+v", sonnet)
	}
	if sonnet.FastMultiplier == nil || *sonnet.FastMultiplier != 2 {
		t.Errorf("sonnet fast multiplier wrong: %v", sonnet.FastMultiplier)
	}

	// The regional inference profile canonicalises to the same row as the
	// base Bedrock id; the base id's price wins.
	bedrock, ok := got[rowKey{"claude-sonnet-4-5-20250929", platformBedrock}]
	if !ok || !approx(bedrock.Input, 3) {
		t.Errorf("bedrock row should come from the base id: %+v", bedrock)
	}
	vertex, ok := got[rowKey{"claude-sonnet-4-5", platformVertex}]
	if !ok || vertex.DeprecatedOn == nil || *vertex.DeprecatedOn != "2026-09-29" {
		t.Errorf("vertex row wrong: %+v", vertex)
	}
	if _, ok := got[rowKey{"gpt-4o", platformAzure}]; !ok {
		t.Error("azure gpt-4o row missing")
	}
	gpt, ok := got[rowKey{"gpt-5.1", platformDirect}]
	if !ok || gpt.PriorityMultiplier == nil || !approx(*gpt.PriorityMultiplier, 2) ||
		gpt.Reasoning == nil || !approx(*gpt.Reasoning, 10) {
		t.Errorf("gpt-5.1 priority / reasoning wrong: %+v", gpt)
	}
	if grok, ok := got[rowKey{"grok-4", platformDirect}]; !ok || grok.Provider != "xai" {
		t.Errorf("xai prefix not stripped or provider wrong: %+v", grok)
	}
	if emb, ok := got[rowKey{"text-embedding-3-small", platformDirect}]; !ok || emb.Output != 0 {
		t.Errorf("embedding row wrong: %+v", emb)
	}
	if _, ok := got[rowKey{"model", platformDirect}]; ok {
		t.Error("a provider outside the cost model must be dropped")
	}
	if _, ok := got[rowKey{"no-input-rate", platformDirect}]; ok {
		t.Error("an entry without an input rate must be dropped")
	}
}

func TestEmbeddedCatalogue_CoversCurrentModels(t *testing.T) {
	rows, err := catalogueRows()
	if err != nil {
		t.Fatalf("embedded catalogue: %v", err)
	}
	if len(rows) < 500 {
		t.Fatalf("embedded catalogue has only %d rows", len(rows))
	}
	got := rowsByKey(t, rows)
	for _, k := range []rowKey{
		{"claude-opus-4-6", platformDirect},
		{"claude-sonnet-4-5", platformDirect},
		{"claude-haiku-4-5", platformDirect},
		{"gpt-4o-mini", platformDirect},
		{"text-embedding-3-small", platformDirect},
		{"gpt-4o", platformAzure},
	} {
		if _, ok := got[k]; !ok {
			t.Errorf("embedded catalogue lacks %v", k)
		}
	}
}
