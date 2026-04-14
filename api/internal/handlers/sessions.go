package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// SessionResponse is the response body for GET /v1/sessions/{id}.
//
// Attachments is the full history of re-attachments recorded for this
// session (one row per session_start arrival whose session_id matched
// an existing row). It excludes the initial session_start that
// created the row. Empty when the session has only ever run once;
// carries one entry per re-execution for orchestrator-driven agents
// that reuse a stable session_id. See DECISIONS.md D094.
type SessionResponse struct {
	Session     *store.Session `json:"session"`
	Events      []store.Event  `json:"events"`
	Attachments []time.Time    `json:"attachments"`
}

// SessionsHandler handles GET /v1/sessions/{id}.
//
// @Summary      Get session detail
// @Description  Returns session metadata (including effective policy thresholds) and all events in chronological order
// @Tags         sessions
// @Produce      json
// @Param        id   path      string  true  "Session UUID"
// @Success      200  {object}  SessionResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/sessions/{id} [get]
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

		// Attachments failure is non-fatal: the session + events are
		// load-bearing for the drawer; the attachment list only adds
		// run separators. Log and continue with an empty slice so a
		// transient DB hiccup doesn't black out the whole drawer.
		attachments, attErr := s.GetSessionAttachments(r.Context(), id)
		if attErr != nil {
			slog.Warn("get session attachments error", "id", id, "err", attErr)
			attachments = nil
		}
		if attachments == nil {
			attachments = []time.Time{}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(SessionResponse{
			Session:     session,
			Events:      events,
			Attachments: attachments,
		})
	}
}
