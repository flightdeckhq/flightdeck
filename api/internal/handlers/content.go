package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// ContentHandler handles GET /v1/events/:id/content.
// Returns 404 when event doesn't exist or has_content=false (rule 36).
//
// @Summary      Get event content
// @Description  Returns prompt capture content for an event. Returns 404 when the event does not exist or capture was not enabled.
// @Tags         events
// @Produce      json
// @Param        id   path      string  true  "Event UUID"
// @Success      200  {object}  store.EventContent
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/events/{id}/content [get]
func ContentHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Extract event ID from path: /v1/events/{id}/content
		path := strings.TrimPrefix(r.URL.Path, "/v1/events/")
		id := strings.TrimSuffix(path, "/content")
		if id == "" || id == path {
			writeError(w, http.StatusBadRequest, "event id is required")
			return
		}

		content, err := s.GetEventContent(r.Context(), id)
		if err != nil {
			slog.Error("get event content error", "id", id, "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		if content == nil {
			writeError(w, http.StatusNotFound, "content not found")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(content)
	}
}
