// Package server provides the HTTP server for the query API.
package server

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/handlers"
	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"github.com/flightdeckhq/flightdeck/api/internal/ws"
	httpSwagger "github.com/swaggo/http-swagger/v2"

	_ "github.com/flightdeckhq/flightdeck/api/docs"
)

const (
	serverReadTimeout  = 10 * time.Second
	serverWriteTimeout = 10 * time.Second
	serverIdleTimeout  = 120 * time.Second
)

// New creates the HTTP server with all routes registered.
func New(addr string, s store.Querier, hub *ws.Hub, corsOrigin string) *http.Server {
	mux := http.NewServeMux()

	mux.Handle("GET /v1/fleet", handlers.FleetHandler(s))
	mux.Handle("GET /v1/sessions/", handlers.SessionsHandler(s))
	mux.Handle("GET /v1/policy", handlers.EffectivePolicyHandler(s))
	mux.Handle("GET /v1/stream", handlers.StreamHandler(hub))
	mux.Handle("GET /health", handlers.HealthHandler())
	mux.Handle("GET /docs/", httpSwagger.WrapHandler)

	return &http.Server{
		Addr:         addr,
		Handler:      withCORS(withLogging(withRecovery(mux)), corsOrigin),
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
