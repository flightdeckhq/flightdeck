// MCP Protection Policy CRUD handlers — read + write + delete.
// Resolve / versions / metrics / dry-run / import-export / templates
// live in their own files for navigability.
//
// All handlers carry full swaggo annotations per Rule 50. Validation
// happens at the API boundary per Rule 36; the storage layer's CHECK
// constraints (D128 / D134) are the second line of defence.

package handlers

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/flightdeckhq/flightdeck/api/internal/auth"
	mcpid "github.com/flightdeckhq/flightdeck/api/internal/mcp_identity"
	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// validEnforcement is the closed set per D128 / ARCHITECTURE.md
// "Storage schema". Empty string is allowed on allow entries
// (no per-entry enforcement override).
var validEnforcement = map[string]bool{
	"":            true,
	"warn":        true,
	"block":       true,
	"interactive": true,
}

// validEntryKind is the closed set per D128.
var validEntryKind = map[string]bool{
	"allow": true,
	"deny":  true,
}

// validMode is the closed set per D128 / D134.
var validMode = map[string]bool{
	"allowlist": true,
	"blocklist": true,
}

func validateMutation(mut store.MCPPolicyMutation, scope string) string {
	if scope == "global" {
		if mut.Mode == nil || !validMode[*mut.Mode] {
			return "mode must be one of: allowlist, blocklist (required on global)"
		}
	} else if mut.Mode != nil {
		// flavor MUST NOT carry mode (D134); reject loudly so the
		// caller learns rather than silently dropping the field.
		return "mode is global-only; flavor policies do not carry mode (D134)"
	}
	for i, e := range mut.Entries {
		if !validEntryKind[e.EntryKind] {
			return entryError(i, "entry_kind must be one of: allow, deny")
		}
		if e.Enforcement != nil && !validEnforcement[*e.Enforcement] {
			return entryError(i, "enforcement must be one of: warn, block, interactive")
		}
		if strings.TrimSpace(e.ServerURL) == "" {
			return entryError(i, "server_url is required")
		}
		if strings.TrimSpace(e.ServerName) == "" {
			return entryError(i, "server_name is required")
		}
	}
	return ""
}

func entryError(i int, msg string) string {
	return "entry[" + itoa(i) + "]: " + msg
}

func itoa(i int) string {
	// Avoid strconv import for one-line use.
	if i == 0 {
		return "0"
	}
	digits := []byte{}
	negative := i < 0
	if negative {
		i = -i
	}
	for i > 0 {
		digits = append([]byte{byte('0' + i%10)}, digits...)
		i /= 10
	}
	if negative {
		return "-" + string(digits)
	}
	return string(digits)
}

// resolveMutationEntries computes server_url_canonical + fingerprint
// for each entry, using the Go identity helper. Returns an error if
// any URL fails canonicalisation.
func resolveMutationEntries(mut store.MCPPolicyMutation) ([]store.MCPPolicyEntry, error) {
	resolved := make([]store.MCPPolicyEntry, 0, len(mut.Entries))
	for _, em := range mut.Entries {
		canonical, err := mcpid.CanonicalizeURL(em.ServerURL)
		if err != nil {
			return nil, err
		}
		resolved = append(resolved, store.MCPPolicyEntry{
			ServerURLCanonical: canonical,
			ServerName:         em.ServerName,
			Fingerprint:        mcpid.FingerprintShort(canonical, em.ServerName),
			EntryKind:          em.EntryKind,
			Enforcement:        em.Enforcement,
		})
	}
	return resolved, nil
}

// flavorFromPath extracts the {flavor} segment from a path like
// /v1/mcp-policies/{flavor}/.... Returns the empty string when the
// path doesn't carry a flavor segment.
func flavorFromPath(r *http.Request) string {
	return r.PathValue("flavor")
}

// actorTokenIDFromContext returns the access-token UUID associated
// with the authenticated request, or nil when no token context is
// attached. The audit-log table's actor column accepts NULL when the
// bearer token has been deleted since the request authenticated, so
// returning a nil pointer here is fine.
func actorTokenIDFromContext(r *http.Request) *string {
	res, ok := auth.ValidationResultFromContext(r.Context())
	if !ok || res.ID == "" {
		return nil
	}
	id := res.ID
	return &id
}

// ----- handlers ------------------------------------------------

// GetGlobalMCPPolicyHandler handles GET /v1/mcp-policies/global.
//
// @Summary      Get global MCP protection policy
// @Description  Returns the singleton global policy + entries. Auto-created at API boot per D133, so this endpoint always returns 200.
// @Tags         mcp-policy
// @Produce      json
// @Success      200  {object}  store.MCPPolicy
// @Failure      401  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/global [get]
func GetGlobalMCPPolicyHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		policy, err := s.GetGlobalMCPPolicy(r.Context())
		if err != nil {
			slog.Error("get global mcp policy", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		if policy == nil {
			// EnsureGlobalMCPPolicy ran at API boot; absence here
			// means a manual delete from the DB. Treat as 500 so an
			// operator notices and re-runs the boot init (or the
			// API restarts).
			writeError(w, http.StatusInternalServerError, "global policy missing; restart API to auto-create")
			return
		}
		writeJSON(w, policy)
	}
}

// GetMCPPolicyHandler handles GET /v1/mcp-policies/{flavor}.
//
// @Summary      Get flavor MCP protection policy
// @Description  Returns the flavor's policy + entries. 404 when no flavor policy exists.
// @Tags         mcp-policy
// @Produce      json
// @Param        flavor  path  string  true  "Agent flavor"
// @Success      200  {object}  store.MCPPolicy
// @Failure      401  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/{flavor} [get]
func GetMCPPolicyHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flavor := flavorFromPath(r)
		if flavor == "" || isReservedFlavorSegment(flavor) {
			writeError(w, http.StatusBadRequest, "flavor is required")
			return
		}
		policy, err := s.GetMCPPolicy(r.Context(), flavor)
		if err != nil {
			slog.Error("get mcp policy", "err", err, "flavor", flavor)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		if policy == nil {
			writeError(w, http.StatusNotFound, "flavor policy not found")
			return
		}
		writeJSON(w, policy)
	}
}

// CreateMCPPolicyHandler handles POST /v1/mcp-policies/{flavor}.
//
// @Summary      Create flavor MCP protection policy
// @Description  Creates a new flavor policy. Returns 409 if a flavor policy already exists. The global policy cannot be POST'd; use PUT /global to modify it.
// @Tags         mcp-policy
// @Accept       json
// @Produce      json
// @Param        flavor  path  string                       true  "Agent flavor"
// @Param        body    body  store.MCPPolicyMutation      true  "Policy state"
// @Success      201  {object}  store.MCPPolicy
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      409  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/{flavor} [post]
func CreateMCPPolicyHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flavor := flavorFromPath(r)
		if flavor == "" || isReservedFlavorSegment(flavor) {
			writeError(w, http.StatusBadRequest, "flavor is required")
			return
		}
		var mut store.MCPPolicyMutation
		if err := json.NewDecoder(r.Body).Decode(&mut); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if msg := validateMutation(mut, "flavor"); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		resolved, err := resolveMutationEntries(mut)
		if err != nil {
			writeError(w, http.StatusBadRequest, "canonicalize url: "+err.Error())
			return
		}
		actor := actorTokenIDFromContext(r)
		created, err := s.CreateMCPPolicy(r.Context(), flavor, mut, resolved, actor)
		if errors.Is(err, store.ErrMCPPolicyAlreadyExists) {
			writeError(w, http.StatusConflict, "flavor policy already exists")
			return
		}
		if err != nil {
			slog.Error("create mcp policy", "err", err, "flavor", flavor)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		w.WriteHeader(http.StatusCreated)
		writeJSONNoStatus(w, created)
	}
}

// UpdateGlobalMCPPolicyHandler handles PUT /v1/mcp-policies/global.
//
// @Summary      Update global MCP protection policy
// @Description  Replaces global policy state — mode, entries, block_on_uncertainty. Bumps version, writes a snapshot, writes an audit-log entry. Single-shot transaction (D128).
// @Tags         mcp-policy
// @Accept       json
// @Produce      json
// @Param        body  body  store.MCPPolicyMutation  true  "New policy state"
// @Success      200  {object}  store.MCPPolicy
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/global [put]
func UpdateGlobalMCPPolicyHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var mut store.MCPPolicyMutation
		if err := json.NewDecoder(r.Body).Decode(&mut); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if msg := validateMutation(mut, "global"); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		resolved, err := resolveMutationEntries(mut)
		if err != nil {
			writeError(w, http.StatusBadRequest, "canonicalize url: "+err.Error())
			return
		}
		actor := actorTokenIDFromContext(r)
		updated, err := s.UpdateMCPPolicy(r.Context(), "global", "", mut, resolved, actor, nil)
		if errors.Is(err, store.ErrMCPPolicyNotFound) {
			writeError(w, http.StatusNotFound, "global policy missing; restart API to auto-create")
			return
		}
		if err != nil {
			slog.Error("update global mcp policy", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		writeJSON(w, updated)
	}
}

// UpdateMCPPolicyHandler handles PUT /v1/mcp-policies/{flavor}.
//
// @Summary      Update flavor MCP protection policy
// @Description  Replaces flavor policy state — entries, block_on_uncertainty. Mode is global-only (D134) and rejected here. Same atomic version + audit semantics as the global PUT.
// @Tags         mcp-policy
// @Accept       json
// @Produce      json
// @Param        flavor  path  string                       true  "Agent flavor"
// @Param        body    body  store.MCPPolicyMutation      true  "New policy state"
// @Success      200  {object}  store.MCPPolicy
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/{flavor} [put]
func UpdateMCPPolicyHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flavor := flavorFromPath(r)
		if flavor == "" || isReservedFlavorSegment(flavor) {
			writeError(w, http.StatusBadRequest, "flavor is required")
			return
		}
		var mut store.MCPPolicyMutation
		if err := json.NewDecoder(r.Body).Decode(&mut); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if msg := validateMutation(mut, "flavor"); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		resolved, err := resolveMutationEntries(mut)
		if err != nil {
			writeError(w, http.StatusBadRequest, "canonicalize url: "+err.Error())
			return
		}
		actor := actorTokenIDFromContext(r)
		updated, err := s.UpdateMCPPolicy(r.Context(), "flavor", flavor, mut, resolved, actor, nil)
		if errors.Is(err, store.ErrMCPPolicyNotFound) {
			writeError(w, http.StatusNotFound, "flavor policy not found")
			return
		}
		if err != nil {
			slog.Error("update mcp policy", "err", err, "flavor", flavor)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		writeJSON(w, updated)
	}
}

// DeleteMCPPolicyHandler handles DELETE /v1/mcp-policies/{flavor}.
//
// @Summary      Delete flavor MCP protection policy
// @Description  Deletes a flavor policy. The global cannot be deleted. Audit-log row preserved via ON DELETE SET NULL on policy_id.
// @Tags         mcp-policy
// @Produce      json
// @Param        flavor  path  string  true  "Agent flavor"
// @Success      204
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/{flavor} [delete]
func DeleteMCPPolicyHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flavor := flavorFromPath(r)
		if flavor == "" || isReservedFlavorSegment(flavor) {
			writeError(w, http.StatusBadRequest, "flavor is required")
			return
		}
		if flavor == "global" {
			writeError(w, http.StatusBadRequest, "global policy cannot be deleted")
			return
		}
		actor := actorTokenIDFromContext(r)
		err := s.DeleteMCPPolicy(r.Context(), flavor, actor)
		if errors.Is(err, store.ErrMCPPolicyNotFound) {
			writeError(w, http.StatusNotFound, "flavor policy not found")
			return
		}
		if err != nil {
			slog.Error("delete mcp policy", "err", err, "flavor", flavor)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// isReservedFlavorSegment recognises path segments that look like
// flavors but actually map to other endpoints under the same prefix
// (e.g., `/v1/mcp-policies/resolve`, `/v1/mcp-policies/templates`).
// The router is flat (Go 1.22 stdlib mux), so the resolver routes
// match before the flavor wildcard, but defence-in-depth covers the
// case where a user accidentally tries to create a flavor named one
// of the reserved words.
func isReservedFlavorSegment(s string) bool {
	switch s {
	case "resolve", "templates":
		return true
	}
	return false
}

// writeJSON writes the value as JSON with a 200 status.
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// writeJSONNoStatus writes JSON without setting a status code (for
// handlers that already wrote one).
func writeJSONNoStatus(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
