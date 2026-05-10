// MCP Protection Policy audit-log handler + shared path-parsing
// helpers. Originally these lived in ``mcp_policy_versions.go``
// alongside the version-history handlers; D142 retired the version
// handlers (step 6.8 cleanup) but audit-log + the helpers stay.

package handlers

import (
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// scopeAndValueFromPath maps the {flavor} path segment to a (scope,
// scopeValue) pair. The literal segment "global" routes to scope
// "global" with scope_value ""; everything else is treated as a
// flavor name.
func scopeAndValueFromPath(r *http.Request) (string, string) {
	flavor := flavorFromPath(r)
	if flavor == "global" {
		return "global", ""
	}
	return "flavor", flavor
}

const defaultListLimit = 50
const maxListLimit = 200

func parseLimitOffset(r *http.Request) (int, int, string) {
	limit := defaultListLimit
	offset := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 1 || v > maxListLimit {
			return 0, 0, "limit must be 1.." + strconv.Itoa(maxListLimit)
		}
		limit = v
	}
	if raw := r.URL.Query().Get("offset"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 0 {
			return 0, 0, "offset must be >= 0"
		}
		offset = v
	}
	return limit, offset, ""
}

func parseTimeParam(r *http.Request, name string) (*time.Time, string) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return nil, ""
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return nil, name + " must be RFC 3339 timestamp"
	}
	return &t, ""
}

// ListMCPPolicyAuditLogHandler handles GET /v1/mcp-policies/{flavor}/audit-log
// and GET /v1/mcp-policies/global/audit-log (server.go wires the same
// handler to both routes — "global" is a sentinel flavor path; see
// ListMCPPolicyAuditLogHandlerGlobalDoc for the dedicated /global/audit-log
// docs entry).
//
// @Summary      List flavor MCP policy audit log
// @Description  Returns operator-initiated mutation history in DESC time order, paginated. event_type query filters to one mutation kind. Sensor-observed system state (decision events, name drift) lives in the events pipeline (D131), NOT here.
// @Tags         mcp-policy
// @Produce      json
// @Param        flavor      path   string  true   "Agent flavor"
// @Param        from        query  string  false  "Start time (RFC 3339)"
// @Param        to          query  string  false  "End time (RFC 3339)"
// @Param        event_type  query  string  false  "Filter by event type"
// @Param        limit       query  int     false  "Max rows; 1..200; default 50"
// @Param        offset      query  int     false  "Pagination offset; default 0"
// @Success      200  {array}   store.MCPPolicyAuditLog
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/{flavor}/audit-log [get]
func ListMCPPolicyAuditLogHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, scopeValue := scopeAndValueFromPath(r)
		if scope == "flavor" && scopeValue == "" {
			writeError(w, http.StatusBadRequest, "flavor is required")
			return
		}
		eventType := r.URL.Query().Get("event_type")
		from, msg := parseTimeParam(r, "from")
		if msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		to, msg := parseTimeParam(r, "to")
		if msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		limit, offset, msg := parseLimitOffset(r)
		if msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		logs, err := s.ListMCPPolicyAuditLog(r.Context(), scope, scopeValue, eventType, from, to, limit, offset)
		if err != nil {
			slog.Error("list mcp policy audit log", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		writeJSON(w, logs)
	}
}

// ListMCPPolicyAuditLogHandlerGlobalDoc is a documentation-only
// stub. The /global/audit-log path is served by the same
// ListMCPPolicyAuditLogHandler instance, but swag doesn't infer
// parallel routes from a single function — a second annotation is
// the cleanest way to surface both paths in the OpenAPI spec.
// This function is never registered as a handler.
//
// @Summary      List global MCP policy audit log
// @Description  Returns operator-initiated mutation history for the global MCP policy in DESC time order, paginated. Same response shape as the flavor variant.
// @Tags         mcp-policy
// @Produce      json
// @Param        from        query  string  false  "Start time (RFC 3339)"
// @Param        to          query  string  false  "End time (RFC 3339)"
// @Param        event_type  query  string  false  "Filter by event type"
// @Param        limit       query  int     false  "Max rows; 1..200; default 50"
// @Param        offset      query  int     false  "Pagination offset; default 0"
// @Success      200  {array}   store.MCPPolicyAuditLog
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/global/audit-log [get]
func ListMCPPolicyAuditLogHandlerGlobalDoc() {}
