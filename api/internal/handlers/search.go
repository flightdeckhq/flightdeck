package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// SearchHandler handles GET /v1/search.
//
// @Summary      Cross-entity search
// @Description  Searches agents, sessions, and events by partial match. Returns up to 5 results per group.
// @Tags         search
// @Produce      json
// @Param        q  query  string  true  "Search query (min 1, max 200 characters)"
// @Success      200  {object}  store.SearchResults
// @Failure      400  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/search [get]
func SearchHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("q")
		if q == "" {
			writeError(w, http.StatusBadRequest, "q parameter is required")
			return
		}
		if len(q) > 200 {
			writeError(w, http.StatusBadRequest, "q parameter must not exceed 200 characters")
			return
		}

		results, err := s.Search(r.Context(), q)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(results)
	}
}
