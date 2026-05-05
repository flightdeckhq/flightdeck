// MCP Protection Policy version-history + audit-log handlers.
// All four endpoints are admin-grade; the route wiring uses
// adminGate (auth.AdminRequired) so non-admin tokens get 403.

package handlers

import (
	"errors"
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

// ListMCPPolicyVersionsHandler handles GET /v1/mcp-policies/{flavor}/versions.
//
// @Summary      List MCP policy version history
// @Description  Returns version metadata (no full snapshots) in DESC version order, paginated. Use the singular versions/{version} endpoint for full snapshots.
// @Tags         mcp-policy
// @Produce      json
// @Param        flavor  path   string  true  "Agent flavor or 'global'"
// @Param        limit   query  int     false "Max rows; 1..200; default 50"
// @Param        offset  query  int     false "Pagination offset; default 0"
// @Success      200  {array}   store.MCPPolicyVersionMeta
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/{flavor}/versions [get]
func ListMCPPolicyVersionsHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, scopeValue := scopeAndValueFromPath(r)
		if scope == "flavor" && scopeValue == "" {
			writeError(w, http.StatusBadRequest, "flavor is required")
			return
		}
		limit, offset, msg := parseLimitOffset(r)
		if msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		versions, err := s.ListMCPPolicyVersions(r.Context(), scope, scopeValue, limit, offset)
		if err != nil {
			slog.Error("list mcp policy versions", "err", err, "scope", scope, "value", scopeValue)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		writeJSON(w, versions)
	}
}

// GetMCPPolicyVersionHandler handles GET /v1/mcp-policies/{flavor}/versions/{version}.
//
// @Summary      Get one MCP policy version snapshot
// @Description  Returns the full snapshot at the named version number (integer, NOT a UUID).
// @Tags         mcp-policy
// @Produce      json
// @Param        flavor   path  string  true  "Agent flavor or 'global'"
// @Param        version  path  int     true  "Version number"
// @Success      200  {object}  store.MCPPolicyVersion
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/{flavor}/versions/{version} [get]
func GetMCPPolicyVersionHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, scopeValue := scopeAndValueFromPath(r)
		if scope == "flavor" && scopeValue == "" {
			writeError(w, http.StatusBadRequest, "flavor is required")
			return
		}
		versionStr := r.PathValue("version")
		version, err := strconv.Atoi(versionStr)
		if err != nil || version < 1 {
			writeError(w, http.StatusBadRequest, "version must be a positive integer")
			return
		}
		v, err := s.GetMCPPolicyVersion(r.Context(), scope, scopeValue, version)
		if err != nil {
			slog.Error("get mcp policy version", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		if v == nil {
			writeError(w, http.StatusNotFound, "version not found")
			return
		}
		writeJSON(w, v)
	}
}

// DiffMCPPolicyVersionsHandler handles GET /v1/mcp-policies/{flavor}/diff.
//
// @Summary      Diff two MCP policy versions
// @Description  Server-computed structural diff between two versions. Returns both snapshots plus mode_changed / block_on_uncertainty_changed / entries_added / entries_removed / entries_changed buckets.
// @Tags         mcp-policy
// @Produce      json
// @Param        flavor  path   string  true   "Agent flavor or 'global'"
// @Param        from    query  int     true   "From version number"
// @Param        to      query  int     true   "To version number"
// @Success      200  {object}  store.MCPPolicyDiff
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/{flavor}/diff [get]
func DiffMCPPolicyVersionsHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, scopeValue := scopeAndValueFromPath(r)
		if scope == "flavor" && scopeValue == "" {
			writeError(w, http.StatusBadRequest, "flavor is required")
			return
		}
		fromStr := r.URL.Query().Get("from")
		toStr := r.URL.Query().Get("to")
		if fromStr == "" || toStr == "" {
			writeError(w, http.StatusBadRequest, "from and to query params are required")
			return
		}
		from, err := strconv.Atoi(fromStr)
		if err != nil || from < 1 {
			writeError(w, http.StatusBadRequest, "from must be a positive integer")
			return
		}
		to, err := strconv.Atoi(toStr)
		if err != nil || to < 1 {
			writeError(w, http.StatusBadRequest, "to must be a positive integer")
			return
		}
		diff, err := s.DiffMCPPolicyVersions(r.Context(), scope, scopeValue, from, to)
		if errors.Is(err, store.ErrMCPPolicyNotFound) {
			writeError(w, http.StatusNotFound, "one or both versions not found")
			return
		}
		if err != nil {
			slog.Error("diff mcp policy versions", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		writeJSON(w, diff)
	}
}

// ListMCPPolicyAuditLogHandler handles GET /v1/mcp-policies/{flavor}/audit-log
// AND GET /v1/mcp-policies/global/audit-log.
//
// @Summary      List MCP policy audit log
// @Description  Returns operator-initiated mutation history in DESC time order, paginated. event_type query filters to one mutation kind. Sensor-observed system state (decision events, name drift) lives in the events pipeline (D131), NOT here.
// @Tags         mcp-policy
// @Produce      json
// @Param        flavor      path   string  true   "Agent flavor or 'global'"
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
