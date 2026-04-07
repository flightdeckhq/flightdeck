package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// EffectivePolicyHandler handles GET /v1/policy.
// Returns the most specific policy for a given flavor/session scope.
//
// @Summary      Get effective policy
// @Description  Returns the most specific policy for a given flavor/session scope. Lookup order: session > flavor > org
// @Tags         policies
// @Produce      json
// @Param        flavor      query  string  false  "Agent flavor"
// @Param        session_id  query  string  false  "Session ID"
// @Success      200  {object}  store.Policy
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/policy [get]
func EffectivePolicyHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flavor := r.URL.Query().Get("flavor")
		sessionID := r.URL.Query().Get("session_id")

		policy, err := s.GetEffectivePolicy(r.Context(), flavor, sessionID)
		if err != nil {
			slog.Error("get effective policy error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		if policy == nil {
			writeError(w, http.StatusNotFound, "no policy found")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(policy)
	}
}
