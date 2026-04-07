package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// TODO(KI07)[Phase 2]: GET /v1/fleet loads all non-lost
// sessions into memory. No pagination. At 100k sessions
// this is a large response and a full table scan.
// Fix: add pagination (?limit=100&offset=0) and composite
// index on (state, flavor).
// See DECISIONS.md D045.

// FleetHandler handles GET /v1/fleet.
func FleetHandler(s store.Querier) http.HandlerFunc {
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
