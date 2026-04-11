// Package server provides the HTTP server for the ingestion API.
package server

import (
	"log/slog"
	"net/http"
	"time"

	ingestiondocs "github.com/flightdeckhq/flightdeck/ingestion/docs"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
	httpSwagger "github.com/swaggo/http-swagger/v2"
)

const (
	serverReadTimeout  = 10 * time.Second
	serverWriteTimeout = 10 * time.Second
	serverIdleTimeout  = 60 * time.Second
)

// New creates the HTTP server with all routes registered.
//
// rateLimitPerMinute is the per-token sliding window cap applied to
// POST /v1/events and POST /v1/heartbeat. Pass
// handlers.DefaultRateLimitPerMinute for production semantics, or a
// higher value (typically from FLIGHTDECK_RATE_LIMIT_PER_MINUTE in
// dev compose) when running the integration suite. A non-positive
// value falls back to the default inside NewRateLimiter so a
// misconfigured env var cannot accidentally disable the limit.
func New(
	addr string,
	validator handlers.TokenValidator,
	publisher handlers.EventPublisher,
	dirStore handlers.DirectiveLookup,
	rateLimitPerMinute int,
) *http.Server {
	mux := http.NewServeMux()

	limiter := handlers.NewRateLimiter(rateLimitPerMinute)
	mux.Handle("POST /v1/events", handlers.EventsHandler(validator, publisher, dirStore, limiter))
	mux.Handle("POST /v1/heartbeat", handlers.HeartbeatHandler(validator, publisher, dirStore))
	mux.Handle("GET /health", handlers.HealthHandler())

	// Swagger UI. Same workaround as the api server: the dynamic
	// ``doc.json`` endpoint is broken under the swag/v2 v2.0.0-rc5 +
	// http-swagger v2.0.2 runtime combination, so we serve the
	// static ``swagger.json`` (embedded via ``go:embed``) at a
	// stable path and configure httpSwagger to use it. See the
	// matching api/internal/server/server.go for the same fix.
	mux.HandleFunc("GET /docs/swagger.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(ingestiondocs.SwaggerJSON)
	})
	mux.Handle("GET /docs/", httpSwagger.Handler(
		httpSwagger.URL("/ingest/docs/swagger.json"),
	))

	return &http.Server{
		Addr:         addr,
		Handler:      withLogging(withRecovery(mux)),
		ReadTimeout:  serverReadTimeout,
		WriteTimeout: serverWriteTimeout,
		IdleTimeout:  serverIdleTimeout,
	}
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
