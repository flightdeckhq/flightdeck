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
	GroupBySecondary string
	Range           string
	From            time.Time
	To              time.Time
	Granularity     string
	FilterFlavor    string
	FilterModel     string
	FilterAgentType string
	FilterProvider  string

	// D126 — sub-agent observability filters. All three compose via
	// AND in the WHERE clause. Each is independent and skipped when
	// unset (empty string for FilterParentSessionID, false for the
	// boolean toggles), so non-sub-agent callers see exactly the
	// pre-D126 query shape.
	//
	// FilterParentSessionID scopes the analytics window to children
	// of one specific parent session — used by the per-agent
	// landing page (Roadmap 2 inheritance) to chart a single tree's
	// activity.
	FilterParentSessionID string
	// FilterHasSubAgents (when true) restricts to parent sessions
	// only: those referenced as a parent_session_id by at least one
	// other session.
	FilterHasSubAgents bool
	// FilterIsSubAgent (when true) restricts to child sessions
	// only: parent_session_id IS NOT NULL.
	FilterIsSubAgent bool
}

// DataPoint is a single time series data point. ``Breakdown`` carries
// per-secondary-axis segments when the caller passes a two-dimension
// ``group_by`` (D126 § 6.4). Single-dim queries leave ``Breakdown``
// nil — the JSON ``omitempty`` keeps the wire shape byte-identical to
// the pre-6.4 contract for those callers.
type DataPoint struct {
	Date      string            `json:"date"`
	Value     float64           `json:"value"`
	Breakdown []BreakdownBucket `json:"breakdown,omitempty"`
}

// BreakdownBucket is one segment of a two-dim DataPoint. ``Key`` is
// the secondary-axis bucket value; ``Value`` is the metric aggregate
// for that primary × secondary × time-bucket triple. The sum of all
// Breakdown[].Value within a single DataPoint equals DataPoint.Value
// (the row total), so a chart can render either the stacked or the
// flat representation off the same payload.
type BreakdownBucket struct {
	Key   string  `json:"key"`
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
	// D126 — sub-agent observability dimensions. Both bake their
	// COALESCE-to-(root) into the expression so the outer
	// ``COALESCE(<dim>, 'unknown')`` in the query builder never
	// overrides the (root) label. Standardising on (root) for these
	// two dims matches the design spec (ARCHITECTURE.md analytics
	// section + CLAUDE.md Rule 25 + DECISIONS.md D126 § 6.4) where
	// "no parent" / "no role" is a meaningful bucket label, not
	// the unknown-data fallback that ``unknown`` implies for the
	// other dimensions.
	//
	// agent_role: framework-supplied role string (CrewAI Agent.role,
	// LangGraph node name, Claude Code Task agent_type). NULL on
	// root sessions and direct-SDK sessions.
	"agent_role": {
		exprEvents:       "COALESCE(s.agent_role, '(root)')",
		exprSessions:     "COALESCE(s.agent_role, '(root)')",
		needsSessionJoin: true,
	},
	// parent_session_id: parent session UUID, NULL on root + direct-
	// SDK sessions. The ::text cast is the cheapest way to render
	// UUIDs as strings; pgx scans the resulting column into a Go
	// string without a custom unmarshaller.
	"parent_session_id": {
		exprEvents:       "COALESCE(s.parent_session_id::text, '(root)')",
		exprSessions:     "COALESCE(s.parent_session_id::text, '(root)')",
		needsSessionJoin: true,
	},
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

// subagentMetricNames is the set of D126 metrics that operate over
// the parent / child relationship rather than over a single events
// or sessions column. They share a query shape distinct from the
// dynamic-SQL builder used for ``tokens`` / ``sessions`` / ... —
// the recursive CTE for token sums and the correlated subqueries
// for child_count + first-child latency don't slot into the
// per-bucket aggregate the existing builder produces. ``QueryAnalytics``
// dispatches to ``querySubagentAnalytics`` when the requested
// metric is in this set.
//
// See D126 § 6.4 for the metric definitions and the
// "Accepted properties / known performance characteristics" note
// in D126 for the recursive-CTE cost flag.
var subagentMetricNames = map[string]bool{
	"parent_token_sum":                 true,
	"child_token_sum":                  true,
	"child_count":                      true,
	"parent_to_first_child_latency_ms": true,
}

// IsSubagentMetric reports whether the given metric name is in the
// D126 sub-agent set. Exported so handlers can validate the metric
// against the union of the standard metrics map and this set
// without duplicating the membership check.
func IsSubagentMetric(metric string) bool {
	return subagentMetricNames[metric]
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

// appendBreakdownPoint folds a (bucket, subDim, value) row into a
// series whose Data points carry per-secondary-axis breakdowns.
// Rows arrive ORDER BY dimension, bucket, sub_dimension so the
// last-data-point lookup is O(1): when the most recent point matches
// the bucket, we extend its Breakdown; otherwise we start a new
// point and seed Value as the running row total.
//
// Maintains the invariant that DataPoint.Value == sum of every
// Breakdown[].Value within the same point. A chart can therefore
// render either the stacked breakdown or a flat-Value line off the
// same payload without re-summing client-side.
func appendBreakdownPoint(
	series *AnalyticsSeries,
	bucket time.Time,
	subDim string,
	value float64,
) {
	dateStr := bucket.Format("2006-01-02")
	if n := len(series.Data); n > 0 && series.Data[n-1].Date == dateStr {
		// Same primary × bucket → append to the existing point.
		series.Data[n-1].Breakdown = append(
			series.Data[n-1].Breakdown,
			BreakdownBucket{Key: subDim, Value: value},
		)
		series.Data[n-1].Value += value
		return
	}
	series.Data = append(series.Data, DataPoint{
		Date:      dateStr,
		Value:     value,
		Breakdown: []BreakdownBucket{{Key: subDim, Value: value}},
	})
}

// groupByWireValue mirrors the request param as written by the
// caller. Single-dim queries echo back ``params.GroupBy`` exactly;
// two-dim queries return ``primary,secondary`` so a client can
// re-construct the request from the response without an additional
// round trip. Mirrors the parsing convention in the analytics
// handler.
func groupByWireValue(params AnalyticsParams) string {
	if params.GroupBySecondary == "" {
		return params.GroupBy
	}
	return params.GroupBy + "," + params.GroupBySecondary
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
	// D126 § 6.4 — optional secondary dimension. Validated against
	// the same locked vocabulary as the primary dim so the two-dim
	// path inherits the dimension whitelist without duplication.
	var secDim dimensionSource
	hasSecondary := params.GroupBySecondary != ""
	if hasSecondary {
		var ok2 bool
		secDim, ok2 = dimensions[params.GroupBySecondary]
		if !ok2 {
			return nil, fmt.Errorf("invalid group_by secondary: %s", params.GroupBySecondary)
		}
		// Reject secondary == primary — two identical axes would
		// produce one bucket per primary key (the secondary collapses
		// to itself) which is meaningless and almost certainly a
		// caller bug. Better to surface the error than silently
		// return a flat single-axis chart with extra payload weight.
		if params.GroupBySecondary == params.GroupBy {
			return nil, fmt.Errorf(
				"group_by primary and secondary must differ; both = %s",
				params.GroupBy)
		}
	}
	// D126 — sub-agent metrics dispatch to a dedicated query path
	// because their shape (recursive CTE for parent_token_sum /
	// child_token_sum, correlated subqueries for child_count and
	// parent_to_first_child_latency_ms) doesn't fit the standard
	// per-bucket aggregate builder below.
	if subagentMetricNames[params.Metric] {
		return s.querySubagentAnalytics(ctx, params, dim, secDim, hasSecondary)
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
		argIdx++
	}

	// D126 — sub-agent observability filters. All three reference
	// sessions columns (parent_session_id, sessions self-join for
	// has_sub_agents); ensure the sessions join is present when the
	// metric's base table is events. The "s" alias is the join's,
	// matching the agent_type filter convention above.
	subagentFiltersActive := params.FilterParentSessionID != "" ||
		params.FilterHasSubAgents || params.FilterIsSubAgent
	if subagentFiltersActive && spec.baseTable == "events" && !needsJoin {
		fromClause = "events e JOIN sessions s ON e.session_id = s.session_id"
	}
	subagentAlias := "s"
	if spec.baseTable == "sessions" {
		subagentAlias = spec.alias
	}
	if params.FilterParentSessionID != "" {
		filterSQL += fmt.Sprintf(
			" AND %s.parent_session_id = $%d::uuid", subagentAlias, argIdx)
		filterArgs = append(filterArgs, params.FilterParentSessionID)
		// No argIdx++ here — the IS NOT NULL / EXISTS branches below
		// don't bind a positional parameter. Adding a future filter
		// that does bind requires re-introducing the increment in
		// the same edit.
	}
	if params.FilterIsSubAgent {
		// Hits the partial index sessions_parent_session_id_idx.
		filterSQL += fmt.Sprintf(
			" AND %s.parent_session_id IS NOT NULL", subagentAlias)
	}
	if params.FilterHasSubAgents {
		filterSQL += fmt.Sprintf(
			" AND EXISTS (SELECT 1 FROM sessions child "+
				"WHERE child.parent_session_id = %s.session_id)",
			subagentAlias)
	}

	whereAnd := ""
	if spec.whereClause != "" {
		whereAnd = spec.whereClause + " AND "
	}

	// Resolve the secondary dim's expression. The secondary axis
	// always picks from the same alias set as the primary because
	// both end up in the same SELECT list; the join requirements
	// already accumulated above (needsSessionJoin or
	// subagentFiltersActive) cover the case where the secondary
	// needs the sessions join even when the primary doesn't.
	var secDimExpr string
	if hasSecondary {
		if spec.baseTable == "events" {
			secDimExpr = secDim.exprEvents
			if secDim.needsSessionJoin && !needsJoin && !subagentFiltersActive {
				fromClause = "events e JOIN sessions s ON e.session_id = s.session_id"
			}
		} else {
			secDimExpr = secDim.exprSessions
		}
	}

	// Main series query. Time bucket rounds down to the chosen
	// granularity (day default). COALESCE(dim, 'unknown') keeps null
	// model / framework values from collapsing into a single empty
	// dimension label.
	//
	// Two-dim shape (D126 § 6.4): when ``hasSecondary``, the SELECT
	// projects three keys (primary, secondary, bucket) and the GROUP
	// BY follows. Single-dim queries take the original two-key
	// shape. The fold loop below walks the rows once and dispatches
	// on row arity so the standard / two-dim paths share scan
	// machinery rather than duplicating the cursor management.
	//
	//nolint:gosec // dimExpr / secDimExpr from the validated
	// whitelist; spec strings come from the metricSpecs map;
	// params.Granularity is validated by the handler.
	var seriesSQL string
	if hasSecondary {
		seriesSQL = fmt.Sprintf(`
			SELECT COALESCE(%s, 'unknown') AS dimension,
			       COALESCE(%s, 'unknown') AS sub_dimension,
			       date_trunc('%s', %s)::date AS bucket,
			       %s AS value
			FROM %s
			WHERE %s%s >= $1 AND %s < $2 %s
			GROUP BY dimension, sub_dimension, bucket
			ORDER BY dimension, bucket, sub_dimension
		`, dimExpr, secDimExpr, params.Granularity, spec.timeCol,
			spec.agg, fromClause, whereAnd, spec.timeCol,
			spec.timeCol, filterSQL)
	} else {
		seriesSQL = fmt.Sprintf(`
			SELECT COALESCE(%s, 'unknown') AS dimension,
			       date_trunc('%s', %s)::date AS bucket,
			       %s AS value
			FROM %s
			WHERE %s%s >= $1 AND %s < $2 %s
			GROUP BY dimension, bucket
			ORDER BY dimension, bucket
		`, dimExpr, params.Granularity, spec.timeCol, spec.agg, fromClause,
			whereAnd, spec.timeCol, spec.timeCol, filterSQL)
	}

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
		var subDimVal string
		var bucket time.Time
		var value float64
		if hasSecondary {
			if err := rows.Scan(&dimVal, &subDimVal, &bucket, &value); err != nil {
				return nil, fmt.Errorf("analytics scan: %w", err)
			}
		} else {
			if err := rows.Scan(&dimVal, &bucket, &value); err != nil {
				return nil, fmt.Errorf("analytics scan: %w", err)
			}
		}
		series, exists := seriesMap[dimVal]
		if !exists {
			series = &AnalyticsSeries{Dimension: dimVal}
			seriesMap[dimVal] = series
			order = append(order, dimVal)
		}
		if hasSecondary {
			appendBreakdownPoint(series, bucket, subDimVal, value)
		} else {
			series.Data = append(series.Data, DataPoint{
				Date:  bucket.Format("2006-01-02"),
				Value: value,
			})
		}
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
		GroupBy:     groupByWireValue(params),
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

// =====================================================================
// D126 § 6.4 — sub-agent-aware analytics
// =====================================================================
//
// The four sub-agent metrics — parent_token_sum, child_token_sum,
// child_count, parent_to_first_child_latency_ms — operate over the
// parent / child relationship rather than over a single events or
// sessions column. Their query shape can't slot into the standard
// per-bucket aggregate builder above:
//
//   * parent_token_sum and child_token_sum need a recursive walk of
//     the parent_session_id tree to roll up tokens across a parent's
//     entire descendant set.
//   * child_count needs a per-parent COUNT(children) — a correlated
//     subquery, not a base-table aggregate.
//   * parent_to_first_child_latency_ms needs MIN(child.started_at)
//     per parent, then a difference against parent.started_at.
//
// This function builds a single CTE chain that materialises a
// per-session metric column then aggregates by time bucket and
// dimension. Filters and dimensions reuse the same SessionsParams
// vocabulary as the standard path (so caller code is uniform), but
// the SQL is bespoke per the metric's shape.
//
// Known performance characteristic (D126): the recursive CTE for
// parent_token_sum / child_token_sum walks the descendant set per
// session; cost grows with descendant fan-out. At 100k+ session
// scales this is the path that benefits from a denorm rollup
// column or a materialised view — deferred per the design doc's
// "ship the correct query, optimise when production load shows
// the ceiling" note. The standard analytics path stays
// recursive-CTE-free.

const subagentRecursiveCTE = `
	WITH RECURSIVE descendants AS (
		-- Anchor: every session is the root of its own subtree.
		SELECT
			session_id AS root_id,
			session_id,
			COALESCE(tokens_used, 0) AS tokens_used
		FROM sessions
		UNION ALL
		-- Recursive step: walk parent_session_id downward. Hits the
		-- partial index sessions_parent_session_id_idx on each
		-- iteration so the per-parent walk is as cheap as the
		-- index allows.
		SELECT
			d.root_id,
			c.session_id,
			COALESCE(c.tokens_used, 0)
		FROM descendants d
		JOIN sessions c ON c.parent_session_id = d.session_id
	),
	subtree_tokens AS (
		SELECT
			root_id,
			SUM(tokens_used) AS total_tokens,
			SUM(CASE WHEN session_id = root_id THEN 0
			         ELSE tokens_used END) AS child_tokens
		FROM descendants
		GROUP BY root_id
	)
`

// subagentMetricExpr returns the per-session SQL expression for the
// sub-agent metric. The CTE above projects ``subtree_tokens`` onto
// every session via the LEFT JOIN inside querySubagentAnalytics, and
// the per-parent fan-out / latency expressions reference correlated
// subqueries against the sessions table directly.
func subagentMetricExpr(metric string) (selectExpr, aggregate string) {
	switch metric {
	case "parent_token_sum":
		// Per-row: total tokens across this session's subtree.
		// Aggregate: SUM at bucket+dimension.
		return "COALESCE(st.total_tokens, 0)", "SUM"
	case "child_token_sum":
		// Per-row: tokens contributed by descendants only.
		// Aggregate: SUM.
		return "COALESCE(st.child_tokens, 0)", "SUM"
	case "child_count":
		// Per-row: direct-child count for this session. Correlated
		// subquery (no recursion needed for direct children).
		// Aggregate: SUM at bucket+dimension (total children
		// surfaced by parents in the bucket).
		return `(SELECT COUNT(*) FROM sessions c
		         WHERE c.parent_session_id = s.session_id)`, "SUM"
	case "parent_to_first_child_latency_ms":
		// Per-row: ms between this session's started_at and the
		// earliest direct-child started_at. NULL for parents with
		// no children — those rows drop out via the WHERE clause
		// in the outer aggregate (AVG ignores NULL by default,
		// matching the intent of "average across parents that
		// actually spawned someone").
		return `EXTRACT(EPOCH FROM (
		         (SELECT MIN(c.started_at) FROM sessions c
		          WHERE c.parent_session_id = s.session_id)
		         - s.started_at
		     )) * 1000`, "AVG"
	}
	return "", ""
}

func (s *Store) querySubagentAnalytics(
	ctx context.Context,
	params AnalyticsParams,
	dim dimensionSource,
	secDim dimensionSource,
	hasSecondary bool,
) (*AnalyticsResponse, error) {
	selectExpr, aggregate := subagentMetricExpr(params.Metric)
	if selectExpr == "" {
		return nil, fmt.Errorf("invalid sub-agent metric: %s", params.Metric)
	}

	start, end := timeRange(params.Range, params.From, params.To)
	prevStart := start.Add(-(end.Sub(start)))

	// Sub-agent metrics are session-scoped; the dimension always
	// resolves to the sessions-side expression even if the dim was
	// originally events-flavored. The standard path branches on
	// spec.baseTable; here every metric is sessions-rooted.
	dimExpr := dim.exprSessions
	var secDimExpr string
	if hasSecondary {
		secDimExpr = secDim.exprSessions
	}

	// Filter chain. Sub-agent metrics share the same filter
	// vocabulary as the standard path. parent_session_id /
	// has_sub_agents / is_sub_agent already reference
	// sessions columns and apply directly.
	filterArgs := []any{start, end}
	argIdx := 3
	var filterSQL string

	if params.FilterFlavor != "" {
		filterSQL += fmt.Sprintf(" AND s.flavor = $%d", argIdx)
		filterArgs = append(filterArgs, params.FilterFlavor)
		argIdx++
	}
	if params.FilterModel != "" {
		filterSQL += fmt.Sprintf(" AND s.model = $%d", argIdx)
		filterArgs = append(filterArgs, params.FilterModel)
		argIdx++
	}
	if params.FilterAgentType != "" {
		filterSQL += fmt.Sprintf(" AND s.agent_type = $%d", argIdx)
		filterArgs = append(filterArgs, params.FilterAgentType)
		argIdx++
	}
	if params.FilterProvider != "" {
		filterSQL += fmt.Sprintf(" AND (%s) = $%d",
			providerCase("s.model"), argIdx)
		filterArgs = append(filterArgs, params.FilterProvider)
		argIdx++
	}
	if params.FilterParentSessionID != "" {
		filterSQL += fmt.Sprintf(" AND s.parent_session_id = $%d::uuid", argIdx)
		filterArgs = append(filterArgs, params.FilterParentSessionID)
		// No argIdx++ here — see comment in QueryAnalytics' main
		// dispatch path for the same chain.
	}
	if params.FilterIsSubAgent {
		filterSQL += " AND s.parent_session_id IS NOT NULL"
	}
	if params.FilterHasSubAgents {
		filterSQL += " AND EXISTS (SELECT 1 FROM sessions child " +
			"WHERE child.parent_session_id = s.session_id)"
	}

	// LEFT JOIN subtree_tokens for the two recursive metrics; the
	// child_count and latency metrics ignore it (their per-row
	// expressions are correlated subqueries against sessions
	// directly).
	//
	// Two-dim shape (D126 § 6.4) folds a secondary dimension into
	// the GROUP BY exactly like the standard path — see
	// QueryAnalytics for the matching shape. The recursive CTE
	// remains the parent / child anchor, which means
	// ``parent_session_id × agent_role`` (the canonical pair)
	// renders one row per (session, role-of-that-session, bucket)
	// rather than per (parent, role-of-its-children) — for charts
	// that want the per-parent / per-child-role decomposition the
	// caller should also pass ``filter_is_sub_agent=true`` so the
	// primary axis (parent_session_id) carries only sub-agent
	// rows under their actual parent's UUID.
	//
	//nolint:gosec // dimExpr / selectExpr / aggregate from validated
	// whitelists; granularity validated by the handler.
	var seriesSQL string
	if hasSecondary {
		seriesSQL = subagentRecursiveCTE + fmt.Sprintf(`
			SELECT
				COALESCE(%s, 'unknown') AS dimension,
				COALESCE(%s, 'unknown') AS sub_dimension,
				date_trunc('%s', s.started_at)::date AS bucket,
				%s(%s) AS value
			FROM sessions s
			LEFT JOIN subtree_tokens st ON st.root_id = s.session_id
			WHERE s.started_at >= $1 AND s.started_at < $2 %s
			GROUP BY dimension, sub_dimension, bucket
			ORDER BY dimension, bucket, sub_dimension
		`, dimExpr, secDimExpr, params.Granularity, aggregate,
			selectExpr, filterSQL)
	} else {
		seriesSQL = subagentRecursiveCTE + fmt.Sprintf(`
			SELECT
				COALESCE(%s, 'unknown') AS dimension,
				date_trunc('%s', s.started_at)::date AS bucket,
				%s(%s) AS value
			FROM sessions s
			LEFT JOIN subtree_tokens st ON st.root_id = s.session_id
			WHERE s.started_at >= $1 AND s.started_at < $2 %s
			GROUP BY dimension, bucket
			ORDER BY dimension, bucket
		`, dimExpr, params.Granularity, aggregate, selectExpr, filterSQL)
	}

	rows, err := s.pool.Query(ctx, seriesSQL, filterArgs...)
	if err != nil {
		return nil, fmt.Errorf("subagent analytics query: %w", err)
	}
	defer rows.Close()

	seriesMap := make(map[string]*AnalyticsSeries)
	var order []string
	var grandTotal float64
	for rows.Next() {
		var dimVal string
		var subDimVal string
		var bucket time.Time
		var value float64
		if hasSecondary {
			if err := rows.Scan(&dimVal, &subDimVal, &bucket, &value); err != nil {
				return nil, fmt.Errorf("subagent analytics scan: %w", err)
			}
		} else {
			if err := rows.Scan(&dimVal, &bucket, &value); err != nil {
				return nil, fmt.Errorf("subagent analytics scan: %w", err)
			}
		}
		series, exists := seriesMap[dimVal]
		if !exists {
			series = &AnalyticsSeries{Dimension: dimVal}
			seriesMap[dimVal] = series
			order = append(order, dimVal)
		}
		if hasSecondary {
			appendBreakdownPoint(series, bucket, subDimVal, value)
			series.Total += value
			grandTotal += value
			continue
		}
		series.Data = append(series.Data, DataPoint{
			Date:  bucket.Format("2006-01-02"),
			Value: value,
		})
		series.Total += value
		grandTotal += value
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("subagent analytics rows: %w", err)
	}

	series := make([]AnalyticsSeries, 0, len(order))
	for _, d := range order {
		series = append(series, *seriesMap[d])
	}

	// Period-over-period grand total — same query shape, different
	// window. AVG / SUM aggregate behaves correctly under empty
	// windows (returns NULL for AVG, 0 for SUM via COALESCE-at-
	// scan-site if needed; here we just take whatever Postgres
	// returns and treat NULL as 0).
	//nolint:gosec
	prevSQL := subagentRecursiveCTE + fmt.Sprintf(`
		SELECT COALESCE(%s(%s), 0)
		FROM sessions s
		LEFT JOIN subtree_tokens st ON st.root_id = s.session_id
		WHERE s.started_at >= $1 AND s.started_at < $2 %s
	`, aggregate, selectExpr, filterSQL)

	prevArgs := append([]any{prevStart, start}, filterArgs[2:]...)
	var prevTotal float64
	_ = s.pool.QueryRow(ctx, prevSQL, prevArgs...).Scan(&prevTotal)

	var changePct float64
	if prevTotal > 0 {
		changePct = ((grandTotal - prevTotal) / prevTotal) * 100
	}

	return &AnalyticsResponse{
		Metric:      params.Metric,
		GroupBy:     groupByWireValue(params),
		Range:       params.Range,
		Granularity: params.Granularity,
		Series:      series,
		Totals: AnalyticsTotals{
			GrandTotal:      grandTotal,
			PeriodChangePct: changePct,
		},
	}, nil
}
