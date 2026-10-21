// MCP Protection Policy metrics handler. Aggregates the
// policy_mcp_warn / policy_mcp_block events the sensor and plugin
// enforcement paths emit, scoped to the policy. Buckets are
// zero-filled across the period, so a policy with no enforcement
// activity returns empty buckets rather than an empty array.

package handlers

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// GetMCPPolicyMetricsHandler handles GET /v1/mcp-policies/{flavor}/metrics.
//
// @Summary      Get MCP policy enforcement metrics
// @Description  Aggregates policy_mcp_warn and policy_mcp_block events emitted by the sensor / plugin enforcement path. Buckets are zero-filled across the period, so a policy with no enforcement activity returns empty buckets. period accepts 24h / 7d / 30d.
// @Tags         mcp-policy
// @Produce      json
// @Param        flavor  path   string  true   "Agent flavor or 'global'"
// @Param        period  query  string  false  "Aggregation window (24h / 7d / 30d); default 24h"
// @Success      200  {object}  store.MCPPolicyMetrics
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/{flavor}/metrics [get]
func GetMCPPolicyMetricsHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, scopeValue := scopeAndValueFromPath(r)
		if scope == "flavor" && scopeValue == "" {
			writeError(w, http.StatusBadRequest, "flavor is required")
			return
		}
		period := r.URL.Query().Get("period")
		if period == "" {
			period = "24h"
		}
		metrics, err := s.GetMCPPolicyMetrics(r.Context(), scope, scopeValue, period)
		if err != nil {
			// store.ErrMCPPolicyInvalidPeriod is the typed sentinel
			// for unknown period values; treat as 400 with the
			// vocabulary list. Pattern mirrors the store's
			// ErrMCPPolicyNotFound / ErrMCPPolicyAlreadyExists
			// sentinels rather than the prior brittle err.Error()
			// string-compare.
			if errors.Is(err, store.ErrMCPPolicyInvalidPeriod) {
				writeError(w, http.StatusBadRequest, "period must be one of: 24h, 7d, 30d")
				return
			}
			slog.Error("mcp policy metrics", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		writeJSON(w, metrics)
	}
}
