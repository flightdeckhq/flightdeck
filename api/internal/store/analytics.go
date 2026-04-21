// Package store -- analytics.go contains all analytics GROUP BY queries.
// SQL lives only in this file and postgres.go per rule 35.
package store

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// AnalyticsParams holds validated query parameters for GET /v1/analytics.
type AnalyticsParams struct {
	Metric          string
	GroupBy         string
	Range           string
	From            time.Time
	To              time.Time
	Granularity     string
	FilterFlavor    string
	FilterModel     string
	FilterAgentType string
	FilterProvider  string
}

// DataPoint is a single time series data point.
type DataPoint struct {
	Date  string  `json:"date"`
	Value float64 `json:"value"`
}

// AnalyticsSeries is one dimension's data (e.g. one flavor's token usage).
type AnalyticsSeries struct {
	Dimension string      `json:"dimension"`
	Total     float64     `json:"total"`
	Data      []DataPoint `json:"data"`
}

// AnalyticsTotals holds aggregate totals across all dimensions.
type AnalyticsTotals struct {
	GrandTotal      float64 `json:"grand_total"`
	PeriodChangePct float64 `json:"period_change_pct"`
}

// AnalyticsResponse is the full response for GET /v1/analytics.
//
// ``PartialEstimate`` is only meaningful when ``metric=estimated_cost``
// and is true when the window contains post_call rows for models that
// are not in the static pricing table (pricing.go). The dashboard
// surfaces an amber disclaimer above the cost chart when this flag
// is set. See DECISIONS.md D099.
type AnalyticsResponse struct {
	Metric          string            `json:"metric"`
	GroupBy         string            `json:"group_by"`
	Range           string            `json:"range"`
	Granularity     string            `json:"granularity"`
	Series          []AnalyticsSeries `json:"series"`
	Totals          AnalyticsTotals   `json:"totals"`
	PartialEstimate bool              `json:"partial_estimate,omitempty"`
}

// dimensionSource describes how to project a group-by dimension. When
// ``needsSessionJoin`` is true and the metric's base table is events,
// the generated query joins ``sessions s`` to expose session-only
// columns (host, agent_type) or the unnested framework array.
// ``expr`` is the SQL fragment written into the SELECT list (may
// reference ``s.``). ``team`` maps onto ``flavor`` because there is
// no team column yet.
//
// ``fromExtras`` is appended verbatim to the FROM clause when non-
// empty. Used by ``framework`` to add a LEFT JOIN LATERAL
// ``jsonb_array_elements_text`` so each string in
// ``sessions.context->'frameworks'`` becomes its own row and sessions
// with no frameworks still appear under ``'unknown'`` via COALESCE.
type dimensionSource struct {
	// exprEvents is the SQL expression for the dimension when the
	// metric's base table is events (with ``sessions s`` joined in
	// when needsSessionJoin).
	exprEvents string
	// exprSessions is the SQL expression when the base table is
	// sessions (no join).
	exprSessions string
	// needsSessionJoin indicates an events-based metric requires a
	// join on ``sessions`` to reach this column.
	needsSessionJoin bool
	// fromExtras is an optional FROM-clause fragment appended after
	// the base table (and the sessions join, if any) without any
	// leading ``,`` or ``AND``. Empty for all dimensions except
	// ``framework``.
	fromExtras string
}

// frameworkUnnest is the LATERAL unnest used by the ``framework``
// dimension. The sensor stores multiple framework versions per
// session as a JSONB array under ``sessions.context->'frameworks'``
// (e.g. ``["langchain/0.1.12","crewai/0.42.0"]``). A plain GROUP BY
// on ``s.framework`` (a legacy unused scalar column) collapsed every
// row into ``'unknown'``. LEFT JOIN LATERAL so sessions with an
// empty or missing array still produce one ``NULL`` row that
// COALESCEs to ``'unknown'`` instead of being dropped. A session
// tagged ``["crewai","langchain"]`` legitimately counts once under
// each framework -- totals across frameworks can therefore exceed
// distinct sessions, which is the honest answer for a multi-valued
// dimension.
const frameworkUnnest = `LEFT JOIN LATERAL jsonb_array_elements_text(
		COALESCE(s.context->'frameworks', '[]'::jsonb)
	) AS fw ON TRUE`

// dimensions maps group_by param values to their SQL projection. The
// provider entry uses the shared ProviderCaseSQL from pricing.go so
// the mapping stays in one place; model / flavor columns live on both
// tables.
var dimensions = map[string]dimensionSource{
	"flavor": {exprEvents: "e.flavor", exprSessions: "s.flavor"},
	"model":  {exprEvents: "e.model", exprSessions: "s.model"},
	"framework": {
		exprEvents:       "fw",
		exprSessions:     "fw",
		needsSessionJoin: true,
		fromExtras:       frameworkUnnest,
	},
	"host":       {exprEvents: "s.host", exprSessions: "s.host", needsSessionJoin: true},
	"agent_type": {exprEvents: "s.agent_type", exprSessions: "s.agent_type", needsSessionJoin: true},
	// team maps to flavor until a real team field lands.
	"team":     {exprEvents: "e.flavor", exprSessions: "s.flavor"},
	"provider": {exprEvents: providerCase("e.model"), exprSessions: providerCase("s.model")},
}

// providerCase returns the canonical provider mapping as a SQL CASE
// expression over the given model column (e.g. e.model or s.model).
// Mirrors pricing.ProviderCaseSQL but parameterised on the model
// reference so the same logic works whether the base query is on
// events or sessions. See DECISIONS.md D098.
func providerCase(modelCol string) string {
	return strings.ReplaceAll(ProviderCaseSQL, "model", modelCol)
}

// metricSpec describes how a single metric is aggregated.
type metricSpec struct {
	// baseTable is the primary FROM table (events or sessions).
	baseTable string
	// alias is the alias used for baseTable in the generated SQL.
	// Always "e" for events, "s" for sessions; dimensions reference
	// these.
	alias string
	// agg is the SQL aggregate expression.
	agg string
	// timeCol is the column used for the time-bucket and window
	// filter, qualified by alias.
	timeCol string
	// whereClause is a pre-existing WHERE fragment appended with AND.
	// Empty for metrics with no extra filter.
	whereClause string
}

// metricSpecs returns the specification for the requested metric.
// ``estimated_cost`` is computed from the static pricing table; see
// pricing.go / DECISIONS.md D099.
func metricSpecs() map[string]metricSpec {
	return map[string]metricSpec{
		"tokens": {
			baseTable: "events", alias: "e",
			agg:         "COALESCE(SUM(e.tokens_total), 0)",
			timeCol:     "e.occurred_at",
			whereClause: "e.event_type = 'post_call'",
		},
		"sessions": {
			baseTable: "sessions", alias: "s",
			agg:     "COUNT(DISTINCT s.session_id)",
			timeCol: "s.started_at",
		},
		"latency_avg": {
			baseTable: "events", alias: "e",
			agg:         "COALESCE(AVG(e.latency_ms), 0)",
			timeCol:     "e.occurred_at",
			whereClause: "e.event_type = 'post_call'",
		},
		"latency_p50": {
			baseTable: "events", alias: "e",
			// PERCENTILE_CONT is an ordered-set aggregate and
			// requires WITHIN GROUP; it returns NULL when the
			// bucket is empty, so COALESCE to 0 for a clean zero
			// series in charts.
			agg:         "COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY e.latency_ms), 0)",
			timeCol:     "e.occurred_at",
			whereClause: "e.event_type = 'post_call'",
		},
		"latency_p95": {
			baseTable: "events", alias: "e",
			agg:         "COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.latency_ms), 0)",
			timeCol:     "e.occurred_at",
			whereClause: "e.event_type = 'post_call'",
		},
		"policy_events": {
			baseTable: "events", alias: "e",
			agg:         "COUNT(*)",
			timeCol:     "e.occurred_at",
			whereClause: "e.event_type IN ('policy_warn', 'policy_block', 'policy_degrade')",
		},
		"estimated_cost": {
			baseTable: "events", alias: "e",
			agg:         BuildCostAggregateSQL("e.model"),
			timeCol:     "e.occurred_at",
			whereClause: "e.event_type = 'post_call'",
		},
	}
}

// timeRange calculates the start and end times for a range string.
func timeRange(rangeStr string, from, to time.Time) (time.Time, time.Time) {
	now := time.Now().UTC()
	switch rangeStr {
	case "today":
		start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
		return start, now
	case "7d":
		return now.AddDate(0, 0, -7), now
	case "30d":
		return now.AddDate(0, 0, -30), now
	case "90d":
		return now.AddDate(0, 0, -90), now
	case "custom":
		return from, to
	default:
		return now.AddDate(0, 0, -30), now
	}
}

// QueryAnalytics runs the analytics query and returns the full response.
func (s *Store) QueryAnalytics(ctx context.Context, params AnalyticsParams) (*AnalyticsResponse, error) {
	dim, ok := dimensions[params.GroupBy]
	if !ok {
		return nil, fmt.Errorf("invalid group_by: %s", params.GroupBy)
	}
	specs := metricSpecs()
	spec, ok := specs[params.Metric]
	if !ok {
		return nil, fmt.Errorf("invalid metric: %s", params.Metric)
	}

	start, end := timeRange(params.Range, params.From, params.To)
	prevStart := start.Add(-(end.Sub(start)))

	// Pick the dimension expression for the metric's base table and
	// decide whether we need to join sessions in.
	var dimExpr string
	needsJoin := false
	if spec.baseTable == "events" {
		dimExpr = dim.exprEvents
		needsJoin = dim.needsSessionJoin
	} else {
		dimExpr = dim.exprSessions
	}

	fromClause := fmt.Sprintf("%s %s", spec.baseTable, spec.alias)
	if needsJoin {
		fromClause = "events e JOIN sessions s ON e.session_id = s.session_id"
	}

	// Filters. All filter columns (flavor, model, agent_type) live on
	// events for event-based metrics (flavor/model are on events
	// directly) except agent_type which needs the join we might have
	// already added. For consistency, use session-side columns when
	// joined so the filter matches the dimension source.
	filterArgs := []any{start, end}
	argIdx := 3
	var filterSQL string

	if params.FilterFlavor != "" {
		filterSQL += fmt.Sprintf(" AND %s.flavor = $%d", spec.alias, argIdx)
		filterArgs = append(filterArgs, params.FilterFlavor)
		argIdx++
	}
	if params.FilterModel != "" {
		filterSQL += fmt.Sprintf(" AND %s.model = $%d", spec.alias, argIdx)
		filterArgs = append(filterArgs, params.FilterModel)
		argIdx++
	}
	if params.FilterAgentType != "" {
		// agent_type is on sessions; if we don't already have the
		// join, add it specifically for this filter.
		if spec.baseTable == "events" && !needsJoin {
			fromClause = "events e JOIN sessions s ON e.session_id = s.session_id"
		}
		aliasForFilter := "s"
		if spec.baseTable == "sessions" {
			aliasForFilter = spec.alias
		}
		filterSQL += fmt.Sprintf(" AND %s.agent_type = $%d", aliasForFilter, argIdx)
		filterArgs = append(filterArgs, params.FilterAgentType)
		argIdx++
	}

	// Append per-dimension FROM-clause extras (LATERAL unnest for
	// framework) after any sessions JOIN has been materialised above.
	// fromExtras is a bare SQL fragment (whitespace-separated, no
	// leading comma or AND) so it can be appended unchanged.
	if dim.fromExtras != "" {
		fromClause = fromClause + " " + dim.fromExtras
	}
	if params.FilterProvider != "" {
		// provider is a derived expression, not a column, so we filter
		// on the CASE directly using the same model column the
		// dimension uses.
		modelCol := "e.model"
		if spec.baseTable == "sessions" {
			modelCol = "s.model"
		}
		filterSQL += fmt.Sprintf(" AND (%s) = $%d", providerCase(modelCol), argIdx)
		filterArgs = append(filterArgs, params.FilterProvider)
	}

	whereAnd := ""
	if spec.whereClause != "" {
		whereAnd = spec.whereClause + " AND "
	}

	// Main series query. Time bucket rounds down to the chosen
	// granularity (day default). COALESCE(dim, 'unknown') keeps null
	// model / framework values from collapsing into a single empty
	// dimension label.
	//
	//nolint:gosec // dimExpr comes from a validated whitelist; spec
	// strings come from the metricSpecs map; params.Granularity is
	// validated by the handler.
	seriesSQL := fmt.Sprintf(`
		SELECT COALESCE(%s, 'unknown') AS dimension,
		       date_trunc('%s', %s)::date AS bucket,
		       %s AS value
		FROM %s
		WHERE %s%s >= $1 AND %s < $2 %s
		GROUP BY dimension, bucket
		ORDER BY dimension, bucket
	`, dimExpr, params.Granularity, spec.timeCol, spec.agg, fromClause,
		whereAnd, spec.timeCol, spec.timeCol, filterSQL)

	rows, err := s.pool.Query(ctx, seriesSQL, filterArgs...)
	if err != nil {
		return nil, fmt.Errorf("analytics query: %w", err)
	}
	defer rows.Close()

	seriesMap := make(map[string]*AnalyticsSeries)
	var order []string
	var grandTotal float64

	for rows.Next() {
		var dimVal string
		var bucket time.Time
		var value float64
		if err := rows.Scan(&dimVal, &bucket, &value); err != nil {
			return nil, fmt.Errorf("analytics scan: %w", err)
		}
		series, exists := seriesMap[dimVal]
		if !exists {
			series = &AnalyticsSeries{Dimension: dimVal}
			seriesMap[dimVal] = series
			order = append(order, dimVal)
		}
		series.Data = append(series.Data, DataPoint{
			Date:  bucket.Format("2006-01-02"),
			Value: value,
		})
		series.Total += value
		grandTotal += value
	}

	series := make([]AnalyticsSeries, 0, len(order))
	for _, d := range order {
		series = append(series, *seriesMap[d])
	}

	// Previous-period grand total for period_change_pct. Same query
	// shape, different time window. Uses the same filterArgs but
	// with prevStart / start rather than start / end.
	//
	//nolint:gosec
	prevSQL := fmt.Sprintf(`
		SELECT COALESCE(%s, 0) FROM (
			SELECT %s AS val FROM %s
			WHERE %s%s >= $1 AND %s < $2 %s
		) sub
	`, spec.agg, spec.agg, fromClause, whereAnd, spec.timeCol, spec.timeCol, filterSQL)

	prevArgs := append([]any{prevStart, start}, filterArgs[2:]...)
	var prevTotal float64
	_ = s.pool.QueryRow(ctx, prevSQL, prevArgs...).Scan(&prevTotal)

	var changePct float64
	if prevTotal > 0 {
		changePct = ((grandTotal - prevTotal) / prevTotal) * 100
	}

	resp := &AnalyticsResponse{
		Metric:      params.Metric,
		GroupBy:     params.GroupBy,
		Range:       params.Range,
		Granularity: params.Granularity,
		Series:      series,
		Totals: AnalyticsTotals{
			GrandTotal:      grandTotal,
			PeriodChangePct: changePct,
		},
	}

	// For estimated_cost, probe for unpriced models in the window and
	// set partial_estimate accordingly. Separate round-trip so the
	// flag never falsely flips on because of pricing-aware JOINs in
	// the main aggregation query.
	if params.Metric == "estimated_cost" {
		probeArgs := []any{start, end}
		known := KnownPricedModels()
		partial := false
		probeSQL := `
			SELECT EXISTS (
				SELECT 1 FROM events
				WHERE event_type = 'post_call'
				  AND occurred_at >= $1 AND occurred_at < $2
				  AND model IS NOT NULL
				  AND NOT (model = ANY($3))
			)
		`
		_ = s.pool.QueryRow(ctx, probeSQL, probeArgs[0], probeArgs[1], known).Scan(&partial)
		resp.PartialEstimate = partial
	}

	return resp, nil
}
