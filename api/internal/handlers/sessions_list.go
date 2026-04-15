package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

const (
	sessionsDefaultLimit = 25
	sessionsMaxLimit     = 100
)

// validSessionStates is the whitelist for the state filter.
var validSessionStates = map[string]bool{
	"active": true,
	"idle":   true,
	"stale":  true,
	"closed": true,
	"lost":   true,
}

// validSessionSorts is the whitelist for the sort parameter.
var validSessionSorts = map[string]bool{
	"started_at": true,
	"duration":   true,
	"tokens_used": true,
	"flavor":     true,
}

// SessionsListHandler handles GET /v1/sessions.
//
// @Summary      List sessions with filters, search, and pagination
// @Description  Returns sessions matching time range, state, flavor, model, and search filters with pagination and sort support.
// @Tags         sessions
// @Produce      json
// @Param        q       query     string  false  "Full-text search across flavor, host, model, hostname, os, git_branch"
// @Param        from    query     string  false  "Start time (ISO 8601, default: 7 days ago)"
// @Param        to      query     string  false  "End time (ISO 8601, default: now)"
// @Param        state   query     string  false  "Filter by state (repeatable: active, idle, stale, closed, lost)"
// @Param        flavor  query     string  false  "Filter by flavor (repeatable)"
// @Param        framework query   string  false  "Filter by framework name/version matching sessions.context.frameworks[] (repeatable: langgraph/1.1.6, crewai/1.14.1, ...)"
// @Param        model   query     string  false  "Filter by model"
// @Param        sort    query     string  false  "Sort field: started_at, duration, tokens_used, flavor (default: started_at)"
// @Param        order   query     string  false  "Sort order: asc, desc (default: desc)"
// @Param        limit   query     int     false  "Max results (default 25, max 100)"
// @Param        offset  query     int     false  "Offset for pagination (default 0)"
// @Success      200  {object}  store.SessionsResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/sessions [get]
func SessionsListHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()

		// Parse time range (defaults to last 7 days)
		now := time.Now().UTC()
		from := now.AddDate(0, 0, -7)
		to := now

		if fromStr := q.Get("from"); fromStr != "" {
			parsed, err := time.Parse(time.RFC3339, fromStr)
			if err != nil {
				writeError(w, http.StatusBadRequest, "from must be ISO 8601 format")
				return
			}
			from = parsed
		}
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

		// Parse state filter (repeatable)
		var states []string
		for _, s := range q["state"] {
			for _, v := range strings.Split(s, ",") {
				v = strings.TrimSpace(v)
				if v != "" {
					if !validSessionStates[v] {
						writeError(w, http.StatusBadRequest, "invalid state: "+v)
						return
					}
					states = append(states, v)
				}
			}
		}

		// Parse flavor filter (repeatable)
		var flavors []string
		for _, f := range q["flavor"] {
			for _, v := range strings.Split(f, ",") {
				v = strings.TrimSpace(v)
				if v != "" {
					flavors = append(flavors, v)
				}
			}
		}

		// Parse framework filter (repeatable). Values are the full
		// name/version strings emitted by the sensor's
		// FrameworkClassifier (e.g. "langgraph/1.1.6"). We do NOT
		// validate against a known set -- a typo here just yields an
		// empty result, same as any other filter.
		var frameworks []string
		for _, f := range q["framework"] {
			for _, v := range strings.Split(f, ",") {
				v = strings.TrimSpace(v)
				if v != "" {
					frameworks = append(frameworks, v)
				}
			}
		}

		// Sort validation
		sort := q.Get("sort")
		if sort == "" {
			sort = "started_at"
		}
		if !validSessionSorts[sort] {
			writeError(w, http.StatusBadRequest, "invalid sort: "+sort+". Allowed: started_at, duration, tokens_used, flavor")
			return
		}

		order := q.Get("order")
		if order == "" {
			order = "desc"
		}
		if order != "asc" && order != "desc" {
			writeError(w, http.StatusBadRequest, "order must be asc or desc")
			return
		}

		// Parse limit
		limit := sessionsDefaultLimit
		if limitStr := q.Get("limit"); limitStr != "" {
			parsed, err := strconv.Atoi(limitStr)
			if err != nil || parsed < 1 {
				writeError(w, http.StatusBadRequest, "limit must be a positive integer")
				return
			}
			if parsed > sessionsMaxLimit {
				writeError(w, http.StatusBadRequest, "limit exceeds maximum of 100")
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

		// Search query
		search := q.Get("q")

		params := store.SessionsParams{
			From:    from,
			To:      to,
			Query:   search,
			States:     states,
			Flavors:    flavors,
			Frameworks: frameworks,
			Model:      q.Get("model"),
			Sort:    sort,
			Order:   order,
			Limit:   limit,
			Offset:  offset,
		}

		result, err := s.GetSessions(r.Context(), params)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	}
}
