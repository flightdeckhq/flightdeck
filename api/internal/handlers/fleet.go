package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// FleetResponse is the v0.4.0 Phase 1 agent-level response body for
// GET /v1/fleet. The shape moved from flavor-grouped to agent-level
// per D115; context_facets carries the aggregated runtime-context
// facets used by the dashboard CONTEXT sidebar.
type FleetResponse struct {
	Agents        []store.AgentSummary                 `json:"agents"`
	Total         int                                  `json:"total"`
	Page          int                                  `json:"page"`
	PerPage       int                                  `json:"per_page"`
	ContextFacets map[string][]store.ContextFacetValue `json:"context_facets"`
}

// FleetHandler handles GET /v1/fleet.
//
// @Summary      Get fleet state (agent-level, D115)
// @Description  Returns agents with aggregated state rollup and pagination. Includes runtime context facets aggregated across all non-terminal sessions for the dashboard CONTEXT sidebar.
// @Tags         fleet
// @Produce      json
// @Param        page        query  int     false  "Page number (1-based, default 1)"
// @Param        per_page    query  int     false  "Rows per page (default 50, max 200)"
// @Param        agent_type  query  string  false  "Filter by D114 agent type: 'coding', 'production', or empty for all"
// @Success      200  {object}  FleetResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/fleet [get]
func FleetHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		page := parseIntParam(r, "page", 1)
		perPage := parseIntParam(r, "per_page", 50)
		agentType := r.URL.Query().Get("agent_type")

		if page < 1 {
			page = 1
		}
		if perPage < 1 {
			perPage = 1
		}
		if perPage > 200 {
			perPage = 200
		}
		offset := (page - 1) * perPage

		agents, totalCount, err := s.GetAgentFleet(r.Context(), perPage, offset, agentType)
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
			Agents:        agents,
			Total:         totalCount,
			Page:          page,
			PerPage:       perPage,
			ContextFacets: facets,
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
