// Package store -- pricing.go
//
// Static per-model list prices used to compute the
// `metric=estimated_cost` analytics series. Values are USD per
// **million tokens** taken from public list prices and mirror what an
// operator would see on each provider's pricing page at the commit
// date. Numbers are approximate by design -- the metric is a
// trend-spotting estimate, not a billing reconciliation.
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

// modelPricing is the input / output rate of every direct-platform
// model, the shape the per-model CASE expression below reads. Populated
// at service startup by LoadPricing (pricing_loader.go) from the
// vendored catalogue and pricing.yaml; empty until then.
var modelPricing = map[string]ModelPricing{}

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

// cacheReadRatio is the multiplier applied to cache-read input tokens
// relative to the uncached input rate. Anthropic bills cache reads at
// 10% of the input list price (90% discount). Applied uniformly to
// every model that reports cache tokens, OpenAI's prompt-cache reads
// included; OpenAI's cached-input rate is model-dependent (0.50x to
// 0.05x of the input rate in pricing.yaml), so the uniform ratio can be
// off in either direction for OpenAI rows. The per-model override on
// ModelPricing that those ratios call for is a README Roadmap item
// (token and cost model), not a pricing.yaml edit.
// Providers that report no cache tokens contribute 0 to the cache_read
// term and the formula collapses to the two-term input/output formula.
const cacheReadRatio = 0.10

// cacheCreationRatio is the multiplier applied to cache-creation input
// tokens. Anthropic bills cache writes at 125% of the input list
// price (25% premium). Same uniform-across-models design as
// cacheReadRatio.
const cacheCreationRatio = 1.25

// BuildCostAggregateSQL generates the SQL aggregate expression for
// ``metric=estimated_cost``. The returned expression is a single
// ``COALESCE(SUM(...), 0)`` that computes, per row,
//
//	(tokens_input - tokens_cache_read - tokens_cache_creation)
//	    * input_rate_for_model
//	+ tokens_cache_read
//	    * input_rate_for_model * cacheReadRatio
//	+ tokens_cache_creation
//	    * input_rate_for_model * cacheCreationRatio
//	+ tokens_output
//	    * output_rate_for_model
//
// where the rates are looked up via ``CASE ... WHEN 'model' THEN rate``
// generated from the active modelPricing map. Models missing from the
// map fall through to 0, which is what makes the metric fail open for
// unknown models (the handler separately flags the response with
// ``partial_estimate``).
//
// Anthropic and OpenAI both report cache reads and cache writes
// (OpenAI's ``cached_tokens`` and ``cache_write_tokens`` usage details
// land in ``tokens_cache_read`` and ``tokens_cache_creation``; an OpenAI
// response without ``cache_write_tokens`` records 0 there, so the
// cache_creation term vanishes for it). OpenAI writes are priced at the
// uniform Anthropic write ratio. For providers that report no
// cache tokens at all, both cache columns are 0, both cache terms
// vanish and uncached = tokens_input, collapsing the formula back to
// the plain two-term expression. The read ratio applies uniformly, so
// OpenAI rows with cache reads are discounted at the Anthropic read
// rate while OpenAI's own rate is model-dependent (0.50x to 0.05x of
// the input rate in pricing.yaml), so the estimate can be off in either
// direction; per-model ratios are a README Roadmap item.
//
// The expression is a bare aggregate -- the caller supplies FROM /
// WHERE / GROUP BY. All values are constants generated at startup so
// there is no SQL-injection surface; the function takes no user input.
// Prices are USD per million tokens, so the multiplier is
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
		safe := strings.ReplaceAll(m, "'", "''")
		fmt.Fprintf(&inputCases, " WHEN '%s' THEN %.10f", safe, p.InputPerMTok/1_000_000)
		fmt.Fprintf(&outputCases, " WHEN '%s' THEN %.10f", safe, p.OutputPerMTok/1_000_000)
	}
	inputCases.WriteString(" ELSE 0 END")
	outputCases.WriteString(" ELSE 0 END")

	inputRate := inputCases.String()
	outputRate := outputCases.String()

	// uncached = tokens_input - cache_read - cache_creation. Wrapped in
	// COALESCE at every column reference so NULL tokens_input rows
	// (historical events before the column was populated) do not
	// propagate NULL into the aggregate and zero the whole SUM.
	return fmt.Sprintf(
		"COALESCE(SUM("+
			"(COALESCE(tokens_input, 0) - COALESCE(tokens_cache_read, 0) - COALESCE(tokens_cache_creation, 0)) * (%s) + "+
			"COALESCE(tokens_cache_read, 0)     * (%s) * %.4f + "+
			"COALESCE(tokens_cache_creation, 0) * (%s) * %.4f + "+
			"COALESCE(tokens_output, 0)         * (%s)"+
			"), 0)",
		inputRate,
		inputRate, cacheReadRatio,
		inputRate, cacheCreationRatio,
		outputRate,
	)
}

// ProviderCaseSQL is the canonical SQL CASE expression that maps
// `events.model` to a provider name. Kept as a package-level string
// so both the group_by=provider path and any future derived queries
// share one source of truth. The matching UI-side mapping lives in
// dashboard/src/lib/models.ts::getProvider.
const ProviderCaseSQL = `CASE
	WHEN model LIKE 'claude-%' THEN 'anthropic'
	WHEN model LIKE 'gpt-%' OR model LIKE 'o1-%' OR model LIKE 'o3-%' OR model LIKE 'o4-%' OR model LIKE 'text-embedding-%' OR model LIKE 'dall-e-%' THEN 'openai'
	WHEN model LIKE 'gemini-%' THEN 'google'
	WHEN model LIKE 'grok-%' THEN 'xai'
	WHEN model LIKE 'mistral-%' OR model LIKE 'mixtral-%' THEN 'mistral'
	WHEN model LIKE 'llama-%' THEN 'meta'
	ELSE 'other'
END`
