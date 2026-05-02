package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

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
	// D126 § 6.4 — sub-agent metrics. Operate over the
	// parent / child relationship; dispatched to a dedicated query
	// path inside store.QueryAnalytics. Vocabulary mirrors
	// CLAUDE.md Rule 26's locked metric list.
	"parent_token_sum":                 true,
	"child_token_sum":                  true,
	"child_count":                      true,
	"parent_to_first_child_latency_ms": true,
}

var validGroupBy = map[string]bool{
	"flavor": true, "model": true, "framework": true, "host": true,
	"agent_type": true, "team": true, "provider": true,
	// D126 § 6.4 — agent_role dimension. Buckets sessions by the
	// framework-supplied role string. Vocabulary mirrors CLAUDE.md
	// Rule 25's locked dimension list.
	"agent_role": true,
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
// @Param        metric           query  string  false  "Metric: tokens, sessions, latency_avg, latency_p50, latency_p95, policy_events, estimated_cost, parent_token_sum, child_token_sum, child_count, parent_to_first_child_latency_ms (default: tokens). The four sub-agent metrics (D126) operate over the parent / child relationship via recursive CTE on parent_session_id."
// @Param        group_by         query  string  false  "Dimension: flavor, model, framework, host, agent_type, team, provider, agent_role (default: flavor). agent_role (D126) groups by the framework-supplied sub-agent role string; null buckets as 'unknown'."
// @Param        range            query  string  false  "Time range: today, 7d, 30d, 90d, custom (default: 30d)"
// @Param        from             query  string  false  "Start time ISO 8601 (required when range=custom)"
// @Param        to               query  string  false  "End time ISO 8601 (required when range=custom)"
// @Param        granularity      query  string  false  "Granularity: hour, day, week (default: day)"
// @Param        filter_flavor    query  string  false  "Filter to specific flavor"
// @Param        filter_model     query  string  false  "Filter to specific model"
// @Param        filter_agent_type query string  false  "Filter to specific agent_type"
// @Param        filter_provider  query  string  false  "Filter to specific provider (anthropic, openai, google, xai, mistral, meta, other)"
// @Param        filter_parent_session_id query string false "D126: filter analytics scope to children of one specific parent session (UUID)."
// @Param        filter_has_sub_agents    query bool   false "D126: when true, restrict to parent sessions only (those referenced as a parent_session_id by at least one other session)."
// @Param        filter_is_sub_agent      query bool   false "D126: when true, restrict to child sessions only (parent_session_id IS NOT NULL)."
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
			writeError(w, http.StatusBadRequest, "invalid metric: must be one of tokens, sessions, latency_avg, latency_p50, latency_p95, policy_events, estimated_cost, parent_token_sum, child_token_sum, child_count, parent_to_first_child_latency_ms")
			return
		}

		groupBy := q.Get("group_by")
		if groupBy == "" {
			groupBy = "flavor"
		}
		if !validGroupBy[groupBy] {
			writeError(w, http.StatusBadRequest, "invalid group_by: must be one of flavor, model, framework, host, agent_type, team, provider, agent_role")
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
			// D126 § 6.4 — sub-agent observability filters. Bool
			// parsing reuses the lenient parseBoolQuery helper from
			// sessions_list.go (true / 1 / yes case-insensitive).
			FilterParentSessionID: strings.TrimSpace(q.Get("filter_parent_session_id")),
			FilterHasSubAgents:    parseBoolQuery(q.Get("filter_has_sub_agents")),
			FilterIsSubAgent:      parseBoolQuery(q.Get("filter_is_sub_agent")),
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
