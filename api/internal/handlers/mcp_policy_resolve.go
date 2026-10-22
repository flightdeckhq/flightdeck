// MCP Protection Policy resolve endpoint — sensor / plugin preflight.
// Read-only scope: any valid
// bearer token can hit this endpoint (it's the hot path the sensor
// calls at init() and the plugin calls at SessionStart). GET-only;
// idempotent, safe, cacheable.
//
// The resolver canonicalizes the raw URL server-side using the Go
// identity helper so callers don't have to. Returns the decision
// (flavor entry, else global entry, else the global-mode default)
// plus the decision_path so callers can render an
// actionable failure message ("policy X blocked tool Y on flavor Z").

package handlers

import (
	"log/slog"
	"net/http"
	"strings"

	mcpid "github.com/flightdeckhq/flightdeck/api/internal/mcp_identity"
	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// ResolveMCPPolicyHandler handles GET /v1/mcp-policies/resolve.
//
// @Summary      Resolve MCP policy decision
// @Description  Sensor / plugin preflight. Returns the decision (allow / warn / block) for a server in a flavor -- a flavor entry wins, then a global entry, then the global-mode default -- plus the decision_path that produced it (flavor_entry / global_entry / mode_default). Entries match on the canonical server URL alone (the server name is display metadata); when a scope holds several entries for one URL the most restrictive wins. The server canonicalizes the URL using the same algorithm as the Python and JS identity primitives.
// @Tags         mcp-policy
// @Produce      json
// @Param        flavor       query  string  false  "Agent flavor; omit to resolve against global only"
// @Param        server_url   query  string  true   "Raw MCP server URL or stdio command"
// @Param        server_name  query  string  false  "Server display name; recorded in the fingerprint, not used to match entries"
// @Success      200  {object}  store.MCPPolicyResolveResult
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/mcp-policies/resolve [get]
func ResolveMCPPolicyHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flavor := strings.TrimSpace(r.URL.Query().Get("flavor"))
		serverURL := strings.TrimSpace(r.URL.Query().Get("server_url"))
		serverName := strings.TrimSpace(r.URL.Query().Get("server_name"))

		if serverURL == "" {
			writeError(w, http.StatusBadRequest, "server_url is required")
			return
		}

		canonical, err := mcpid.CanonicalizeURL(serverURL)
		if err != nil {
			writeError(w, http.StatusBadRequest, "canonicalize url: "+err.Error())
			return
		}
		fingerprint := mcpid.FingerprintShort(canonical, serverName)

		result, err := s.ResolveMCPPolicy(r.Context(), flavor, canonical, fingerprint)
		if err != nil {
			slog.Error("resolve mcp policy",
				"err", err, "flavor", flavor, "fingerprint", fingerprint)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		writeJSON(w, result)
	}
}
