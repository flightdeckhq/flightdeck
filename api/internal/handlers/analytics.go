package handlers

import (
	"log/slog"
	"net/http"
	"time"

	"encoding/json"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

var validMetrics = map[string]bool{
	"tokens":         true,
	"sessions":       true,
	"latency_avg":    true,
	"latency_p50":    true,
	"latency_p95":    true,
	"policy_events":  true,
	"estimated_cost": true,
}

var validGroupBy = map[string]bool{
	"flavor": true, "model": true, "framework": true, "host": true,
	"agent_type": true, "team": true, "provider": true,
}

var validRanges = map[string]bool{
	"today": true, "7d": true, "30d": true, "90d": true, "custom": true,
}

var validGranularities = map[string]bool{
	"hour": true, "day": true, "week": true,
}

// AnalyticsHandler handles GET /v1/analytics.
//
// @Summary      Query analytics
// @Description  Flexible GROUP BY analytics endpoint. Returns time series data grouped by dimension.
// @Tags         analytics
// @Produce      json
// @Param        metric           query  string  false  "Metric: tokens, sessions, latency_avg, latency_p50, latency_p95, policy_events, estimated_cost (default: tokens)"
// @Param        group_by         query  string  false  "Dimension: flavor, model, framework, host, agent_type, team, provider (default: flavor)"
// @Param        range            query  string  false  "Time range: today, 7d, 30d, 90d, custom (default: 30d)"
// @Param        from             query  string  false  "Start time ISO 8601 (required when range=custom)"
// @Param        to               query  string  false  "End time ISO 8601 (required when range=custom)"
// @Param        granularity      query  string  false  "Granularity: hour, day, week (default: day)"
// @Param        filter_flavor    query  string  false  "Filter to specific flavor"
// @Param        filter_model     query  string  false  "Filter to specific model"
// @Param        filter_agent_type query string  false  "Filter to specific agent_type"
// @Param        filter_provider  query  string  false  "Filter to specific provider (anthropic, openai, google, xai, mistral, meta, other)"
// @Success      200  {object}  store.AnalyticsResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/analytics [get]
func AnalyticsHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()

		metric := q.Get("metric")
		if metric == "" {
			metric = "tokens"
		}
		if !validMetrics[metric] {
			writeError(w, http.StatusBadRequest, "invalid metric: must be one of tokens, sessions, latency_avg, latency_p50, latency_p95, policy_events, estimated_cost")
			return
		}

		groupBy := q.Get("group_by")
		if groupBy == "" {
			groupBy = "flavor"
		}
		if !validGroupBy[groupBy] {
			writeError(w, http.StatusBadRequest, "invalid group_by: must be one of flavor, model, framework, host, agent_type, team, provider")
			return
		}

		rangeParam := q.Get("range")
		if rangeParam == "" {
			rangeParam = "30d"
		}
		if !validRanges[rangeParam] {
			writeError(w, http.StatusBadRequest, "invalid range: must be one of today, 7d, 30d, 90d, custom")
			return
		}

		granularity := q.Get("granularity")
		if granularity == "" {
			granularity = "day"
		}
		if !validGranularities[granularity] {
			writeError(w, http.StatusBadRequest, "invalid granularity: must be one of hour, day, week")
			return
		}

		var from, to time.Time
		if rangeParam == "custom" {
			var err error
			fromStr := q.Get("from")
			toStr := q.Get("to")
			if fromStr == "" || toStr == "" {
				writeError(w, http.StatusBadRequest, "from and to are required when range=custom")
				return
			}
			from, err = time.Parse(time.RFC3339, fromStr)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid from: must be ISO 8601")
				return
			}
			to, err = time.Parse(time.RFC3339, toStr)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid to: must be ISO 8601")
				return
			}
		}

		params := store.AnalyticsParams{
			Metric:          metric,
			GroupBy:         groupBy,
			Range:           rangeParam,
			From:            from,
			To:              to,
			Granularity:     granularity,
			FilterFlavor:    q.Get("filter_flavor"),
			FilterModel:     q.Get("filter_model"),
			FilterAgentType: q.Get("filter_agent_type"),
			FilterProvider:  q.Get("filter_provider"),
		}

		result, err := s.QueryAnalytics(r.Context(), params)
		if err != nil {
			slog.Error("analytics query error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	}
}
