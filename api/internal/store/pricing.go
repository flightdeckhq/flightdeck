// Package store -- pricing.go
//
// Static per-model list prices used to compute the
// `metric=estimated_cost` analytics series. Values are USD per
// **million tokens** taken from public list prices and mirror what an
// operator would see on each provider's pricing page at the commit
// date. Numbers are approximate by design -- see DECISIONS.md D099
// for the rationale and refresh cadence.
//
// The map is closed-world: models missing from it contribute $0 to
// the cost aggregate, and the analytics handler flags the response
// with `partial_estimate=true` when any post_call row in the window
// references a model the table does not know about. The dashboard
// surfaces an amber disclaimer in that case.
package store

import (
	"fmt"
	"sort"
	"strings"
)

// ModelPricing holds list prices for one model, keyed per million
// tokens. `InputPerMTok` is the price for prompt / input tokens and
// `OutputPerMTok` is the price for completion / output tokens.
type ModelPricing struct {
	InputPerMTok  float64
	OutputPerMTok float64
}

// modelPricing is the authoritative table. Keep in sync with
// provider list pricing pages; add a comment pointing at the source
// for each block. Prices are USD per 1M tokens. Keys are the exact
// model strings the sensor emits on `events.model`.
//
// Updated: April 2026. See D099 for maintenance policy.
//
// Anthropic pricing notes: Opus 4.x (the 4-5 / 4-6 generation) is
// $5/$25 per million tokens, a 67% reduction versus the legacy Opus 3
// and the Opus 4.0/4.1 launch prices of $15/$75. The old $15/$75 tier
// is retained only for `claude-3-opus-20240229`, which Anthropic still
// bills at the legacy rate. Haiku 4.5 moved to $1/$5 over its earlier
// $0.80/$4 figure.
var modelPricing = map[string]ModelPricing{
	// Anthropic list prices (anthropic.com/pricing)
	"claude-opus-4-6":            {5.00, 25.00},
	"claude-opus-4-5-20251101":   {5.00, 25.00},
	"claude-opus-4-20250514":     {5.00, 25.00},
	"claude-3-opus-20240229":     {15.00, 75.00},
	"claude-sonnet-4-6":          {3.00, 15.00},
	"claude-sonnet-4-5-20250929": {3.00, 15.00},
	"claude-sonnet-4-20250514":   {3.00, 15.00},
	"claude-3-5-sonnet-20241022": {3.00, 15.00},
	"claude-haiku-4-5":           {1.00, 5.00},
	"claude-haiku-4-5-20251001":  {1.00, 5.00},
	"claude-3-5-haiku-20241022":  {0.80, 4.00},

	// OpenAI list prices (openai.com/pricing)
	"gpt-4o":      {2.50, 10.00},
	"gpt-4o-mini": {0.15, 0.60},
	"gpt-4.1":     {2.00, 8.00},
	"gpt-4.1-mini": {0.40, 1.60},
	"gpt-4.1-nano": {0.10, 0.40},
	"gpt-4-turbo": {10.00, 30.00},
	"o1":          {15.00, 60.00},
	"o1-mini":     {3.00, 12.00},
	"o3":          {2.00, 8.00},
	"o3-pro":      {20.00, 80.00},
	"o3-mini":     {1.10, 4.40},
	"o4-mini":     {1.10, 4.40},
	"text-embedding-3-small": {0.02, 0.00},
	"text-embedding-3-large": {0.13, 0.00},
}

// KnownPricedModels returns the set of models with a pricing entry.
// Used by the analytics store to decide whether the response's
// partial_estimate flag should be set (any post_call row with a
// model outside the set means the cost figure is incomplete).
func KnownPricedModels() []string {
	out := make([]string, 0, len(modelPricing))
	for m := range modelPricing {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}

// BuildCostAggregateSQL generates the SQL aggregate expression for
// `metric=estimated_cost`. The returned expression is a single
// `COALESCE(SUM(...), 0)` that computes, per row,
//
//	tokens_input * (input_rate_for_model) +
//	tokens_output * (output_rate_for_model)
//
// where the rates are looked up via a `CASE ... WHEN 'model' THEN
// rate` generated from `modelPricing`. Models missing from the map
// fall through to `0`, which is what makes the metric fail open for
// unknown models (the handler separately flags the response with
// `partial_estimate`).
//
// The expression is a bare aggregate -- the caller supplies FROM /
// WHERE / GROUP BY. All values are constants generated at startup
// so there is no SQL-injection surface; the function takes no user
// input. Prices are USD per million tokens, so the multiplier is
// price / 1_000_000.
func BuildCostAggregateSQL(modelColumn string) string {
	// Sort keys for stable SQL output (eases debugging and snapshot
	// tests).
	models := make([]string, 0, len(modelPricing))
	for m := range modelPricing {
		models = append(models, m)
	}
	sort.Strings(models)

	var inputCases, outputCases strings.Builder
	inputCases.WriteString("CASE " + modelColumn)
	outputCases.WriteString("CASE " + modelColumn)
	for _, m := range models {
		p := modelPricing[m]
		// Escape single quotes by doubling, though none of the
		// current model keys contain quotes.
		safe := strings.ReplaceAll(m, "'", "''")
		fmt.Fprintf(&inputCases, " WHEN '%s' THEN %.10f", safe, p.InputPerMTok/1_000_000)
		fmt.Fprintf(&outputCases, " WHEN '%s' THEN %.10f", safe, p.OutputPerMTok/1_000_000)
	}
	inputCases.WriteString(" ELSE 0 END")
	outputCases.WriteString(" ELSE 0 END")

	return fmt.Sprintf(
		"COALESCE(SUM("+
			"COALESCE(tokens_input, 0) * (%s) + "+
			"COALESCE(tokens_output, 0) * (%s)"+
			"), 0)",
		inputCases.String(), outputCases.String(),
	)
}

// ProviderCaseSQL is the canonical SQL CASE expression that maps
// `events.model` to a provider name. Kept as a package-level string
// so both the group_by=provider path and any future derived queries
// share one source of truth. The matching UI-side mapping lives in
// dashboard/src/lib/models.ts::getProvider (D098).
const ProviderCaseSQL = `CASE
	WHEN model LIKE 'claude-%' THEN 'anthropic'
	WHEN model LIKE 'gpt-%' OR model LIKE 'o1-%' OR model LIKE 'o3-%' OR model LIKE 'o4-%' OR model LIKE 'text-embedding-%' OR model LIKE 'dall-e-%' THEN 'openai'
	WHEN model LIKE 'gemini-%' THEN 'google'
	WHEN model LIKE 'grok-%' THEN 'xai'
	WHEN model LIKE 'mistral-%' OR model LIKE 'mixtral-%' THEN 'mistral'
	WHEN model LIKE 'llama-%' THEN 'meta'
	ELSE 'other'
END`
