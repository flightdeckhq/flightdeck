// Package server provides the HTTP server for the ingestion API.
package server

import (
	"bufio"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	ingestiondocs "github.com/flightdeckhq/flightdeck/ingestion/docs"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
	httpSwagger "github.com/swaggo/http-swagger/v2"
)

// publicPathPrefix is the path the ingestion is published at behind the
// edge proxy or Ingress (see withPublicPrefix).
const publicPathPrefix = "/ingest"

const (
	serverReadTimeout  = 10 * time.Second
	serverWriteTimeout = 10 * time.Second
	serverIdleTimeout  = 60 * time.Second
)

// New creates the HTTP server with all routes registered.
//
// otlpDialect maps decoded OTLP export requests to events for the
// POST /v1/logs, /v1/traces and /v1/metrics receivers.
//
// rateLimitPerMinute is the per-token sliding window cap applied to
// POST /v1/events and the OTLP routes. Pass
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
	sessAttacher handlers.SessionAttacher,
	otlpDialect handlers.OTLPDialect,
	rateLimitPerMinute int,
) *http.Server {
	mux := http.NewServeMux()

	limiter := handlers.NewRateLimiter(rateLimitPerMinute)
	mux.Handle("POST /v1/events", handlers.EventsHandler(validator, publisher, dirStore, sessAttacher, limiter))
	mux.Handle("POST /v1/heartbeat", handlers.HeartbeatHandler(validator, publisher, dirStore))
	mux.Handle("GET /health", handlers.HealthHandler())

	// OTLP/HTTP receiver. The paths are the OTLP defaults, so an
	// exporter whose endpoint is https://<host>/ingest reaches them
	// through the edge proxy. They share the events route's limiter:
	// one budget per token, however it sends.
	mux.Handle("POST /v1/logs", handlers.OTLPLogsHandler(validator, publisher, otlpDialect, limiter))
	mux.Handle("POST /v1/traces", handlers.OTLPTracesHandler(validator, publisher, otlpDialect, limiter))
	mux.Handle("POST /v1/metrics", handlers.OTLPMetricsHandler(validator, publisher, otlpDialect, limiter))

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
		Handler:      withPublicPrefix(withLogging(withRecovery(mux)), publicPathPrefix),
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

// withPublicPrefix serves the routes registered on next both at their
// own paths and under prefix, the path the service is published at
// (/ingest/v1/events reaches the same handler as /v1/events). The compose nginx strips the prefix before proxying; a
// Kubernetes Ingress forwards the path unchanged, and rewriting it there
// is specific to each ingress controller, so the service accepts both
// forms itself.
//
// The prefix must be the whole first segment of the escaped path, so
// /ingestfoo and a prefix followed by an encoded slash are left alone and
// 404; an escaped spelling of the prefix itself is accepted, as nginx
// would. A redirect the mux answers for a prefixed request (a missing
// trailing slash, an unclean path) keeps the prefix in its Location so
// the client stays on this service.
func withPublicPrefix(next http.Handler, prefix string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rest, ok := stripPathPrefix(r.URL, prefix)
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		r2 := new(http.Request)
		*r2 = *r
		r2.URL = rest
		next.ServeHTTP(&prefixRedirectWriter{ResponseWriter: w, prefix: prefix}, r2)
	})
}

// stripPathPrefix returns a copy of u without prefix when prefix is the
// whole first segment of u's escaped path, keeping the rest's escaping
// (an encoded slash further down stays encoded).
func stripPathPrefix(u *url.URL, prefix string) (*url.URL, bool) {
	escaped := u.EscapedPath()
	if !strings.HasPrefix(escaped, "/") {
		return nil, false
	}
	first, restEscaped := escaped, "/"
	if i := strings.IndexByte(escaped[1:], '/'); i >= 0 {
		first, restEscaped = escaped[:i+1], escaped[i+1:]
	}
	if decoded, err := url.PathUnescape(first); err != nil || decoded != prefix {
		return nil, false
	}
	restPath, err := url.PathUnescape(restEscaped)
	if err != nil {
		return nil, false
	}
	out := *u
	out.Path, out.RawPath = restPath, ""
	if out.EscapedPath() != restEscaped {
		out.RawPath = restEscaped
	}
	return &out, true
}

// prefixRedirectWriter puts the public prefix back on the path-only
// Location of a redirect answered for a prefixed request.
type prefixRedirectWriter struct {
	http.ResponseWriter
	prefix string
}

func (w *prefixRedirectWriter) WriteHeader(code int) {
	if code >= 300 && code < 400 {
		h := w.Header()
		if loc := h.Get("Location"); strings.HasPrefix(loc, "/") && !strings.HasPrefix(loc, "//") {
			h.Set("Location", w.prefix+loc)
		}
	}
	w.ResponseWriter.WriteHeader(code)
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (w *prefixRedirectWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// Flush passes through to the underlying writer when it can flush.
func (w *prefixRedirectWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack passes through to the underlying writer, which the WebSocket
// upgrade needs.
func (w *prefixRedirectWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	return h.Hijack()
}
