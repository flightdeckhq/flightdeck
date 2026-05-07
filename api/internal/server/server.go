// Package server provides the HTTP server for the query API.
package server

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	apidocs "github.com/flightdeckhq/flightdeck/api/docs"
	"github.com/flightdeckhq/flightdeck/api/internal/auth"
	"github.com/flightdeckhq/flightdeck/api/internal/handlers"
	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"github.com/flightdeckhq/flightdeck/api/internal/ws"
	httpSwagger "github.com/swaggo/http-swagger/v2"
)

const (
	serverReadTimeout = 15 * time.Second
	// WriteTimeout intentionally omitted -- WebSocket connections are
	// long-lived and a global write timeout kills them after N seconds.
	// The WebSocket write pump controls its own per-message deadline.
	// REST routes are protected by withRESTTimeout per-handler.
	serverIdleTimeout = 120 * time.Second
	restTimeout       = 30 * time.Second
)

// New creates the HTTP server with all routes registered.
//
// validator MUST be non-nil. The sensor-facing endpoints
// (POST /v1/directives/sync and POST /v1/directives/register) are
// mounted behind bearer-token auth via this validator (D073 stopgap).
// Passing nil panics on construction so a future refactor cannot
// silently disable authentication on those endpoints. Use
// NewForTesting if you need an unauthenticated server in tests.
//
// corsOrigin must be either "*" or a parseable absolute URL with a
// non-empty scheme and host. Anything else fails fast at startup
// (Phase 4.5 M-14) rather than rendering a non-functional CORS
// surface in production.
func New(addr string, s store.Querier, hub *ws.Hub, validator *auth.Validator, corsOrigin string) *http.Server {
	if validator == nil {
		panic("server: validator must not be nil. Pass auth.NewValidator() in production or use NewForTesting() in tests.")
	}
	if err := validateCORSOrigin(corsOrigin); err != nil {
		panic(fmt.Sprintf("server: %v", err))
	}
	return newServer(addr, s, hub, validator, corsOrigin)
}

// validateCORSOrigin enforces the documented contract on
// FLIGHTDECK_CORS_ORIGIN: either the wildcard "*" or an absolute
// URL such as "https://app.example.com". An empty string, a
// hostname-only value, or a path-only value would be silently
// echoed by the browser as an invalid Access-Control-Allow-Origin
// and break CORS for every user agent.
func validateCORSOrigin(origin string) error {
	if origin == "" {
		return fmt.Errorf("CORS origin must not be empty (use \"*\" for any origin)")
	}
	if origin == "*" {
		return nil
	}
	u, err := url.Parse(origin)
	if err != nil {
		return fmt.Errorf("CORS origin %q is not a valid URL: %w", origin, err)
	}
	if u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("CORS origin %q must include scheme and host (e.g. https://app.example.com)", origin)
	}
	return nil
}

// NewForTesting builds a server with sync/register endpoints mounted
// WITHOUT auth. Intended for tests that exercise handler wiring through
// the real ServeMux without needing a Postgres-backed token validator.
// Never call this from production code paths.
func NewForTesting(addr string, s store.Querier, hub *ws.Hub, corsOrigin string) *http.Server {
	return newServer(addr, s, hub, nil, corsOrigin)
}

// newServer is the unexported builder shared by New and NewForTesting.
// validator may be nil; when nil the sync/register endpoints mount
// without auth (NewForTesting only -- New panics before reaching here).
func newServer(addr string, s store.Querier, hub *ws.Hub, validator *auth.Validator, corsOrigin string) *http.Server {
	mux := http.NewServeMux()

	// gate wraps REST handlers with the 30s timeout AND the Phase 5
	// bearer-token auth middleware. Phase 5 D095: every /v1 endpoint
	// must present a valid token. /health and /docs/ remain open so
	// container healthchecks and the Swagger UI still work without
	// credentials. The WebSocket /v1/stream is gated separately --
	// http.TimeoutHandler is incompatible with hijacking, but auth
	// must still apply; see below.
	gate := func(h http.Handler) http.Handler {
		if validator != nil {
			h = auth.Middleware(validator, h)
		}
		return withRESTTimeout(h)
	}

	// REST routes -- all require a valid bearer token (D095).
	mux.Handle("GET /v1/fleet", gate(handlers.FleetHandler(s)))
	mux.Handle("GET /v1/agents", gate(handlers.AgentsListHandler(s)))
	mux.Handle("GET /v1/agents/", gate(handlers.AgentByIDHandler(s)))
	mux.Handle("GET /v1/sessions", gate(handlers.SessionsListHandler(s)))
	mux.Handle("GET /v1/sessions/", gate(handlers.SessionsHandler(s)))
	mux.Handle("GET /v1/events/", gate(handlers.ContentHandler(s)))
	mux.Handle("GET /v1/policy", gate(handlers.EffectivePolicyHandler(s)))
	mux.Handle("GET /v1/policies", gate(handlers.PoliciesListHandler(s)))
	mux.Handle("POST /v1/policies", gate(handlers.PolicyCreateHandler(s)))
	mux.Handle("PUT /v1/policies/{id}", gate(handlers.PolicyUpdateHandler(s)))
	mux.Handle("DELETE /v1/policies/{id}", gate(handlers.PolicyDeleteHandler(s)))
	mux.Handle("POST /v1/directives", gate(handlers.CreateDirectiveHandler(s)))

	mux.Handle("POST /v1/directives/sync", gate(handlers.SyncDirectivesHandler(s)))
	mux.Handle("POST /v1/directives/register", gate(handlers.RegisterDirectivesHandler(s)))

	mux.Handle("GET /v1/directives/custom", gate(handlers.GetCustomDirectivesHandler(s)))
	mux.Handle("DELETE /v1/directives/custom", gate(handlers.DeleteCustomDirectivesHandler(s)))
	mux.Handle("GET /v1/events", gate(handlers.EventsListHandler(s)))
	mux.Handle("GET /v1/analytics", gate(handlers.AnalyticsHandler(s)))
	mux.Handle("GET /v1/search", gate(handlers.SearchHandler(s)))

	// Token management (D095). All four require a valid bearer token;
	// the delete/rename handlers additionally refuse the seed tok_dev
	// row with a 403. The POST response is the only place the
	// plaintext token is ever exposed.
	mux.Handle("GET /v1/access-tokens", gate(handlers.AccessTokensListHandler(s)))
	mux.Handle("POST /v1/access-tokens", gate(handlers.AccessTokenCreateHandler(s)))
	mux.Handle("DELETE /v1/access-tokens/{id}", gate(handlers.AccessTokenDeleteHandler(s)))
	mux.Handle("PATCH /v1/access-tokens/{id}", gate(handlers.AccessTokenRenameHandler(s)))

	// Admin-only ops endpoints. The adminGate composes the 30s
	// REST timeout with auth.AdminRequired, which wraps the
	// standard bearer validation AND requires IsAdmin=true on the
	// resolved token (auth/token.go). Non-admin tokens get 403,
	// missing/invalid tokens get 401 — matches the 40c/50 contract
	// the handler annotation promises.
	adminGate := func(h http.Handler) http.Handler {
		if validator != nil {
			h = auth.AdminRequired(validator, h)
		}
		return withRESTTimeout(h)
	}
	mux.Handle("POST /v1/admin/reconcile-agents",
		adminGate(handlers.AdminReconcileAgentsHandler(s)))

	// MCP Protection Policy (D128) — read-open / mutation-admin per
	// D147. All GETs accept any authenticated bearer token; mutations
	// require IsAdmin=true (adminGate). The dashboard reads
	// /v1/whoami once at session start to determine which CTAs to
	// surface for the operator. The resolve endpoint is GET-only by
	// design (idempotent + safe + cacheable).
	mux.Handle("GET /v1/mcp-policies/global",
		gate(handlers.GetGlobalMCPPolicyHandler(s)))
	mux.Handle("GET /v1/mcp-policies/resolve",
		gate(handlers.ResolveMCPPolicyHandler(s)))
	mux.Handle("GET /v1/mcp-policies/templates",
		gate(handlers.ListMCPPolicyTemplatesHandler()))
	mux.Handle("GET /v1/mcp-policies/{flavor}",
		gate(handlers.GetMCPPolicyHandler(s)))
	mux.Handle("GET /v1/mcp-policies/{flavor}/audit-log",
		gate(handlers.ListMCPPolicyAuditLogHandler(s)))
	mux.Handle("GET /v1/mcp-policies/{flavor}/metrics",
		gate(handlers.GetMCPPolicyMetricsHandler(s)))

	// Mutations: admin-grade.
	mux.Handle("POST /v1/mcp-policies/{flavor}",
		adminGate(handlers.CreateMCPPolicyHandler(s)))
	mux.Handle("PUT /v1/mcp-policies/global",
		adminGate(handlers.UpdateGlobalMCPPolicyHandler(s)))
	mux.Handle("PUT /v1/mcp-policies/{flavor}",
		adminGate(handlers.UpdateMCPPolicyHandler(s)))
	mux.Handle("DELETE /v1/mcp-policies/{flavor}",
		adminGate(handlers.DeleteMCPPolicyHandler(s)))
	mux.Handle("POST /v1/mcp-policies/{flavor}/apply_template",
		adminGate(handlers.ApplyMCPPolicyTemplateHandler(s)))

	// Whoami — read-open. Returns the authenticated token's role +
	// id so the dashboard can gate mutation CTAs (D147).
	mux.Handle("GET /v1/whoami", gate(handlers.WhoamiHandler()))

	mux.Handle("GET /health", withRESTTimeout(handlers.HealthHandler()))

	// Swagger UI. The swag/v2 v2.0.0-rc5 + http-swagger v2.0.2
	// runtime combination this project pins has a broken dynamic
	// ``doc.json`` endpoint that returns 500 when the UI tries to
	// fetch its spec. We work around it by serving the static
	// ``swagger.json`` (embedded into the docs package via
	// ``go:embed``) at a stable path and pointing httpSwagger at it.
	// The Go-1.22 method-prefixed pattern ``GET /docs/swagger.json``
	// is more specific than ``GET /docs/`` so it wins precedence.
	mux.HandleFunc("GET /docs/swagger.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(apidocs.SwaggerJSON)
	})
	mux.Handle("GET /docs/", httpSwagger.Handler(
		httpSwagger.URL("/api/docs/swagger.json"),
	))

	// /v1/stream is intentionally NOT wrapped in withRESTTimeout --
	// WebSocket connections are long-lived and the timeout would kill
	// them after restTimeout. The WebSocket write pump owns its own
	// per-message deadline. Auth is handled inside the handler (D095)
	// because the upgrade handshake needs to accept the token via
	// either the Authorization header or a ?token= query parameter,
	// and the generic auth.Middleware only checks the header path.
	mux.Handle("GET /v1/stream", handlers.StreamHandler(hub, validator))

	return &http.Server{
		Addr:        addr,
		Handler:     withCORS(withLogging(withRecovery(mux)), corsOrigin),
		ReadTimeout: serverReadTimeout,
		IdleTimeout: serverIdleTimeout,
	}
}

// withRESTTimeout wraps a handler in http.TimeoutHandler so any
// non-WebSocket REST endpoint has a maximum response time. This
// matters because the server-level WriteTimeout was removed to
// keep the WebSocket stream alive.
func withRESTTimeout(h http.Handler) http.Handler {
	return http.TimeoutHandler(h, restTimeout, `{"error":"request timeout"}`)
}

func withRecovery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				slog.Error("panic recovered", "err", err, "path", r.URL.Path)
				http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		slog.Debug("request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(start))
	})
}

func withCORS(next http.Handler, origin string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
