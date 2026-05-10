// MCP Protection Policy resolve endpoint — sensor / plugin preflight.
// Read-only scope per the auth amendment locked in step 3: any valid
// bearer token can hit this endpoint (it's the hot path the sensor
// calls at init() and the plugin calls at SessionStart). GET-only;
// idempotent, safe, cacheable.
//
// The resolver canonicalizes the raw URL server-side using the Go
// identity helper so callers don't have to. Returns the per-D135
// decision plus the decision_path so callers can render an
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
// @Description  Sensor / plugin preflight. Returns the per-D135 decision (allow / warn / block) for a (flavor, server_url, server_name) tuple, plus the decision_path that produced it (flavor_entry / global_entry / mode_default). The server canonicalizes the URL using the same algorithm as the Python and JS identity primitives.
// @Tags         mcp-policy
// @Produce      json
// @Param        flavor       query  string  false  "Agent flavor; omit to resolve against global only"
// @Param        server_url   query  string  true   "Raw MCP server URL or stdio command"
// @Param        server_name  query  string  true   "Server display name"
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
		if serverName == "" {
			writeError(w, http.StatusBadRequest, "server_name is required")
			return
		}

		canonical, err := mcpid.CanonicalizeURL(serverURL)
		if err != nil {
			writeError(w, http.StatusBadRequest, "canonicalize url: "+err.Error())
			return
		}
		fingerprint := mcpid.FingerprintShort(canonical, serverName)

		result, err := s.ResolveMCPPolicy(r.Context(), flavor, fingerprint)
		if err != nil {
			slog.Error("resolve mcp policy",
				"err", err, "flavor", flavor, "fingerprint", fingerprint)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		writeJSON(w, result)
	}
}
