package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// FleetResponse is the response body for GET /v1/fleet.
type FleetResponse struct {
	Flavors           []store.FlavorSummary                  `json:"flavors"`
	TotalSessionCount int                                    `json:"total_session_count"`
	ContextFacets     map[string][]store.ContextFacetValue   `json:"context_facets"`
}

// FleetHandler handles GET /v1/fleet.
//
// @Summary      Get fleet state
// @Description  Returns sessions grouped by flavor, excluding lost sessions. Includes runtime context facets aggregated across all non-terminal sessions for the dashboard CONTEXT sidebar.
// @Tags         fleet
// @Produce      json
// @Param        limit       query  int     false  "Max sessions to return (default 50, max 200)"
// @Param        offset      query  int     false  "Offset into sessions list (default 0)"
// @Param        agent_type  query  string  false  "Filter by agent type: 'developer', 'production', or empty for all"
// @Success      200  {object}  FleetResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/fleet [get]
func FleetHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := parseIntParam(r, "limit", 50)
		offset := parseIntParam(r, "offset", 0)
		agentType := r.URL.Query().Get("agent_type")

		if limit < 1 {
			limit = 1
		}
		if limit > 200 {
			limit = 200
		}
		if offset < 0 {
			offset = 0
		}

		flavors, totalCount, err := s.GetFleet(r.Context(), limit, offset, agentType)
		if err != nil {
			slog.Error("get fleet error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		// Context facets are best-effort. A failure here must NOT
		// fail the fleet request -- log the error and return an
		// empty map so the dashboard can render without the CONTEXT
		// sidebar instead of breaking the whole page.
		facets, facetsErr := s.GetContextFacets(r.Context())
		if facetsErr != nil {
			slog.Warn("get context facets error", "err", facetsErr)
			facets = map[string][]store.ContextFacetValue{}
		}
		if facets == nil {
			facets = map[string][]store.ContextFacetValue{}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(FleetResponse{
			Flavors:           flavors,
			TotalSessionCount: totalCount,
			ContextFacets:     facets,
		})
	}
}

func parseIntParam(r *http.Request, name string, defaultVal int) int {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return defaultVal
	}
	val, err := strconv.Atoi(raw)
	if err != nil {
		return defaultVal
	}
	return val
}
