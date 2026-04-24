package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// uuidRE matches the standard 36-char RFC-4122 hyphenated form the
// agents.agent_id column is populated with. The handler validates the
// path param against this before reaching the store so a malformed
// client-side value returns a clean 400 rather than a Postgres cast
// error wrapped in a 500. The store's ``$1::uuid`` cast stays as a
// belt-and-braces defence.
var uuidRE = regexp.MustCompile(
	`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`,
)

const (
	agentsDefaultLimit = 25
	agentsMaxLimit     = 100
)

// validAgentTypes is the D114 vocabulary whitelist for the
// ``agent_type`` filter. Matches the CHECK constraint on the agents
// table (``000015_agent_identity_model.up.sql``). Unknown values
// return 400 rather than quietly matching nothing, because the
// alternative — silent "no results" — hides client bugs and blocks
// operators from distinguishing "no data" from "I typed the wrong
// value".
var validAgentTypes = map[string]bool{
	"coding":     true,
	"production": true,
}

// validClientTypes mirrors the agents.client_type CHECK constraint.
var validClientTypes = map[string]bool{
	"claude_code":        true,
	"flightdeck_sensor":  true,
}

// validAgentStates is the rollup-state vocabulary. Mirrors the
// sessions.state values the state reconciler computes via LATERAL.
var validAgentStates = map[string]bool{
	"active": true,
	"idle":   true,
	"stale":  true,
	"closed": true,
	"lost":   true,
}

// validAgentSorts lists the handler-level allowed sort columns. The
// store carries the authoritative mapping in
// ``store.AllowedAgentSortColumns``; this set exists here so the
// handler can emit a helpful 400 with the allowed names instead of
// delegating the error shape to the store.
var validAgentSorts = map[string]bool{
	"last_seen_at":   true,
	"first_seen_at":  true,
	"agent_name":     true,
	"total_sessions": true,
	"total_tokens":   true,
	"state":          true,
	"user":           true,
	"hostname":       true,
}

// AgentsListHandler handles GET /v1/agents.
//
// @Summary      List agents with filters, search, sort, and pagination
// @Description  Returns agents matching the supplied filters. Multi-value filters (state, agent_type, client_type, hostname, user, os, orchestration) accept comma-separated values and repeated query params; values within a dimension are OR, values across dimensions are AND. ``search`` is a case-insensitive substring match against ``agent_name`` and ``hostname``. ``updated_since`` filters on ``last_seen_at >= ts``. State is computed via LATERAL subquery against the most-recent session. Pagination defaults to 25/page, max 100.
// @Tags         agents
// @Produce      json
// @Param        agent_type      query     string  false  "Filter by agent_type (repeatable/comma: coding, production)"
// @Param        client_type     query     string  false  "Filter by client_type (repeatable/comma: claude_code, flightdeck_sensor)"
// @Param        state           query     string  false  "Filter by rollup state (repeatable/comma: active, idle, stale, closed, lost)"
// @Param        hostname        query     string  false  "Filter by hostname (repeatable/comma, exact match)"
// @Param        user            query     string  false  "Filter by user_name (repeatable/comma, exact match)"
// @Param        os              query     string  false  "Filter by sessions.context.os (EXISTS subquery; matches if ANY session had the OS)"
// @Param        orchestration   query     string  false  "Filter by sessions.context.orchestration (EXISTS subquery)"
// @Param        search          query     string  false  "Case-insensitive substring search on agent_name + hostname"
// @Param        updated_since   query     string  false  "Filter to agents whose last_seen_at >= this ISO-8601 timestamp"
// @Param        sort            query     string  false  "Sort column (default: last_seen_at). One of: last_seen_at, first_seen_at, agent_name, total_sessions, total_tokens, state, user, hostname"
// @Param        order           query     string  false  "asc or desc (default: desc)"
// @Param        limit           query     int     false  "Max results (default 25, max 100)"
// @Param        offset          query     int     false  "Offset for pagination (default 0)"
// @Success      200  {object}  store.AgentListResponse
// @Failure      400  {object}  ErrorResponse  "Invalid filter value, sort column, order direction, or limit over 100"
// @Failure      401  {object}  ErrorResponse  "Missing or invalid bearer token"
// @Failure      500  {object}  ErrorResponse  "Database error"
// @Router       /v1/agents [get]
func AgentsListHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()

		// Multi-value parse helper. Accepts both ``key=a,b`` and
		// ``key=a&key=b``; empty values are dropped. Matches the
		// pattern the existing /v1/sessions handler uses.
		parseMulti := func(key string) []string {
			var out []string
			for _, raw := range q[key] {
				for _, v := range strings.Split(raw, ",") {
					v = strings.TrimSpace(v)
					if v != "" {
						out = append(out, v)
					}
				}
			}
			return out
		}

		agentTypes := parseMulti("agent_type")
		for _, v := range agentTypes {
			if !validAgentTypes[v] {
				writeError(w, http.StatusBadRequest,
					"invalid agent_type: "+v+". Allowed: coding, production")
				return
			}
		}

		clientTypes := parseMulti("client_type")
		for _, v := range clientTypes {
			if !validClientTypes[v] {
				writeError(w, http.StatusBadRequest,
					"invalid client_type: "+v+". Allowed: claude_code, flightdeck_sensor")
				return
			}
		}

		states := parseMulti("state")
		for _, v := range states {
			if !validAgentStates[v] {
				writeError(w, http.StatusBadRequest,
					"invalid state: "+v+". Allowed: active, idle, stale, closed, lost")
				return
			}
		}

		hostnames := parseMulti("hostname")
		users := parseMulti("user")
		oses := parseMulti("os")
		orchestrations := parseMulti("orchestration")
		search := strings.TrimSpace(q.Get("search"))

		var updatedSince *time.Time
		if raw := q.Get("updated_since"); raw != "" {
			parsed, err := time.Parse(time.RFC3339, raw)
			if err != nil {
				writeError(w, http.StatusBadRequest,
					"updated_since must be ISO 8601 format")
				return
			}
			updatedSince = &parsed
		}

		sort := q.Get("sort")
		if sort == "" {
			sort = "last_seen_at"
		}
		if !validAgentSorts[sort] {
			writeError(w, http.StatusBadRequest,
				"invalid sort: "+sort+
					". Allowed: last_seen_at, first_seen_at, agent_name, "+
					"total_sessions, total_tokens, state, user, hostname")
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

		limit := agentsDefaultLimit
		if limitStr := q.Get("limit"); limitStr != "" {
			parsed, err := strconv.Atoi(limitStr)
			if err != nil || parsed < 1 {
				writeError(w, http.StatusBadRequest,
					"limit must be a positive integer")
				return
			}
			if parsed > agentsMaxLimit {
				writeError(w, http.StatusBadRequest,
					"limit exceeds maximum of 100")
				return
			}
			limit = parsed
		}

		offset := 0
		if offsetStr := q.Get("offset"); offsetStr != "" {
			parsed, err := strconv.Atoi(offsetStr)
			if err != nil || parsed < 0 {
				writeError(w, http.StatusBadRequest,
					"offset must be a non-negative integer")
				return
			}
			offset = parsed
		}

		result, err := s.ListAgents(r.Context(), store.AgentListParams{
			AgentType:     agentTypes,
			ClientType:    clientTypes,
			State:         states,
			Hostname:      hostnames,
			UserName:      users,
			OS:            oses,
			Orchestration: orchestrations,
			Search:        search,
			UpdatedSince:  updatedSince,
			Sort:          sort,
			Order:         order,
			Limit:         limit,
			Offset:        offset,
		})
		if err != nil {
			slog.Error("list agents error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	}
}

// AgentByIDHandler handles GET /v1/agents/{agent_id}.
//
// @Summary      Get agent detail by id
// @Description  Returns the full AgentSummary for a single agent including rollup counters and the LATERAL-computed rollup state. Powers the Investigate chip agent-name resolver so the UI no longer has to fall back to a UUID prefix when the filtered sessions list is empty.
// @Tags         agents
// @Produce      json
// @Param        agent_id  path      string  true  "Agent UUID"
// @Success      200  {object}  store.AgentSummary
// @Failure      400  {object}  ErrorResponse  "Invalid UUID format"
// @Failure      401  {object}  ErrorResponse  "Missing or invalid bearer token"
// @Failure      404  {object}  ErrorResponse  "Agent not found"
// @Failure      500  {object}  ErrorResponse  "Database error"
// @Router       /v1/agents/{agent_id} [get]
func AgentByIDHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/v1/agents/")
		id = strings.TrimSuffix(id, "/")
		if id == "" {
			writeError(w, http.StatusBadRequest, "agent_id is required")
			return
		}
		if !uuidRE.MatchString(id) {
			writeError(w, http.StatusBadRequest, "agent_id must be a UUID")
			return
		}

		agent, err := s.GetAgentByID(r.Context(), id)
		if err != nil {
			slog.Error("get agent by id error", "id", id, "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		if agent == nil {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(agent)
	}
}
