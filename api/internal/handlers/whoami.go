// Whoami handler (D147). Returns the authenticated token's role +
// id so the dashboard can gate mutation CTAs without a second
// validator round-trip. Reads the ValidationResult that
// auth.Middleware already stashed in the request context.

package handlers

import (
	"net/http"

	"github.com/flightdeckhq/flightdeck/api/internal/auth"
)

// WhoamiResponse is the response shape for GET /v1/whoami.
type WhoamiResponse struct {
	Role    string `json:"role"`     // "admin" | "viewer"
	TokenID string `json:"token_id"`
}

// WhoamiHandler handles GET /v1/whoami.
//
// @Summary      Identify the authenticated bearer
// @Description  Returns the role + token_id for the bearer token in the request. ``admin`` for IsAdmin tokens (env-configured admin or tok_admin_dev in dev), ``viewer`` for any other valid token. The dashboard reads this once at session start (D147) and gates mutation CTAs on role === "admin".
// @Tags         auth
// @Produce      json
// @Success      200  {object}  WhoamiResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/whoami [get]
func WhoamiHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		result, ok := auth.ValidationResultFromContext(r.Context())
		if !ok {
			// gate() always populates the context before reaching
			// here; absence is a server.go misconfiguration, not a
			// caller error. 500 surfaces the bug rather than
			// silently returning empty fields.
			writeError(w, http.StatusInternalServerError,
				"validation result missing from context")
			return
		}
		role := "viewer"
		if result.IsAdmin {
			role = "admin"
		}
		writeJSON(w, WhoamiResponse{Role: role, TokenID: result.ID})
	}
}
