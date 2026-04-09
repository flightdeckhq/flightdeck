package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

const (
	eventsDefaultLimit = 500
	eventsMaxLimit     = 2000
)

// EventsListHandler handles GET /v1/events.
//
// @Summary      List events with filters
// @Description  Returns events matching time range, flavor, event type, and session filters with pagination.
// @Tags         events
// @Produce      json
// @Param        from        query     string  true   "Start time (ISO 8601)"
// @Param        to          query     string  false  "End time (ISO 8601, defaults to now)"
// @Param        flavor      query     string  false  "Filter by flavor"
// @Param        event_type  query     string  false  "Filter by event type"
// @Param        session_id  query     string  false  "Filter by session ID"
// @Param        limit       query     int     false  "Max results (default 500, max 2000)"
// @Param        offset      query     int     false  "Offset for pagination (default 0)"
// @Success      200  {object}  store.EventsResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/events [get]
func EventsListHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()

		// Parse required "from" param
		fromStr := q.Get("from")
		if fromStr == "" {
			writeError(w, http.StatusBadRequest, "from parameter is required")
			return
		}
		from, err := time.Parse(time.RFC3339, fromStr)
		if err != nil {
			writeError(w, http.StatusBadRequest, "from must be ISO 8601 format")
			return
		}

		// Parse optional "to" param (defaults to now)
		to := time.Now().UTC()
		if toStr := q.Get("to"); toStr != "" {
			parsed, err := time.Parse(time.RFC3339, toStr)
			if err != nil {
				writeError(w, http.StatusBadRequest, "to must be ISO 8601 format")
				return
			}
			to = parsed
		}

		if from.After(to) {
			writeError(w, http.StatusBadRequest, "from must be before to")
			return
		}

		// Parse limit
		limit := eventsDefaultLimit
		if limitStr := q.Get("limit"); limitStr != "" {
			parsed, err := strconv.Atoi(limitStr)
			if err != nil || parsed < 1 {
				writeError(w, http.StatusBadRequest, "limit must be a positive integer")
				return
			}
			if parsed > eventsMaxLimit {
				writeError(w, http.StatusBadRequest, "limit exceeds maximum of 2000")
				return
			}
			limit = parsed
		}

		// Parse offset
		offset := 0
		if offsetStr := q.Get("offset"); offsetStr != "" {
			parsed, err := strconv.Atoi(offsetStr)
			if err != nil || parsed < 0 {
				writeError(w, http.StatusBadRequest, "offset must be a non-negative integer")
				return
			}
			offset = parsed
		}

		params := store.EventsParams{
			From:      from,
			To:        to,
			Flavor:    q.Get("flavor"),
			EventType: q.Get("event_type"),
			SessionID: q.Get("session_id"),
			Limit:     limit,
			Offset:    offset,
		}

		result, err := s.GetEvents(r.Context(), params)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	}
}
