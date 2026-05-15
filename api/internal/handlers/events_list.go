package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

const (
	eventsDefaultLimit = 500
	eventsMaxLimit     = 2000
	// eventsMaxOffset caps deep pagination. Postgres must scan and
	// discard every row before the offset on each request, so an
	// unbounded offset (e.g. 2^31) turns every request into a
	// full-table scan — a cheap authenticated DoS. 100_000 is far
	// past any realistic page depth for the /events table.
	eventsMaxOffset = 100_000
	// eventsMaxFilterValues caps how many values a single repeatable
	// filter (event_type, model, …) may carry, so a caller cannot
	// post thousands of repeated params into one ANY($N::text[])
	// array. The URL-length limit is otherwise the only bound.
	eventsMaxFilterValues = 100
)

// EventsListHandler handles GET /v1/events.
//
// @Summary      List events with filters
// @Description  Returns events matching time range, flavor, event type, session, agent, model, framework, and event-payload facet filters with pagination. Multi-value filters OR within a dimension and AND across dimensions. Supports an optional “before“ keyset cursor and “order“ direction for newest-first drawer pagination. When “facets=true“ the response is an EventFacets object of per-dimension chip counts computed over the same filter set instead of the paginated event list.
// @Tags         events
// @Produce      json
// @Param        from                     query  string  true   "Start time (ISO 8601)"
// @Param        to                       query  string  false  "End time (ISO 8601, defaults to now)"
// @Param        flavor                   query  string  false  "Filter by flavor"
// @Param        event_type               query  []string false "Filter by event type (repeatable; OR within)"
// @Param        session_id               query  string  false  "Filter by session ID"
// @Param        agent_id                 query  string  false  "Filter to every event across all of one agent's runs (UUID; resolved via a sessions subquery)"
// @Param        model                    query  []string false "Filter by model (repeatable)"
// @Param        framework                query  []string false "Filter by framework — bare name or versioned context entry (repeatable; resolved via a sessions subquery)"
// @Param        error_type               query  []string false "Filter by payload error type (repeatable)"
// @Param        close_reason             query  []string false "Filter by session_end close reason (repeatable)"
// @Param        estimated_via            query  []string false "Filter by token-estimation method (repeatable)"
// @Param        matched_entry_id         query  []string false "Filter by MCP-policy matched entry id (repeatable)"
// @Param        originating_call_context query  []string false "Filter by originating call context (repeatable)"
// @Param        mcp_server               query  []string false "Filter by MCP server name from an MCP event's payload (repeatable)"
// @Param        terminal                 query  bool    false  "Filter to events whose payload terminal flag matches"
// @Param        facets                   query  bool    false  "When true, return per-dimension facet counts instead of the event list"
// @Param        before                   query  string  false  "Keyset cursor (ISO 8601). When set, only rows with occurred_at < before are returned. Pair with order=desc for newest-first drawer pagination."
// @Param        order                    query  string  false  "Sort order: asc (default) or desc"
// @Param        limit                    query  int     false  "Max results (default 500, max 2000)"
// @Param        offset                   query  int     false  "Offset for pagination (default 0, max 100000)"
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
				writeError(w, http.StatusBadRequest, fmt.Sprintf(
					"limit exceeds maximum of %d", eventsMaxLimit))
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
			if parsed > eventsMaxOffset {
				writeError(w, http.StatusBadRequest, fmt.Sprintf(
					"offset exceeds maximum of %d", eventsMaxOffset))
				return
			}
			offset = parsed
		}

		// Parse optional ``before`` keyset cursor. Same RFC3339 shape
		// as from/to so the handler stays internally consistent.
		var before time.Time
		if beforeStr := q.Get("before"); beforeStr != "" {
			parsed, err := time.Parse(time.RFC3339, beforeStr)
			if err != nil {
				writeError(w, http.StatusBadRequest, "before must be ISO 8601 format")
				return
			}
			before = parsed
		}

		// Parse optional ``order`` direction. Default ASC preserves the
		// pre-pagination shape for existing callers.
		order := q.Get("order")
		if order != "" && order != "asc" && order != "desc" {
			writeError(w, http.StatusBadRequest, "order must be asc or desc")
			return
		}

		// Parse optional ``agent_id`` filter. Validated against the
		// shared UUID shape so a malformed value returns a clean 400
		// rather than a Postgres cast error wrapped in a 500.
		agentID := strings.TrimSpace(q.Get("agent_id"))
		if agentID != "" && !uuidRE.MatchString(agentID) {
			writeError(w, http.StatusBadRequest, "agent_id must be a UUID")
			return
		}

		// Parse optional ``terminal`` boolean facet filter.
		var terminal *bool
		if t := q.Get("terminal"); t != "" {
			switch t {
			case "true":
				v := true
				terminal = &v
			case "false":
				v := false
				terminal = &v
			default:
				writeError(w, http.StatusBadRequest, "terminal must be true or false")
				return
			}
		}

		// Cap repeatable-filter cardinality (see eventsMaxFilterValues).
		for name, vals := range map[string][]string{
			"event_type":               q["event_type"],
			"model":                    q["model"],
			"framework":                q["framework"],
			"error_type":               q["error_type"],
			"close_reason":             q["close_reason"],
			"estimated_via":            q["estimated_via"],
			"matched_entry_id":         q["matched_entry_id"],
			"originating_call_context": q["originating_call_context"],
			"mcp_server":               q["mcp_server"],
		} {
			if len(vals) > eventsMaxFilterValues {
				writeError(w, http.StatusBadRequest, fmt.Sprintf(
					"%s accepts at most %d values", name, eventsMaxFilterValues))
				return
			}
		}

		params := store.EventsParams{
			From:                    from,
			To:                      to,
			Flavor:                  q.Get("flavor"),
			EventTypes:              q["event_type"],
			SessionID:               q.Get("session_id"),
			AgentID:                 agentID,
			Models:                  q["model"],
			ErrorTypes:              q["error_type"],
			CloseReasons:            q["close_reason"],
			EstimatedVia:            q["estimated_via"],
			MatchedEntryIDs:         q["matched_entry_id"],
			OriginatingCallContexts: q["originating_call_context"],
			MCPServers:              q["mcp_server"],
			Terminal:                terminal,
			Frameworks:              q["framework"],
			Before:                  before,
			Order:                   order,
			Limit:                   limit,
			Offset:                  offset,
		}

		// Facets mode — return per-dimension chip counts over the same
		// filter set instead of the paginated event list.
		if q.Get("facets") == "true" {
			facets, err := s.GetEventFacets(r.Context(), params)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "internal server error")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(facets)
			return
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
