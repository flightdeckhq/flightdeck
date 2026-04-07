package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// SessionsHandler handles GET /v1/sessions/{id}.
func SessionsHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/v1/sessions/")
		if id == "" {
			writeError(w, http.StatusBadRequest, "session id is required")
			return
		}

		session, err := s.GetSession(r.Context(), id)
		if err != nil {
			slog.Error("get session error", "id", id, "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		if session == nil {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}

		events, err := s.GetSessionEvents(r.Context(), id)
		if err != nil {
			slog.Error("get session events error", "id", id, "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session": session,
			"events":  events,
		})
	}
}
