package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// FleetHandler handles GET /v1/fleet.
// Returns all sessions grouped by flavor, excluding lost sessions.
func FleetHandler(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flavors, err := s.GetFleet(r.Context())
		if err != nil {
			slog.Error("get fleet error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"flavors": flavors,
		})
	}
}
