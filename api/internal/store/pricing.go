// Package store -- pricing.go
//
// The SQL that turns events into estimated cost (ARCHITECTURE.md, Cost
// estimation). Every LLM event (post_call, embeddings) is priced from
// its model_pricing row, found per event by CostPriceJoinSQL, with the
// formula in costRowSQL; only metered calls are counted, and a cost the
// gateway or client reported is used in place of the estimate. The
// expressions are built from constants and from the operator's
// pricing.yaml settings (numbers and quoted literals), never from
// request input, so there is no injection surface.
package store

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// costEventTypes are the events whose tokens estimated cost prices.
const costEventTypes = "('post_call', 'embeddings')"

// costEventFilter restricts a query on events aliased e to them.
const costEventFilter = "e.event_type IN " + costEventTypes

// effectiveBillingSQL is the billing mode of an event aliased e: its
// own column, or, for an event that carries none, subscription for a
// Claude Code session and metered otherwise. The session lookup runs
// only for such events (COALESCE stops at the first non-NULL argument).
const effectiveBillingSQL = `COALESCE(e.billing_mode, CASE WHEN (
	SELECT s_b.client_type FROM sessions s_b WHERE s_b.session_id = e.session_id
) = 'claude_code' THEN 'subscription' ELSE 'metered' END)`

// platformFamilySQL maps events.platform to the family model_pricing
// rows are keyed by; every label that is not a cloud platform's prices
// from the provider's own (direct) rates.
const platformFamilySQL = `CASE
	WHEN e.platform IN ('bedrock', 'bedrock-mantle') THEN 'bedrock'
	WHEN e.platform IN ('vertex', 'azure', 'foundry') THEN e.platform
	ELSE 'direct' END`

// undatedModelSQL strips a trailing snapshot date (-20250929 or
// -2025-11-13) from e.model, the fallback when the dated id has no
// price of its own.
const undatedModelSQL = `regexp_replace(e.model, '-([0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})$', '')`

// CostPriceJoinSQL joins each LLM event aliased e to its model_pricing
// row as mp: the exact id before the undated id, the platform family's
// row before the direct one. Events without a price, and events that
// are not LLM calls, get a NULL mp.
func CostPriceJoinSQL() string {
	return `LEFT JOIN LATERAL (
		SELECT p.* FROM model_pricing p
		WHERE ` + costEventFilter + `
		  AND p.model_id IN (e.model, ` + undatedModelSQL + `)
		  AND p.platform IN (` + platformFamilySQL + `, 'direct')
		ORDER BY (p.model_id = e.model) DESC, (p.platform = 'direct') ASC
		LIMIT 1
	) mp ON TRUE`
}

// sqlString quotes s as a SQL string literal.
func sqlString(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// sortedKeys returns m's keys in order, so the generated SQL is stable.
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// perModelMultipliers are the multiplier values priced per model from a
// model_pricing column rather than from the flat settings.
var perModelMultipliers = map[string]map[string]string{
	"service_tier": {"priority": "mp.priority_multiplier"},
	"speed":        {"fast": "mp.fast_multiplier"},
}

// multiplierSQL is the CASE over one payload field that yields its
// multiplier: the per-model column where there is one (the settings'
// value standing in when the column is NULL), the settings' value
// otherwise, and 1 for anything not listed.
func multiplierSQL(field string, values map[string]float64) string {
	var b strings.Builder
	fmt.Fprintf(&b, "CASE e.payload->>%s", sqlString(field))
	perModel := perModelMultipliers[field]
	for _, value := range sortedKeys(values) {
		if col, ok := perModel[value]; ok {
			fmt.Fprintf(&b, " WHEN %s THEN COALESCE(%s, %.6f)", sqlString(value), col, values[value])
			continue
		}
		fmt.Fprintf(&b, " WHEN %s THEN %.6f", sqlString(value), values[value])
	}
	for _, value := range sortedKeys(perModel) {
		if _, listed := values[value]; !listed {
			fmt.Fprintf(&b, " WHEN %s THEN COALESCE(%s, 1)", sqlString(value), perModel[value])
		}
	}
	b.WriteString(" ELSE 1 END")
	return b.String()
}

// costRowSQL is the USD cost of one event aliased e priced by mp (see
// CostPriceJoinSQL), following the formula in ARCHITECTURE.md: the
// reported cost when there is one, else the token terms at the row's
// rates (the context tier's above its threshold) times the multipliers,
// plus the server-tool fees. Calls that are not metered cost 0; an
// unpriced call is NULL, which SUM skips.
func costRowSQL(settings PricingSettings) string {
	const (
		in     = "COALESCE(e.tokens_input, 0)"
		out    = "COALESCE(e.tokens_output, 0)"
		read   = "COALESCE(e.tokens_cache_read, 0)"
		write  = "COALESCE(e.tokens_cache_creation, 0)"
		write1 = "LEAST(COALESCE((e.payload->>'tokens_cache_creation_1h')::bigint, 0), " + write + ")"
		reason = "LEAST(COALESCE(e.tokens_reasoning, 0), " + out + ")"
	)
	tiered := func(base, tier string) string {
		return fmt.Sprintf(
			"(CASE WHEN mp.tier_threshold_tokens IS NOT NULL AND %s > mp.tier_threshold_tokens"+
				" THEN COALESCE(mp.%s, mp.%s) ELSE mp.%s END)", in, tier, base, base)
	}
	tokens := fmt.Sprintf(
		"(GREATEST(%s - %s - %s, 0) * %s"+
			" + %s * %s"+
			" + GREATEST(%s - %s, 0) * %s"+
			" + %s * %s"+
			" + GREATEST(%s - %s, 0) * %s"+
			" + %s * COALESCE(mp.reasoning, %s)) / 1000000.0",
		in, read, write, tiered("input", "tier_input"),
		read, tiered("cache_read", "tier_cache_read"),
		write, write1, tiered("cache_write_5m", "tier_cache_write_5m"),
		write1, tiered("cache_write_1h", "tier_cache_write_1h"),
		out, reason, tiered("output", "tier_output"),
		reason, tiered("output", "tier_output"),
	)

	// Every field with settings or a per-model column contributes a
	// factor; a field with neither multiplies by 1 and is left out.
	fields := map[string]map[string]float64{}
	for field, values := range settings.Multipliers {
		fields[field] = values
	}
	for field := range perModelMultipliers {
		if _, ok := fields[field]; !ok {
			fields[field] = map[string]float64{}
		}
	}
	var factor strings.Builder
	for _, field := range sortedKeys(fields) {
		fmt.Fprintf(&factor, " * %s", multiplierSQL(field, fields[field]))
	}
	var fees strings.Builder
	for _, tool := range sortedKeys(settings.ServerTools) {
		fmt.Fprintf(&fees, " + COALESCE((e.payload->'server_tool_use'->>%s)::numeric, 0) * %.6f",
			sqlString(tool), settings.ServerTools[tool])
	}

	return fmt.Sprintf(
		"(CASE WHEN %s = 'metered' THEN COALESCE(e.cost_reported, %s%s%s) ELSE 0 END)",
		effectiveBillingSQL, tokens, factor.String(), fees.String(),
	)
}

// BuildCostAggregateSQL is the estimated-cost aggregate over events
// aliased e joined to their prices with CostPriceJoinSQL. It sums LLM
// events only, so it is correct in a query over every event type (the
// per-agent summary) as well as in one already limited to them.
func BuildCostAggregateSQL() string {
	return "COALESCE(SUM(" + costRowSQL(CurrentPricingSettings()) +
		") FILTER (WHERE " + costEventFilter + "), 0)"
}

// maxUnpricedModels bounds the models_unpriced list: a surface names a
// handful of models, and a window with more than this many unpriced ids
// has a pricing gap the first ones already reveal.
const maxUnpricedModels = 50

// unpricedModelsSQL lists the canonical ids of metered calls in a window
// ($1, $2) that have neither a price nor a reported cost, for the
// models_unpriced response field. The window's distinct model and
// platform pairs are collected first and only those few are checked
// against model_pricing, so the probe costs one pass over the events
// rather than a price lookup per event. extraJoin and extraWhere narrow
// the events (to an agent's sessions); they are fixed fragments, never
// request input.
func unpricedModelsSQL(extraJoin, extraWhere string) string {
	return `
		SELECT DISTINCT k.model FROM (
			SELECT DISTINCT e.model, ` + platformFamilySQL + ` AS family
			FROM events e ` + extraJoin + `
			WHERE ` + costEventFilter + `
			  AND e.occurred_at >= $1 AND e.occurred_at < $2
			  AND e.model IS NOT NULL
			  AND e.cost_reported IS NULL
			  AND ` + effectiveBillingSQL + ` = 'metered' ` + extraWhere + `
		) k
		WHERE NOT EXISTS (
			SELECT 1 FROM model_pricing p
			WHERE p.model_id IN (k.model, ` + strings.ReplaceAll(undatedModelSQL, "e.model", "k.model") + `)
			  AND p.platform IN (k.family, 'direct')
		)
		ORDER BY k.model
		LIMIT ` + fmt.Sprint(maxUnpricedModels)
}

// billingModesSQL lists the billing modes the LLM calls in a window
// ($1, $2) used, for the billing_modes response field.
func billingModesSQL(extraJoin, extraWhere string) string {
	return `
		SELECT DISTINCT ` + effectiveBillingSQL + ` AS mode
		FROM events e ` + extraJoin + `
		WHERE ` + costEventFilter + `
		  AND e.occurred_at >= $1 AND e.occurred_at < $2 ` + extraWhere + `
		ORDER BY mode`
}

// ProviderCaseSQL maps a model id to its vendor. It mirrors the
// worker's Go rule (workers/internal/modelid.Provider), and a DB test
// runs both over the shared test vectors so they cannot drift. Used for
// rows whose events.provider is empty and for the session-level model.
// "model" is replaced with the column by providerCase.
const ProviderCaseSQL = `CASE
	WHEN model ~ '^(ft:)?claude' OR model ~ '^anthropic\.' THEN 'anthropic'
	WHEN model ~ '^(ft:)?(gpt-|chatgpt-|o[1-9](-|$)|codex-|text-embedding-|dall-e-|gpt-image-|whisper-|tts-|omni-moderation)'
		OR model ~ '^openai\.' THEN 'openai'
	WHEN model ~ '^(gemini|gemma)' THEN 'google'
	WHEN model ~ '^grok' THEN 'xai'
	WHEN model ~ '^(mistral|mixtral|codestral|ministral|pixtral|magistral|devstral|open-mistral|open-mixtral)' THEN 'mistral'
	WHEN model ~ '^(llama|meta\.)' THEN 'meta'
	WHEN model ~ '^deepseek' THEN 'deepseek'
	ELSE 'other'
END`

// CostCoverage says what a cost total leaves out: the models of metered
// calls with no price and no reported cost, and the billing modes the
// calls used.
type CostCoverage struct {
	ModelsUnpriced []string
	BillingModes   []string
}

// costCoverage runs the models_unpriced and billing_modes probes over a
// window, narrowed by the fixed extraJoin / extraWhere fragments (whose
// placeholders, if any, start at $3) with extraArgs.
func (s *Store) costCoverage(
	ctx context.Context, start, end time.Time, extraJoin, extraWhere string, extraArgs ...any,
) (CostCoverage, error) {
	args := append([]any{start, end}, extraArgs...)
	var out CostCoverage
	for _, probe := range []struct {
		sql  string
		dest *[]string
	}{
		{unpricedModelsSQL(extraJoin, extraWhere), &out.ModelsUnpriced},
		{billingModesSQL(extraJoin, extraWhere), &out.BillingModes},
	} {
		rows, err := s.pool.Query(ctx, probe.sql, args...)
		if err != nil {
			return out, fmt.Errorf("cost coverage: %w", err)
		}
		values, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return out, fmt.Errorf("cost coverage: %w", err)
		}
		*probe.dest = values
	}
	return out, nil
}
