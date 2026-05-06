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

// parseBoolQuery interprets a single URL query parameter as boolean.
// Truthy values: ``true``, ``1``, ``yes`` (case-insensitive). Every
// other value (including empty string and unrecognised strings)
// returns false. The lenient shape matches the ``?has_sub_agents=true``
// dashboard URL the Investigate facets emit; the strict shape would
// 400 on every facet-checkbox toggle which is the wrong UX.
func parseBoolQuery(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "true", "1", "yes":
		return true
	}
	return false
}

// validSessionStates is the whitelist for the state filter.
var validSessionStates = map[string]bool{
	"active": true,
	"idle":   true,
	"stale":  true,
	"closed": true,
	"lost":   true,
}

// validSessionSorts is the whitelist for the sort parameter.
// Extended in v0.4.0 phase 2: last_seen_at, model, hostname join the
// original {started_at, duration, tokens_used, flavor} set so the
// Investigate table can sort on the columns users actually scan
// first (recency, model, host). The mapping to SQL expressions lives
// in ``store.allowedSorts``; this set mirrors the keys so the
// handler can emit the 400 with the full allow-list.
var validSessionSorts = map[string]bool{
	"started_at":   true,
	"last_seen_at": true,
	"duration":     true,
	"tokens_used":  true,
	"flavor":       true,
	"model":        true,
	"hostname":     true,
	// state sort uses a custom severity ordinal (S-TBL-2): ascending
	// = active → idle → stale → lost → closed (most-needs-attention
	// first); descending reverses. SQL CASE expression in
	// store.allowedSorts.
	"state": true,
}

// validSessionClientTypes mirrors the sessions.client_type CHECK
// constraint (see migrations/000015_agent_identity_model.up.sql).
var validSessionClientTypes = map[string]bool{
	"claude_code":       true,
	"flightdeck_sensor": true,
}

// validPolicyEventTypes is the closed vocabulary for the
// ?policy_event_type=... filter. Mirrors the sensor's EventType enum
// values (sensor/flightdeck_sensor/core/types.py). A typo lands as
// 400 with the allowed set so callers can self-correct rather than
// silently receiving an empty result.
//
// D131 MCP Protection Policy adds four event types into the
// "policy_event_type" filter family per ARCHITECTURE.md →
// "Adjacent surfaces" so the existing Investigate facet can show
// MCP-policy filtering chips alongside the token-budget policy
// types. The chips render on the same facet column; chroma is
// distinguished by the per-event eventBadgeConfig (amber/red for
// enforcement, purple/info for FYI).
var validPolicyEventTypes = map[string]bool{
	"policy_warn":                true,
	"policy_degrade":             true,
	"policy_block":               true,
	"policy_mcp_warn":            true,
	"policy_mcp_block":           true,
	"mcp_server_name_changed":    true,
	"mcp_policy_user_remembered": true,
}

// SessionsListHandler handles GET /v1/sessions.
//
// @Summary      List sessions with filters, search, and pagination
// @Description  Returns sessions matching time range, state, flavor, client_type, agent_type, model, framework, agent_id, context-scalar (user/os/hostname/git_branch/orchestration/...), and search filters with pagination and sort support. Multi-value filters (state, flavor, client_type, framework, agent_type, context-scalar) accept repeated query params and comma-separated values; values within a dimension are OR, values across dimensions are AND. ``q`` is a case-insensitive substring search across agent_name, flavor, host, model, session_id, context.hostname, context.os, context.git_branch, context.python_version, and the frameworks array.
// @Tags         sessions
// @Produce      json
// @Param        q          query  string  false  "Full-text search across agent_name, flavor, host, model, session_id, context.hostname, context.os, context.git_branch, context.python_version, frameworks"
// @Param        from       query  string  false  "Start time (ISO 8601, default: 7 days ago)"
// @Param        to         query  string  false  "End time (ISO 8601, default: now)"
// @Param        state      query  string  false  "Filter by state (repeatable: active, idle, stale, closed, lost)"
// @Param        flavor     query  string  false  "Filter by flavor (repeatable)"
// @Param        agent_id   query  string  false  "Filter to a single agent (D115 UUID; deep-linked from the Fleet agent table and Investigate AGENT facet)"
// @Param        agent_type query  string  false  "Filter by agent_type (repeatable: coding, production)"
// @Param        client_type query string  false  "Filter by client_type (repeatable: claude_code, flightdeck_sensor)"
// @Param        framework  query  string  false  "Filter by framework name/version matching sessions.context.frameworks[] (repeatable: langgraph/1.1.6, crewai/1.14.1, ...)"
// @Param        model      query  string  false  "Filter by model"
// @Param        user       query  string  false  "Filter by context.user (repeatable)"
// @Param        os         query  string  false  "Filter by context.os (repeatable)"
// @Param        hostname   query  string  false  "Filter by context.hostname (repeatable)"
// @Param        arch       query  string  false  "Filter by context.arch (repeatable)"
// @Param        git_branch query  string  false  "Filter by context.git_branch (repeatable)"
// @Param        git_repo   query  string  false  "Filter by context.git_repo (repeatable)"
// @Param        orchestration query string false "Filter by context.orchestration (repeatable)"
// @Param        error_type query  string  false  "Filter to sessions that emitted an llm_error event of one of the listed taxonomy values (repeatable/comma). 14-entry vocabulary: rate_limit, quota_exceeded, context_overflow, content_filter, invalid_request, authentication, permission, not_found, request_too_large, api_error, overloaded, timeout, stream_error, other."
// @Param        policy_event_type query  string  false  "Filter to sessions that emitted at least one policy enforcement event of the listed types (repeatable/comma). Vocabulary: policy_warn, policy_degrade, policy_block, policy_mcp_warn, policy_mcp_block, mcp_server_name_changed, mcp_policy_user_remembered."
// @Param        mcp_server query  string  false  "Filter to sessions that connected to an MCP server with the given name (repeatable/comma). Phase 5: backed by the JSONB array sessions.context.mcp_servers. Each row in the response carries mcp_server_names[] for facet rendering."
// @Param        parent_session_id query string false "D126: filter to children of one specific parent session (UUID). Used by the SessionDrawer Sub-agents tab to fetch the per-parent child list."
// @Param        agent_role query  string  false  "D126: filter by sub-agent role string (repeatable/comma). CrewAI Agent.role, LangGraph node name, Claude Code Task agent_type. Backs the Investigate ROLE facet."
// @Param        has_sub_agents query bool false "D126: when true, restrict to parent sessions only (those referenced as a parent_session_id by at least one other session). Backs the Investigate TOPOLOGY facet 'Has sub-agents' checkbox."
// @Param        is_sub_agent query bool false "D126: when true, restrict to child sessions only (parent_session_id IS NOT NULL). Backs the Investigate TOPOLOGY facet 'Is sub-agent' checkbox."
// @Param        include_pure_children query bool false "D126 UX revision 2026-05-03: when false, exclude pure children (rows whose parent_session_id is set AND that themselves have no descendants), leaving parents-with-children + lone sessions. Default scope of the Investigate page. Omit or set true to preserve the legacy 'all sessions' behaviour."
// @Param        sort       query  string  false  "Sort field: started_at, last_seen_at, duration, tokens_used, flavor, model, hostname, state (default: started_at). state sort uses severity ordinal active→idle→stale→lost→closed."
// @Param        order      query  string  false  "Sort order: asc, desc (default: desc)"
// @Param        limit      query  int     false  "Max results (default 25, max 100)"
// @Param        offset     query  int     false  "Offset for pagination (default 0)"
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

		// Parse agent_type filter (repeatable). Values are unvalidated
		// against a fixed set -- new agent_type values can land without
		// a migration; a typo just yields an empty result like every
		// other text filter. Backs the AGENT TYPE facet on the
		// Investigate page.
		var agentTypes []string
		for _, a := range q["agent_type"] {
			for _, v := range strings.Split(a, ",") {
				v = strings.TrimSpace(v)
				if v != "" {
					agentTypes = append(agentTypes, v)
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

		// Phase 4: filter sessions to those that emitted an
		// llm_error event of one of the listed taxonomy values. The
		// 14-entry taxonomy lives in the sensor's core/errors.py;
		// the API accepts every taxonomy value plus any future
		// value (free-form) -- the EXISTS subquery on events just
		// won't match a typo, same as every other text filter.
		// Multi-value OR within the dimension; AND against other
		// filters.
		var errorTypes []string
		for _, e := range q["error_type"] {
			for _, v := range strings.Split(e, ",") {
				v = strings.TrimSpace(v)
				if v != "" {
					errorTypes = append(errorTypes, v)
				}
			}
		}

		// Policy-event-type filter (repeatable/comma). Vocabulary
		// validated against the closed set so a typo 400s with the
		// allowed values rather than silently matching nothing — same
		// posture as state / client_type filters because the dimension
		// is a fixed enum at the sensor side.
		var policyEventTypes []string
		for _, p := range q["policy_event_type"] {
			for _, v := range strings.Split(p, ",") {
				v = strings.TrimSpace(v)
				if v == "" {
					continue
				}
				if !validPolicyEventTypes[v] {
					writeError(w, http.StatusBadRequest,
						"invalid policy_event_type: "+v+
							". Allowed: policy_warn, policy_degrade, "+
							"policy_block, policy_mcp_warn, "+
							"policy_mcp_block, mcp_server_name_changed, "+
							"mcp_policy_user_remembered")
					return
				}
				policyEventTypes = append(policyEventTypes, v)
			}
		}

		// MCP-server filter (repeatable/comma). Phase 5. No fixed
		// vocabulary — server names are user-defined at the agent's
		// .mcp.json / claude.json layer; an unknown name yields an
		// empty result, same posture as the framework / model
		// filters. Backs the MCP SERVER facet on the Investigate
		// sidebar.
		var mcpServers []string
		for _, m := range q["mcp_server"] {
			for _, v := range strings.Split(m, ",") {
				v = strings.TrimSpace(v)
				if v != "" {
					mcpServers = append(mcpServers, v)
				}
			}
		}

		// Parse client_type filter (repeatable). Validated against
		// the CHECK-constraint vocabulary so a typo returns a 400
		// with the allowed set rather than silently zero results --
		// the same contract the /v1/agents handler uses.
		var clientTypes []string
		for _, c := range q["client_type"] {
			for _, v := range strings.Split(c, ",") {
				v = strings.TrimSpace(v)
				if v == "" {
					continue
				}
				if !validSessionClientTypes[v] {
					writeError(w, http.StatusBadRequest,
						"invalid client_type: "+v+". Allowed: claude_code, flightdeck_sensor")
					return
				}
				clientTypes = append(clientTypes, v)
			}
		}

		// Parse generic scalar-key context filters. We iterate the
		// closed whitelist rather than looping over ``q`` so an
		// unrecognised query param (typo, injection attempt) is
		// silently ignored instead of forwarded to the store where
		// the helper would panic. Values are comma-splittable for
		// "user=a,b" shorthand and repeatable for "user=a&user=b".
		contextFilters := map[string][]string{}
		for _, key := range store.AllowedContextFilterKeys {
			for _, raw := range q[key] {
				for _, v := range strings.Split(raw, ",") {
					v = strings.TrimSpace(v)
					if v != "" {
						contextFilters[key] = append(contextFilters[key], v)
					}
				}
			}
		}

		// Sort validation
		sort := q.Get("sort")
		if sort == "" {
			sort = "started_at"
		}
		if !validSessionSorts[sort] {
			writeError(w, http.StatusBadRequest,
				"invalid sort: "+sort+
					". Allowed: started_at, last_seen_at, duration, "+
					"tokens_used, flavor, model, hostname, state")
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

		// D126 — sub-agent observability filters. Each is independent
		// and composes via AND in the WHERE clause. parent_session_id
		// is single-value (the natural one-parent-many-children
		// shape); agent_role accepts repeatable / comma-split values
		// for the Investigate ROLE facet's multi-select shape;
		// has_sub_agents / is_sub_agent are boolean toggles.
		parentSessionID := strings.TrimSpace(q.Get("parent_session_id"))
		var agentRoles []string
		for _, role := range q["agent_role"] {
			for _, v := range strings.Split(role, ",") {
				v = strings.TrimSpace(v)
				if v != "" {
					agentRoles = append(agentRoles, v)
				}
			}
		}
		hasSubAgents := parseBoolQuery(q.Get("has_sub_agents"))
		isSubAgent := parseBoolQuery(q.Get("is_sub_agent"))
		// D126 UX revision 2026-05-03 — include_pure_children
		// gates the new Investigate default scope. Tri-state on
		// the wire: omit (nil) preserves existing API behaviour;
		// "true" (explicit) returns all rows matching the other
		// filters (the existing default rephrased); "false"
		// excludes pure children. Stored as *bool in the params
		// struct so the SQL layer can distinguish omit from
		// explicit-true.
		var includePureChildren *bool
		if raw := q.Get("include_pure_children"); raw != "" {
			b := parseBoolQuery(raw)
			includePureChildren = &b
		}

		params := store.SessionsParams{
			From:    from,
			To:      to,
			Query:   search,
			States:  states,
			Flavors: flavors,
			// D115: single-agent filter. Empty string = no filter.
			// Validated at the SQL layer via ``::uuid`` cast so a
			// malformed value produces a query error rather than a
			// silently-bypassed filter.
			AgentID:          strings.TrimSpace(q.Get("agent_id")),
			AgentTypes:       agentTypes,
			ClientTypes:      clientTypes,
			ErrorTypes:       errorTypes,
			PolicyEventTypes: policyEventTypes,
			Frameworks:       frameworks,
			MCPServers:       mcpServers,
			ParentSessionID:     parentSessionID,
			AgentRoles:          agentRoles,
			HasSubAgents:        hasSubAgents,
			IsSubAgent:          isSubAgent,
			IncludePureChildren: includePureChildren,
			ContextFilters:   contextFilters,
			Model:            q.Get("model"),
			Sort:             sort,
			Order:            order,
			Limit:            limit,
			Offset:           offset,
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
