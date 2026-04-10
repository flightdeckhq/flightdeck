// Package server provides the HTTP server for the query API.
package server

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/auth"
	"github.com/flightdeckhq/flightdeck/api/internal/handlers"
	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"github.com/flightdeckhq/flightdeck/api/internal/ws"
	httpSwagger "github.com/swaggo/http-swagger/v2"

	_ "github.com/flightdeckhq/flightdeck/api/docs"
)

// TODO(KI12)[Phase 5]: REST endpoints have no per-IP rate limit.
// The query API has no analogue to the ingestion-side per-token
// sliding window rate limiter (D048). Add per-IP middleware in
// Phase 5 alongside the JWT auth refactor. See DECISIONS.md D073
// for the related sensor-endpoint stopgap.

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
// validator is used by the sensor-facing endpoints (/v1/directives/sync
// and /v1/directives/register). When nil (e.g. in unit tests), those
// endpoints are mounted without auth.
func New(addr string, s store.Querier, hub *ws.Hub, validator *auth.Validator, corsOrigin string) *http.Server {
	mux := http.NewServeMux()

	// REST routes wrapped with a 30s timeout. The wrapper applies
	// http.TimeoutHandler so a hung pgx query cannot pin a request
	// indefinitely.
	mux.Handle("GET /v1/fleet", withRESTTimeout(handlers.FleetHandler(s)))
	mux.Handle("GET /v1/sessions/", withRESTTimeout(handlers.SessionsHandler(s)))
	mux.Handle("GET /v1/events/", withRESTTimeout(handlers.ContentHandler(s)))
	mux.Handle("GET /v1/policy", withRESTTimeout(handlers.EffectivePolicyHandler(s)))
	mux.Handle("GET /v1/policies", withRESTTimeout(handlers.PoliciesListHandler(s)))
	mux.Handle("POST /v1/policies", withRESTTimeout(handlers.PolicyCreateHandler(s)))
	mux.Handle("PUT /v1/policies/{id}", withRESTTimeout(handlers.PolicyUpdateHandler(s)))
	mux.Handle("DELETE /v1/policies/{id}", withRESTTimeout(handlers.PolicyDeleteHandler(s)))
	mux.Handle("POST /v1/directives", withRESTTimeout(handlers.CreateDirectiveHandler(s)))

	// Sensor-facing endpoints: bearer token auth (stopgap until Phase 5
	// JWT auth lands -- see DECISIONS.md D073). When validator is nil
	// (unit tests) we mount the handler directly without auth.
	syncHandler := http.Handler(handlers.SyncDirectivesHandler(s))
	registerHandler := http.Handler(handlers.RegisterDirectivesHandler(s))
	if validator != nil {
		syncHandler = auth.Middleware(validator, syncHandler)
		registerHandler = auth.Middleware(validator, registerHandler)
	}
	mux.Handle("POST /v1/directives/sync", withRESTTimeout(syncHandler))
	mux.Handle("POST /v1/directives/register", withRESTTimeout(registerHandler))

	mux.Handle("GET /v1/directives/custom", withRESTTimeout(handlers.GetCustomDirectivesHandler(s)))
	mux.Handle("GET /v1/events", withRESTTimeout(handlers.EventsListHandler(s)))
	mux.Handle("GET /v1/analytics", withRESTTimeout(handlers.AnalyticsHandler(s)))
	mux.Handle("GET /v1/search", withRESTTimeout(handlers.SearchHandler(s)))
	mux.Handle("GET /health", withRESTTimeout(handlers.HealthHandler()))
	mux.Handle("GET /docs/", httpSwagger.WrapHandler)

	// /v1/stream is intentionally NOT wrapped in withRESTTimeout --
	// WebSocket connections are long-lived and the timeout would kill
	// them after restTimeout. The WebSocket write pump owns its own
	// per-message deadline.
	mux.Handle("GET /v1/stream", handlers.StreamHandler(hub))

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
