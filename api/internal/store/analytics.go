// Package store -- analytics.go contains all analytics GROUP BY queries.
// SQL lives only in this file and postgres.go per rule 35.
package store

import (
	"context"
	"fmt"
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
type AnalyticsResponse struct {
	Metric      string            `json:"metric"`
	GroupBy     string            `json:"group_by"`
	Range       string            `json:"range"`
	Granularity string            `json:"granularity"`
	Series      []AnalyticsSeries `json:"series"`
	Totals      AnalyticsTotals   `json:"totals"`
}

// validGroupByColumns is a whitelist of columns safe to use in GROUP BY.
// Never interpolate user input directly -- select from this map.
var validGroupByColumns = map[string]string{
	"flavor":     "flavor",
	"model":      "model",
	"framework":  "framework",
	"host":       "host",
	"agent_type": "agent_type",
	"team":       "flavor", // team maps to flavor until team field is added
}

// timeRange calculates the start and end times for a range string.
func timeRange(rangeStr string, from, to time.Time) (time.Time, time.Time) {
	now := time.Now().UTC()
	switch rangeStr {
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
	col, ok := validGroupByColumns[params.GroupBy]
	if !ok {
		return nil, fmt.Errorf("invalid group_by: %s", params.GroupBy)
	}

	start, end := timeRange(params.Range, params.From, params.To)
	prevStart := start.Add(-(end.Sub(start)))

	// Build query based on metric
	var table, agg, timeCol, whereClause string
	switch params.Metric {
	case "tokens":
		table = "events"
		agg = "COALESCE(SUM(tokens_total), 0)"
		timeCol = "occurred_at"
		whereClause = "event_type = 'post_call'"
	case "sessions":
		table = "sessions"
		agg = "COUNT(DISTINCT session_id)"
		timeCol = "started_at"
		whereClause = "1=1"
	case "latency_avg":
		table = "events"
		agg = "COALESCE(AVG(latency_ms), 0)"
		timeCol = "occurred_at"
		whereClause = "event_type = 'post_call'"
	case "policy_events":
		table = "events"
		agg = "COUNT(*)"
		timeCol = "occurred_at"
		whereClause = "event_type IN ('policy_warn', 'policy_block', 'policy_degrade')"
	default:
		return nil, fmt.Errorf("invalid metric: %s", params.Metric)
	}

	// Add filters
	filterArgs := []any{start, end}
	argIdx := 3

	filterSQL := ""
	if params.FilterFlavor != "" {
		filterSQL += fmt.Sprintf(" AND flavor = $%d", argIdx)
		filterArgs = append(filterArgs, params.FilterFlavor)
		argIdx++
	}
	if params.FilterModel != "" && table == "events" {
		filterSQL += fmt.Sprintf(" AND model = $%d", argIdx)
		filterArgs = append(filterArgs, params.FilterModel)
		argIdx++
	}
	if params.FilterAgentType != "" {
		filterSQL += fmt.Sprintf(" AND agent_type = $%d", argIdx)
		filterArgs = append(filterArgs, params.FilterAgentType)
	}

	// Query time series data grouped by dimension and date
	//nolint:gosec // col is from a validated whitelist, not user input
	seriesSQL := fmt.Sprintf(`
		SELECT COALESCE(%s, 'unknown') AS dimension,
		       date_trunc('%s', %s)::date AS bucket,
		       %s AS value
		FROM %s
		WHERE %s AND %s >= $1 AND %s < $2 %s
		GROUP BY dimension, bucket
		ORDER BY dimension, bucket
	`, col, params.Granularity, timeCol, agg, table, whereClause, timeCol, timeCol, filterSQL)

	rows, err := s.pool.Query(ctx, seriesSQL, filterArgs...)
	if err != nil {
		return nil, fmt.Errorf("analytics query: %w", err)
	}
	defer rows.Close()

	// Build series map
	seriesMap := make(map[string]*AnalyticsSeries)
	var order []string
	var grandTotal float64

	for rows.Next() {
		var dim string
		var bucket time.Time
		var value float64
		if err := rows.Scan(&dim, &bucket, &value); err != nil {
			return nil, fmt.Errorf("analytics scan: %w", err)
		}

		s, ok := seriesMap[dim]
		if !ok {
			s = &AnalyticsSeries{Dimension: dim}
			seriesMap[dim] = s
			order = append(order, dim)
		}
		s.Data = append(s.Data, DataPoint{
			Date:  bucket.Format("2006-01-02"),
			Value: value,
		})
		s.Total += value
		grandTotal += value
	}

	series := make([]AnalyticsSeries, 0, len(order))
	for _, dim := range order {
		series = append(series, *seriesMap[dim])
	}

	// Calculate period change percentage
	var prevTotal float64
	//nolint:gosec // col is from validated whitelist
	prevSQL := fmt.Sprintf(`
		SELECT COALESCE(%s, 0) FROM (
			SELECT %s AS val FROM %s
			WHERE %s AND %s >= $1 AND %s < $2 %s
		) sub
	`, agg, agg, table, whereClause, timeCol, timeCol, filterSQL)

	prevArgs := append([]any{prevStart, start}, filterArgs[2:]...)
	_ = s.pool.QueryRow(ctx, prevSQL, prevArgs...).Scan(&prevTotal)

	var changePct float64
	if prevTotal > 0 {
		changePct = ((grandTotal - prevTotal) / prevTotal) * 100
	}

	return &AnalyticsResponse{
		Metric:      params.Metric,
		GroupBy:     params.GroupBy,
		Range:       params.Range,
		Granularity: params.Granularity,
		Series:      series,
		Totals: AnalyticsTotals{
			GrandTotal:      grandTotal,
			PeriodChangePct: changePct,
		},
	}, nil
}
