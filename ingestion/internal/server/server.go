// Package server provides the HTTP server for the ingestion API.
package server

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
	httpSwagger "github.com/swaggo/http-swagger/v2"

	_ "github.com/flightdeckhq/flightdeck/ingestion/docs"
)

const (
	serverReadTimeout  = 10 * time.Second
	serverWriteTimeout = 10 * time.Second
	serverIdleTimeout  = 60 * time.Second
)

// New creates the HTTP server with all routes registered.
func New(
	addr string,
	validator handlers.TokenValidator,
	publisher handlers.EventPublisher,
	dirStore handlers.DirectiveLookup,
) *http.Server {
	mux := http.NewServeMux()

	mux.Handle("POST /v1/events", handlers.EventsHandler(validator, publisher, dirStore))
	mux.Handle("POST /v1/heartbeat", handlers.HeartbeatHandler(validator, publisher, dirStore))
	mux.Handle("GET /health", handlers.HealthHandler())
	mux.Handle("GET /docs/", httpSwagger.WrapHandler)

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
