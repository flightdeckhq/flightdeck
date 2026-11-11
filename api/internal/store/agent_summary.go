package store

import (
	"context"
	"fmt"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// AgentSummaryParams selects the window + bucketing for
// “GET /v1/agents/{id}/summary“. The handler validates every
// field's vocabulary before reaching the store; the store trusts
// its caller for that layer.
type AgentSummaryParams struct {
	// AgentID is the UUID the handler already validated against
	// uuidRE. Empty is rejected at the handler layer; the store
	// never sees an empty value in normal flow but emits a
	// well-formed query either way.
	AgentID string
	// Period is one of ``1h``, ``24h``, ``7d``, ``30d``. Drives
	// the lower bound of the window (``now - period``). The
	// handler rejects unknown values.
	Period string
	// Bucket is one of ``hour``, ``day``, ``week`` and feeds the
	// time truncation. Default is derived from Period at the
	// handler layer.
	Bucket string
}

// AgentSummaryTotals carries the across-the-window aggregates the
// per-agent landing page renders in its summary tiles. “Errors“
// counts “llm_error“ events and failed “tool_call“ events
// (errorEventFilter) only — policy events
// (policy_block / policy_warn / policy_degrade / policy_mcp_*)
// are enforcement decisions, not failures, and live on a separate
// dashboard surface. “Sessions“ is distinct session_id across
// events in the window (every session that had activity counts,
// regardless of when it started — operators read "sessions" as
// "agents that were active here", not "sessions started here").
type AgentSummaryTotals struct {
	Tokens       int64   `json:"tokens"`
	Errors       int64   `json:"errors"`
	Sessions     int64   `json:"sessions"`
	CostUSD      float64 `json:"cost_usd"`
	LatencyP50MS int64   `json:"latency_p50_ms"`
	LatencyP95MS int64   `json:"latency_p95_ms"`
	// What CostUSD leaves out (ARCHITECTURE.md, Cost estimation): the
	// models of metered calls with no price, whether there were any,
	// and every billing mode the agent's calls used.
	PartialEstimate bool     `json:"partial_estimate"`
	ModelsUnpriced  []string `json:"models_unpriced"`
	BillingModes    []string `json:"billing_modes"`
}

// AgentSummarySeriesPoint is one per-bucket row in the time
// series the chart renders. p50 is intentionally absent here —
// charts plot p95 (the operator-actionable headline number) and
// the summary tile carries p50 for context.
type AgentSummarySeriesPoint struct {
	// TS is the bucket's start, truncated to the requested
	// granularity. Serialised as RFC 3339 / ISO 8601 by Go's default
	// JSON encoder.
	TS           time.Time `json:"ts"`
	Tokens       int64     `json:"tokens"`
	Errors       int64     `json:"errors"`
	Sessions     int64     `json:"sessions"`
	CostUSD      float64   `json:"cost_usd"`
	LatencyP95MS int64     `json:"latency_p95_ms"`
}

// AgentSummaryResponse is the full “GET /v1/agents/{id}/summary“
// payload. “Series“ is always non-nil (empty slice for agents
// with no activity in the window) so the dashboard's chart code
// never has to distinguish “null“ from “[]“.
type AgentSummaryResponse struct {
	AgentID string                    `json:"agent_id"`
	Period  string                    `json:"period"`
	Bucket  string                    `json:"bucket"`
	Totals  AgentSummaryTotals        `json:"totals"`
	Series  []AgentSummarySeriesPoint `json:"series"`
}

// agentSummaryPeriodToDuration maps the four supported period
// vocabulary values to their lower-bound offsets. Centralised so
// the handler's validation list and the store's window
// computation can never drift.
func agentSummaryPeriodToDuration(period string) (time.Duration, bool) {
	switch period {
	case "1h":
		return time.Hour, true
	case "24h":
		return 24 * time.Hour, true
	case "7d":
		return 7 * 24 * time.Hour, true
	case "30d":
		return 30 * 24 * time.Hour, true
	}
	return 0, false
}

// truncUnit maps a validated bucket / granularity name onto the
// dialect's truncation unit.
func truncUnit(name string) (storage.TruncUnit, bool) {
	switch name {
	case "hour":
		return storage.TruncHour, true
	case "day":
		return storage.TruncDay, true
	case "week":
		return storage.TruncWeek, true
	case "month":
		return storage.TruncMonth, true
	}
	return "", false
}

// AgentSummary runs the totals + series queries for one agent
// over the requested period. The two queries share the same
// FROM / WHERE shape; running them sequentially keeps each plan
// simple and avoids forcing the planner to fold totals into the
// per-bucket aggregate (which would either need a window function
// or a CTE that some operators would have to re-explain on call).
//
// Latency percentiles use “event_type = 'post_call'“ only —
// matching the existing analytics convention for “latency_p50“
// / “latency_p95“ in analytics.go. Errors count the error events
// errorEventFilter matches (“llm_error“ and failed “tool_call“);
// policy events are excluded.
func (s *Store) AgentSummary(
	ctx context.Context, params AgentSummaryParams,
) (*AgentSummaryResponse, error) {
	dur, ok := agentSummaryPeriodToDuration(params.Period)
	if !ok {
		return nil, fmt.Errorf("invalid period: %s", params.Period)
	}
	unit, ok := truncUnit(params.Bucket)
	if !ok || params.Bucket == "month" {
		return nil, fmt.Errorf("invalid bucket: %s", params.Bucket)
	}

	end := time.Now().UTC()
	start := end.Add(-dur)
	d := s.d

	costExpr := s.costAggregateSQL()
	priceJoin := s.q.priceJoin()
	errorFilter := s.errorEventFilter()

	// Per-metric aggregates as CASE expressions (a FILTER clause has
	// no SQLite spelling): tokens over the billed events, errors over
	// errorEventFilter, latency percentiles over post_call rows only
	// (the CASE yields NULL for the rest, which the percentile skips).
	tokensAgg := "COALESCE(SUM(CASE WHEN " + tokenEventFilter + " THEN e.tokens_total END), 0)"
	errorsAgg := "COUNT(CASE WHEN " + errorFilter + " THEN 1 END)"
	postCallLatency := "CASE WHEN e.event_type = 'post_call' THEN e.latency_ms END"

	// Totals query.
	//
	// The cost expression (costAggregateSQL) carries its own filter to
	// the priced events (post_call, embeddings and failed streams'
	// llm_error), and the price lookup (queries.priceJoin) yields no
	// row for any other event, so the query can scan every event of
	// the agent. Tokens count the same calls and failed streams as the
	// analytics tokens metric (tokenEventFilter).
	//
	// COUNT(DISTINCT session_id) is unfiltered: an agent's
	// "sessions in the window" is every session that emitted at
	// least one event regardless of event type — matching the
	// operator-facing definition recorded in
	// AgentSummaryTotals's docstring.
	totalsSQL := `
		SELECT
			` + tokensAgg + ` AS tokens,
			` + errorsAgg + ` AS errors,
			COUNT(DISTINCT e.session_id) AS sessions,
			COALESCE(` + costExpr + `, 0) AS cost_usd,
			COALESCE(` + d.Percentile("0.5", postCallLatency) + `, 0) AS p50,
			COALESCE(` + d.Percentile("0.95", postCallLatency) + `, 0) AS p95
		FROM events e
		JOIN sessions s ON e.session_id = s.session_id
		` + priceJoin + `
		WHERE s.agent_id = $1
		  AND e.occurred_at >= $2
		  AND e.occurred_at < $3
	`

	resp := &AgentSummaryResponse{
		AgentID: params.AgentID,
		Period:  params.Period,
		Bucket:  params.Bucket,
		Series:  []AgentSummarySeriesPoint{},
	}

	agentID := uuidArg(params.AgentID)
	var totals AgentSummaryTotals
	var costUSD, p50, p95 float64
	if err := s.reader().QueryRowContext(ctx, totalsSQL,
		agentID, start, end,
	).Scan(
		&totals.Tokens,
		&totals.Errors,
		&totals.Sessions,
		&costUSD,
		&p50,
		&p95,
	); err != nil {
		return nil, fmt.Errorf("agent summary totals: %w", err)
	}
	totals.CostUSD = costUSD
	totals.LatencyP50MS = int64(p50)
	totals.LatencyP95MS = int64(p95)
	coverage, err := s.costCoverage(ctx, start, end,
		"JOIN sessions s ON e.session_id = s.session_id", "AND s.agent_id = $3",
		agentID)
	if err != nil {
		return nil, fmt.Errorf("agent summary: %w", err)
	}
	totals.ModelsUnpriced = nonNil(coverage.ModelsUnpriced)
	totals.PartialEstimate = len(coverage.ModelsUnpriced) > 0
	totals.BillingModes = nonNil(coverage.BillingModes)
	resp.Totals = totals

	// Series query. The bucket name was validated against the
	// hour/day/week whitelist above, so the truncation unit is safe
	// to render. Buckets with no rows simply don't appear; the chart
	// code handles the gap rather than the query padding with zeros.
	seriesSQL := `
		SELECT
			` + d.DateTrunc(unit, "e.occurred_at") + ` AS bucket,
			` + tokensAgg + ` AS tokens,
			` + errorsAgg + ` AS errors,
			COUNT(DISTINCT e.session_id) AS sessions,
			COALESCE(` + costExpr + `, 0) AS cost_usd,
			COALESCE(` + d.Percentile("0.95", postCallLatency) + `, 0) AS p95
		FROM events e
		JOIN sessions s ON e.session_id = s.session_id
		` + priceJoin + `
		WHERE s.agent_id = $1
		  AND e.occurred_at >= $2
		  AND e.occurred_at < $3
		GROUP BY bucket
		ORDER BY bucket
	`

	rows, err := s.reader().QueryContext(ctx, seriesSQL, agentID, start, end)
	if err != nil {
		return nil, fmt.Errorf("agent summary series: %w", err)
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var pt AgentSummarySeriesPoint
		var bucket storage.Time
		var pCost, p95 float64
		if err := rows.Scan(
			&bucket,
			&pt.Tokens,
			&pt.Errors,
			&pt.Sessions,
			&pCost,
			&p95,
		); err != nil {
			return nil, fmt.Errorf("agent summary series scan: %w", err)
		}
		pt.TS = bucket.Time.UTC()
		pt.CostUSD = pCost
		pt.LatencyP95MS = int64(p95)
		resp.Series = append(resp.Series, pt)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("agent summary series rows: %w", err)
	}

	return resp, nil
}

// nonNil returns s, or an empty slice for nil, so a JSON field renders
// as [] rather than null.
func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
